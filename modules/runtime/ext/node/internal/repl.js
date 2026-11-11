// Adapted from Node.js v24.22.1 lib/internal/repl.js.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  Number,
  NumberIsNaN,
  NumberParseInt,
} = require('internal/per_context/primordials');

const REPL = require('repl');
const { kStandaloneREPL } = require('internal/repl/syntax');

module.exports = { __proto__: REPL };
module.exports.createInternalRepl = createRepl;

function createRepl(env, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = null;
  }
  opts = {
    [kStandaloneREPL]: true,
    ignoreUndefined: false,
    useGlobal: true,
    breakEvalOnSigint: true,
    ...opts,
  };

  if (NumberParseInt(env.NODE_NO_READLINE)) {
    opts.terminal = false;
  }

  if (env.NODE_REPL_MODE) {
    opts.replMode = {
      'strict': REPL.REPL_MODE_STRICT,
      'sloppy': REPL.REPL_MODE_SLOPPY,
    }[env.NODE_REPL_MODE.toLowerCase().trim()];
  }

  if (opts.replMode === undefined) {
    opts.replMode = REPL.REPL_MODE_SLOPPY;
  }

  const size = Number(env.NODE_REPL_HISTORY_SIZE);
  if (!NumberIsNaN(size) && size > 0) {
    opts.size = size;
  } else {
    opts.size = 1000;
  }

  const term = 'terminal' in opts ? opts.terminal : process.stdout.isTTY;
  opts.filePath = term ? env.NODE_REPL_HISTORY : '';

  const repl = REPL.start(opts);

  repl.setupHistory({
    filePath: opts.filePath,
    size: opts.size,
    onHistoryFileLoaded: cb,
  });
}
