'use strict';

// WHATWG stream algorithms: web-streams-polyfill 4.5.0, MIT.
const streams = require('internal/web/vendor/streams');
const { TextEncoder, TextDecoder } = require('internal/web/encoding');
const closedStates = new WeakMap();
const closedSymbol = Symbol.for('nodejs.webstream.isClosedPromise');
const errorSymbol = Symbol.for('nodejs.webstream.controllerErrorFunction');

// Node's finished() observes closure without acquiring a reader/writer lock.
// The vendored implementation stores transitions in _state; observe only streams
// for which Node requests this hook, leaving ordinary streams unchanged.
function observeClosed(stream) {
  let record = closedStates.get(stream);
  if (record) return record;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  record = { promise };
  closedStates.set(stream, record);
  let state = stream._state;
  const settle = () => {
    if (state === 'closed') resolve();
    else if (state === 'errored') reject(stream._storedError);
  };
  Object.defineProperty(stream, '_state', {
    configurable: true,
    enumerable: true,
    get() { return state; },
    set(value) {
      state = value;
      // Error transitions assign _storedError in the same synchronous step.
      if (value === 'closed' || value === 'errored') Promise.resolve().then(settle);
    },
  });
  settle();
  return record;
}
for (const Constructor of [streams.ReadableStream, streams.WritableStream]) {
  Object.defineProperties(Constructor.prototype, {
    [closedSymbol]: { configurable: true, get() { return observeClosed(this); } },
    [errorSymbol]: {
      configurable: true,
      value(error) {
        const controller = this._readableStreamController || this._writableStreamController;
        controller.error(error);
      },
    },
    [Symbol.for('nodejs.stream.disturbed')]: { configurable: true, get() { return Boolean(this._disturbed); } },
    [Symbol.for('nodejs.stream.errored')]: {
      configurable: true,
      get() { return this._state === 'errored' || this._state === 'erroring'; },
    },
  });
}
Object.defineProperty(streams.TransformStream.prototype, errorSymbol, {
  configurable: true,
  value(error) { this._transformStreamController.error(error); },
});

const encoderStreams = new WeakMap();
const decoderStreams = new WeakMap();
function state(map, receiver) {
  const value = map.get(receiver);
  if (!value) throw new TypeError('Invalid encoding stream receiver');
  return value;
}
class TextEncoderStream {
  constructor() {
    const encoder = new TextEncoder();
    let pending = '';
    const transform = new streams.TransformStream({
      transform(chunk, controller) {
        if (typeof chunk === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        let text = pending + String(chunk);
        pending = '';
        if (text.length) {
          const last = text.charCodeAt(text.length - 1);
          if (last >= 0xd800 && last <= 0xdbff) {
            pending = text.slice(-1);
            text = text.slice(0, -1);
          }
        }
        if (text.length) controller.enqueue(encoder.encode(text));
      },
      flush(controller) {
        if (pending) controller.enqueue(encoder.encode(pending));
      },
    });
    encoderStreams.set(this, transform);
  }
  get encoding() { state(encoderStreams, this); return 'utf-8'; }
  get readable() { return state(encoderStreams, this).readable; }
  get writable() { return state(encoderStreams, this).writable; }
}
class TextDecoderStream {
  constructor(label = 'utf-8', options = {}) {
    const decoder = new TextDecoder(label, options);
    const transform = new streams.TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        if (text.length) controller.enqueue(text);
      },
      flush(controller) {
        const text = decoder.decode();
        if (text.length) controller.enqueue(text);
      },
    });
    decoderStreams.set(this, { decoder, transform });
  }
  get encoding() { return state(decoderStreams, this).decoder.encoding; }
  get fatal() { return state(decoderStreams, this).decoder.fatal; }
  get ignoreBOM() { return state(decoderStreams, this).decoder.ignoreBOM; }
  get readable() { return state(decoderStreams, this).transform.readable; }
  get writable() { return state(decoderStreams, this).transform.writable; }
}
for (const Constructor of [TextEncoderStream, TextDecoderStream]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
}
module.exports = { ...streams, TextEncoderStream, TextDecoderStream };
