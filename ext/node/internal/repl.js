'use strict';
const REPL = require('repl');
const { inspect } = require('util');

// CLI-only setup. Script/module dispatch remains the bootstrap's responsibility.
function createInternalRepl(env, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const opts = { ignoreUndefined: false, useGlobal: true, breakEvalOnSigint: true, ...options };
  if (parseInt(env.NODE_NO_READLINE, 10)) opts.terminal = false;
  if (env.NODE_REPL_MODE) {
    const mode = env.NODE_REPL_MODE.toLowerCase().trim();
    opts.replMode = mode === 'strict' ? REPL.REPL_MODE_STRICT : REPL.REPL_MODE_SLOPPY;
  }
  const terminal = opts.terminal === undefined ? !!(opts.output || process.stdout).isTTY : !!opts.terminal;
  const size = Number(env.NODE_REPL_HISTORY_SIZE);
  opts.historySize = Number.isInteger(size) && size > 0 ? size : 1000;
  const server = REPL.start(opts);
  REPL.repl = server;
  Object.defineProperty(inspect, 'replDefaults', {
    configurable: true, enumerable: true,
    get: () => REPL.writer.options,
    set(value) {
      if (!value || typeof value !== 'object') throw Object.assign(new TypeError('The "options" argument must be an object'), { code: 'ERR_INVALID_ARG_TYPE' });
      Object.assign(REPL.writer.options, value);
    },
  });
  server.setupHistory({
    filePath: terminal ? env.NODE_REPL_HISTORY : '',
    size: opts.historySize,
    onHistoryFileLoaded: callback,
  });
  return server;
}
module.exports = Object.assign(Object.create(REPL), { createInternalRepl });
