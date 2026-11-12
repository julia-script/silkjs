'use strict';

// The parts of Node.js v24 lib/internal/async_hooks.js that the ported modules use.
// Async ids come from the runtime's async_hooks.
const asyncHooks = require('async_hooks');
const { _newAsyncId, executionAsyncId } = asyncHooks;

// internalBinding('symbols'), with Node's descriptions (env_properties.h).
const symbols = {
  async_id_symbol: Symbol('async_id_symbol'),
  trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
  owner_symbol: Symbol('owner_symbol'),
  // Where a resource keeps its AsyncLocalStorage stores with --no-async-context-frame.
  async_local_storage_context_symbol: Symbol('kAsyncLocalStorageContext'),
};

function newAsyncId() { return _newAsyncId(); }

// The engine takes trigger ids from the resource that is current when a resource is
// created, so `block` runs as is.
function defaultTriggerAsyncIdScope(triggerAsyncId, block, ...args) {
  return Reflect.apply(block, null, args);
}

function getOrSetAsyncId(object) {
  if (Object.hasOwn(object, symbols.async_id_symbol)) return object[symbols.async_id_symbol];
  return object[symbols.async_id_symbol] = executionAsyncId();
}

// Whether any hook is enabled, with or without callbacks, as Node's enabledHooksExist.
function enabledHooksExist() { return asyncHooks._hooksActive(); }

module.exports = { symbols, newAsyncId, defaultTriggerAsyncIdScope, getOrSetAsyncId, executionAsyncId, enabledHooksExist };
