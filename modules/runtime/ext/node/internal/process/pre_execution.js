'use strict';

// The parts of Node.js v24.22.1 lib/internal/process/pre_execution.js that the test
// runner uses. The runtime's bootstrap prepares execution itself before it runs the
// main entry (options, realm setup, loaders), so for the test runner what is left is
// Node's shouldPreloadModules step: the -r modules, which isolation none loads later.

const { getOptionValue } = require('internal/options');

// The bootstrap has prepared the main thread already when a main entry such as
// internal/main/watch_mode runs.
function prepareMainThreadExecution() {}

function prepareTestRunnerMainExecution(loadUserModules = true) {
  if (loadUserModules) loadPreloadModules();
}

function loadPreloadModules() {
  // For user code, we preload modules if `-r` is passed
  const preloadModules = getOptionValue('--require');
  if (preloadModules && preloadModules.length > 0) {
    const {
      Module: {
        _preloadModules,
      },
    } = require('internal/modules/cjs/loader');
    _preloadModules(preloadModules);
  }
}

function markBootstrapComplete() {
  require('internal/host').markBootstrapComplete();
}

module.exports = {
  loadPreloadModules,
  markBootstrapComplete,
  prepareMainThreadExecution,
  prepareTestRunnerMainExecution,
};
