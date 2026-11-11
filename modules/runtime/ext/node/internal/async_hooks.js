'use strict';

// The parts of Node.js v24 lib/internal/async_hooks.js that the stream and net modules use.
// Async ids come from the runtime's async_hooks; a trigger id scope only runs its block, since
// the runtime takes trigger ids from the resource that is current when a request starts.

const { _newAsyncId } = require('async_hooks');

const symbols = {
  async_id_symbol: Symbol('asyncId'),
  trigger_async_id_symbol: Symbol('triggerAsyncId'),
  owner_symbol: Symbol('owner_symbol'),
};

function newAsyncId() { return _newAsyncId(); }

function defaultTriggerAsyncIdScope(triggerAsyncId, block, ...args) {
  return block(...args);
}

module.exports = { symbols, newAsyncId, defaultTriggerAsyncIdScope };
