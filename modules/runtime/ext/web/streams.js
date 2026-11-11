'use strict';

// WHATWG streams: the Node.js v24.22.1 implementation in internal/webstreams.
const {
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
} = require('internal/webstreams/readablestream');
const {
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} = require('internal/webstreams/writablestream');
const {
  TransformStream,
  TransformStreamDefaultController,
} = require('internal/webstreams/transformstream');
const {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
} = require('internal/webstreams/queuingstrategies');
const {
  TextEncoderStream,
  TextDecoderStream,
} = require('internal/webstreams/encoding');

module.exports = {
  ReadableStream,
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
};
