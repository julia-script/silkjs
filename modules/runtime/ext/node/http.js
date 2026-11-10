'use strict';
const { Agent } = require('_http_agent');
const { ClientRequest, request, get } = require('_http_client');
const { Server, ServerResponse, createServer, STATUS_CODES } = require('_http_server');
const { IncomingMessage } = require('_http_incoming');
const { OutgoingMessage, validateHeaderName, validateHeaderValue } = require('_http_outgoing');
const { METHODS } = require('internal/http/constants');
module.exports = {
  Agent, ClientRequest, IncomingMessage, OutgoingMessage, Server, ServerResponse,
  METHODS, STATUS_CODES, createServer, request, get, validateHeaderName, validateHeaderValue,
  setMaxIdleHTTPParsers(max) {
    if (typeof max !== 'number') throw Object.assign(new TypeError('max must be a number'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (!Number.isSafeInteger(max) || max < 1) throw Object.assign(new RangeError('max must be an integer >= 1'), { code: 'ERR_OUT_OF_RANGE' });
    require('_http_common').parsers.max = max;
  },
  _connectionListener: function connectionListener(socket) { return Server.prototype._connection.call(this, socket); },
};
Object.defineProperty(module.exports, 'maxHeaderSize', { enumerable: true, get: () => 16384 });
Object.defineProperty(module.exports, 'globalAgent', {
  enumerable: true, configurable: true,
  get: () => require('_http_agent').globalAgent,
  set: agent => { require('_http_agent').globalAgent = agent; },
});
