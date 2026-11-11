'use strict';

// The parts of Node.js lib/internal/async_hooks.js that the ported modules use.
const asyncHooks = require('async_hooks');
const { executionAsyncId } = asyncHooks;

const symbols = {
  async_id_symbol: Symbol('asyncId'),
  trigger_async_id_symbol: Symbol('triggerAsyncId'),
  owner_symbol: Symbol('owner_symbol'),
};

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

module.exports = { symbols, defaultTriggerAsyncIdScope, getOrSetAsyncId, executionAsyncId, enabledHooksExist };
