// Adapted from Node.js v24.22.3 lib/internal/readline/emitKeypressEvents.js; Silk uses public JS stream/event APIs.
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
  SafeStringIterator,
  Symbol,
} = require('internal/readline/primordials');

const {
  charLengthAt,
  CSI,
  emitKeys,
} = require('internal/readline/utils');
const {
  kSawKeyPress,
} = require('internal/readline/interface');

const { clearTimeout, setTimeout } = require('timers');
const {
  kEscape,
} = CSI;

const { StringDecoder } = require('string_decoder');

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE_DECODER = Symbol('escape-decoder');

// GNU readline library - keyseq-timeout is 500ms (default)
const ESCAPE_CODE_TIMEOUT = 500;

/**
 * accepts a readable Stream instance and makes it emit "keypress" events
 */

function emitKeypressEvents(stream, iface = {}) {
  if (stream[KEYPRESS_DECODER]) return;

  stream[KEYPRESS_DECODER] = new StringDecoder('utf8');

  stream[ESCAPE_DECODER] = emitKeys(stream);
  stream[ESCAPE_DECODER].next();

  const triggerEscape = () => stream[ESCAPE_DECODER].next('');
  const { escapeCodeTimeout = ESCAPE_CODE_TIMEOUT } = iface;
  let timeoutId;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(timeoutId);
    stream.removeListener('data', onData);
    stream.removeListener('newListener', onNewListener);
    stream.removeListener('end', cleanup);
    stream.removeListener('close', cleanup);
    delete stream[KEYPRESS_DECODER];
    delete stream[ESCAPE_DECODER];
  }

  function onData(input) {
    if (stream.listenerCount('keypress') > 0) {
      const string = stream[KEYPRESS_DECODER].write(input);
      if (string) {
        clearTimeout(timeoutId);

        // This supports characters of length 2.
        iface[kSawKeyPress] = charLengthAt(string, 0) === string.length;
        iface.isCompletionEnabled = false;

        let length = 0;
        for (const character of new SafeStringIterator(string)) {
          length += character.length;
          if (length === string.length) {
            iface.isCompletionEnabled = true;
          }

          try {
            stream[ESCAPE_DECODER].next(character);
            if (closed) break;
            // Escape letter at the tail position
            if (length === string.length && character === kEscape) {
              timeoutId = setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (err) {
            // If the generator throws (it could happen in the `keypress`
            // event), we need to restart it.
            if (!closed) {
              stream[ESCAPE_DECODER] = emitKeys(stream);
              stream[ESCAPE_DECODER].next();
            }
            throw err;
          }
        }
      }
    } else {
      // Nobody's watching anyway
      stream.removeListener('data', onData);
      stream.on('newListener', onNewListener);
    }
  }

  function onNewListener(event) {
    if (event === 'keypress') {
      stream.on('data', onData);
      stream.removeListener('newListener', onNewListener);
    }
  }

  stream.once('end', cleanup);
  stream.once('close', cleanup);
  if (stream.listenerCount('keypress') > 0) {
    stream.on('data', onData);
  } else {
    stream.on('newListener', onNewListener);
  }
  return () => {
    if (stream.listenerCount('keypress') === 0) cleanup();
  };
}

module.exports = emitKeypressEvents;
