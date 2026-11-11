'use strict';

const host = require('internal/host');
const { EventTarget, DOMException } = require('internal/path_events/event_target');
const { MessageEvent } = require('internal/web/websocket/events');
const clone = require('internal/worker/clone');
const ports = require('internal/worker/ports');
const { codes: { ERR_MISSING_ARGS } } = require('internal/validators');
const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
const channels = new WeakMap();
function state(channel) {
  const data = channels.get(channel);
  if (!data) throw clone.codedError('ERR_INVALID_THIS', 'Value of this must be a BroadcastChannel');
  return data;
}
class BroadcastChannel extends EventTarget {
  constructor(name) {
    super();
    if (arguments.length === 0) throw new ERR_MISSING_ARGS('name');
    if (typeof name === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    name = String(name);
    const endpoint = host.workerNative('subscribe', [name]);
    const port = ports.wrap(endpoint);
    channels.set(this, { name, endpoint, port, closed: false, handlers: Object.create(null) });
    for (const type of ['message', 'messageerror']) port.on(type, data => {
      const event = new MessageEvent(type, { data });
      if (data === undefined) Object.defineProperty(event, 'data', { value: undefined, enumerable: true });
      this.dispatchEvent(event);
    });
  }
  get name() { return state(this).name; }
  postMessage(value) {
    if (arguments.length === 0) throw new ERR_MISSING_ARGS('message');
    const data = state(this);
    if (data.closed) throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
    const prepared = clone.prepare(value);
    host.workerNative('broadcastPost', [data.endpoint, prepared.bytes, prepared.shared, prepared.buffers]);
  }
  close() {
    const data = state(this);
    if (data.closed) return;
    host.workerNative('unsubscribe', [data.endpoint]);
    ports.close(data.port);
    data.closed = true;
  }
  ref() { const data = state(this); if (!data.closed) data.port.ref(); return this; }
  unref() { const data = state(this); if (!data.closed) data.port.unref(); return this; }
}
for (const type of ['message', 'messageerror']) Object.defineProperty(BroadcastChannel.prototype, 'on' + type, {
  enumerable: true, configurable: true,
  get() { return state(this).handlers[type] || null; },
  set(listener) {
    const data = state(this);
    if (data.handlers[type]) this.removeEventListener(type, data.handlers[type]);
    data.handlers[type] = typeof listener === 'function' ? listener : null;
    if (data.handlers[type]) this.addEventListener(type, listener);
  },
});
Object.defineProperty(BroadcastChannel.prototype, inspectCustom, {
  enumerable: false, writable: true, configurable: true,
  value: function inspect(depth, options) {
    const data = channels.get(this);
    if (!data) throw clone.codedError('ERR_INVALID_THIS', 'Value of "this" must be of type BroadcastChannel');
    if (depth < 0) return 'BroadcastChannel';
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `BroadcastChannel ${require('util').inspect({ name: data.name, active: !data.closed }, opts)}`;
  },
});
Object.defineProperty(BroadcastChannel.prototype, Symbol.toStringTag, { value: 'BroadcastChannel', configurable: true });
module.exports = { BroadcastChannel, portOf: value => channels.get(value)?.port };
