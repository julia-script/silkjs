// Adapted from Node.js v24.22.1 lib/internal/cluster/worker.js by tools/port_node_net.py.
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
  FunctionPrototypeCall,
  ObjectSetPrototypeOf,
  ReflectApply,
} = require('internal/per_context/primordials');

const EventEmitter = require('events');

const kEmptyObject = Object.freeze({ __proto__: null });

module.exports = Worker;

// Common Worker implementation shared between the cluster primary and workers.
function Worker(options) {
  if (!(this instanceof Worker))
    return new Worker(options);

  FunctionPrototypeCall(EventEmitter, this);

  if (options === null || typeof options !== 'object')
    options = kEmptyObject;

  this.exitedAfterDisconnect = undefined;

  this.state = options.state || 'none';
  this.id = options.id | 0;

  if (options.process) {
    this.process = options.process;
    this.process.on('error', (code, signal) =>
      this.emit('error', code, signal),
    );
    this.process.on('message', (message, handle) =>
      this.emit('message', message, handle),
    );
  }
}

ObjectSetPrototypeOf(Worker.prototype, EventEmitter.prototype);
ObjectSetPrototypeOf(Worker, EventEmitter);

Worker.prototype.kill = function() {
  ReflectApply(this.destroy, this, arguments);
};

Worker.prototype.send = function() {
  return ReflectApply(this.process.send, this.process, arguments);
};

Worker.prototype.isDead = function() {
  return this.process.exitCode != null || this.process.signalCode != null;
};

Worker.prototype.isConnected = function() {
  return this.process.connected;
};
