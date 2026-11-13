'use strict';

// internalBinding('performance') for --expose-internals tests: the parts of Node's
// src/node_perf.cc that the runtime keeps in JS.
const { observerCounts } = require('internal/perf_observers');
module.exports = {
  observerCounts,
  // node_perf.cc CreateELDHistogram (src/histogram.cc IntervalHistogram).
  createELDHistogram(resolution, samplePerIteration) {
    return require('internal/histogram_native').createELDHistogram(resolution, samplePerIteration);
  },
};
