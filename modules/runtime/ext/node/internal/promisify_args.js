'use strict';
// Node's kCustomPromisifyArgsSymbol (lib/internal/util.js): names for the values of a callback
// that receives several, so util.promisify resolves with an object, e.g. fs.read's
// { bytesRead, buffer }. Private to the runtime, unlike util.promisify.custom.
const kCustomPromisifyArgsSymbol = Symbol('customPromisifyArgs');
function setCustomPromisifyArgs(fn, names) {
  Object.defineProperty(fn, kCustomPromisifyArgsSymbol, { value: names, enumerable: false });
  return fn;
}
module.exports = { kCustomPromisifyArgsSymbol, setCustomPromisifyArgs };
