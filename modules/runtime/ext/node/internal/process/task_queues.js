'use strict';

// The queueMicrotask of Node's lib/internal/process/task_queues.js: the runtime's,
// which runs the callback in its own async resource like Node's AsyncResource wrap.
// nextTick and the tick queue stay in the bootstrap.
const { queueMicrotask } = require('internal/host');

module.exports = { queueMicrotask };
