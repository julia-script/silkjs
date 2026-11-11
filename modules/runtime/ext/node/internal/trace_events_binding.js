'use strict';

// internalBinding('trace_events') for --expose-internals tests, over the runtime's
// trace writer in internal/trace_events (Node's src/node_trace_events.cc surface).
const backend = require('internal/trace_events');

module.exports = {
  hasAgent: () => backend.available(),
  getEnabledCategories: () => backend.getEnabledCategories(),
  setTraceCategoryStateUpdateHandler: backend.setTraceCategoryStateUpdateHandler,
  getCategoryEnabledBuffer: backend.getCategoryEnabledBuffer,
  CategorySet: backend.CategorySet,
  isTraceCategoryEnabled: category => backend.isTraceCategoryEnabled(`${category}`),
  trace: backend.trace,
};
