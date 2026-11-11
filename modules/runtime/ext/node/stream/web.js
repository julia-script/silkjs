// Node.js v24.22.1 lib/stream/web.js, unchanged.
// Copyright Node.js contributors. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

'use strict';

const {
  TransformStream,
  TransformStreamDefaultController,
} = require('internal/webstreams/transformstream');

const {
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} = require('internal/webstreams/writablestream');

const {
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
  isReadableStream,
  readableStreamTee,
} = require('internal/webstreams/readablestream');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');

const {
  validateBoolean,
} = require('internal/validators');

const {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
} = require('internal/webstreams/queuingstrategies');

const {
  TextEncoderStream,
  TextDecoderStream,
} = require('internal/webstreams/encoding');

const {
  CompressionStream,
  DecompressionStream,
} = require('internal/webstreams/compression');

function ReadableStreamTee(stream, cloneForBranch2 = false) {
  if (!isReadableStream(stream)) {
    throw new ERR_INVALID_ARG_TYPE('stream', 'ReadableStream', stream);
  }
  validateBoolean(cloneForBranch2, 'cloneForBranch2');
  return readableStreamTee(stream, cloneForBranch2);
}

module.exports = {
  ReadableStream,
  ReadableStreamTee,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  WritableStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  TextEncoderStream,
  TextDecoderStream,
  CompressionStream,
  DecompressionStream,
};
