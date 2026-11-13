'use strict';

// Self-contained web globals for the QuickJS bootstrap. Networking is supplied
// separately; these constructors never delegate to another JavaScript runtime.
//
// Each global is an accessor until first use, so startup does not load fetch,
// WebSocket, the legacy text codecs and the other web modules a script may never
// touch. The first read or write turns it into a plain data property.
const groups = [
  ['internal/encoding', ['TextEncoder', 'TextDecoder']],
  ['internal/web/streams', ['ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'ReadableByteStreamController',
    'ReadableStream', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController',
    'ReadableStreamDefaultReader', 'TransformStream', 'TransformStreamDefaultController', 'WritableStream',
    'WritableStreamDefaultController', 'WritableStreamDefaultWriter', 'TextEncoderStream', 'TextDecoderStream']],
  ['internal/web/fetch', ['fetch', 'Headers', 'Request', 'Response', 'FormData']],
  ['internal/web/structured_clone', ['structuredClone']],
  ['internal/web/compression', ['CompressionStream', 'DecompressionStream']],
  ['internal/navigator', ['Navigator', 'navigator']],
  ['internal/web/urlpattern', ['URLPattern']],
  ['internal/url', ['URL', 'URLSearchParams']],
  ['internal/web/blob', ['Blob', 'File']],
  ['internal/web/websocket', ['WebSocket', 'MessageEvent', 'CloseEvent']],
  ['worker_threads', ['MessageChannel', 'MessagePort', 'BroadcastChannel']],
];

// Node lists only these web globals in Object.keys(globalThis); interfaces
// such as URL or TextEncoder are non-enumerable, as WebIDL defines them.
const enumerableGlobals = new Set(['fetch', 'structuredClone', 'navigator']);

// Node exposes these interfaces as plain data properties from the start, and
// its tests read their descriptors. A native lazy data property keeps that
// shape and still loads the module on first use.
const dataGlobals = new Set(['URL', 'URLSearchParams']);

// The accessors carry Node's names (`get fetch`), which tests and
// util.inspect show.
function defineLazy(target, name, load, enumerable) {
  const settle = value => Object.defineProperty(target, name, { value, writable: true, enumerable, configurable: true });
  const get = function () { const value = load()[name]; settle(value); return value; };
  const set = function (value) { settle(value); };
  Object.defineProperty(get, 'name', { value: 'get ' + name });
  Object.defineProperty(set, 'name', { value: 'set ' + name });
  Object.defineProperty(target, name, { get, set, enumerable, configurable: true });
}

// Modules every process has loaded anyway (the heap image holds them): their
// interfaces are plain data properties from the start, as Node's are.
const eagerGroups = new Set(['internal/encoding', 'internal/url']);

function install(target) {
  for (const [id, names] of groups) {
    if (eagerGroups.has(id)) {
      const exports = require(id);
      for (const name of names) {
        Object.defineProperty(target, name, { value: exports[name], writable: true, enumerable: enumerableGlobals.has(name), configurable: true });
      }
      continue;
    }
    let exports;
    const load = () => exports || (exports = require(id));
    for (const name of names) {
      if (dataGlobals.has(name)) require('internal/host').defineLazyDataProperty(target, name, () => load()[name]);
      else defineLazy(target, name, load, enumerableGlobals.has(name));
    }
  }
  // As lib/internal/bootstrap/web/exposed-window-or-worker.js does.
  require('internal/url').installObjectURLMethods();
}

module.exports = { install, defineLazy };
