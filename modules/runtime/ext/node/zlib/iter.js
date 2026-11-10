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

// Public entry point for the iterable compression/decompression API.
// Usage: require('node:zlib/iter')
// Requires: --experimental-stream-iter

const { emitExperimentalWarning } = require('internal/streams/iter/support');
emitExperimentalWarning('zlib/iter');

const {
  compressGzip,
  compressGzipSync,
  compressDeflate,
  compressDeflateSync,
  compressBrotli,
  compressBrotliSync,
  compressZstd,
  compressZstdSync,
  decompressGzip,
  decompressGzipSync,
  decompressDeflate,
  decompressDeflateSync,
  decompressBrotli,
  decompressBrotliSync,
  decompressZstd,
  decompressZstdSync,
} = require('internal/streams/iter/transform');

module.exports = {
  // Compression transforms (async)
  compressGzip,
  compressDeflate,
  compressBrotli,
  compressZstd,

  // Compression transforms (sync)
  compressGzipSync,
  compressDeflateSync,
  compressBrotliSync,
  compressZstdSync,

  // Decompression transforms (async)
  decompressGzip,
  decompressDeflate,
  decompressBrotli,
  decompressZstd,

  // Decompression transforms (sync)
  decompressGzipSync,
  decompressDeflateSync,
  decompressBrotliSync,
  decompressZstdSync,
};
