'use strict';

const { Buffer } = require('buffer');
const { ReadableStream } = require('internal/web/streams');
const { URL } = require('internal/url');
const { Headers, immutable, rawHeaders, parsedHeaders, headerList, copyHeaders } = require('internal/web/fetch/headers');
const { makeResponse, nullBodyStatus } = require('internal/web/fetch/message');
const { performance } = require('perf_hooks');
// node:zlib loads with the first encoded body, as in Node (it reads buffer.kMaxLength at load).
const constants = require('internal/compression/constants');
let zlib;
function lazyZlib() { return zlib ??= require('zlib'); }
const { Transform, PassThrough } = require('stream');
let client;
function lazyClient() { return client ??= require('internal/web/fetch/client'); }
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
// The decoders for a Content-Encoding fetch understands, outermost last; null when the
// coding is one it passes through as is.
function decoders(value) {
  const coding = value.toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  if (!coding.every(item => ['gzip', 'x-gzip', 'deflate', 'x-deflate', 'br', 'identity'].includes(item))) return null;
  const result = [];
  for (const item of coding.reverse()) {
    if (item === 'identity') continue;
    result.push(item === 'br' ? lazyZlib().createBrotliDecompress({ flush: constants.BROTLI_OPERATION_FLUSH, finishFlush: constants.BROTLI_OPERATION_FLUSH })
      : item === 'deflate' || item === 'x-deflate' ? new Inflate() : lazyZlib().createGunzip(inflateOptions));
  }
  return result.length ? result : null;
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
// The request's header list as fetch sends it. Names fetch adds are constants, so the
// list is edited directly rather than through Headers' validating setters.
function requestHeaders(record, url) {
  const headers = copyHeaders(record.headers);
  const list = headerList(headers);
  if (!list.has('accept')) list.set('accept', ['*/*']);
  if (!list.has('accept-language')) list.set('accept-language', ['*']);
  if (!list.has('user-agent')) list.set('user-agent', ['node']);
  if (!list.has('accept-encoding')) list.set('accept-encoding', [list.has('range') ? 'identity' : url.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate']);
  list.set('sec-fetch-mode', [record.mode]);
  const referer = referrer(record, url);
  if (referer) list.set('referer', [referer]); else list.delete('referer');
  const cache = record.cache;
  if ((cache === 'no-store' || cache === 'reload') && !list.has('cache-control')) list.set('cache-control', ['no-cache']);
  if ((cache === 'no-store' || cache === 'reload') && !list.has('pragma')) list.set('pragma', ['no-cache']);
  if (cache === 'no-cache' && !list.has('cache-control')) list.set('cache-control', ['max-age=0']);
  const length = list.has('content-length') ? list.get('content-length').join(', ') : null;
  if (record.body?.length !== null && record.body?.length !== undefined) {
    if (length !== null && length !== String(record.body.length)) throw networkError('Request body length does not match content-length');
    list.set('content-length', [String(record.body.length)]);
  } else if (!record.body && (record.method === 'POST' || record.method === 'PUT')) {
    if (length !== null && length !== '0') throw networkError('Request body length does not match content-length');
    list.set('content-length', ['0']);
  }
  if (list.has('transfer-encoding') || list.has('upgrade') || list.has('expect') || list.has('keep-alive')) throw networkError('Unsupported fetch request framing header');
  if (list.has('connection')) {
    const connection = list.get('connection').join(', ').toLowerCase();
    if (connection !== 'close' && connection !== 'keep-alive') throw networkError('Invalid connection header');
  }
  const sent = list.has('content-length') ? list.get('content-length').join(', ') : null;
  if (sent !== null && !/^\d+$/.test(sent)) throw networkError('Invalid content-length header');
  if (!record.body && sent !== null && sent !== '0') throw networkError('Request body length does not match content-length');
  return headers;
}
// signal: what can abort the request (message.abortSource), or null.
function dispatch(record, timing, dispatcher, url, signal) {
  if (badPorts.has(url.port)) return Promise.reject(networkError('bad port'));
  let headers;
  try { headers = requestHeaders(record, url); } catch (error) { return Promise.reject(error); }
  return dispatcher === undefined ? exchange(record, timing, url, headers, signal) : dispatchThrough(record, timing, dispatcher, url, headers, signal);
}
const noAbort = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} };
// Through an Undici dispatcher, which owns its connections (internal/web/fetch/dispatcher).
function dispatchThrough(record, timing, dispatcher, url, headers, signal = noAbort) {
  return new Promise((resolve, reject) => {
    let req, incoming, reader, controller, settled = false, streamDone = false, cancelled = false, uploadDone = false;
    let source, encoded = 0, decoded = 0;
    const codecs = [];
    signal ??= noAbort;
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
      const { DispatcherRequest } = require('internal/web/fetch/dispatcher');
      req = new DispatcherRequest(dispatcher, url, { method: record.method, headers: rawHeaders(headers) }, !!record.body);
    } catch (error) { fail(networkError(error)); return; }
    req.on('error', error => signal.aborted ? fail(signal.reason) : failNetwork(error));
    req.on('information', () => { if (timing.firstInterimNetworkResponseStartTime === undefined) timing.firstInterimNetworkResponseStartTime = performance.now(); });
    req.on('response-started', () => { timing.finalNetworkResponseStartTime = performance.now(); });
    req.method = record.method;
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
        for (const codec of decoders(responseHeaders.get('content-encoding') || '') || []) {
          codec.on('error', failNetwork);
          codecs.push(codec); source.pipe(codec); source = codec;
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
      // undici's fetch reads ahead into a 64 KiB Readable: a body that fits completes
      // (and reports its end) before anything reads it.
      }, { highWaterMark: 65536 });
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
// The field list a response parser gave, with lower-case names, as Headers keeps them.
function responseHeaders(fields) {
  const list = new Array(fields.length);
  for (let i = 0; i < fields.length; i += 2) {
    list[i] = fields[i].toLowerCase();
    let value = fields[i + 1];
    const last = value.length - 1;
    if (last >= 0 && (value.charCodeAt(0) <= 32 || value.charCodeAt(last) <= 32)) value = value.replace(/^[\t ]+|[\t ]+$/g, '');
    list[i + 1] = value;
  }
  return parsedHeaders(list, 0);
}
// Over fetch's own HTTP/1.1 client (internal/web/fetch/client), as Node's fetch goes over
// undici's Client when no dispatcher is set.
function exchange(record, timing, url, headers, source) {
  const { Exchange, ChannelRequest, channels, observed } = lazyClient();
  return new Promise((resolve, reject) => {
    const signal = source ?? noAbort;
    if (signal.aborted) { reject(signal.reason); return; }
    let transfer = null, controller = null, settled = false, streamDone = false, cancelled = false;
    let encoded = 0, decoded = 0, raw = null, reader = null, completed;
    const codecs = [];
    const completion = new Promise(done => { completed = done; });
    const method = record.method;
    let path = url.pathname + url.search;
    if (url.search === '' && url.href[url.href.length - url.hash.length - 1] === '?') path += '?';
    let authority = url.host;
    const fields = [];
    for (const [name, values] of headerList(headers)) {
      if (name === 'host') { authority = values[0]; continue; }
      if (name === 'set-cookie') for (const value of values) fields.push(name, value);
      else fields.push(name, values.length === 1 ? values[0] : values.join(name === 'cookie' ? '; ' : ', '));
    }
    const payload = record.body;
    const known = payload !== null && payload !== undefined && payload.current === null && payload.bytes !== null;
    const chunked = !!payload && !headers.has('content-length');
    let request = null;
    if (observed()) {
      request = new ChannelRequest(url.origin, method, path, fields, payload ? (known ? payload.bytes : payload.stream) : null);
      if (channels.create.hasSubscribers) channels.create.publish({ request });
    }
    const removeAbort = () => signal.removeEventListener('abort', onAbort);
    const stop = reason => {
      if (reader) reader.cancel(reason).catch(() => {});
      for (const codec of codecs) codec.destroy();
      transfer?.abort();
    };
    const fail = reason => {
      if (cancelled) return;
      cancelled = true;
      if (!settled) { settled = true; reject(reason); }
      if (controller && !streamDone) { streamDone = true; controller.error(reason); }
      completed(false);
      removeAbort(); stop(reason);
    };
    const failNetwork = cause => fail(settled ? new TypeError('terminated', { cause: cause instanceof Error ? cause : new Error(String(cause)) }) : networkError(cause));
    const onAbort = () => fail(signal.reason);
    if (source !== null) signal.addEventListener('abort', onAbort, { once: true });
    const finishBody = () => {
      if (streamDone || cancelled) return;
      streamDone = true;
      timing.endTime = performance.now(); timing.encodedBodySize = encoded; timing.decodedBodySize = decoded;
      if (controller) {
        const pending = controller.byobRequest;
        controller.close();
        if (pending) pending.respond(0);
      }
      removeAbort();
      completed(true);
    };
    const bodySent = () => {
      if (request !== null && channels.bodySent.hasSubscribers) channels.bodySent.publish({ request });
    };
    let head = method + ' ' + path + ' HTTP/1.1\r\nhost: ' + authority + '\r\nconnection: keep-alive\r\n';
    for (let i = 0; i < fields.length; i += 2) head += fields[i] + ': ' + fields[i + 1] + '\r\n';
    head += chunked ? 'transfer-encoding: chunked\r\n\r\n' : '\r\n';
    const upload = async socket => {
      payload.used = true;
      reader = payload.stream.getReader();
      let written = 0;
      const expected = chunked ? null : Number(headers.get('content-length'));
      try {
        for (;;) {
          const item = await reader.read();
          if (cancelled) return;
          if (item.done) break;
          if (!(item.value instanceof Uint8Array)) throw new TypeError('Request body must yield Uint8Array chunks');
          written += item.value.length;
          if (expected !== null && written > expected) throw new TypeError('Request body length does not match content-length');
          if (request !== null && channels.bodyChunkSent.hasSubscribers) channels.bodyChunkSent.publish({ request, chunk: item.value });
          if (!item.value.length) continue;
          if (chunked) socket.write(item.value.length.toString(16) + '\r\n');
          await new Promise((done, failWrite) => socket.write(item.value, error => error ? failWrite(error) : done()));
          if (chunked) socket.write('\r\n');
        }
        if (expected !== null && written !== expected) throw new TypeError('Request body length does not match content-length');
        if (chunked) socket.write('0\r\n\r\n');
        bodySent();
      } finally { reader.releaseLock(); reader = null; }
    };
    const send = socket => {
      if (known) {
        const bytes = payload.bytes;
        payload.used = true;
        if (request !== null && bytes.length && channels.bodyChunkSent.hasSubscribers) channels.bodyChunkSent.publish({ request, chunk: bytes });
        if (bytes.length) { socket.write(head); socket.write(bytes); } else socket.write(head);
        bodySent();
        return;
      }
      socket.write(head);
      if (!payload) { bodySent(); return; }
      upload(socket).catch(error => signal.aborted ? fail(signal.reason) : failNetwork(error));
    };
    const deliver = bytes => {
      decoded += bytes.length;
      controller.enqueue(bytes);
      return controller.desiredSize > 0;
    };
    const handler = {
      information() { if (timing.firstInterimNetworkResponseStartTime === undefined) timing.firstInterimNetworkResponseStartTime = performance.now(); },
      head(status, text, list) {
        if (cancelled) return;
        timing.finalNetworkResponseStartTime = performance.now();
        const responseFields = responseHeaders(list);
        const noBody = method === 'HEAD' || nullBodyStatus.has(status);
        let stream = null;
        if (!noBody) {
          const chain = decoders(responseFields.get('content-encoding') || '');
          let source = null;
          if (chain !== null) {
            raw = new PassThrough();
            raw.on('drain', () => transfer.resume());
            source = raw;
            for (const codec of chain) {
              codec.on('error', failNetwork);
              codecs.push(codec); source.pipe(codec); source = codec;
            }
            source.on('data', chunk => {
              if (cancelled || streamDone) return;
              // Byte stream controllers transfer the buffer: never the codec's pooled one.
              if (!deliver(new Uint8Array(chunk))) source.pause();
            });
            source.once('end', finishBody);
          }
          stream = new ReadableStream({
            type: 'bytes',
            start(value) { controller = value; },
            pull() { if (cancelled || streamDone) return; if (source !== null) source.resume(); else transfer.resume(); },
            cancel(reason) { cancelled = true; streamDone = true; completed(false); removeAbort(); stop(reason); },
          // undici's fetch reads ahead into a 64 KiB Readable: a body that fits completes
          // (and reports its end) before anything reads it.
          }, { highWaterMark: 65536 });
        }
        const fragment = record.url.indexOf('#');
        const result = makeResponse({ status, statusText: text, headers: immutable(responseFields), body: stream ? require('internal/web/fetch/body').streamBody(stream) : null, type: 'basic', url: fragment === -1 ? record.url : record.url.slice(0, fragment), redirected: false, immutable: true });
        settled = true;
        resolve({ response: result, completion, cancel: reason => { if (!streamDone) { cancelled = true; streamDone = true; completed(false); } removeAbort(); stop(reason); } });
      },
      body(bytes) {
        if (cancelled || streamDone || (controller === null && raw === null)) return;
        encoded += bytes.length;
        if (raw !== null) { if (!raw.write(bytes)) transfer.pause(); return; }
        if (!deliver(bytes)) transfer.pause();
      },
      complete() {
        if (cancelled) return;
        if (raw !== null) raw.end(); else finishBody();
      },
      fail: failNetwork,
    };
    timing.postRedirectStartTime = timing.finalNetworkRequestStartTime = performance.now();
    timing.finalConnectionTimingInfo = undefined;
    transfer = new Exchange(url, method === 'HEAD', !payload || known, request, send, handler, timing);
    try { transfer.start(); } catch (error) { failNetwork(error); }
  });
}
module.exports = { dispatch, networkError, performance };
