'use strict';
// Node's kCustomPromisifyArgsSymbol (lib/internal/util.js): names for the values of a callback
// that receives several, so util.promisify resolves with an object, e.g. fs.read's
// { bytesRead, buffer }. Private to the runtime, unlike util.promisify.custom.
module.exports = { kCustomPromisifyArgsSymbol: Symbol('customPromisifyArgs') };
