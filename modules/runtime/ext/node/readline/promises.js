// Adapted from Node.js v24.22.3 lib/readline/promises.js; Silk uses public JS stream/event APIs.
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
  Promise,
  SymbolDispose,
} = require('internal/per_context/primordials');

const {
  Readline,
} = require('internal/readline/promises');

const {
  Interface: _Interface,
  kQuestion,
  kQuestionCallback,
  kQuestionCancel,
  kQuestionReject,
} = require('internal/readline/interface');

const {
  AbortError,
} = require('internal/errors');
const { validateAbortSignal } = require('internal/validators');

const {
  kEmptyObject,
} = require('internal/util');
let addAbortListener;

class Interface extends _Interface {
  question(query, options = kEmptyObject) {
    return new Promise((resolve, reject) => {
      let cb = resolve;

      if (options?.signal) {
        validateAbortSignal(options.signal, 'options.signal');
        if (options.signal.aborted) {
          return reject(
            new AbortError(undefined, { cause: options.signal.reason }));
        }

        const onAbort = () => {
          this[kQuestionCancel]();
          reject(new AbortError(undefined, { cause: options.signal.reason }));
        };
        addAbortListener ??= require('internal/path_events/abort_listener').addAbortListener;
        const disposable = addAbortListener(options.signal, onAbort);

        cb = (answer) => {
          disposable[SymbolDispose]();
          resolve(answer);
        };
      }

      this[kQuestionReject] = reject;

      this[kQuestion](query, cb);
    });
  }
}

function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

module.exports = {
  Interface,
  Readline,
  createInterface,
};
