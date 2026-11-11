'use strict';

// Node.js v24.22.1 lib/internal/util/debuglog.js: util.debuglog, at Node's path so
// internal modules can take it without loading util (NODE_DEBUG selects the
// sections), and formatTime, how console.timeEnd and console.timeLog print a duration.
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).
const host = require('internal/host');
const { format } = require('internal/util/inspect');
const ReflectApply = Reflect.apply;

function debuglog(section, callback) {
  section = String(section).toUpperCase();
  let enabled;
  // NODE_DEBUG is read on first use, not when a module asks for its logger.
  const initialize = () => { enabled = String(host.env.NODE_DEBUG || '').split(/[\s,]+/).filter(Boolean).some(pattern => new RegExp('^' + pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(section)); };
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

module.exports = { debuglog, formatTime };
