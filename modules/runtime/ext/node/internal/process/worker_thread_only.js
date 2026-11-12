'use strict';

// Node.js lib/internal/process/worker_thread_only.js: process bootstrappers
// that can only be run in the worker thread.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const {
  codes: {
    ERR_WORKER_UNSUPPORTED_OPERATION,
  },
} = require('internal/errors');

function unavailable(name) {
  function unavailableInWorker() {
    throw new ERR_WORKER_UNSUPPORTED_OPERATION(name);
  }

  unavailableInWorker.disabled = true;
  return unavailableInWorker;
}

module.exports = {
  unavailable,
};
