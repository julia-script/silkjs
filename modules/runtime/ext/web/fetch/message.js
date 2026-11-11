'use strict';

const { Buffer } = require('buffer');
const { URL } = require('internal/web/url');
const { AbortController, AbortSignal } = require('internal/path_events/event_target');
const { Headers, immutable, parsedHeaders, scalar, byteString, token } = require('internal/web/fetch/headers');
const body = require('internal/web/fetch/body');
const { textBody } = body;
// Requests and Responses keep their records in a private field; the module reads them through
// these, set by each class's static block. `internal` makes an instance around a given record.
const internal = Symbol('internal');
let readRequest, readResponse;
const nullBodyStatus = new Set([101, 204, 205, 304]);
const redirectStatus = new Set([301, 302, 303, 307, 308]);
const normalizedMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
function dictionary(value) {
  if (value == null) return {};
  if (typeof value !== 'object' && typeof value !== 'function') throw new TypeError('Options must be an object');
  return value;
}
function requestState(value) { const record = readRequest(value); if (record === undefined) throw new TypeError('Illegal Request invocation'); return record; }
function responseState(value) { const record = readResponse(value); if (record === undefined) throw new TypeError('Illegal Response invocation'); return record; }
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
// A plain copy of a request record's fields; server request records keep some on their prototype.
function copyRequestRecord(record) {
  return {
    url: record.url, method: record.method, dispatcher: record.dispatcher, headers: record.headers,
    mode: record.mode, credentials: record.credentials, cache: record.cache, redirect: record.redirect,
    referrer: record.referrer, referrerPolicy: record.referrerPolicy, integrity: record.integrity, keepalive: record.keepalive,
    signalSource: record.signalSource, followed: record.followed, signal: record.signal, body: record.body,
  };
}
function signalGetter() { return this.followed ??= followSignal(this.signalSource); }
function lazySignal(record) { Object.defineProperty(record, 'signal', { get: signalGetter, enumerable: true, configurable: true }); }
class Request {
  #state;
  static { readRequest = value => typeof value === 'object' && value !== null && #state in value ? value.#state : undefined; }
  constructor(input, init = {}) {
    if (input === internal) { this.#state = init; return; }
    if (!arguments.length) throw new TypeError('Request requires an argument');
    init = dictionary(init);
    const original = readRequest(input) ?? null;
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
    this.#state = record;
  }
  clone() {
    const record = requestState(this);
    const copy = copyRequestRecord(record);
    copy.headers = new Headers(record.headers); copy.body = body.clone(record.body);
    copy.signalSource = record.signal; copy.followed = null;
    lazySignal(copy);
    return new Request(internal, copy);
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
// A Response made with no headers gets its Headers object only when something asks for it: until
// then `fields` is null and `contentType` holds the one field the body gave it.
class ResponseRecord {
  constructor(status, statusText, fields, payload, contentType = null) {
    this.status = status; this.statusText = statusText; this.fields = fields; this.body = payload; this.contentType = contentType;
  }
  get headers() {
    let headers = this.fields;
    if (headers === null) {
      headers = this.fields = new Headers();
      if (this.contentType !== null) headers.set('content-type', this.contentType);
    }
    return headers;
  }
  set headers(value) { this.fields = value; }
}
// What most responses share; a response that differs gets its own field.
Object.assign(ResponseRecord.prototype, { type: 'default', url: '', redirected: false, immutable: false });

class Response {
  #state;
  static { readResponse = value => typeof value === 'object' && value !== null && #state in value ? value.#state : undefined; }
  constructor(value = null, init = undefined) {
    if (value === internal) { this.#state = init; return; }
    let status = 200, statusText = '', headers = null;
    if (init !== undefined) {
      init = dictionary(init);
      if (init.status !== undefined) {
        const number = +init.status;
        status = Number.isFinite(number) ? ((Math.trunc(number) % 65536) + 65536) % 65536 : 0;
        if (status < 200 || status > 599) throw new RangeError('Response status must be in the range 200 to 599');
      }
      if (init.statusText !== undefined) {
        statusText = byteString(init.statusText);
        if (/[^\t\x20-\x7e\x80-\xff]/.test(statusText)) throw new TypeError('Invalid statusText');
      }
      if (init.headers !== undefined) headers = new Headers(init.headers);
    }
    const payload = typeof value === 'string' ? textBody(value) : body.extract(value);
    if (payload !== null && status !== 200 && nullBodyStatus.has(status)) throw new TypeError('Invalid response status code for a body: ' + status);
    const type = payload === null ? null : payload.type;
    if (type && headers !== null && !headers.has('content-type')) headers.set('content-type', type);
    this.#state = new ResponseRecord(status, statusText, headers, payload, headers === null && type ? type : null);
  }
  clone() {
    const record = responseState(this), headers = new Headers(record.headers);
    if (record.immutable) immutable(headers);
    const copy = new ResponseRecord(record.status, record.statusText, headers, body.clone(record.body));
    copy.type = record.type; copy.url = record.url; copy.redirected = record.redirected; copy.immutable = record.immutable;
    return makeResponse(copy);
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
function makeResponse(record) { return new Response(internal, record); }
// The record of a request that the native server parsed: `fields` is [method, target, host, name,
// value, ...]. Its URL and Headers are made when first read, and the fields every such request
// shares live on the prototype.
class ServerRequestRecord {
  constructor(fields, authority, payload) {
    this.fields = fields; this.authority = authority; this.href = null; this.parsed = null; this.followed = null; this.body = payload;
  }
  get method() { return this.fields[0]; }
  get url() {
    let href = this.href;
    if (href === null) {
      const target = this.fields[1];
      href = this.href = target.charCodeAt(0) === 47 ? 'http://' + (this.fields[2] || this.authority) + target : target;
    }
    return href;
  }
  set url(value) { this.href = value; }
  get headers() { return this.parsed ??= parsedHeaders(this.fields, 3); }
  set headers(value) { this.parsed = value; }
  get signal() { return this.followed ??= followSignal(undefined); }
}
Object.assign(ServerRequestRecord.prototype, {
  dispatcher: undefined, mode: 'cors', credentials: 'same-origin', cache: 'default', redirect: 'follow',
  referrer: 'about:client', referrerPolicy: '', integrity: '', keepalive: false, signalSource: undefined,
});
// A Request for the server: `fields` as above, `authority` the host for a request without one, and
// `bytes` the body or undefined.
function serverRequest(fields, authority, bytes) {
  const payload = bytes === undefined ? null : body.bytesBody(Buffer.from(bytes));
  return new Request(internal, new ServerRequestRecord(fields, authority, payload));
}
body.readStates(value => readRequest(value) ?? readResponse(value));
body.installBody(Request.prototype); body.installBody(Response.prototype);
module.exports = { Request, Response, copyRequestRecord, readResponse, requestState, responseState, makeResponse, serverRequest, nullBodyStatus, redirectStatus };
