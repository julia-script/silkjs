'use strict';

const { Buffer } = require('buffer');
const { ReadableStream } = require('internal/web/streams');
const { URL } = require('internal/url');
const { Headers, immutable, rawHeaders } = require('internal/web/fetch/headers');
const { makeResponse, nullBodyStatus } = require('internal/web/fetch/message');
const { performance } = require('perf_hooks');
// node:zlib loads with the first encoded body, as in Node (it reads buffer.kMaxLength at load).
const constants = require('internal/compression/constants');
let zlib;
function lazyZlib() { return zlib ??= require('zlib'); }
const { Transform } = require('stream');
const badPorts = new Set('1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080'.split(' '));
function networkError(cause) { return new TypeError('fetch failed', { cause: cause instanceof Error ? cause : new Error(String(cause)) }); }
const inflateOptions = { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH };
class Inflate extends Transform {
  constructor() { super(); this.decoder = null; this.failure = null; }
  _read(size) { if (this.decoder) this.decoder.resume(); Transform.prototype._read.call(this, size); }
  _transform(chunk, encoding, callback) {
    if (!chunk.length) { callback(); return; }
    if (!this.decoder) {
      this.decoder = (chunk[0] & 15) === 8 ? lazyZlib().createInflate(inflateOptions) : lazyZlib().createInflateRaw(inflateOptions);
      this.decoder.on('data', data => { if (!this.push(data)) this.decoder.pause(); });
      this.decoder.on('error', error => { this.failure = error; this.destroy(error); });
    }
    this.decoder.write(chunk, callback);
  }
  _flush(callback) {
    if (!this.decoder) { callback(); return; }
    let settled = false;
    const done = error => { if (!settled) { settled = true; callback(error); } };
    this.decoder.once('error', done); this.decoder.once('end', () => done()); this.decoder.end();
  }
  _destroy(error, callback) { if (this.decoder) this.decoder.destroy(); callback(error); }
}
function referrer(record, url) {
  if (!record.referrer || record.referrer === 'about:client') return null;
  const source = new URL(record.referrer);
  if (!['http:', 'https:'].includes(source.protocol)) return null;
  source.username = ''; source.password = ''; source.hash = '';
  const same = source.origin === url.origin;
  const downgrade = source.protocol === 'https:' && url.protocol !== 'https:';
  const origin = source.origin + '/';
  let full = source.href;
  if (full.length > 4096) full = origin;
  switch (record.referrerPolicy || 'strict-origin-when-cross-origin') {
    case 'no-referrer': return null;
    case 'same-origin': return same ? full : null;
    case 'origin': return origin;
    case 'strict-origin': return downgrade ? null : origin;
    case 'origin-when-cross-origin': return same ? full : origin;
    case 'unsafe-url': return full;
    case 'no-referrer-when-downgrade': return downgrade ? null : full;
    default: return same ? full : downgrade ? null : origin;
  }
}
function requestHeaders(record, url) {
  const headers = new Headers(record.headers);
  if (!headers.has('accept')) headers.set('accept', '*/*');
  if (!headers.has('accept-language')) headers.set('accept-language', '*');
  if (!headers.has('user-agent')) headers.set('user-agent', 'node');
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', headers.has('range') ? 'identity' : url.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate');
  headers.set('sec-fetch-mode', record.mode);
  const referer = referrer(record, url);
  if (referer) headers.set('referer', referer); else headers.delete('referer');
  if ((record.cache === 'no-store' || record.cache === 'reload') && !headers.has('cache-control')) headers.set('cache-control', 'no-cache');
  if ((record.cache === 'no-store' || record.cache === 'reload') && !headers.has('pragma')) headers.set('pragma', 'no-cache');
  if (record.cache === 'no-cache' && !headers.has('cache-control')) headers.set('cache-control', 'max-age=0');
  if (record.body?.length !== null && record.body?.length !== undefined) {
    if (headers.has('content-length') && headers.get('content-length') !== String(record.body.length)) throw networkError('Request body length does not match content-length');
    headers.set('content-length', String(record.body.length));
  } else if (!record.body && ['POST', 'PUT'].includes(record.method)) {
    if (headers.has('content-length') && headers.get('content-length') !== '0') throw networkError('Request body length does not match content-length');
    headers.set('content-length', '0');
  }
  if (headers.has('transfer-encoding') || headers.has('upgrade') || headers.has('expect') || headers.has('keep-alive')) throw networkError('Unsupported fetch request framing header');
  if (headers.has('connection') && !['close', 'keep-alive'].includes(headers.get('connection').toLowerCase())) throw networkError('Invalid connection header');
  if (headers.has('content-length') && !/^\d+$/.test(headers.get('content-length'))) throw networkError('Invalid content-length header');
  if (!record.body && headers.has('content-length') && headers.get('content-length') !== '0') throw networkError('Request body length does not match content-length');
  return headers;
}
function dispatch(record, timing, dispatcher) {
  return new Promise((resolve, reject) => {
    const url = new URL(record.url);
    if (badPorts.has(url.port)) { reject(networkError('bad port')); return; }
    let headers;
    try { headers = requestHeaders(record, url); } catch (error) { reject(error); return; }
    let req, incoming, reader, controller, settled = false, streamDone = false, cancelled = false, uploadDone = false;
    let source, encoded = 0, decoded = 0;
    const codecs = [];
    const signal = record.signal;
    const removeAbort = () => signal.removeEventListener('abort', onAbort);
    const stop = reason => {
      if (reader) reader.cancel(reason).catch(() => {});
      for (const codec of codecs) codec.destroy();
      if (req) req.destroy(reason);
      if (incoming) incoming.destroy();
    };
    const finish = () => {
      if (!uploadDone || !streamDone) return;
      removeAbort();
    };
    const fail = reason => {
      if (cancelled) return;
      cancelled = true;
      if (!settled) { settled = true; reject(reason); }
      if (controller && !streamDone) { streamDone = true; controller.error(reason); }
      removeAbort(); stop(reason);
    };
    const failNetwork = cause => fail(settled ? new TypeError('terminated', { cause: cause instanceof Error ? cause : new Error(String(cause)) }) : networkError(cause));
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    timing.postRedirectStartTime = performance.now();
    timing.finalNetworkRequestStartTime = performance.now();
    timing.finalConnectionTimingInfo = undefined;
    try {
      const options = { method: record.method, headers: rawHeaders(headers) };
      if (dispatcher !== undefined) {
        const { DispatcherRequest } = require('internal/web/fetch/dispatcher');
        req = new DispatcherRequest(dispatcher, url, options, !!record.body);
      } else {
        const transport = require(url.protocol === 'https:' ? 'https' : 'http');
        req = transport.request(url.href, options);
      }
    } catch (error) { fail(networkError(error)); return; }
    req.on('error', error => signal.aborted ? fail(signal.reason) : failNetwork(error));
    req.on('upgrade', (response, socket) => { socket.destroy(); fail(networkError('Unexpected protocol upgrade')); });
    req.on('socket', socket => {
      if (!socket.connecting) return;
      const connection = { connectionStartTime: performance.now() };
      timing.finalConnectionTimingInfo = connection;
      socket.once('lookup', () => { connection.domainLookupEndTime = performance.now(); });
      socket.once('connect', () => {
        connection.connectionEndTime = performance.now();
        if (url.protocol === 'https:') connection.secureConnectionStartTime = performance.now();
        else connection.ALPNNegotiatedProtocol = 'http/1.1';
      });
      socket.once('secureConnect', () => { connection.connectionEndTime = performance.now(); connection.ALPNNegotiatedProtocol = socket.alpnProtocol || 'http/1.1'; });
    });
    req.on('information', () => { if (timing.firstInterimNetworkResponseStartTime === undefined) timing.firstInterimNetworkResponseStartTime = performance.now(); });
    req.on('response-started', () => { timing.finalNetworkResponseStartTime = performance.now(); });
    req.method = record.method;
    if (dispatcher === undefined && record.body && !headers.has('content-length')) req.setHeader('Transfer-Encoding', 'chunked');
    req.once('response', response => {
      if (cancelled) { response.destroy(); return; }
      incoming = response;
      timing.finalNetworkResponseStartTime = performance.now();
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      const noBody = record.method === 'HEAD' || nullBodyStatus.has(response.statusCode);
      source = response;
      response.on('error', failNetwork);
      response.on('aborted', () => failNetwork('Response terminated'));
      response.on('data', chunk => { encoded += chunk.length; });
      // Keep the HTTP parser paused until the web reader requests bytes.
      response.pause();
      if (!noBody) {
        const coding = (responseHeaders.get('content-encoding') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (coding.every(value => ['gzip', 'x-gzip', 'deflate', 'x-deflate', 'br', 'identity'].includes(value))) {
          for (const value of coding.reverse()) {
            if (value === 'identity') continue;
            const codec = value === 'br' ? lazyZlib().createBrotliDecompress({ flush: constants.BROTLI_OPERATION_FLUSH, finishFlush: constants.BROTLI_OPERATION_FLUSH }) : value === 'deflate' || value === 'x-deflate' ? new Inflate() : lazyZlib().createGunzip(inflateOptions);
            codec.on('error', failNetwork);
            codecs.push(codec); source.pipe(codec); source = codec;
          }
        }
      }
      const complete = () => {
        if (streamDone || cancelled) return;
        streamDone = true;
        timing.endTime = performance.now(); timing.encodedBodySize = encoded; timing.decodedBodySize = decoded;
        if (controller) {
          const pending = controller.byobRequest;
          controller.close();
          if (pending) pending.respond(0);
        }
        finish();
      };
      let stream = null;
      if (noBody) { source.once('end', complete); source.resume(); }
      else stream = new ReadableStream({
        type: 'bytes',
        start(value) {
          controller = value;
          source.on('data', chunk => {
            if (cancelled || streamDone) return;
            decoded += chunk.length;
            // Byte stream controllers transfer the buffer. Never detach the
            // pooled Buffer backing store owned by the HTTP parser/codec.
            controller.enqueue(new Uint8Array(chunk));
            if (controller.desiredSize <= 0) source.pause();
          });
          source.once('end', complete);
          source.pause();
        },
        pull() { if (!cancelled && !streamDone) source.resume(); },
        cancel(reason) { cancelled = true; streamDone = true; removeAbort(); stop(reason); },
      });
      const responseURL = new URL(record.url); responseURL.hash = '';
      const result = makeResponse({ status: response.statusCode, statusText: response.statusMessage, headers: immutable(responseHeaders), body: stream ? require('internal/web/fetch/body').streamBody(stream) : null, type: 'basic', url: responseURL.href, redirected: false, immutable: true });
      const completion = new Promise(done => {
        source.once('end', () => done(true));
        source.once('error', () => done(false));
        source.once('close', () => done(streamDone && !cancelled));
      });
      settled = true;
      resolve({ response: result, completion, cancel: reason => { cancelled = true; streamDone = true; removeAbort(); stop(reason); } });
    });
    const upload = async () => {
      if (cancelled) return;
      const payload = record.body;
      if (!payload) { req.end(); uploadDone = true; finish(); return; }
      payload.used = true;
      reader = payload.stream.getReader();
      let written = 0;
      const expected = headers.has('content-length') ? Number(headers.get('content-length')) : null;
      try {
        for (;;) {
          const item = await reader.read();
          if (cancelled) return;
          if (item.done) break;
          if (!(item.value instanceof Uint8Array)) throw new TypeError('Request body must yield Uint8Array chunks');
          written += item.value.length;
          if (expected !== null && written > expected) throw new TypeError('Request body length does not match content-length');
          await new Promise((done, failWrite) => req.write(item.value, error => error ? failWrite(error) : done()));
        }
        if (expected !== null && written !== expected) throw new TypeError('Request body length does not match content-length');
        req.end(); uploadDone = true; finish();
      } finally { reader.releaseLock(); reader = null; }
    };
    req.flushHeaders();
    upload().catch(error => signal.aborted ? fail(signal.reason) : failNetwork(error));
  });
}
module.exports = { dispatch, networkError, performance };
