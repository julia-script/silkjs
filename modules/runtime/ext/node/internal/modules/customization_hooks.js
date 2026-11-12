'use strict';

// registerHooks of Node's lib/internal/modules/customization_hooks.js: the runtime's
// module loader keeps the synchronous resolve and load hook chains (module.registerHooks).
const { Module } = require('internal/host').loader;

function registerHooks(hooks) {
  return Module.registerHooks(hooks);
}

module.exports = { registerHooks };
