'use strict';

const { Buffer } = require('buffer');
const { Blob } = require('internal/web/blob');
const { URLSearchParams } = require('internal/url');
const { ReadableStream } = require('internal/web/streams');
const { TextDecoder } = require('internal/encoding');
const { FormData, encodeForm, parseForm, parseMIME } = require('internal/web/fetch/formdata');
const { scalar } = require('internal/web/fetch/headers');
const disturbedSymbol = Symbol.for('nodejs.stream.disturbed');
// decode() without stream keeps no state between calls.
const utf8 = new TextDecoder();
// A body made from bytes or a Blob gets its stream only when something reads it.
class BodyRecord {
  // A string body keeps its text, and is encoded only when something needs its bytes: a server
  // can write the text itself.
  constructor(stream, source, bytes, length, type, text = null) {
    this.current = stream; this.source = source; this.text = text; this.encoded = bytes; this.size = length; this.type = type; this.used = false;
  }
  get bytes() {
    let bytes = this.encoded;
    if (bytes === null && this.text !== null) { bytes = this.encoded = Buffer.from(this.text, 'utf8'); this.size = bytes.length; }
    return bytes;
  }
  get length() { return this.size === null && this.text !== null ? this.bytes.length : this.size; }
  get stream() {
    if (this.current === null) {
      const bytes = this.bytes;
      this.current = bytes !== null ? new ReadableStream({ type: 'bytes', start(controller) { if (bytes.length) controller.enqueue(new Uint8Array(bytes)); controller.close(); } })
        : this.source.stream();
    }
    return this.current;
  }
  set stream(value) { this.current = value; }
  // No source to read again: the body is a stream.
  get streaming() { return (this.source === null || this.source.incoming === true) && this.encoded === null && this.text === null; }
}
// A response body arriving from the network. Until something asks for its stream, chunks
// collect here, and text(), json(), arrayBuffer() and the rest take them without a
// ReadableStream; a stream made later starts with what has arrived. pull() asks the source
// for more, cancel(reason) stops it.
class IncomingBody {
  constructor(pull, cancel) {
    this.incoming = true; this.pull = pull; this.cancel = cancel;
    this.chunks = []; this.length = 0; this.done = false; this.failure = null;
    this.controller = null; this.waiter = null;
  }
  // Takes bytes nothing else holds; false asks the source to pause.
  push(bytes) {
    if (this.controller !== null) { this.controller.enqueue(bytes); return this.controller.desiredSize > 0; }
    this.chunks.push(bytes); this.length += bytes.length;
    // undici's fetch reads ahead into a 64 KiB Readable: a body that fits completes (and
    // reports its end) before anything reads it.
    return this.waiter !== null || this.length < 65536;
  }
  end() {
    this.done = true;
    if (this.controller !== null) {
      const pending = this.controller.byobRequest;
      this.controller.close();
      if (pending) pending.respond(0);
    } else if (this.waiter !== null) { const { resolve } = this.waiter; this.waiter = null; resolve(this.take()); }
  }
  fail(reason) {
    if (this.done) return;
    this.done = true; this.failure = { reason };
    if (this.controller !== null) this.controller.error(reason);
    else if (this.waiter !== null) { const { reject } = this.waiter; this.waiter = null; reject(reason); }
  }
  take() {
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length === 1) return chunks[0];
    const bytes = new Uint8Array(this.length);
    let at = 0;
    for (let i = 0; i < chunks.length; i++) { bytes.set(chunks[i], at); at += chunks[i].length; }
    return bytes;
  }
  // Every byte, once the body ends.
  collect() {
    if (this.failure !== null) return Promise.reject(this.failure.reason);
    if (this.done) return Promise.resolve(this.take());
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.pull(); });
  }
  stream() {
    const body = this;
    return new ReadableStream({
      type: 'bytes',
      start(controller) {
        body.controller = controller;
        for (let i = 0; i < body.chunks.length; i++) controller.enqueue(body.chunks[i]);
        body.chunks = [];
        if (body.failure !== null) controller.error(body.failure.reason);
        else if (body.done) controller.close();
      },
      pull() { if (!body.done) body.pull(); },
      cancel(reason) { body.done = true; body.cancel(reason); },
    }, { highWaterMark: 65536 });
  }
}
function used(body) { return !!body && (body.used || (body.current !== null && !!body.current[disturbedSymbol])); }
function unusable(body) { return !!body && (used(body) || (body.current !== null && body.current.locked)); }
// Reads the record of a Request or Response; message.js sets it.
let read = null;
function readStates(reader) { read = reader; }
function state(object) {
  const value = read(object);
  if (!value) throw new TypeError('Illegal body invocation');
  return value;
}
function extract(value, keepalive = false) {
  if (value == null) return null;
  let stream = null, source = null, type = null, length = null;
  if (typeof value === 'string') return textBody(value);
  if (value instanceof ReadableStream) stream = value;
  else if (value instanceof Blob) { source = value; type = value.type || null; }
  else if (value instanceof FormData) { source = encodeForm(value); type = source.type; }
  else if (value instanceof URLSearchParams) { source = new Blob([value.toString()]); type = 'application/x-www-form-urlencoded;charset=UTF-8'; }
  else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const bytes = Buffer.from(view);
    return new BodyRecord(null, null, bytes, bytes.length, null);
  }
  else if (value && typeof value[Symbol.asyncIterator] === 'function') {
    const iterator = value[Symbol.asyncIterator]();
    stream = new ReadableStream({
      async pull(controller) {
        const item = await iterator.next();
        if (item.done) controller.close();
        else if (typeof item.value === 'string') controller.enqueue(Buffer.from(item.value));
        else if (item.value instanceof Uint8Array) controller.enqueue(item.value);
        else throw new TypeError('Body stream must yield Uint8Array chunks');
      },
      async cancel(reason) { if (iterator.return) await iterator.return(reason); },
    }, { highWaterMark: 0 });
  } else { source = new Blob([scalar(value)]); type = 'text/plain;charset=UTF-8'; }
  if (stream) {
    if (keepalive) throw new TypeError('keepalive cannot be used with a streaming body');
    if (stream.locked || stream[disturbedSymbol]) throw new TypeError('Response body object should not be disturbed or locked');
  } else length = source.size;
  return new BodyRecord(stream, source, null, length, type);
}
function clone(body) {
  if (!body) return null;
  if (unusable(body)) throw new TypeError('Body has already been consumed');
  if (body.current === null && body.source?.incoming !== true) return new BodyRecord(null, body.source, body.encoded, body.size, body.type, body.text);
  const branches = body.stream.tee();
  body.stream = branches[0];
  return new BodyRecord(branches[1], body.source, body.encoded, body.size, body.type, body.text);
}
function transfer(body) {
  if (!body) return null;
  if (unusable(body)) throw new TypeError('Body has already been consumed');
  const reader = body.stream.getReader();
  body.used = true;
  const stream = new ReadableStream({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) { reader.releaseLock(); controller.close(); }
      else controller.enqueue(next.value);
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  return new BodyRecord(stream, body.source, body.encoded, body.size, body.type, body.text);
}
async function consume(object) {
  const record = state(object), body = record.body;
  if (unusable(body)) throw new TypeError('Body is unusable: Body has already been read');
  if (!body) return new Uint8Array(0);
  body.used = true;
  if (body.current === null && body.bytes !== null) return new Uint8Array(body.bytes);
  if (body.current === null && body.source?.incoming === true) return body.source.collect();
  const reader = body.stream.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Received non-Uint8Array chunk');
      // A producer may reuse its backing store after the next pull.
      const chunk = Buffer.from(value); chunks.push(chunk); length += chunk.length;
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks, length));
}
function installBody(prototype) {
  Object.defineProperties(prototype, {
    body: { configurable: true, enumerable: true, get() { return state(this).body?.stream || null; } },
    bodyUsed: { configurable: true, enumerable: true, get() { return used(state(this).body); } },
    arrayBuffer: { configurable: true, writable: true, enumerable: true, async value() { return (await consume(this)).buffer; } },
    bytes: { configurable: true, writable: true, enumerable: true, async value() { return consume(this); } },
    text: { configurable: true, writable: true, enumerable: true, async value() { return utf8.decode(await consume(this)); } },
    json: { configurable: true, writable: true, enumerable: true, async value() { return JSON.parse(utf8.decode(await consume(this))); } },
    blob: { configurable: true, writable: true, enumerable: true, async value() {
      const mime = parseMIME(state(this).headers.get('content-type'));
      return new Blob([await consume(this)], { type: mime ? state(this).headers.get('content-type') : '' });
    } },
    formData: { configurable: true, writable: true, enumerable: true, async value() {
      const type = state(this).headers.get('content-type');
      return parseForm(await consume(this), type);
    } },
  });
}
// A fresh unread body from the same bytes or Blob, for a redirect that sends it again.
function replay(body) { return new BodyRecord(null, body.source, body.encoded, body.size, body.type, body.text); }
function streamBody(stream) { return new BodyRecord(stream, null, null, null, null); }
function incomingBody(pull, cancel) { return new BodyRecord(null, new IncomingBody(pull, cancel), null, null, null); }
// A body of bytes that nothing else holds, without a copy.
function bytesBody(bytes) { return new BodyRecord(null, null, bytes, bytes.length, null); }
function textBody(text) { return new BodyRecord(null, null, null, null, 'text/plain;charset=UTF-8', text); }
module.exports = { replay, streamBody, incomingBody, bytesBody, textBody, readStates, state, extract, clone, transfer, consume, used, unusable, installBody };
