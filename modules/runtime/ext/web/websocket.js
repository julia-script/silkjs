'use strict';

const { Buffer } = require('buffer');
const { randomBytes, createHash } = require('crypto');
const { Event, EventTarget, DOMException } = require('internal/path_events/event_target');
const { URL } = require('internal/web/url');
const { Blob } = require('internal/web/blob');
const { MessageEvent, CloseEvent, ErrorEvent, string } = require('internal/web/websocket/events');
const { Receiver, frame, failure } = require('internal/web/websocket/framing');
const { offer, negotiate, Inflater } = require('internal/web/websocket/compression');
const records = new WeakMap();
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const empty = Buffer.alloc(0);
const badPorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
function state(value) {
  const record = records.get(value);
  if (!record) throw new TypeError('Value of this must be of type WebSocket');
  return record;
}
function scalarString(value) {
  const result = string(value);
  // Buffer's UTF-8 encoder replaces unmatched UTF-16 surrogates.
  return result.toWellFormed ? result.toWellFormed() : Buffer.from(result).toString();
}
function closePayload(code, reason) {
  if (code === undefined && !reason.length) return empty;
  const payload = Buffer.allocUnsafe(2 + reason.length);
  payload.writeUInt16BE(code === undefined ? 1000 : code, 0);
  payload.set(reason, 2);
  return payload;
}
function finish(record) {
  if (record.readyState === 3) return;
  record.readyState = 3;
  clearTimeout(record.closeTimer);
  record.receiver?.stop();
  record.queue = [];
  const clean = record.receivedClose && record.closeWritten && !record.failure;
  if (!clean && !record.failure) record.failure = new Error('WebSocket connection closed abnormally');
  if (record.failure) record.target.dispatchEvent(new ErrorEvent('error', { error: record.failure, message: record.failure.message }));
  record.target.dispatchEvent(new CloseEvent('close', {
    wasClean: clean,
    code: record.receivedClose && !record.failure ? record.closeCode : 1006,
    reason: record.receivedClose && !record.failure ? record.closeReason : '',
  }));
}
function peerEnded(record) {
  record.ended = true;
  // Async inflation may still precede the peer's close frame in the read queue.
  if (record.receiver?.paused) return;
  if (!record.receivedClose) fail(record, new Error('WebSocket peer ended without a close frame'));
  else if (record.closeWritten) record.socket.end();
}
function armCloseTimer(record) {
  if (record.closeTimer) return;
  record.closeTimer = setTimeout(() => {
    record.failure ||= new Error('WebSocket closing handshake timed out');
    record.socket?.destroy();
    record.request?.destroy();
    finish(record);
  }, 30000);
  record.closeTimer.unref?.();
}
function fail(record, error) {
  if (record.readyState === 3 || record.failure) return;
  record.failure = error;
  record.readyState = 2;
  record.receiver?.stop();
  record.queue = [];
  const socket = record.socket;
  if (!socket) {
    record.request?.destroy();
    process.nextTick(() => finish(record));
    return;
  }
  armCloseTimer(record);
  if (!record.sentClose && error.closeCode && !socket.destroyed && socket.writable) {
    record.sentClose = true;
    try { socket.write(frame(8, closePayload(error.closeCode, empty)), () => socket.destroy()); }
    catch { socket.destroy(); }
  } else socket.destroy();
}
function writeClose(record, payload) {
  if (record.sentClose || record.readyState === 3 || record.failure) return;
  record.sentClose = true;
  armCloseTimer(record);
  try {
    record.socket.write(frame(8, payload), error => {
      if (error) { fail(record, error); return; }
      record.closeWritten = true;
      if (record.receivedClose) record.socket.end();
    });
  } catch (error) { fail(record, error); }
}
function drain(record) {
  if (record.sending || record.failure || record.readyState === 3) return;
  record.sending = true;
  while (record.queue.length && !record.failure && !record.receivedClose) {
    const item = record.queue.shift();
    if (item.close) { writeClose(record, item.payload); continue; }
    if (item.blob) {
      // Read the actual Blob bytes without invoking an overridden instance method.
      Blob.prototype.arrayBuffer.call(item.blob).then(bytes => {
        record.sending = false;
        if (record.failure || record.readyState === 3 || record.receivedClose) return;
        record.queue.unshift({ opcode: 2, payload: Buffer.from(bytes), size: item.size });
        drain(record);
      }, error => { record.sending = false; fail(record, error); });
      return;
    }
    try {
      record.socket.write(frame(item.opcode, item.payload), error => {
        if (error) { fail(record, error); return; }
        record.bufferedAmount -= item.size;
      });
    } catch (error) { fail(record, error); }
  }
  record.sending = false;
}
function establish(record, protocols) {
  if (record.readyState !== 0) return;
  const url = record.parsed;
  if (badPorts.has(Number(url.port))) { fail(record, new Error('WebSocket port is blocked')); return; }
  const secure = url.protocol === 'wss:';
  try {
    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const headers = {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Extensions': offer, 'Sec-Fetch-Mode': 'websocket',
    };
    if (protocols.length) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const request = record.request = require(secure ? 'https' : 'http').request({
      protocol: secure ? 'https:' : 'http:', hostname: url.hostname,
      port: url.port || (secure ? 443 : 80), path: url.pathname + url.search,
      method: 'GET', headers, agent: false, ALPNProtocols: ['http/1.1'],
      auth: url.username || url.password ? decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password) : undefined,
    });
    request.on('error', error => fail(record, error));
    request.on('response', response => {
      fail(record, new Error('WebSocket handshake returned HTTP ' + response.statusCode));
      response.destroy();
    });
    request.on('close', () => {
      if (!record.socket && record.readyState !== 3) {
        if (!record.failure) fail(record, new Error('WebSocket handshake closed before upgrade'));
        else finish(record);
      }
    });
    request.on('upgrade', (response, socket, head) => {
      if (record.readyState !== 0) { socket.destroy(); return; }
      // HTTP parsers may join or discard duplicate fields. Validate the raw
      // single-valued handshake fields rather than trusting that normalization.
      const fields = new Map();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i].toLowerCase();
        const values = fields.get(name) || [];
        values.push(response.rawHeaders[i + 1].trim());
        fields.set(name, values);
      }
      const single = name => {
        const values = fields.get(name);
        if (values && values.length !== 1) throw failure('Duplicate WebSocket handshake field: ' + name);
        return values?.[0];
      };
      let compression;
      try {
        if (response.statusCode !== 101 || response.httpVersionMajor !== 1 || response.httpVersionMinor < 1) throw failure('Invalid WebSocket upgrade status');
        if (single('upgrade')?.toLowerCase() !== 'websocket') throw failure('Invalid WebSocket Upgrade header');
        if (single('connection')?.toLowerCase() !== 'upgrade') throw failure('Invalid WebSocket Connection header');
        if (single('sec-websocket-accept') !== expected) throw failure('Invalid WebSocket accept digest');
        const protocol = single('sec-websocket-protocol');
        if (protocol === undefined ? protocols.length !== 0 : !token.test(protocol) || !protocols.includes(protocol)) throw failure('Invalid WebSocket subprotocol selection');
        const extension = (fields.get('sec-websocket-extensions') || []).join(', ');
        compression = fields.has('sec-websocket-extensions') ? negotiate(extension) : null;
        record.protocol = protocol || '';
        record.extensions = extension;
      } catch (error) {
        socket.destroy();
        fail(record, error);
        return;
      }
      record.socket = socket;
      const receiver = record.receiver = new Receiver({
        error: error => fail(record, error),
        pause: () => socket.pause(),
        resume: () => { if (record.ended) peerEnded(record); else socket.resume(); },
        message: (opcode, payload) => {
          if (record.readyState !== 1) return;
          let data = payload;
          if (opcode === 2) data = record.binaryType === 'blob' ? new Blob([payload]) : Uint8Array.from(payload).buffer;
          record.target.dispatchEvent(new MessageEvent('message', { data, origin: record.parsed.origin }));
        },
        ping: payload => {
          if (record.sentClose || record.failure) return;
          try { socket.write(frame(10, payload), error => { if (error) fail(record, error); }); }
          catch (error) { fail(record, error); }
        },
        close: (code, reason, payload) => {
          record.receivedClose = true;
          record.closeCode = code;
          record.closeReason = reason;
          record.readyState = 2;
          record.queue = [];
          if (!record.sentClose) writeClose(record, payload);
          else if (record.closeWritten) socket.end();
        },
      }, compression ? new Inflater(compression) : null);
      socket.on('data', chunk => receiver.feed(chunk));
      socket.on('error', error => fail(record, error));
      socket.on('close', () => finish(record));
      socket.on('end', () => peerEnded(record));
      socket.allowHalfOpen = true;
      socket.setNoDelay(true);
      record.readyState = 1;
      record.target.dispatchEvent(new Event('open'));
      if (head.length) receiver.feed(head);
      if (!receiver.paused && !receiver.stopped) socket.resume();
    });
    request.end();
  } catch (error) { fail(record, error); }
}
class WebSocket extends EventTarget {
  constructor(url, protocols = []) {
    super();
    if (!arguments.length) throw new TypeError('WebSocket requires a URL');
    url = scalarString(url);
    let parsed;
    try { parsed = new URL(url); }
    catch (error) { throw new DOMException(error.message, 'SyntaxError'); }
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new DOMException('Expected a ws: or wss: URL', 'SyntaxError');
    if (parsed.hash || parsed.href.endsWith('#')) throw new DOMException('WebSocket URL must not contain a fragment', 'SyntaxError');
    if (typeof protocols === 'string') protocols = [protocols];
    else if (protocols != null && typeof protocols[Symbol.iterator] === 'function') protocols = Array.from(protocols, string);
    else throw new TypeError('WebSocket protocols must be a string or iterable sequence');
    if (protocols.some(protocol => !token.test(protocol)) || new Set(protocols.map(protocol => protocol.toLowerCase())).size !== protocols.length) throw new DOMException('Invalid Sec-WebSocket-Protocol value', 'SyntaxError');
    const record = {
      target: this, parsed, readyState: 0, binaryType: 'blob', bufferedAmount: 0,
      protocol: '', extensions: '', request: null, socket: null, receiver: null,
      queue: [], sending: false, sentClose: false, closeWritten: false,
      receivedClose: false, closeCode: 1006, closeReason: '', closeTimer: null, ended: false,
      failure: null, handlers: Object.create(null),
    };
    records.set(this, record);
    process.nextTick(() => establish(record, protocols));
  }
  get url() { return state(this).parsed.href; }
  get readyState() { return state(this).readyState; }
  get bufferedAmount() { return state(this).bufferedAmount; }
  get extensions() { return state(this).extensions; }
  get protocol() { return state(this).protocol; }
  get binaryType() { return state(this).binaryType; }
  set binaryType(value) {
    const record = state(this);
    value = string(value);
    if (value === 'blob' || value === 'arraybuffer') record.binaryType = value;
  }
  send(data) {
    const record = state(this);
    if (!arguments.length) throw new TypeError('WebSocket.send requires data');
    let payload, blob, opcode = 2;
    if (data instanceof Blob) blob = data;
    else if (data instanceof ArrayBuffer) payload = Buffer.from(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) payload = Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else { opcode = 1; payload = Buffer.from(scalarString(data)); }
    if (record.readyState === 0) throw new DOMException('Sent before connected', 'InvalidStateError');
    if (record.readyState !== 1) return;
    const size = blob ? Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get.call(blob) : payload.length;
    record.bufferedAmount += size;
    record.queue.push({ opcode, payload, blob, size });
    drain(record);
  }
  close(code = undefined, reason = undefined) {
    const record = state(this);
    if (code !== undefined) {
      const number = +code;
      const bounded = Number.isNaN(number) ? 0 : Math.min(65535, Math.max(0, number));
      // Web IDL [Clamp] rounds halfway values to the even integer.
      const floor = Math.floor(bounded);
      code = bounded - floor === 0.5 ? floor + (floor % 2) : Math.round(bounded);
    }
    const bytes = Buffer.from(reason === undefined ? '' : scalarString(reason));
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid WebSocket close code', 'InvalidAccessError');
    if (bytes.length > 123) throw new DOMException('WebSocket close reason exceeds 123 UTF-8 bytes', 'SyntaxError');
    if (record.readyState === 2 || record.readyState === 3) return;
    if (record.readyState === 0) { fail(record, new Error('WebSocket was closed before the connection was established')); return; }
    record.readyState = 2;
    armCloseTimer(record);
    record.queue.push({ close: true, payload: closePayload(code, bytes) });
    drain(record);
  }
}
for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
  Object.defineProperty(WebSocket, name, { value, enumerable: true });
  Object.defineProperty(WebSocket.prototype, name, { value, enumerable: true });
}
for (const type of ['open', 'message', 'error', 'close']) {
  Object.defineProperty(WebSocket.prototype, 'on' + type, {
    enumerable: true, configurable: true,
    get() { return state(this).handlers[type]?.callback || null; },
    set(callback) {
      const handlers = state(this).handlers;
      if (typeof callback !== 'function') callback = null;
      if (handlers[type]) {
        if (callback) handlers[type].callback = callback;
        else { this.removeEventListener(type, handlers[type].listener); delete handlers[type]; }
      } else if (callback) {
        const entry = { callback, listener: event => entry.callback.call(this, event) };
        handlers[type] = entry;
        this.addEventListener(type, entry.listener);
      }
    },
  });
}
Object.defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });
for (const key of Object.getOwnPropertyNames(WebSocket.prototype)) {
  if (key !== 'constructor') Object.defineProperty(WebSocket.prototype, key, { enumerable: true });
}
module.exports = { WebSocket, MessageEvent, CloseEvent, ErrorEvent };
