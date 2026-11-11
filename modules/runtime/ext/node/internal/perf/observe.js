'use strict';

// The parts of Node.js lib/internal/perf/observe.js that the ported modules use.
let hooks;
const perf = () => hooks ??= require('perf_hooks');

function hasObserver(type) {
  return perf()._hasObserver(type);
}

function startPerf(target, key, context = {}) {
  target[key] = {
    ...context,
    startTime: perf()._now(),
  };
}

function stopPerf(target, key, context = {}) {
  const ctx = target[key];
  if (!ctx) {
    return;
  }
  const startTime = ctx.startTime;
  perf()._enqueueNodeEntry(ctx.name, ctx.type, startTime, perf()._now() - startTime,
                           { ...ctx.detail, ...context.detail });
}

module.exports = { hasObserver, startPerf, stopPerf };
