'use strict';

const { Buffer } = require('buffer');
const { URL } = require('internal/url');
const { Blob, resolveObjectURL } = require('internal/web/blob');
const { TextEncoder } = require('internal/encoding');
const { Headers, immutable } = require('internal/web/fetch/headers');
const { FormData } = require('internal/web/fetch/formdata');
const { Request, Response, copyRequestRecord, requestState, responseState, redirectStatus } = require('internal/web/fetch/message');
const body = require('internal/web/fetch/body');
const { dispatch, networkError, performance } = require('internal/web/fetch/transport');

function dataResponse(url) {
  const text = url.href.slice(5).split('#')[0];
  const comma = text.indexOf(',');
  if (comma < 0) throw networkError('Invalid data URL');
  let type = text.slice(0, comma).trim();
  const encoded = new TextEncoder().encode(text.slice(comma + 1));
  const bytes = new Uint8Array(encoded.length);
  let count = 0;
  const hex = code => code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === 37 && i + 2 < encoded.length && hex(encoded[i + 1]) >= 0 && hex(encoded[i + 2]) >= 0) {
      bytes[count++] = hex(encoded[++i]) * 16 + hex(encoded[++i]);
    } else bytes[count++] = encoded[i];
  }
  let payload = bytes.subarray(0, count);
  if (/; *base64$/i.test(type)) {
    let encodedBody = Buffer.from(payload).toString('latin1').replace(/[\t\n\f\r ]/g, '');
    if (encodedBody.length % 4 === 0) encodedBody = encodedBody.replace(/={1,2}$/, '');
    if (encodedBody.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(encodedBody)) throw networkError('Invalid base64 data URL');
    payload = Buffer.from(encodedBody, 'base64'); type = type.replace(/; *base64$/i, '');
  }
  if (type.startsWith(';')) type = 'text/plain' + type;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;|$)/.test(type)) type = 'text/plain;charset=US-ASCII';
  return new Response(payload, { headers: { 'content-type': type } });
}
function blobResponse(record, url) {
  if (record.method !== 'GET') throw networkError('Blob URLs only support GET');
  const clean = new URL(url.href); clean.hash = '';
  let value = resolveObjectURL(clean.href);
  if (!(value instanceof Blob)) throw networkError('Blob URL was not found');
  const headers = new Headers({ 'content-type': value.type, 'content-length': String(value.size) });
  let status = 200, statusText = 'OK';
  const range = record.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || !match[1] && !match[2] || value.size === 0) throw networkError('Invalid blob byte range');
    const first = match[1] ? Number(match[1]) : Math.max(0, value.size - Number(match[2]));
    const last = match[1] ? match[2] ? Math.min(Number(match[2]), value.size - 1) : value.size - 1 : value.size - 1;
    if (first > last || first >= value.size) throw networkError('Unsatisfiable blob byte range');
    headers.set('content-range', 'bytes ' + first + '-' + last + '/' + value.size);
    value = value.slice(first, last + 1, value.type);
    headers.set('content-length', String(value.size)); status = 206; statusText = 'Partial Content';
  }
  return new Response(value, { status, statusText, headers });
}
async function integrityResponse(response, integrity) {
  if (!integrity) return response;
  const supported = [];
  for (const part of integrity.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?.*)?$/.exec(part);
    if (match) supported.push({ algorithm: match[1], digest: match[2].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') });
  }
  if (!supported.length) return response;
  const algorithm = supported.some(item => item.algorithm === 'sha512') ? 'sha512' : supported.some(item => item.algorithm === 'sha384') ? 'sha384' : 'sha256';
  const bytes = await body.consume(response);
  const actual = require('crypto').createHash(algorithm).update(bytes).digest('base64').replace(/=+$/, '');
  if (!supported.some(item => item.algorithm === algorithm && item.digest === actual)) throw networkError('integrity mismatch');
  if (responseState(response).body) responseState(response).body = body.extract(bytes);
  return response;
}
function fetch(input, init = undefined) {
  if (!arguments.length) return Promise.reject(new TypeError('fetch requires an argument'));
  let request;
  try { request = new Request(input, init); }
  catch (error) { return Promise.reject(error); }
  const original = requestState(request);
  if (original.signal.aborted) return Promise.reject(original.signal.reason);
  if (original.dispatcher !== undefined) require('assert').ok(original.dispatcher);
  return performFetch(original);
}
async function performFetch(original) {
  const dispatcher = original.dispatcher;
  const record = copyRequestRecord(original);
  record.headers = new Headers(original.headers);
  const timing = { startTime: performance.now() };
  let redirects = 0;
  for (;;) {
    if (record.signal.aborted) throw record.signal.reason;
    const url = new URL(record.url);
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      const response = url.protocol === 'data:' ? dataResponse(url) : blobResponse(record, url);
      const state = responseState(response); url.hash = ''; state.url = url.href; state.type = 'basic'; state.immutable = true; immutable(state.headers);
      return integrityResponse(response, record.integrity);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw networkError('Unsupported URL scheme: ' + url.protocol);
    const transaction = await dispatch(record, timing, dispatcher);
    const response = transaction.response;
    if (redirectStatus.has(response.status) && record.redirect === 'error') {
      transaction.cancel();
      throw networkError('Unexpected redirect');
    }
    const location = response.headers.get('location');
    if (!redirectStatus.has(response.status) || location === null || record.redirect === 'manual') {
      responseState(response).redirected = redirects > 0;
      transaction.completion.then(complete => {
        if (!complete) return;
        performance.markResourceTiming({ ...timing }, original.url, 'fetch', globalThis, '', {
          contentType: response.headers.get('content-type') || '', contentEncoding: response.headers.get('content-encoding') || '',
        }, response.status);
      });
      try { return await integrityResponse(response, record.integrity); }
      catch (error) { transaction.cancel(error); throw error; }
    }
    transaction.cancel();
    if (redirects >= 20) throw networkError('redirect count exceeded');
    let target;
    try { target = new URL(location, url); } catch (cause) { throw networkError(cause); }
    if (!['http:', 'https:'].includes(target.protocol)) throw networkError('URL scheme must be HTTP(S) for redirects');
    if (target.username || target.password) throw networkError('Redirect URL contains credentials');
    if (!location.includes('#')) target.hash = url.hash;
    const rewrite = ((response.status === 301 || response.status === 302) && record.method === 'POST') || (response.status === 303 && record.method !== 'GET' && record.method !== 'HEAD');
    if (rewrite) {
      record.method = 'GET'; record.body = null;
      for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) record.headers.delete(name);
    } else if (record.body) {
      if (record.body.streaming) throw networkError('Cannot replay a streaming request body across a redirect');
      record.body = body.replay(record.body);
    }
    if (target.origin !== url.origin) {
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host']) record.headers.delete(name);
    }
    const policies = (response.headers.get('referrer-policy') || '').split(',').map(value => value.trim());
    for (const policy of policies) if (['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'].includes(policy)) record.referrerPolicy = policy;
    if (!redirects) timing.redirectStartTime = timing.startTime;
    timing.redirectEndTime = performance.now();
    timing.firstInterimNetworkResponseStartTime = undefined;
    record.url = target.href; redirects++;
  }
}
for (const Constructor of [Headers, FormData, Request, Response]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { configurable: true, value: Constructor.name });
  for (const name of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (name !== 'constructor') Object.defineProperty(Constructor.prototype, name, { enumerable: true });
  }
}
module.exports = { fetch, Headers, Request, Response, FormData };
