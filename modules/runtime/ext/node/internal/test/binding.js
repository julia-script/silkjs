'use strict';

// Node.js lib/internal/test/binding.js, for --expose-internals tests.
// internalBinding returns the runtime's JS emulations of Node's bindings,
// only for the bindings that have one; any other name throws as Node's
// internalBinding does for an unknown binding.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const primordials = require('internal/per_context/primordials');

process.emitWarning(
  'These APIs are for internal testing only. Do not use them.',
  'internal/test/binding');

const kBindings = {
  __proto__: null,
  buffer: 'internal/buffer_binding',
  crypto: 'internal/crypto/binding',
  http2: 'internal/http2/binding',
  // node_http_parser.cc: HTTPParser, ConnectionsList, methods, allMethods.
  http_parser: 'internal/http/native-parser',
  timers: 'internal/timers_binding',
  util: 'internal/util/binding',
  uv: 'internal/uv_binding',
};

function internalBinding(module) {
  const id = kBindings[module];
  if (id === undefined) throw new Error(`No such binding: ${module}`);
  return require(id);
}

module.exports = { internalBinding, primordials };
