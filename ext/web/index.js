'use strict';

// Self-contained web globals for the QuickJS bootstrap. Networking is supplied
// separately; these constructors never delegate to another JavaScript runtime.
//
// Each global is an accessor until first use, so startup does not load fetch,
// WebSocket, the legacy text codecs and the other web modules a script may never
// touch. The first read or write turns it into a plain data property.
const groups = [
  ['internal/web/encoding', ['TextEncoder', 'TextDecoder']],
  ['internal/web/streams', ['ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'ReadableByteStreamController',
    'ReadableStream', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController',
    'ReadableStreamDefaultReader', 'TransformStream', 'TransformStreamDefaultController', 'WritableStream',
    'WritableStreamDefaultController', 'WritableStreamDefaultWriter', 'TextEncoderStream', 'TextDecoderStream']],
  ['internal/web/fetch', ['fetch', 'Headers', 'Request', 'Response', 'FormData']],
  ['internal/web/structured_clone', ['structuredClone']],
  ['internal/web/compression', ['CompressionStream', 'DecompressionStream']],
  ['internal/web/navigator', ['Navigator', 'navigator']],
  ['internal/web/urlpattern', ['URLPattern']],
  ['internal/web/url', ['URL', 'URLSearchParams']],
  ['internal/web/blob', ['Blob', 'File']],
  ['internal/web/websocket', ['WebSocket', 'MessageEvent', 'CloseEvent']],
  ['worker_threads', ['MessageChannel', 'MessagePort', 'BroadcastChannel']],
];

function defineLazy(target, name, load) {
  const settle = value => Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(target, name, {
    get() { const value = load()[name]; settle(value); return value; },
    set(value) { settle(value); },
    enumerable: true, configurable: true,
  });
}

function install(target) {
  for (const [id, names] of groups) {
    let exports;
    const load = () => exports || (exports = require(id));
    for (const name of names) defineLazy(target, name, load);
  }
}

module.exports = { install, defineLazy };
