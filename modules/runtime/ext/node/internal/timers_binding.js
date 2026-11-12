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
// Environment::SetImmediate's native queue: binding work (an http2 session's
// scheduled write) that the check phase runs before the JS immediate queue.
const nativeImmediates = [];
let nativeRefs = 0;
host.setNativeImmediate = (callback, ref = true) => {
  nativeImmediates.push({ callback, ref });
  if (ref) nativeRefs++;
};
function runNativeImmediates() {
  // Callbacks queued while the queue runs run in the same pass, as RunAndClearNativeImmediates.
  for (let i = 0; i < nativeImmediates.length; i++) {
    const { callback, ref } = nativeImmediates[i];
    if (ref) nativeRefs--;
    callback();
  }
  nativeImmediates.length = 0;
}

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
  hasRef() { return (timerRefed && timerDue !== -1) || immediateRefed || nativeRefs !== 0; },
  // Milliseconds the poll may wait for I/O before a phase has work: 0 while
  // referenced immediates wait, the delay to the loop timer, or -1 for none.
  pollDelay() {
    if (immediateRefed || nativeImmediates.length !== 0) return 0;
    if (timerDue === -1) return -1;
    return Math.max(0, timerDue - host.now());
  },
  // Environment::RunTimers, when the loop timer is due.
  runTimers() {
    if (timerDue === -1 || host.now() < timerDue) return false;
    if (host.traceEnvironment) return traced('RunTimers', runTimers);
    return runTimers();
  },
  // Environment::CheckImmediate, the check phase, which runs every loop turn.
  checkImmediate() {
    if (host.traceEnvironment) return traced('CheckImmediate', checkImmediate);
    return checkImmediate();
  },
  immediateInfo,
  timeoutInfo,
};

function traced(name, phase) {
  const trace = require('internal/trace_events');
  const start = trace.now();
  try { return phase(); } finally { trace.phase(name, start); }
}

function runTimers() {
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
}

function checkImmediate() {
  const ranNative = nativeImmediates.length !== 0;
  if (host.traceEnvironment) {
    const trace = require('internal/trace_events');
    const start = trace.now();
    try { runNativeImmediates(); } finally { trace.phase('RunAndClearNativeImmediates', start); }
  } else if (ranNative) runNativeImmediates();
  if (immediateInfo[0] === 0) return ranNative;
  do processImmediateCallback();
  while (immediateInfo[2] !== 0);
  if (immediateInfo[1] === 0) immediateRefed = false;
  return true;
}

module.exports = binding;
