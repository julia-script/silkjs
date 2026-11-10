'use strict';

// These are installed by the runtime's Web-primitives bootstrap. Getters keep
// the stream helpers independent of the Web implementation's private state.
for (const name of ['AbortController', 'AbortSignal', 'Blob', 'TextDecoder', 'TextEncoder',
  'ReadableStream', 'WritableStream', 'CountQueuingStrategy', 'ByteLengthQueuingStrategy']) {
  Object.defineProperty(exports, name, {
    enumerable: true,
    get() { return globalThis[name]; },
  });
}
exports.isBlob = (value) => typeof globalThis.Blob === 'function' && value instanceof globalThis.Blob;
