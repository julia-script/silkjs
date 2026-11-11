// Adapted from Node.js v24.22.1 lib/internal/inspector_network_tracking.js for Silk.
// Copyright Node.js contributors. MIT license; see the PROVENANCE.json licenseFile.
'use strict';

function enable() {
  require('internal/inspector/network_http').enable();
  require('internal/inspector/network_http2').enable();
  require('internal/inspector/network_undici').enable();
}

function disable() {
  require('internal/inspector/network_http').disable();
  require('internal/inspector/network_http2').disable();
  require('internal/inspector/network_undici').disable();
}

module.exports = {
  enable,
  disable,
};
