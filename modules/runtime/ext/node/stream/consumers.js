// Adapted from Node.js v24.11.0 for Silk QuickJS.
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
  JSONParse,
} = require('internal/streams/primordials');

const {
  TextDecoder,
} = require('internal/streams/web');

const {
  Blob,
} = require('internal/streams/web');

const {
  Buffer,
} = require('buffer');

/**
 * @typedef {import('../internal/webstreams/readablestream').ReadableStream
 * } ReadableStream
 * @typedef {import('../internal/streams/readable')} Readable
 */

/**
 * @param {AsyncIterable|ReadableStream|Readable} stream
 * @returns {Promise<Blob>}
 */
async function blob(stream) {
  const chunks = [];
  for await (const chunk of stream)
    chunks.push(chunk);
  return new Blob(chunks);
}

/**
 * @param {AsyncIterable|ReadableStream|Readable} stream
 * @returns {Promise<ArrayBuffer>}
 */
async function arrayBuffer(stream) {
  const ret = await blob(stream);
  return ret.arrayBuffer();
}

/**
 * @param {AsyncIterable|ReadableStream|Readable} stream
 * @returns {Promise<Buffer>}
 */
async function buffer(stream) {
  return Buffer.from(await arrayBuffer(stream));
}

/**
 * @param {AsyncIterable|ReadableStream|Readable} stream
 * @returns {Promise<string>}
 */
async function text(stream) {
  const dec = new TextDecoder();
  let str = '';
  for await (const chunk of stream) {
    if (typeof chunk === 'string')
      str += chunk;
    else
      str += dec.decode(chunk, { stream: true });
  }
  // Flush the streaming TextDecoder so that any pending
  // incomplete multibyte characters are handled.
  str += dec.decode(undefined, { stream: false });
  return str;
}

/**
 * @param {AsyncIterable|ReadableStream|Readable} stream
 * @returns {Promise<any>}
 */
async function json(stream) {
  const str = await text(stream);
  return JSONParse(str);
}

module.exports = {
  arrayBuffer,
  blob,
  buffer,
  text,
  json,
};
