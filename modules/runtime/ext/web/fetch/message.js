'use strict';

const { URL } = require('internal/web/url');
const { AbortController, AbortSignal } = require('internal/path_events/event_target');
const { Headers, immutable, scalar, byteString, token } = require('internal/web/fetch/headers');
const body = require('internal/web/fetch/body');
const requests = new WeakSet();
const responses = new WeakSet();
const nullBodyStatus = new Set([101, 204, 205, 304]);
const redirectStatus = new Set([301, 302, 303, 307, 308]);
const normalizedMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
function dictionary(value) {
  if (value == null) return {};
  if (typeof value !== 'object' && typeof value !== 'function') throw new TypeError('Options must be an object');
  return value;
}
function requestState(value) { if (!requests.has(value)) throw new TypeError('Illegal Request invocation'); return body.state(value); }
function responseState(value) { if (!responses.has(value)) throw new TypeError('Illegal Response invocation'); return body.state(value); }
function choice(value, allowed, name) {
  value = scalar(value);
  if (!allowed.includes(value)) throw new TypeError('Invalid ' + name + ': ' + value);
  return value;
}
function followSignal(signal) {
  const controller = new AbortController();
  if (signal != null) {
    if (!(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
function signalGetter() { return this.followed ??= followSignal(this.signalSource); }
function lazySignal(record) { Object.defineProperty(record, 'signal', { get: signalGetter, enumerable: true, configurable: true }); }
class Request {
  constructor(input, init = {}) {
    if (!arguments.length) throw new TypeError('Request requires an argument');
    init = dictionary(init);
    const original = requests.has(input) ? requestState(input) : null;
    let url;
    try { url = new URL(original ? original.url : scalar(input)); }
    catch (cause) { throw new TypeError('Failed to parse URL from ' + String(input), { cause }); }
    if (url.username || url.password) throw new TypeError('Request cannot be constructed from a URL that includes credentials');
    let method = init.method === undefined ? original?.method || 'GET' : byteString(init.method);
    if (!token.test(method)) throw new TypeError('Invalid HTTP method');
    const upper = method.toUpperCase();
    if (['CONNECT', 'TRACE', 'TRACK'].includes(upper)) throw new TypeError('Forbidden HTTP method: ' + method);
    if (normalizedMethods.has(upper)) method = upper;
    const dispatcher = init.dispatcher;
    const record = {
      url: url.href, method,
      dispatcher: dispatcher === undefined ? original?.dispatcher : dispatcher,
      headers: new Headers(init.headers === undefined ? original?.headers : init.headers),
      mode: init.mode === undefined ? original?.mode || 'cors' : choice(init.mode, ['cors', 'no-cors', 'same-origin', 'navigate'], 'mode'),
      credentials: init.credentials === undefined ? original?.credentials || 'same-origin' : choice(init.credentials, ['omit', 'same-origin', 'include'], 'credentials'),
      cache: init.cache === undefined ? original?.cache || 'default' : choice(init.cache, ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'], 'cache'),
      redirect: init.redirect === undefined ? original?.redirect || 'follow' : choice(init.redirect, ['follow', 'error', 'manual'], 'redirect'),
      referrer: original?.referrer ?? 'about:client',
      referrerPolicy: init.referrerPolicy === undefined ? original?.referrerPolicy || '' : choice(init.referrerPolicy, ['', 'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'], 'referrerPolicy'),
      integrity: init.integrity === undefined ? original?.integrity || '' : scalar(init.integrity),
      keepalive: init.keepalive === undefined ? original?.keepalive || false : Boolean(init.keepalive),
      // An AbortController per request costs more than the rest of the request: the
      // request's signal follows its source from the first time someone reads it.
      signalSource: init.signal === undefined ? original?.signal : init.signal,
      followed: null,
      body: null,
    };
    lazySignal(record);
    if (record.signalSource != null && !(record.signalSource instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    if (record.mode === 'navigate') throw new TypeError('Request constructor: invalid request mode navigate');
    if (record.mode === 'no-cors' && !['GET', 'HEAD', 'POST'].includes(method)) throw new TypeError('Method is unsupported in no-cors mode');
    if (record.cache === 'only-if-cached' && record.mode !== 'same-origin') throw new TypeError('only-if-cached requires same-origin mode');
    if (init.referrer !== undefined) {
      const referrer = scalar(init.referrer);
      if (referrer === '' || referrer === 'about:client') record.referrer = referrer;
      else {
        let parsed; try { parsed = new URL(referrer); } catch { throw new TypeError('Invalid referrer URL'); }
        parsed.username = ''; parsed.password = ''; parsed.hash = ''; record.referrer = parsed.href;
      }
    }
    if (init.duplex !== undefined) choice(init.duplex, ['half'], 'duplex');
    const suppliedBody = init.body !== undefined && init.body !== null;
    if ((suppliedBody || original?.body) && (method === 'GET' || method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body');
    if (suppliedBody) {
      record.body = body.extract(init.body, record.keepalive);
      if (record.body.streaming && init.duplex === undefined) throw new TypeError('RequestInit: duplex option is required when sending a body');
      if (record.body.streaming && !['same-origin', 'cors'].includes(record.mode)) throw new TypeError('Streaming request requires cors or same-origin mode');
    } else if (original?.body) {
      if (original.body.streaming && record.keepalive) throw new TypeError('keepalive cannot be used with a streaming body');
      if (original.body.streaming && !['same-origin', 'cors'].includes(record.mode)) throw new TypeError('Streaming request requires cors or same-origin mode');
      record.body = body.transfer(original.body);
    }
    if (record.body?.type && !record.headers.has('content-type')) record.headers.set('content-type', record.body.type);
    requests.add(this); body.states.set(this, record);
  }
  clone() {
    const record = requestState(this);
    const result = Object.create(Request.prototype);
    requests.add(result);
    const copy = { ...record, headers: new Headers(record.headers), body: body.clone(record.body) };
    copy.signalSource = record.signal; copy.followed = null; lazySignal(copy);
    body.states.set(result, copy);
    return result;
  }
  get method() { return requestState(this).method; }
  get url() { return requestState(this).url; }
  get headers() { return requestState(this).headers; }
  get destination() { requestState(this); return ''; }
  get referrer() { return requestState(this).referrer; }
  get referrerPolicy() { return requestState(this).referrerPolicy; }
  get mode() { return requestState(this).mode; }
  get credentials() { return requestState(this).credentials; }
  get cache() { return requestState(this).cache; }
  get redirect() { return requestState(this).redirect; }
  get integrity() { return requestState(this).integrity; }
  get keepalive() { return requestState(this).keepalive; }
  get isReloadNavigation() { requestState(this); return false; }
  get isHistoryNavigation() { requestState(this); return false; }
  get signal() { return requestState(this).signal; }
  get duplex() { requestState(this); return 'half'; }
}
class Response {
  constructor(value = null, init = {}) {
    init = dictionary(init);
    const number = init.status === undefined ? 200 : +init.status;
    const status = Number.isFinite(number) ? ((Math.trunc(number) % 65536) + 65536) % 65536 : 0;
    if (status < 200 || status > 599) throw new RangeError('Response status must be in the range 200 to 599');
    const statusText = init.statusText === undefined ? '' : byteString(init.statusText);
    if (/[^\t\x20-\x7e\x80-\xff]/.test(statusText)) throw new TypeError('Invalid statusText');
    const headers = new Headers(init.headers);
    const payload = body.extract(value);
    if (payload && nullBodyStatus.has(status)) throw new TypeError('Invalid response status code for a body: ' + status);
    if (payload?.type && !headers.has('content-type')) headers.set('content-type', payload.type);
    responses.add(this);
    body.states.set(this, { status, statusText, headers, body: payload, type: 'default', url: '', redirected: false, immutable: false });
  }
  clone() {
    const record = responseState(this), headers = new Headers(record.headers);
    if (record.immutable) immutable(headers);
    return makeResponse({ ...record, headers, body: body.clone(record.body) });
  }
  get type() { return responseState(this).type; }
  get url() { return responseState(this).url; }
  get redirected() { return responseState(this).redirected; }
  get status() { return responseState(this).status; }
  get ok() { const status = responseState(this).status; return status >= 200 && status <= 299; }
  get statusText() { return responseState(this).statusText; }
  get headers() { return responseState(this).headers; }
  static error() {
    return makeResponse({ status: 0, statusText: '', headers: immutable(new Headers()), body: null, type: 'error', url: '', redirected: false, immutable: true });
  }
  static redirect(url, status = 302) {
    if (!arguments.length) throw new TypeError('Response.redirect requires an argument');
    url = new URL(scalar(url));
    status = ((Math.trunc(+status) % 65536) + 65536) % 65536;
    if (!redirectStatus.has(status)) throw new RangeError('Invalid redirect status code');
    const response = new Response(null, { status, headers: { location: url.href } });
    const record = responseState(response); immutable(record.headers); record.immutable = true;
    return response;
  }
  static json(value, init = {}) {
    if (!arguments.length) throw new TypeError('Response.json requires an argument');
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('Value is not JSON serializable');
    init = dictionary(init);
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(text, { ...init, headers });
  }
}
function makeResponse(record) {
  const result = Object.create(Response.prototype);
  responses.add(result); body.states.set(result, record); return result;
}
body.installBody(Request.prototype); body.installBody(Response.prototype);
module.exports = { Request, Response, requestState, responseState, makeResponse, nullBodyStatus, redirectStatus };
