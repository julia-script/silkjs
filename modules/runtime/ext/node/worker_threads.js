'use strict';

// Node.js lib/worker_threads.js: the public surface of internal/worker and
// internal/worker/io. A main thread that never uses messaging loads none of
// the port modules; each export below loads on first use.

const {
  isInternalThread,
  isMainThread,
  SHARE_ENV,
  Worker,
  threadId,
  getEnvironmentData,
  setEnvironmentData,
  receiveMessageOnPort,
} = require('internal/worker');

const lazy = name => { let loaded; return () => loaded ??= require(name); };
const io = lazy('internal/worker/io');

module.exports = {
  isInternalThread,
  isMainThread,
  MessagePort: undefined,
  MessageChannel: undefined,
  markAsUncloneable: undefined,
  markAsUntransferable: undefined,
  isMarkedAsUntransferable: undefined,
  moveMessagePortToContext: undefined,
  receiveMessageOnPort,
  resourceLimits: {},
  postMessageToThread: undefined,
  threadId,
  threadName: null,
  SHARE_ENV,
  Worker,
  parentPort: null,
  workerData: null,
  BroadcastChannel: undefined,
  setEnvironmentData,
  getEnvironmentData,
  locks: undefined,
};

// Indexed, not for-of: user code may replace Array.prototype[Symbol.iterator] before this loads.
const lazyExports = [
  ['MessagePort', () => io().MessagePort], ['MessageChannel', () => io().MessageChannel],
  ['BroadcastChannel', () => io().BroadcastChannel],
  ['moveMessagePortToContext', () => io().moveMessagePortToContext],
  ['markAsUncloneable', () => io().markAsUncloneable],
  ['markAsUntransferable', () => require('internal/buffer').markAsUntransferable],
  ['isMarkedAsUntransferable', () => require('internal/buffer').isMarkedAsUntransferable],
  ['postMessageToThread', () => require('internal/worker/messaging').postMessageToThread],
  ['locks', () => require('internal/worker/locks').locks],
];
for (let index = 0; index < lazyExports.length; index++) {
  const name = lazyExports[index][0], load = lazyExports[index][1];
  Object.defineProperty(module.exports, name, {
    enumerable: true, configurable: true,
    get() { const value = load(); Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true }); return value; },
    set(value) { Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true }); },
  });
}
