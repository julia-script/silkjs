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
  ObjectFreeze,
  SymbolDispose,
} = require('internal/path_events/primordials');
const {
  validateAbortSignal,
  validateFunction,
} = require('internal/path_events/support');
const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/path_events/support');

let queueMicrotask;
let kResistStopPropagation;
let abortListenerOptions;

/**
 * @param {AbortSignal} signal
 * @param {EventListener} listener
 * @returns {Disposable}
 */
function addAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask ??= require('internal/host').queueMicrotask;
    queueMicrotask(() => listener());
  } else {
    kResistStopPropagation ??= require('internal/path_events/event_target').kResistStopPropagation;
    abortListenerOptions ??= ObjectFreeze({ __proto__: null, once: true, [kResistStopPropagation]: true });
    signal.addEventListener('abort', listener, abortListenerOptions);
    removeEventListener = () => {
      signal.removeEventListener('abort', listener);
    };
  }
  return {
    __proto__: null,
    [SymbolDispose]() {
      removeEventListener?.();
    },
  };
}

module.exports = {
  __proto__: null,
  addAbortListener,
};
