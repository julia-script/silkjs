'use strict';

// Node's internalBinding('timers') (src/timers.cc) and the parts of
// Environment (src/env.cc) that drive it: one loop timer, scheduled by
// scheduleTimer and run by runTimers, and the check phase that runs the
// immediate queue. getLibuvNow is the loop's clock in whole milliseconds,
// brought up to date on each call as Environment::GetNow does.
//
// The bootstrap's event loop reads the loop side through host.timerLoop:
// whether the timer or the immediate queue keeps the loop alive, how long the
// poll may wait, and when to run each phase.

const host = require('internal/host');

// Environment::ImmediateInfo fields: kCount, kRefCount, kHasOutstanding.
const immediateInfo = new Uint32Array(3);
// The count of referenced Timeouts, at index 0.
const timeoutInfo = new Int32Array(1);

let processImmediateCallback, processTimersCallback;
// The loop timer: when it is due (on the getLibuvNow clock, -1 when it is
// stopped), and whether it keeps the loop alive (uv_ref / uv_unref).
let timerDue = -1;
let timerRefed = false;
// The idle handle that keeps the loop polling while referenced immediates wait.
let immediateRefed = false;

function getLibuvNow() { return Math.floor(host.now()); }

const binding = {
  immediateInfo,
  timeoutInfo,
  getLibuvNow,
  setupTimers(processImmediate, processTimers) {
    processImmediateCallback = processImmediate;
    processTimersCallback = processTimers;
  },
  scheduleTimer(duration) { timerDue = getLibuvNow() + Math.max(1, duration); },
  toggleTimerRef(ref) { timerRefed = !!ref; },
  toggleImmediateRef(ref) { immediateRefed = !!ref; },
};

host.timerLoop = {
  // Whether a timer or an immediate keeps the loop alive.
  hasRef() { return (timerRefed && timerDue !== -1) || immediateRefed; },
  // Milliseconds the poll may wait for I/O before a phase has work: 0 while
  // referenced immediates wait, the delay to the loop timer, or -1 for none.
  pollDelay() {
    if (immediateRefed) return 0;
    if (timerDue === -1) return -1;
    return Math.max(0, timerDue - host.now());
  },
  // Environment::RunTimers, when the loop timer is due.
  runTimers() {
    if (timerDue === -1 || host.now() < timerDue) return false;
    timerDue = -1;
    const expiry = processTimersCallback(getLibuvNow());
    if (expiry !== 0) {
      const duration = Math.abs(expiry) - getLibuvNow();
      binding.scheduleTimer(duration > 0 ? duration : 1);
      timerRefed = expiry > 0;
    } else {
      timerRefed = false;
    }
    return true;
  },
  // Environment::CheckImmediate, the check phase.
  checkImmediate() {
    if (immediateInfo[0] === 0) return false;
    do processImmediateCallback();
    while (immediateInfo[2] !== 0);
    if (immediateInfo[1] === 0) immediateRefed = false;
    return true;
  },
  immediateInfo,
  timeoutInfo,
};

module.exports = binding;
