// Adapted from Node.js v24.22.1 lib/internal/cluster/shared_handle.js by tools/port_node_net.py.
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
  SafeMap,
} = require('internal/per_context/primordials');

const assert = require('assert').ok;
const dgram = require('internal/dgram');
const net = require('net');

module.exports = SharedHandle;

function SharedHandle(key, address, { port, addressType, fd, flags }) {
  this.key = key;
  this.workers = new SafeMap();
  this.handle = null;
  this.errno = 0;

  let rval;
  if (addressType === 'udp4' || addressType === 'udp6')
    rval = dgram._createSocketHandle(address, port, addressType, fd, flags);
  else
    rval = net._createServerHandle(address, port, addressType, fd, flags);

  if (typeof rval === 'number')
    this.errno = rval;
  else
    this.handle = rval;
}

SharedHandle.prototype.add = function(worker, send) {
  assert(!this.workers.has(worker.id));
  this.workers.set(worker.id, worker);
  send(this.errno, null, this.handle);
};

SharedHandle.prototype.remove = function(worker) {
  if (!this.workers.has(worker.id))
    return false;

  this.workers.delete(worker.id);

  if (this.workers.size !== 0)
    return false;

  this.handle.close();
  this.handle = null;
  return true;
};

SharedHandle.prototype.has = function(worker) {
  return this.workers.has(worker.id);
};
