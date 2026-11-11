'use strict';

// The parts of Node.js v24 lib/internal/timers.js that the stream and net modules use, over
// the runtime's timers.

const { setTimeout } = require('timers');
const { codes: { ERR_OUT_OF_RANGE } } = require('internal/errors');
const { validateNumber } = require('internal/validators');

const kTimeout = Symbol('timeout');
const TIMEOUT_MAX = 2 ** 31 - 1;

function getTimerDuration(msecs, name) {
  validateNumber(msecs, name);
  if (msecs < 0 || !Number.isFinite(msecs)) {
    throw new ERR_OUT_OF_RANGE(name, 'a non-negative finite number', msecs);
  }
  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    process.emitWarning(`${msecs} does not fit into a 32-bit signed integer.` +
                        `\nTimer duration was truncated to ${TIMEOUT_MAX}.`,
                        'TimeoutOverflowWarning');
    return TIMEOUT_MAX;
  }
  return msecs;
}

// An unreferenced timer, as Node's internal setUnrefTimeout makes.
function setUnrefTimeout(callback, after, ...args) {
  const timer = setTimeout(callback, after, ...args);
  timer.unref();
  return timer;
}

// Node reuses the timer object when it is not running; a new unreferenced timer behaves the same.
function reuseOrCreateUnrefTimeout(timer, callback, after, arg1) {
  return setUnrefTimeout(callback, after, arg1);
}

module.exports = { kTimeout, TIMEOUT_MAX, getTimerDuration, setUnrefTimeout, reuseOrCreateUnrefTimeout };
