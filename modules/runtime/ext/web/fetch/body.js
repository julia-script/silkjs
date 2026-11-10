'use strict';

const { Buffer } = require('buffer');
const { Blob } = require('internal/web/blob');
const { URLSearchParams } = require('internal/web/url');
const { ReadableStream } = require('internal/web/streams');
const { TextDecoder } = require('internal/web/encoding');
const { FormData, encodeForm, parseForm, parseMIME } = require('internal/web/fetch/formdata');
const { scalar } = require('internal/web/fetch/headers');
const states = new WeakMap();
const disturbedSymbol = Symbol.for('nodejs.stream.disturbed');
function used(body) { return !!body && (body.used || !!body.stream[disturbedSymbol]); }
function unusable(body) { return !!body && (used(body) || body.stream.locked); }
function state(object) {
  const value = states.get(object);
  if (!value) throw new TypeError('Illegal body invocation');
  return value;
}
function extract(value, keepalive = false) {
  if (value == null) return null;
  let stream, source = null, type = null, length = null;
  if (value instanceof ReadableStream) stream = value;
  else if (value instanceof Blob) { source = value; type = value.type || null; }
  else if (value instanceof FormData) { source = encodeForm(value); type = source.type; }
  else if (value instanceof URLSearchParams) { source = new Blob([value.toString()]); type = 'application/x-www-form-urlencoded;charset=UTF-8'; }
  else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) source = new Blob([value]);
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
  } else { stream = source.stream(); length = source.size; }
  return { stream, source, length, type, used: false };
}
function clone(body) {
  if (!body) return null;
  if (unusable(body)) throw new TypeError('Body has already been consumed');
  const branches = body.stream.tee();
  body.stream = branches[0];
  return { ...body, stream: branches[1], used: false };
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
  return { ...body, stream, used: false };
}
async function consume(object) {
  const record = state(object), body = record.body;
  if (unusable(body)) throw new TypeError('Body is unusable: Body has already been read');
  if (!body) return new Uint8Array(0);
  body.used = true;
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
    text: { configurable: true, writable: true, enumerable: true, async value() { return new TextDecoder().decode(await consume(this)); } },
    json: { configurable: true, writable: true, enumerable: true, async value() { return JSON.parse(new TextDecoder().decode(await consume(this))); } },
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
module.exports = { states, state, extract, clone, transfer, consume, used, unusable, installBody };
