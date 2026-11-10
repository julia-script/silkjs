// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';
const { setImmediate } = require('timers');
const { HTTPParser, methods, allMethods, isExecuting } = require('internal/http/native-parser');
const { IncomingMessage, readStart, readStop } = require('_http_incoming');
const { token, checkInvalidHeaderChar, isLenient, calculateLenientFlags } = require('internal/http/parser');
const kIncomingMessage = Symbol('IncomingMessage');
const kSkipPendingData = Symbol('SkipPendingData');

class FreeList {
  constructor(name, max, ctor) { this.name = name; this.max = max; this.ctor = ctor; this.list = []; }
  alloc() { return this.list.length ? this.list.pop() : Reflect.apply(this.ctor, this, arguments); }
  free(value) { if (this.list.length >= this.max) return false; this.list.push(value); return true; }
}
function parserOnHeaders(headers, url) {
  const capacity = this.maxHeaderPairs - this._headers.length;
  if (this.maxHeaderPairs <= 0 || capacity >= headers.length) this._headers.push(...headers);
  else if (capacity > 0) this._headers.push(...headers.slice(0, capacity));
  this._url += url;
}
function parserOnHeadersComplete(major, minor, headers, method, url, statusCode, statusMessage, upgrade, keepAlive) {
  if (headers === undefined) { headers = this._headers; this._headers = []; }
  if (url === undefined) { url = this._url; this._url = ''; }
  const Message = this.socket?.server?.[kIncomingMessage] || IncomingMessage;
  const incoming = this.incoming = new Message(this.socket);
  incoming.httpVersionMajor = major;
  incoming.httpVersionMinor = minor;
  incoming.httpVersion = `${major}.${minor}`;
  incoming.joinDuplicateHeaders = this.socket?.server?.joinDuplicateHeaders || this.joinDuplicateHeaders;
  incoming.url = url;
  incoming.upgrade = upgrade;
  incoming._addHeaderLines(headers, this.maxHeaderPairs > 0 ? Math.min(headers.length, this.maxHeaderPairs) : headers.length);
  if (typeof method === 'number') incoming.method = allMethods[method];
  else { incoming.statusCode = statusCode; incoming.statusMessage = statusMessage; }
  return this.onIncoming(incoming, keepAlive);
}
function parserOnBody(chunk) {
  const incoming = this.incoming;
  if (incoming && !incoming[kSkipPendingData] && !incoming._dumped && !incoming.push(chunk)) readStop(this.socket);
}
function parserOnMessageComplete() {
  const incoming = this.incoming;
  if (incoming && !incoming[kSkipPendingData]) {
    incoming.complete = true;
    if (this._headers.length) {
      incoming._addHeaderLines(this._headers, this._headers.length);
      this._headers = [];
      this._url = '';
    }
    incoming.push(null);
  }
  readStart(this.socket);
}
function cleanParser(parser) {
  parser._headers = [];
  parser._url = '';
  parser.socket = parser.incoming = parser.outgoing = null;
  parser.maxHeaderPairs = 2000;
  parser[HTTPParser.kOnMessageBegin] = parser[HTTPParser.kOnExecute] = parser[HTTPParser.kOnTimeout] = null;
  parser[HTTPParser.kOnHeaders] = parserOnHeaders;
  parser[HTTPParser.kOnHeadersComplete] = parserOnHeadersComplete;
  parser[HTTPParser.kOnBody] = parserOnBody;
  parser[HTTPParser.kOnMessageComplete] = parserOnMessageComplete;
  parser._consumed = false;
  parser.onIncoming = parser.joinDuplicateHeaders = null;
}
const parsers = new FreeList('parsers', 1000, function parsersCb() {
  const parser = new HTTPParser();
  cleanParser(parser);
  return parser;
});
function freeParser(parser, req, socket) {
  if (parser) {
    if (isExecuting(parser)) {
      parser.pause();
      setImmediate(freeParser, parser);
    } else {
      if (parser._consumed) parser.unconsume();
      parser.remove();
      cleanParser(parser);
      if (!parsers.free(parser)) setImmediate(() => parser.close());
      else parser.free();
    }
  }
  if (req) req.parser = null;
  if (socket) socket.parser = null;
}
function prepareError(err, parser, rawPacket) {
  err.rawPacket = rawPacket || parser.getCurrentBuffer();
  if (typeof err.reason === 'string') err.message = `Parse Error: ${err.reason}`;
}
module.exports = {
  _checkInvalidHeaderChar: checkInvalidHeaderChar,
  _checkIsHttpToken: value => token.test(value),
  chunkExpression: /(?:^|\W)chunked(?:$|\W)/i,
  continueExpression: /(?:^|\W)100-continue(?:$|\W)/i,
  CRLF: '\r\n', freeParser, methods, parsers, kIncomingMessage, HTTPParser,
  isLenient, calculateLenientFlags, prepareError, kSkipPendingData,
};
