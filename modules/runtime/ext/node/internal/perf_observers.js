'use strict';
// Performance entries that runtime modules make themselves (Node's http2 entries
// come from C++). perf_hooks installs observing and emit when it loads; before that
// nothing can observe an entry.
const host = require('internal/host');

const entries = module.exports = {
  // Whether an observer takes entries of this type.
  observing(type) { return false; },
  // Reports an entry; start is a host.now() time.
  emit(name, type, start, duration, detail) {},
  // Node's internal/perf/observe helpers over the two above.
  hasObserver(type) { return entries.observing(type); },
  startPerf(target, key, context = {}) {
    target[key] = { ...context, startTime: host.now() };
  },
  stopPerf(target, key, context = {}) {
    const ctx = target[key];
    if (!ctx) return;
    const startTime = ctx.startTime;
    entries.emit(ctx.name, ctx.type, startTime, host.now() - startTime, { ...ctx.detail, ...context.detail });
  },
};
