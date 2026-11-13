'use strict';

// Node.js v24.22.1 lib/internal/util/debuglog.js: util.debuglog, at Node's path so
// internal modules can take it without loading util (NODE_DEBUG selects the
// sections), and formatTime, how console.timeEnd and console.timeLog print a duration.
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).
const host = require('internal/host');
const { format } = require('internal/util/inspect');
const ReflectApply = Reflect.apply;

const { RegExpPrototypeExec } = require('internal/per_context/primordials');
const debugWarned = new Set();
// Node's initializeDebugEnv: NODE_DEBUG as one case-insensitive pattern, "," between
// sections and "*" as a wildcard. It is read on first use, which can follow user code,
// so it calls no user-mutable String or RegExp method.
let debugEnvRegex;
function testEnabled(section) {
  if (debugEnvRegex === undefined) {
    const debugEnv = host.env.NODE_DEBUG;
    debugEnvRegex = null;
    if (debugEnv) {
      let pattern = '';
      for (let i = 0; i < debugEnv.length; i++) {
        const c = debugEnv[i];
        switch (c) {
          case '*': pattern += '.*'; break;
          case ',': pattern += '$|^'; break;
          case '|': case '\\': case '{': case '}': case '(': case ')': case '[': case ']':
          case '^': case '$': case '+': case '?': case '.': pattern += '\\' + c; break;
          default: pattern += c;
        }
      }
      debugEnvRegex = new RegExp(`^${pattern}$`, 'i');
    }
  }
  return debugEnvRegex !== null && RegExpPrototypeExec(debugEnvRegex, section) !== null;
}
function debuglog(section, callback) {
  section = String(section).toUpperCase();
  let enabled;
  // NODE_DEBUG is read on first use, not when a module asks for its logger.
  const initialize = () => {
    enabled = testEnabled(section);
    // Like Node's debuglogImpl, the first enabled logger of http or http2 warns once.
    if (enabled && (section === 'HTTP' || section === 'HTTP2') && !debugWarned.has(section)) {
      debugWarned.add(section);
      process.emitWarning(`Setting the NODE_DEBUG environment variable to '${section.toLowerCase()}' can expose sensitive data (such as passwords, tokens and authentication headers) in the resulting log.`);
    }
  };
  const write = (...args) => { if (enabled) host.stderr.write(section + ' ' + (globalThis.process ? process.pid : 0) + ': ' + ReflectApply(format, undefined, args) + '\n'); };
  Object.defineProperty(write, 'enabled', { enumerable: true, configurable: true, get: () => enabled });
  const quiet = function debug() {};
  Object.defineProperty(quiet, 'enabled', { enumerable: true, configurable: true, get: () => enabled });
  let initialized = false;
  // Disabled loggers run on every stream chunk: no rest array before the check.
  const logger = function() {
    if (enabled === false) return;
    if (!initialized) {
      initialize(); initialized = true;
      // Like Node, a disabled section hands the caller a no-op to call from then on.
      if (typeof callback === 'function') callback(enabled ? write : quiet);
    }
    // Not spread: user code may have replaced the array iterator.
    return ReflectApply(write, undefined, arguments);
  };
  Object.defineProperty(logger, 'enabled', { enumerable: true, configurable: true, get() { if (enabled === undefined) initialize(); return enabled; } });
  return logger;
}

function pad(value) { return `${value}`.padStart(2, '0'); }
function formatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (ms >= 1000) {
    if (ms >= 60000) {
      if (ms >= 3600000) {
        hours = Math.floor(ms / 3600000);
        ms = ms % 3600000;
      }
      minutes = Math.floor(ms / 60000);
      ms = ms % 60000;
    }
    seconds = ms / 1000;
  }
  if (hours !== 0 || minutes !== 0) {
    ({ 0: seconds, 1: ms } = seconds.toFixed(3).split('.', 2));
    const res = hours !== 0 ? `${hours}:${pad(minutes)}` : minutes;
    return `${res}:${pad(seconds)}.${ms} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`;
  }
  if (seconds !== 0) return `${seconds.toFixed(3)}s`;
  return `${Number(ms.toFixed(3))}ms`;
}

// debugWithTimer(set): timers that print to stderr when NODE_DEBUG names the set and
// emit begin and end trace events while the node.<set> trace category is on.
// The trace category can only be on once internal/trace_events is loaded, so it is
// not loaded before. active() says whether a timer would do anything.
const kTraceBegin = 98, kTraceEnd = 101;
function debugWithTimer(set) {
  set = String(set).toUpperCase();
  const traceCategory = `node,node.${set.toLowerCase()}`;
  const times = new Map();
  let logEnabled;
  let categoryBuffer;
  function traceEnabled() {
    if (categoryBuffer === undefined) {
      if (!host.builtinLoaded('internal/trace_events')) return false;
      categoryBuffer = require('internal/trace_events').getCategoryEnabledBuffer(traceCategory);
    }
    return categoryBuffer[0] !== 0;
  }
  function logging() {
    logEnabled ??= testEnabled(set);
    return logEnabled;
  }
  function log(label, formatted) {
    const colors = { colors: require('internal/util/colors').shouldColorize(process.stderr) };
    process.stderr.write(format('%s %s %s: %s\n', set, require('internal/util/inspect').inspect(process.pid, colors), label, formatted));
  }
  function active() { return logging() || traceEnabled(); }
  function start(logLabel, traceLabel = logLabel) {
    logLabel = `${logLabel}`;
    if (times.has(logLabel)) {
      process.emitWarning(`Label '${logLabel}' already exists for debuglog.time`);
      return;
    }
    if (traceEnabled()) require('internal/trace_events').trace(kTraceBegin, traceCategory, `${traceLabel}`, 0);
    times.set(logLabel, process.hrtime());
  }
  function end(logLabel, traceLabel = logLabel) {
    logLabel = `${logLabel}`;
    if (logging()) {
      const time = times.get(logLabel);
      if (time === undefined) process.emitWarning(`No such label '${logLabel}' for debuglog.timeEnd`);
      else {
        const duration = process.hrtime(time);
        log(logLabel, formatTime(duration[0] * 1000 + duration[1] / 1e6));
      }
    }
    if (traceEnabled()) require('internal/trace_events').trace(kTraceEnd, traceCategory, `${traceLabel}`, 0);
    times.delete(logLabel);
  }
  return { active, start, end };
}

module.exports = { debuglog, debugWithTimer, formatTime };
