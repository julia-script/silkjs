'use strict';

// internalBinding('async_wrap') for --expose-internals tests: the parts of Node's
// src/async_wrap.cc that the runtime's async_hooks implements. async_hook_fields holds
// only the hook counters (kInit to kTotals): the runtime keeps no async id stack there.
const asyncHooks = require('async_hooks');

module.exports = {
  Providers: asyncHooks.asyncWrapProviders,
  async_hook_fields: asyncHooks._hookFields,
  constants: { kInit: 0, kBefore: 1, kAfter: 2, kDestroy: 3, kPromiseResolve: 4, kTotals: 5 },
  getPromiseHooks: asyncHooks._getPromiseHooks,
  queueDestroyAsyncId(asyncId) { asyncHooks._queueDestroyId(asyncId); },
};
