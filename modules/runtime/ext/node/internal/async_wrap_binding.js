'use strict';

// internalBinding('async_wrap') for --expose-internals tests: the parts of Node's
// src/async_wrap.cc that the runtime's async_hooks implements.
const asyncHooks = require('async_hooks');

module.exports = {
  Providers: asyncHooks.asyncWrapProviders,
  queueDestroyAsyncId(asyncId) { asyncHooks._queueDestroyId(asyncId); },
};
