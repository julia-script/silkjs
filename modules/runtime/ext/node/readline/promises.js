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
} = require('internal/readline/primordials');

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
} = require('internal/readline/support');
const { validateAbortSignal } = require('internal/readline/support');

const {
  kEmptyObject,
} = require('internal/readline/support');
let addAbortListener;

class Interface extends _Interface {
  question(query, options = kEmptyObject) {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal) {
        validateAbortSignal(signal, 'options.signal');
        if (signal.aborted) {
          reject(new AbortError(undefined, { cause: signal.reason }));
          return;
        }
      }
      if (this[kQuestionCallback]) {
        this.prompt();
        return;
      }
      let disposable;
      const cleanup = () => {
        disposable?.[SymbolDispose]();
        this.removeListener('close', cleanup);
        this[kQuestionReject] = undefined;
      };
      if (signal) {
        const onAbort = () => {
          cleanup();
          this[kQuestionCancel]();
          reject(new AbortError(undefined, { cause: signal.reason }));
        };
        addAbortListener ??= require('internal/path_events/abort_listener').addAbortListener;
        disposable = addAbortListener(signal, onAbort);
      }
      this.once('close', cleanup);
      this[kQuestionReject] = reject;
      try {
        this[kQuestion](query, (answer) => {
          cleanup();
          resolve(answer);
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
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
