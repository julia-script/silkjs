'use strict';

const { Buffer } = require('buffer');
const { Event, EventTarget, DOMException, AbortController } = require('internal/path_events/event_target');
const { URL } = require('internal/url');
const { fetch } = require('internal/web/fetch');
const { MessageEvent, string } = require('internal/web/websocket/events');
const { EventSourceParser } = require('internal/web/eventsource/parser');
const records = new WeakMap();
require('internal/host').types.isEventSource = value => records.has(value);
let experimentalWarned = false;

function state(value) {
  const record = records.get(value);
  if (!record) throw new TypeError('Value of this must be of type EventSource');
  return record;
}
function dictionary(value) {
  if (value == null) return {};
  if (typeof value !== 'object' && typeof value !== 'function') throw new TypeError('EventSource options must be an object');
  return value;
}
function reconnect(record) {
  if (record.readyState === 2) return;
  record.readyState = 0;
  record.target.dispatchEvent(new Event('error'));
  if (record.readyState === 2) return;
  record.timer = setTimeout(() => {
    record.timer = null;
    if (record.readyState !== 0) return;
    // Node retains an already-sent header when a subsequent id field is empty.
    if (record.lastEventId) record.lastEventHeader = Buffer.from(record.lastEventId).toString('latin1');
    connect(record);
  }, record.reconnectionTime);
  record.timer.unref?.();
}
function close(record) {
  if (record.readyState === 2) return;
  record.readyState = 2;
  clearTimeout(record.timer);
  record.timer = null;
  record.controller?.abort();
  if (record.reader) record.reader.cancel().catch(() => {});
}
function fail(record) {
  if (record.readyState === 2) return;
  close(record);
  record.target.dispatchEvent(new Event('error'));
}
async function connect(record) {
  if (record.readyState === 2) return;
  const controller = new AbortController();
  record.controller = controller;
  let reader;
  try {
    const headers = { accept: 'text/event-stream' };
    if (record.lastEventHeader !== undefined) headers['last-event-id'] = record.lastEventHeader;
    const response = await fetch(record.requestURL, {
      headers, signal: controller.signal, redirect: 'follow', cache: 'no-store',
      mode: 'cors', credentials: record.withCredentials ? 'omit' : 'same-origin',
      referrer: '', keepalive: true, dispatcher: record.dispatcher,
    });
    if (record.readyState === 2) {
      if (response.body) await response.body.cancel();
      return;
    }
    const mime = response.headers.get('content-type');
    const essence = mime === null ? '' : mime.split(';', 1)[0].replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '').toLowerCase();
    if (response.status !== 200 || essence !== 'text/event-stream') {
      fail(record);
      if (response.body) await response.body.cancel().catch(() => {});
      return;
    }
    // Reconnect to the final URL, but preserve the constructor URL attribute.
    record.requestURL = response.url || record.requestURL;
    record.origin = new URL(record.requestURL).origin;
    reader = response.body?.getReader();
    record.reader = reader;
    record.readyState = 1;
    record.target.dispatchEvent(new Event('open'));
    const parser = new EventSourceParser(record, (type, data) => {
      if (record.readyState !== 1) return false;
      record.target.dispatchEvent(new MessageEvent(type, {
        data, origin: record.origin, lastEventId: record.lastEventId,
      }));
      return record.readyState === 1;
    }, record.dispatcher?.eventSourceOptions?.maxEventSize ?? undefined);
    while (record.readyState === 1 && reader) {
      const result = await reader.read();
      if (record.readyState !== 1 || result.done) break;
      parser.feed(result.value);
    }
  } catch (error) {
    // Node reports an aborted fetch before response headers as an error even
    // after close(). Aborting an already-open body does not emit that event.
    if (!reader && controller.signal.aborted) record.target.dispatchEvent(new Event('error'));
    else if (error?.aborted === false) fail(record);
  } finally {
    if (reader) reader.releaseLock();
    record.reader = null;
    record.controller = null;
  }
  reconnect(record);
}

class EventSource extends EventTarget {
  constructor(url, options = {}) {
    super();
    if (!arguments.length) throw new TypeError('EventSource constructor requires a URL');
    if (!experimentalWarned) {
      experimentalWarned = true;
      process.emitWarning('EventSource is experimental, expect them to change at any time.', { code: 'UNDICI-ES' });
    }
    url = string(url);
    // URL performs the USVString conversion, including lone-surrogate replacement.
    options = dictionary(options);
    const dispatcher = options.dispatcher;
    const node = dictionary(options.node);
    const nodeDispatcher = node.dispatcher;
    const retry = node.reconnectionTime;
    let reconnectionTime = 3000;
    if (retry !== undefined) {
      const number = Number(retry);
      reconnectionTime = Number.isFinite(number) ? ((Math.trunc(number) % 4294967296) + 4294967296) % 4294967296 : 0;
    }
    const withCredentials = Boolean(options.withCredentials);
    const selectedDispatcher = nodeDispatcher || dispatcher;
    if (selectedDispatcher !== undefined) require('assert').ok(selectedDispatcher);
    let parsed;
    try { parsed = new URL(url); }
    catch (error) { throw new DOMException(String(error), 'SyntaxError'); }
    const record = {
      target: this, url: parsed.href, requestURL: parsed.href, origin: parsed.origin,
      withCredentials, readyState: 0, reconnectionTime, lastEventId: '',
      lastEventHeader: undefined, controller: null, reader: null, timer: null,
      handlers: Object.create(null), dispatcher: selectedDispatcher,
    };
    records.set(this, record);
    connect(record);
  }
  get readyState() { return state(this).readyState; }
  get url() { return state(this).url; }
  get withCredentials() { return state(this).withCredentials; }
  close() { close(state(this)); }
}
for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSED: 2 })) {
  Object.defineProperty(EventSource, name, { value, enumerable: true });
  Object.defineProperty(EventSource.prototype, name, { value, enumerable: true });
}
for (const type of ['open', 'message', 'error']) {
  Object.defineProperty(EventSource.prototype, 'on' + type, {
    enumerable: true, configurable: true,
    get() { return state(this).handlers[type]?.value ?? null; },
    set(value) {
      const handlers = state(this).handlers;
      if (handlers[type]) this.removeEventListener(type, handlers[type].listener);
      if (typeof value !== 'function' && (value === null || typeof value !== 'object')) {
        delete handlers[type];
        return;
      }
      // Web IDL EventHandlerNonNull retains objects but only calls functions.
      const listener = typeof value === 'function' ? value : () => {};
      handlers[type] = { value, listener };
      this.addEventListener(type, listener);
    },
  });
}
for (const key of ['readyState', 'url', 'withCredentials', 'close']) {
  Object.defineProperty(EventSource.prototype, key, { enumerable: true });
}
module.exports = { EventSource };
