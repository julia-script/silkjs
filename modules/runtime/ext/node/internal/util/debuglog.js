'use strict';

// util.debuglog, at Node's path (lib/internal/util/debuglog.js) so internal
// modules can take it without loading util. NODE_DEBUG selects the sections.
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

module.exports = { debuglog };
