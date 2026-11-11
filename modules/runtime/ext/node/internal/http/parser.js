'use strict';

const { Buffer } = require('buffer');
const EMPTY_BUFFER = Buffer.alloc(0);
const { HTTPParser, allMethods, takeRemainder, remainingBytes, setUpgrade, needsEOF } = require('internal/http/native-parser');
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const invalidValue = /[^\t\x20-\x7e\x80-\xff]/;
const relaxedInvalidValue = /[\x00\x0a\x0d]|[^\x00-\xff]/;
const failures = new WeakSet();
const host = require('internal/host');
let warnedLenient = false;
function error(code, message) { return Object.assign(new Error(message), { code }); }
function hasToken(value, name) { return String(value || '').split(',').some(s => s.trim().toLowerCase() === name); }
function checkInvalidHeaderChar(value, relaxed = false) { return (relaxed ? relaxedInvalidValue : invalidValue).test(value); }
function isLenient() {
  const insecureDefault = !!host.insecureHTTPParser;
  if (insecureDefault && !warnedLenient) { warnedLenient = true; process.emitWarning('Using insecure HTTP parsing'); }
  return insecureDefault;
}
function calculateLenientFlags(validation, insecure) {
  if (validation === 'strict') return HTTPParser.kLenientNone;
  if (validation === 'relaxed') return HTTPParser.kLenientHeaderValueRelaxed;
  if (validation === 'insecure') return HTTPParser.kLenientAll;
  return (insecure === undefined ? isLenient() : insecure) ? HTTPParser.kLenientAll : HTTPParser.kLenientNone;
}
function setParserOptions(target, options) {
  const { httpValidation, insecureHTTPParser } = options;
  if (insecureHTTPParser !== undefined && typeof insecureHTTPParser !== 'boolean')
    throw Object.assign(new TypeError('options.insecureHTTPParser must be a boolean'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (httpValidation !== undefined && !['strict', 'relaxed', 'insecure'].includes(httpValidation))
    throw Object.assign(new TypeError('options.httpValidation must be strict, relaxed, or insecure'), { code: 'ERR_INVALID_ARG_VALUE' });
  if (httpValidation !== undefined && insecureHTTPParser !== undefined)
    throw Object.assign(new TypeError('options.httpValidation cannot be used together with options.insecureHTTPParser'), { code: 'ERR_INVALID_ARG_VALUE' });
  target.httpValidation = httpValidation;
  target.insecureHTTPParser = insecureHTTPParser;
}

class Parser {
  constructor(type, callbacks, options = {}) {
    this.type = type;
    this.callbacks = callbacks;
    this.state = 'headers';
    this.messageStarted = false;
    this._paused = this._stopped = this.running = this._ended = false;
    this._resumePending = false;
    this._queue = [];
    this._queuedBytes = 0;
    this._headers = [];
    this._url = '';
    this._upgrade = null;
    const parser = this._parser = require('_http_common').parsers.alloc();
    parser.initialize(type === 'request' ? HTTPParser.REQUEST : HTTPParser.RESPONSE, this,
      options.maxHeaderSize || 16384, calculateLenientFlags(options.httpValidation, options.insecureHTTPParser));
    parser.maxHeaderPairs = options.maxHeadersCount == null ? 2000 : options.maxHeadersCount * 2;
    parser[HTTPParser.kOnMessageBegin] = () => {
      this.state = 'headers';
      this.messageStarted = true;
      this._headers = [];
      this._url = '';
    };
    parser[HTTPParser.kOnHeaders] = (headers, url) => {
      const capacity = parser.maxHeaderPairs - this._headers.length;
      if (parser.maxHeaderPairs <= 0 || capacity >= headers.length) this._headers.push(...headers);
      else if (capacity > 0) this._headers.push(...headers.slice(0, capacity));
      this._url += url;
    };
    parser[HTTPParser.kOnHeadersComplete] = (major, minor, headers, method, url, statusCode, statusMessage, upgrade, keepAlive) => {
      let rawHeaders = headers === undefined ? this._headers : headers;
      if (parser.maxHeaderPairs > 0 && rawHeaders.length > parser.maxHeaderPairs) rawHeaders = rawHeaders.slice(0, parser.maxHeaderPairs);
      const info = { httpVersionMajor: major, httpVersionMinor: minor, httpVersion: `${major}.${minor}`, rawHeaders, upgrade, keepAlive };
      if (type === 'request') { info.method = allMethods[method]; info.url = url === undefined ? this._url : url; }
      else { info.statusCode = statusCode; info.statusMessage = statusMessage; }
      this._headers = [];
      this._url = '';
      this.state = 'body';
      const control = callbacks.headers(info) || {};
      if (control.upgrade || info.upgrade) {
        if (!upgrade) setUpgrade(parser, true);
        this._upgrade = info;
        return 2;
      }
      if (upgrade) setUpgrade(parser, false);
      if (control.skipBody) return 1;
      if (needsEOF(parser)) { this.state = 'eof'; callbacks.eofBody?.(); }
      return 0;
    };
    parser[HTTPParser.kOnBody] = chunk => { if (callbacks.body(chunk) === false) this.paused = true; };
    parser[HTTPParser.kOnMessageComplete] = () => {
      if (this._headers.length) callbacks.trailers(this._headers);
      this._headers = [];
      this.state = 'headers';
      this.messageStarted = false;
      // llhttp completes an upgrade message before returning its paused head.
      // Ownership passes through upgrade(), not the ordinary body completion.
      if (!this._upgrade) callbacks.complete();
    };
  }
  get paused() { return this._paused; }
  set paused(value) {
    this._paused = !!value;
    if (this._paused && this.running) this._parser.pause();
  }
  get stopped() { return this._stopped; }
  set stopped(value) {
    if (!value || this._stopped) return;
    this._stopped = true;
    this._queue.length = this._queuedBytes = 0;
    this._resumePending = false;
    if (this.running) this._parser.pause();
    else this._close();
  }
  _close() {
    const parser = this._parser;
    if (!parser) return;
    this._parser = null;
    require('_http_common').freeParser(parser);
  }
  get pendingBytes() { return this._queuedBytes + (this.running ? remainingBytes(this._parser) : 0); }
  fail(code, message) { const err = error(code, message); failures.add(err); throw err; }
  feed(data) {
    if (this._stopped) return;
    if (data?.length) { this._queue.push(data); this._queuedBytes += data.length; }
    this.run();
  }
  resume() {
    if (this._stopped || (this.callbacks.canResume && !this.callbacks.canResume())) return;
    this._paused = false;
    this._parser.resume();
    this.run();
  }
  _report(err, input) {
    this.stopped = true;
    if (input) err.rawPacket = input;
    if (typeof err.reason === 'string') err.message = `Parse Error: ${err.reason}`;
    this.callbacks.error(err);
  }
  run() {
    if (this.running || this._paused || this._stopped) return;
    this.running = true;
    try {
      while (!this._paused && !this._stopped && (this._queue.length || this._resumePending)) {
        const input = this._queue.shift() || EMPTY_BUFFER;
        this._queuedBytes -= input.length;
        this._resumePending = false;
        const result = this._parser.execute(input);
        const saved = takeRemainder(this._parser);
        if (this._stopped) break;
        const parsed = typeof result === 'number' ? result : result.bytesParsed;
        const remainder = saved || (parsed < input.length ? input.subarray(parsed) : EMPTY_BUFFER);
        if (this._upgrade) {
          const info = this._upgrade;
          this._upgrade = null;
          const head = this._queue.length ? Buffer.concat([remainder, ...this._queue]) : remainder;
          this.stopped = true;
          this.callbacks.upgrade(info, head);
          break;
        }
        if (typeof result !== 'number' && !(this._paused && result.code === 'HPE_PAUSED')) {
          this._report(result, input);
          break;
        }
        this._resumePending = typeof result !== 'number';
        if (remainder.length) { this._queue.unshift(remainder); this._queuedBytes += remainder.length; }
      }
      if (this._ended && !this._paused && !this._stopped && !this._queue.length) {
        const result = this._parser.finish();
        if (result && !(this._paused && result.code === 'HPE_PAUSED')) this._report(result);
        else this.stopped = true;
      }
    } catch (err) {
      if (!failures.has(err)) throw err;
      this._report(err);
    } finally {
      this.running = false;
      if (this._stopped) this._close();
    }
  }
  end() { this._ended = true; this.run(); }
}
module.exports = { Parser, token, invalidValue, error, hasToken, checkInvalidHeaderChar, isLenient, calculateLenientFlags, setParserOptions };
