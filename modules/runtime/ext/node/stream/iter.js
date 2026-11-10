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


// Adapted from Node.js v24.22.2 shipped builtin source.
'use strict';

// Public entry point for the iterable streams API.
// Usage: require('node:stream/iter')
// Requires: --experimental-stream-iter

const {
  ObjectFreeze,
} = require('internal/streams/iter/primordials');

const { emitExperimentalWarning } = require('internal/streams/iter/support');
emitExperimentalWarning('stream/iter');

// Protocol symbols
const {
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,
} = require('internal/streams/iter/types');

// Factories
const { push } = require('internal/streams/iter/push');
const { duplex } = require('internal/streams/iter/duplex');
const { from, fromSync } = require('internal/streams/iter/from');

// Pipelines
const {
  pull,
  pullSync,
  pipeTo,
  pipeToSync,
} = require('internal/streams/iter/pull');

// Consumers
const {
  bytes,
  bytesSync,
  text,
  textSync,
  arrayBuffer,
  arrayBufferSync,
  array,
  arraySync,
  tap,
  tapSync,
  merge,
  ondrain,
} = require('internal/streams/iter/consumers');

// Classic stream interop (Node.js-specific, not part of the spec)
const {
  fromReadable,
  fromWritable,
  toReadable,
  toReadableSync,
  toWritable,
} = require('internal/streams/iter/classic');

// Multi-consumer
const { broadcast, Broadcast } = require('internal/streams/iter/broadcast');
const {
  share,
  shareSync,
  Share,
  SyncShare,
} = require('internal/streams/iter/share');

/**
 * Stream namespace - unified access to all stream functions.
 * @example
 * const { Stream } = require('stream/iter');
 *
 * const { writer, readable } = Stream.push();
 * await writer.write("hello");
 * await writer.end();
 *
 * const output = Stream.pull(readable, transform1, transform2);
 * const data = await Stream.bytes(output);
 */
const Stream = ObjectFreeze({
  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,

  // Pipe to destination
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,

  // Combining
  merge,

  // Multi-consumer (push model)
  broadcast,

  // Multi-consumer (pull model)
  share,
  shareSync,

  // Utilities
  tap,
  tapSync,

  // Drain utility for event source integration
  ondrain,

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,
});

module.exports = {
  // The Stream namespace
  Stream,

  // Also export everything individually for destructured imports

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,

  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,

  // Combining
  merge,

  // Multi-consumer
  broadcast,
  Broadcast,
  share,
  shareSync,
  Share,
  SyncShare,

  // Utilities
  tap,
  tapSync,
  ondrain,

  // Classic stream interop
  fromReadable,
  fromWritable,
  toReadable,
  toReadableSync,
  toWritable,
};
