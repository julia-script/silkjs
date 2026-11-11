// Ported from Node.js v24.22.1 lib/internal/promise_hooks.js. Copyright Node.js
// contributors. MIT license (see vendor/node-api/LICENSE).
'use strict';

// internalBinding('async_wrap').setPromiseHooks and internalBinding('errors')
// .triggerUncaughtException are the runtime's.
const { _setPromiseHooks: setPromiseHooks } = require('async_hooks');
const { triggerUncaughtException } = require('internal/host');

const kEmptyObject = Object.freeze({ __proto__: null });
const { validatePlainFunction } = require('internal/validators');

const hooks = {
  init: [],
  before: [],
  after: [],
  settled: [],
};

function initAll(promise, parent) {
  const hookSet = hooks.init.slice();
  const exceptions = [];

  for (let i = 0; i < hookSet.length; i++) {
    const init = hookSet[i];
    try {
      init(promise, parent);
    } catch (err) {
      exceptions.push(err);
    }
  }

  // Triggering exceptions is deferred to allow other hooks to complete
  for (let i = 0; i < exceptions.length; i++) {
    const err = exceptions[i];
    triggerUncaughtException(err, false);
  }
}

function makeRunHook(list) {
  return (promise) => {
    const hookSet = list.slice();
    const exceptions = [];

    for (let i = 0; i < hookSet.length; i++) {
      const hook = hookSet[i];
      try {
        hook(promise);
      } catch (err) {
        exceptions.push(err);
      }
    }

    // Triggering exceptions is deferred to allow other hooks to complete
    for (let i = 0; i < exceptions.length; i++) {
      const err = exceptions[i];
      triggerUncaughtException(err, false);
    }
  };
}

const beforeAll = makeRunHook(hooks.before);
const afterAll = makeRunHook(hooks.after);
const settledAll = makeRunHook(hooks.settled);

function maybeFastPath(list, runAll) {
  return list.length > 1 ? runAll : list[0];
}

function update() {
  const init = maybeFastPath(hooks.init, initAll);
  const before = maybeFastPath(hooks.before, beforeAll);
  const after = maybeFastPath(hooks.after, afterAll);
  const settled = maybeFastPath(hooks.settled, settledAll);
  setPromiseHooks(init, before, after, settled);
}

function stop(list, hook) {
  const index = list.indexOf(hook);
  if (index >= 0) {
    list.splice(index, 1);
    update();
  }
}

function makeUseHook(name) {
  const list = hooks[name];
  return (hook) => {
    validatePlainFunction(hook, `${name}Hook`);
    list.push(hook);
    update();
    return stop.bind(null, list, hook);
  };
}

const onInit = makeUseHook('init');
const onBefore = makeUseHook('before');
const onAfter = makeUseHook('after');
const onSettled = makeUseHook('settled');

function createHook({ init, before, after, settled } = kEmptyObject) {
  const hooks = [];

  if (init) hooks.push(onInit(init));
  if (before) hooks.push(onBefore(before));
  if (after) hooks.push(onAfter(after));
  if (settled) hooks.push(onSettled(settled));

  return () => {
    for (const stop of hooks) {
      stop();
    }
  };
}

module.exports = {
  createHook,
  onInit,
  onBefore,
  onAfter,
  onSettled,
};
