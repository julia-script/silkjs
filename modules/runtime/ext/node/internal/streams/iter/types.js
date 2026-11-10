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

const {
  Symbol,
  SymbolFor,
} = require('internal/streams/iter/primordials');

/**
 * Symbol for sync value-to-streamable conversion protocol.
 * Objects implementing this can be written to streams or yielded
 * from generators. Works in both sync and async contexts.
 *
 * Third-party: [Symbol.for('Stream.toStreamable')]() { ... }
 */
const toStreamable = SymbolFor('Stream.toStreamable');

/**
 * Symbol for async value-to-streamable conversion protocol.
 * Objects implementing this can be written to async streams.
 * Works in async contexts only.
 *
 * Third-party: [Symbol.for('Stream.toAsyncStreamable')]() { ... }
 */
const toAsyncStreamable = SymbolFor('Stream.toAsyncStreamable');

/**
 * Symbol for Broadcastable protocol - object can provide a Broadcast.
 */
const broadcastProtocol = SymbolFor('Stream.broadcastProtocol');

/**
 * Symbol for Shareable protocol - object can provide a Share.
 */
const shareProtocol = SymbolFor('Stream.shareProtocol');

/**
 * Symbol for SyncShareable protocol - object can provide a SyncShare.
 */
const shareSyncProtocol = SymbolFor('Stream.shareSyncProtocol');

/**
 * Symbol for Drainable protocol - object can signal when backpressure
 * clears. Used to bridge event-driven sources that need drain notification.
 */
const drainableProtocol = SymbolFor('Stream.drainableProtocol');

/**
 * Internal sentinel for validated stateful transforms. A transform object
 * with [kValidatedTransform] = true signals that:
 *   1. It handles source exhaustion (done) internally - no withFlushAsync
 *      wrapper needed.
 *   2. It always yields valid Uint8Array[] batches - no isUint8ArrayBatch
 *      validation needed on each yield.
 * This is NOT a public protocol symbol - it uses Symbol() not Symbol.for().
 */
const kValidatedTransform = Symbol('kValidatedTransform');

/**
 * Internal sentinel for validated sources. An async iterable with
 * [kValidatedSource] = true signals that it already yields valid
 * Uint8Array[] batches - no normalizeAsyncSource wrapper needed.
 * from() will return such sources directly, skipping all normalization.
 * This is NOT a public protocol symbol - it uses Symbol() not Symbol.for().
 */
const kValidatedSource = Symbol('kValidatedSource');

module.exports = {
  broadcastProtocol,
  drainableProtocol,
  kValidatedSource,
  kValidatedTransform,
  shareProtocol,
  shareSyncProtocol,
  toAsyncStreamable,
  toStreamable,
};
