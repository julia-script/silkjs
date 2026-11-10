'use strict';
const net = require('net');
const tls = require('tls');
const http = require('http');
const { URL } = require('url');
const { Http2Session, ServerHttp2Session } = require('internal/http2/session');
const { Http2ServerRequest, Http2ServerResponse, compatibility } = require('internal/http2/compat');
const { error, integer, packSettings, unpackSettings, sensitiveHeaders, validateOptions } = require('internal/http2/util');
function connect(authority, options, listener) {
  if (typeof options === 'function') { listener = options; options = {}; } options ||= {};
  validateOptions(options, true);
  if (options.maxOriginSetSize != null) {
    if (typeof options.maxOriginSetSize !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'options.maxOriginSetSize must be a number', TypeError);
    if (options.maxOriginSetSize < 0) throw error('ERR_OUT_OF_RANGE', 'options.maxOriginSetSize must be nonnegative', RangeError);
  }
  const url = authority instanceof URL ? authority : new URL(String(authority));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw error('ERR_HTTP2_UNSUPPORTED_PROTOCOL', 'Unsupported protocol: ' + url.protocol);
  const secure = url.protocol === 'https:', host = url.hostname.replace(/^\[|\]$/g, '');
  const settings = { ...options, host, port: +(url.port || (secure ? 443 : 80)), ALPNProtocols: ['h2'] };
  if (secure && settings.servername === undefined && !net.isIP(host)) settings.servername = host;
  const socket = options.createConnection ? options.createConnection(url, settings) : secure ? tls.connect(settings) : net.connect(settings);
  const session = new Http2Session(socket, false, options, url.host);
  if (listener) session.once('connect', listener);
  return session;
}
function accept(server, socket) {
  const session = new ServerHttp2Session(socket, true, server._http2Options);
  session.server = server; server._sessions.add(session);
  session.once('close', () => server._sessions.delete(session));
  session.on('error', err => server.emit('sessionError', err, session));
  session.on('stream', (stream, headers, flags, raw) => {
    stream.on('error', err => server.emit('streamError', err, stream));
    server.emit('stream', stream, headers, flags, raw);
    compatibility(server, stream, headers, flags, raw);
  });
  if (server.timeout) session.setTimeout(server.timeout, () => { if (!server.emit('timeout', session)) session.destroy(); });
  server.emit('session', session);
}
class Http2Server extends http.Server {
  constructor(options, listener) {
    if (typeof options === 'function') { listener = options; options = {}; } options ||= {};
    validateOptions(options);
    super(options); this.removeAllListeners('connection'); this._http2Options = { ...options }; this._sessions = new Set(); this.timeout = 0;
    if (listener) this.on('request', listener);
    this.on('connection', socket => accept(this, socket));
  }
  updateSettings(settings) { packSettings(settings); this._http2Options.settings = { ...this._http2Options.settings, ...settings }; }
  close(callback) { return net.Server.prototype.close.call(this, callback); }
  closeAllConnections() { for (const session of this._sessions) session.destroy(); super.closeAllConnections(); }
}
class Http2SecureServer extends Http2Server {
  constructor(options, listener) {
    if (typeof options === 'function') { listener = options; options = {}; } options ||= {};
    const unknownProtocolTimeout = options.unknownProtocolTimeout === undefined ? 10000 : integer(options.unknownProtocolTimeout, 'options.unknownProtocolTimeout', 0, 0xffffffff);
    options = { ...options, pauseOnConnect: true, ALPNProtocols: options.allowHTTP1 ? ['h2', 'http/1.1'] : ['h2'] };
    super(options, listener); this.removeAllListeners('connection');
    require('internal/tls/server').initialize(this, options);
    this.on('secureConnection', socket => {
      if (socket.alpnProtocol === 'h2') { accept(this, socket); return; }
      if (options.allowHTTP1 && (!socket.alpnProtocol || socket.alpnProtocol === 'http/1.1')) { this._connection(socket); return; }
      if (!this.emit('unknownProtocol', socket)) {
        const timer = setTimeout(() => socket.destroy(), unknownProtocolTimeout);
        timer.unref(); socket.once('close', () => clearTimeout(timer));
        socket.end('HTTP/1.0 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n\r\n' +
          'Missing ALPN Protocol, expected `h2` to be available.\n' +
          'If this is a HTTP request: The server was not ' +
          'configured with the `allowHTTP1` option or a ' +
          'listener for the `unknownProtocol` event.\n');
      }
    });
    this.on('tlsClientError', (err, socket) => { if (!this.emit('clientError', err, socket)) socket.destroy(); });
  }
  setSecureContext(options) { require('internal/tls/server').setSecureContext(this, options); }
  addContext(servername, context) { require('internal/tls/server').addContext(this, servername, context); }
}
function createServer(options, listener) { return new Http2Server(options, listener); }
function createSecureServer(options, listener) { return new Http2SecureServer(options, listener); }
function performServerHandshake(socket, options = {}) { return new ServerHttp2Session(socket, true, options); }
function getDefaultSettings() { return { headerTableSize: 4096, enablePush: true, initialWindowSize: 65535, maxFrameSize: 16384, maxConcurrentStreams: 4294967295, maxHeaderListSize: 65535, maxHeaderSize: 65535, enableConnectProtocol: false }; }
const constants = {
  PADDING_STRATEGY_NONE: 0, PADDING_STRATEGY_ALIGNED: 1, PADDING_STRATEGY_MAX: 2, PADDING_STRATEGY_CALLBACK: 1,
  NGHTTP2_SESSION_SERVER: 0, NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_STREAM_STATE_IDLE: 1, NGHTTP2_STREAM_STATE_OPEN: 2, NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3, NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4, NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5, NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6, NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_FLAG_NONE: 0, NGHTTP2_FLAG_END_STREAM: 1, NGHTTP2_FLAG_END_HEADERS: 4, NGHTTP2_FLAG_ACK: 1, NGHTTP2_FLAG_PADDED: 8, NGHTTP2_FLAG_PRIORITY: 32,
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1, NGHTTP2_SETTINGS_ENABLE_PUSH: 2, NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3, NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4, NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5, NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6, NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  NGHTTP2_DEFAULT_WEIGHT: 16, NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1, NGHTTP2_INTERNAL_ERROR: 2, NGHTTP2_FLOW_CONTROL_ERROR: 3, NGHTTP2_SETTINGS_TIMEOUT: 4, NGHTTP2_STREAM_CLOSED: 5, NGHTTP2_FRAME_SIZE_ERROR: 6, NGHTTP2_REFUSED_STREAM: 7, NGHTTP2_CANCEL: 8, NGHTTP2_COMPRESSION_ERROR: 9, NGHTTP2_CONNECT_ERROR: 10, NGHTTP2_ENHANCE_YOUR_CALM: 11, NGHTTP2_INADEQUATE_SECURITY: 12, NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_AUTHORITY: ':authority', HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_PROTOCOL: ':protocol',
  HTTP2_HEADER_ACCEPT: 'accept', HTTP2_HEADER_ACCEPT_CHARSET: 'accept-charset', HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding', HTTP2_HEADER_ACCEPT_LANGUAGE: 'accept-language', HTTP2_HEADER_ACCEPT_RANGES: 'accept-ranges', HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: 'access-control-allow-origin', HTTP2_HEADER_AUTHORIZATION: 'authorization', HTTP2_HEADER_CACHE_CONTROL: 'cache-control', HTTP2_HEADER_CONTENT_DISPOSITION: 'content-disposition', HTTP2_HEADER_CONTENT_ENCODING: 'content-encoding', HTTP2_HEADER_CONTENT_LANGUAGE: 'content-language', HTTP2_HEADER_CONTENT_LENGTH: 'content-length', HTTP2_HEADER_CONTENT_LOCATION: 'content-location', HTTP2_HEADER_CONTENT_RANGE: 'content-range', HTTP2_HEADER_CONTENT_TYPE: 'content-type', HTTP2_HEADER_COOKIE: 'cookie', HTTP2_HEADER_DATE: 'date', HTTP2_HEADER_ETAG: 'etag', HTTP2_HEADER_EXPECT: 'expect', HTTP2_HEADER_EXPIRES: 'expires', HTTP2_HEADER_HOST: 'host', HTTP2_HEADER_IF_MATCH: 'if-match', HTTP2_HEADER_IF_MODIFIED_SINCE: 'if-modified-since', HTTP2_HEADER_IF_NONE_MATCH: 'if-none-match', HTTP2_HEADER_IF_RANGE: 'if-range', HTTP2_HEADER_IF_UNMODIFIED_SINCE: 'if-unmodified-since', HTTP2_HEADER_LAST_MODIFIED: 'last-modified', HTTP2_HEADER_LINK: 'link', HTTP2_HEADER_LOCATION: 'location', HTTP2_HEADER_ORIGIN: 'origin', HTTP2_HEADER_RANGE: 'range', HTTP2_HEADER_REFERER: 'referer', HTTP2_HEADER_SERVER: 'server', HTTP2_HEADER_SET_COOKIE: 'set-cookie', HTTP2_HEADER_TE: 'te', HTTP2_HEADER_TRAILER: 'trailer', HTTP2_HEADER_USER_AGENT: 'user-agent', HTTP2_HEADER_VARY: 'vary', HTTP2_HEADER_WWW_AUTHENTICATE: 'www-authenticate',
  HTTP_STATUS_CONTINUE: 100, HTTP_STATUS_SWITCHING_PROTOCOLS: 101, HTTP_STATUS_PROCESSING: 102, HTTP_STATUS_EARLY_HINTS: 103, HTTP_STATUS_OK: 200, HTTP_STATUS_CREATED: 201, HTTP_STATUS_ACCEPTED: 202, HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203, HTTP_STATUS_NO_CONTENT: 204, HTTP_STATUS_RESET_CONTENT: 205, HTTP_STATUS_PARTIAL_CONTENT: 206, HTTP_STATUS_MULTI_STATUS: 207, HTTP_STATUS_ALREADY_REPORTED: 208, HTTP_STATUS_IM_USED: 226,
  HTTP_STATUS_MULTIPLE_CHOICES: 300, HTTP_STATUS_MOVED_PERMANENTLY: 301, HTTP_STATUS_FOUND: 302, HTTP_STATUS_SEE_OTHER: 303, HTTP_STATUS_NOT_MODIFIED: 304, HTTP_STATUS_USE_PROXY: 305, HTTP_STATUS_TEMPORARY_REDIRECT: 307, HTTP_STATUS_PERMANENT_REDIRECT: 308,
  HTTP_STATUS_BAD_REQUEST: 400, HTTP_STATUS_UNAUTHORIZED: 401, HTTP_STATUS_PAYMENT_REQUIRED: 402, HTTP_STATUS_FORBIDDEN: 403, HTTP_STATUS_NOT_FOUND: 404, HTTP_STATUS_METHOD_NOT_ALLOWED: 405, HTTP_STATUS_NOT_ACCEPTABLE: 406, HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407, HTTP_STATUS_REQUEST_TIMEOUT: 408, HTTP_STATUS_CONFLICT: 409, HTTP_STATUS_GONE: 410, HTTP_STATUS_LENGTH_REQUIRED: 411, HTTP_STATUS_PRECONDITION_FAILED: 412, HTTP_STATUS_PAYLOAD_TOO_LARGE: 413, HTTP_STATUS_URI_TOO_LONG: 414, HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415, HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416, HTTP_STATUS_EXPECTATION_FAILED: 417, HTTP_STATUS_TEAPOT: 418, HTTP_STATUS_MISDIRECTED_REQUEST: 421, HTTP_STATUS_UNPROCESSABLE_ENTITY: 422, HTTP_STATUS_LOCKED: 423, HTTP_STATUS_FAILED_DEPENDENCY: 424, HTTP_STATUS_TOO_EARLY: 425, HTTP_STATUS_UPGRADE_REQUIRED: 426, HTTP_STATUS_PRECONDITION_REQUIRED: 428, HTTP_STATUS_TOO_MANY_REQUESTS: 429, HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431, HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500, HTTP_STATUS_NOT_IMPLEMENTED: 501, HTTP_STATUS_BAD_GATEWAY: 502, HTTP_STATUS_SERVICE_UNAVAILABLE: 503, HTTP_STATUS_GATEWAY_TIMEOUT: 504, HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505, HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506, HTTP_STATUS_INSUFFICIENT_STORAGE: 507, HTTP_STATUS_LOOP_DETECTED: 508, HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509, HTTP_STATUS_NOT_EXTENDED: 510, HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
};
for (const method of http.METHODS) constants['HTTP2_METHOD_' + method.replace(/-/g, '_')] = method;
module.exports = { connect, createServer, createSecureServer, performServerHandshake, Http2ServerRequest, Http2ServerResponse, constants, sensitiveHeaders, getDefaultSettings, getPackedSettings: settings => packSettings(settings), getUnpackedSettings: unpackSettings };
