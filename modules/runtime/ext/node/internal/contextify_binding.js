'use strict';

// The SIGINT watchdog of Node's internalBinding('contextify') (src/node_watchdog.cc).
// Watchdogs nest: a SIGINT while any is active is recorded instead of reaching
// the process, and interrupts a vm run started with breakOnSigint.
const host = require('internal/host');
const guards = [];

// Throws ERR_CANNOT_WATCH_SIGINT where Node returns false.
function startSigintWatchdog() {
  guards.push(host.workerNative('startSigintWatch', []));
  return true;
}
// Whether a SIGINT arrived while the innermost watchdog was active.
function stopSigintWatchdog() {
  if (guards.length === 0) return false;
  return !!host.workerNative('stopSigintWatch', [guards.pop()]);
}

module.exports = { startSigintWatchdog, stopSigintWatchdog };
