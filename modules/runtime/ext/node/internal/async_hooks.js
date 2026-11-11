'use strict';

// The parts of Node.js v24 lib/internal/async_hooks.js that the ported modules use.
// Async ids come from the runtime's async_hooks.
const { _newAsyncId, executionAsyncId } = require('async_hooks');

const symbols = {
  async_id_symbol: Symbol('asyncId'),
  trigger_async_id_symbol: Symbol('triggerAsyncId'),
  owner_symbol: Symbol('owner_symbol'),
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

module.exports = { symbols, newAsyncId, defaultTriggerAsyncIdScope, getOrSetAsyncId, executionAsyncId };
