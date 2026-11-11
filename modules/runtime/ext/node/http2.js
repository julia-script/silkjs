'use strict';
// Ported from Node.js v24 lib/http2.js. Copyright Joyent, Inc. and other Node
// contributors. MIT license (see THIRD_PARTY_NOTICES). Changes from Node are
// marked with "silkjs:" comments.

const {
  connect,
  constants,
  createServer,
  createSecureServer,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  performServerHandshake,
  sensitiveHeaders,
  Http2ServerRequest,
  Http2ServerResponse,
} = require('internal/http2/core');

module.exports = {
  connect,
  constants,
  createServer,
  createSecureServer,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  performServerHandshake,
  sensitiveHeaders,
  Http2ServerRequest,
  Http2ServerResponse,
};
