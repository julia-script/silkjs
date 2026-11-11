// Adapted from Node.js v24.22.1 lib/internal/cluster/utils.js by tools/port_node_net.py.
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
  ReflectApply,
  SafeMap,
} = require('internal/per_context/primordials');

module.exports = {
  sendHelper,
  internal,
};

const callbacks = new SafeMap();
let seq = 0;

function sendHelper(proc, message, handle, cb) {
  if (!proc.connected)
    return false;

  // Mark message as internal. See INTERNAL_PREFIX
  // in lib/internal/child_process.js
  message = { cmd: 'NODE_CLUSTER', ...message, seq };

  if (typeof cb === 'function')
    callbacks.set(seq, cb);

  seq += 1;
  return proc.send(message, handle);
}

// Returns an internalMessage listener that hands off normal messages
// to the callback but intercepts and redirects ACK messages.
function internal(worker, cb) {
  return function onInternalMessage(message, handle) {
    if (message.cmd !== 'NODE_CLUSTER')
      return;

    let fn = cb;

    if (message.ack !== undefined) {
      const callback = callbacks.get(message.ack);

      if (callback !== undefined) {
        fn = callback;
        callbacks.delete(message.ack);
      }
    }

    ReflectApply(fn, worker, arguments);
  };
}
