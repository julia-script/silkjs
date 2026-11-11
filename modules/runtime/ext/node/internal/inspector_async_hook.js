'use strict';

// Node's lib/internal/inspector_async_hook.js over internal/inspector_async,
// which stands in for internalBinding('inspector'). Task ids are numbers on
// every platform here, so there is no 32 bit warning.
let hook;

function lazyHookCreation() {
  const inspector = require('internal/inspector_async');
  const { createHook } = require('async_hooks');

  hook = createHook({
    init(asyncId, type, triggerAsyncId, resource) {
    // It's difficult to tell which tasks will be recurring and which won't,
    // therefore we mark all tasks as recurring. Based on the discussion
    // in https://github.com/nodejs/node/pull/13870#discussion_r124515293,
    // this should be fine as long as we call asyncTaskCanceled() too.
      const recurring = true;
      inspector.asyncTaskScheduled(type, asyncId, recurring);
    },

    before(asyncId) {
      inspector.asyncTaskStarted(asyncId);
    },

    after(asyncId) {
      inspector.asyncTaskFinished(asyncId);
    },

    destroy(asyncId) {
      inspector.asyncTaskCanceled(asyncId);
    },
    trackPromises: false,
  });
}

function enable() {
  if (hook === undefined) lazyHookCreation();
  hook.enable();
}

function disable() {
  if (hook === undefined) lazyHookCreation();
  hook.disable();
}

module.exports = {
  enable,
  disable,
};
