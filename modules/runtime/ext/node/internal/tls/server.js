'use strict';
// https and http2 secure servers are not tls.Server instances, but they accept
// TLS connections the way Node's tls.Server does.
const kTLSServer = Symbol('kTLSServer');
function tlsServer() { return require('tls').Server; }
function initialize(server, options, listener) {
  const { initServer, tlsConnectionListener } = tlsServer()[kTLSServer];
  initServer(server, options);
  if (listener) server.on('secureConnection', listener);
  server.on('connection', tlsConnectionListener);
}
function setSecureContext(server, options) { tlsServer().prototype.setSecureContext.call(server, options); }
function addContext(server, servername, context) { tlsServer().prototype.addContext.call(server, servername, context); }
module.exports = { kTLSServer, initialize, setSecureContext, addContext };
