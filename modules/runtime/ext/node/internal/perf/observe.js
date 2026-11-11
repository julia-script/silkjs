'use strict';

// The parts of Node.js lib/internal/perf/observe.js that the ported modules use.
// Entries go through internal/perf_observers, which perf_hooks fills in once loaded.
const host = require('internal/host');
const entries = require('internal/perf_observers');

function hasObserver(type) {
  return entries.observing(type);
}

function startPerf(target, key, context = {}) {
  target[key] = {
    ...context,
    startTime: host.now(),
  };
}

function stopPerf(target, key, context = {}) {
  const ctx = target[key];
  if (!ctx) {
    return;
  }
  const startTime = ctx.startTime;
  entries.emit(ctx.name, ctx.type, startTime, host.now() - startTime,
               { ...ctx.detail, ...context.detail });
}

module.exports = { hasObserver, startPerf, stopPerf };
