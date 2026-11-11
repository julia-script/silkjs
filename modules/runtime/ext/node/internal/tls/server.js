'use strict';
const { SecureContext, createSecureContext, error } = require('internal/tls/context');
function setSecureContext(server, options = {}) {
  server._tlsOptions = { ...options, isServer: true, requestCert: !!options.requestCert, rejectUnauthorized: options.rejectUnauthorized !== false };
  server._sharedCreds = options.secureContext || createSecureContext(options);
  if (!(server._sharedCreds instanceof SecureContext)) throw error('ERR_INVALID_ARG_TYPE', 'secureContext must be a SecureContext', TypeError);
}
function addContext(server, servername, context) {
  if (typeof servername !== 'string' || !servername.length) throw error('ERR_INVALID_ARG_TYPE', 'servername must be a nonempty string', TypeError);
  const escaped = servername.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
  server._contexts.push({ pattern: new RegExp('^' + escaped + '$', 'i'), context: context instanceof SecureContext ? context : createSecureContext(context) });
}
function initialize(server, options, listener) {
  server._contexts = []; setSecureContext(server, options);
  if (listener) server.on('secureConnection', listener);
  server.on('connection', carrier => {
    let socket;
    try {
      const configuration = { ...server._tlsOptions, secureContext: server._sharedCreds };
      if (!configuration.SNICallback) configuration.SNICallback = (name, callback) => {
        for (let i = server._contexts.length - 1; i >= 0; i--) if (server._contexts[i].pattern.test(name)) { callback(null, server._contexts[i].context); return; }
        callback(null, null);
      };
      socket = new (require('tls').TLSSocket)(carrier, configuration);
    } catch (err) { carrier.destroy(); server.emit('tlsClientError', err, carrier); return; }
    // Like Node, only the accepted carrier counts as the server's connection (_server).
    socket.server = server;
    let secure = false, reported = false;
    socket.on('error', err => { if (!secure && !reported) { reported = true; server.emit('tlsClientError', err, socket); } });
    socket.once('close', () => {
      if (!secure && !reported) { reported = true; server.emit('tlsClientError', error('ECONNRESET', 'Socket closed before TLS handshake completed'), socket); }
    });
    socket.once('secure', () => {
      secure = true;
      if (server.pauseOnConnect && options.pauseOnConnect) socket.pause();
      server.emit('secureConnection', socket);
    });
  });
}
module.exports = { initialize, setSecureContext, addContext };
