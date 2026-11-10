'use strict';
const http = require('http');
const tls = require('tls');
const { URL, urlToHttpOptions } = require('url');
const { Buffer } = require('buffer');
const { initialize, setSecureContext, addContext } = require('internal/tls/server');

class Server extends http.Server {
  constructor(options, requestListener) {
    if (typeof options === 'function') { requestListener = options; options = {}; }
    options = { ...options, ALPNProtocols: options?.ALPNProtocols || ['http/1.1'] };
    super({ ...options, pauseOnConnect: true }, requestListener);
    // HTTP's real parser is attached only after TLS authentication. The TCP
    // listener itself remains the inherited net.Server, including its accounting.
    this.removeAllListeners('connection');
    initialize(this, options);
    this.on('secureConnection', socket => this._connection(socket));
    this.on('tlsClientError', (err, socket) => { if (!this.emit('clientError', err, socket)) socket.destroy(); });
  }
  setSecureContext(options) { setSecureContext(this, options); }
  addContext(servername, context) { addContext(this, servername, context); }
}
class Agent extends http.Agent {
  constructor(options = {}) {
    super(options); this.defaultPort = 443; this.protocol = 'https:';
    this.maxCachedSessions = options.maxCachedSessions === undefined ? 100 : options.maxCachedSessions;
    this._sessions = new Map(); this._identities = new WeakMap(); this._sequence = 0;
  }
  _identity(value) {
    if (value === undefined) return '';
    if (typeof value === 'function' || value instanceof tls.SecureContext) {
      if (!this._identities.has(value)) this._identities.set(value, ++this._sequence);
      return '#' + this._identities.get(value);
    }
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    if (Array.isArray(value)) return value.map(item => this._identity(item));
    if (value && typeof value === 'object') return Object.keys(value).sort().map(key => [key, this._identity(value[key])]);
    return value;
  }
  getName(options = {}) {
    // Include trust policy and client identity, never pool across authorization boundaries.
    return super.getName(options) + ':' + JSON.stringify(['ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers', 'ecdhCurve', 'rejectUnauthorized', 'servername', 'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'sessionIdContext', 'ALPNProtocols', 'checkServerIdentity', 'secureContext'].map(key => this._identity(options[key])));
  }
  createConnection(options, callback) {
    options = { ...options };
    if (options.servername === undefined && !require('net').isIP(options.host || '')) options.servername = options.host;
    const key = this.getName(options);
    if (options.session === undefined && this._sessions.has(key)) options.session = this._sessions.get(key);
    const socket = tls.connect(options);
    socket.on('session', session => {
      if (this.maxCachedSessions <= 0) return;
      this._sessions.delete(key); this._sessions.set(key, session);
      while (this._sessions.size > this.maxCachedSessions) this._sessions.delete(this._sessions.keys().next().value);
    });
    socket.once('close', hadError => { if (hadError) this._sessions.delete(key); });
    return socket;
  }
}
const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });
function request(input, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const base = typeof input === 'string' || input instanceof URL ? urlToHttpOptions(typeof input === 'string' ? new URL(input) : input) : input || {};
  const configuration = { ...base, ...options };
  configuration.protocol ||= 'https:'; configuration.defaultPort ||= 443;
  configuration._defaultAgent = module.exports.globalAgent;
  if (configuration.agent === false) configuration.agent = new Agent({ keepAlive: false });
  if (configuration.agent === null && !configuration.createConnection) configuration.createConnection = opts => tls.connect(opts);
  return new http.ClientRequest(configuration, callback);
}
function get(...args) { const req = request(...args); req.end(); return req; }
function createServer(options, listener) { return new Server(options, listener); }
module.exports = { Agent, Server, createServer, request, get, globalAgent };
