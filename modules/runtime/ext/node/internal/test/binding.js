'use strict';

// Node.js lib/internal/test/binding.js, for --expose-internals tests.
// internalBinding returns the runtime's JS emulations of Node's bindings
// (internal/bindings); any other name throws as Node's internalBinding does
// for an unknown binding.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const primordials = require('internal/per_context/primordials');

process.emitWarning(
  'These APIs are for internal testing only. Do not use them.',
  'internal/test/binding');

const { internalBinding } = require('internal/bindings');

module.exports = { internalBinding, primordials };
