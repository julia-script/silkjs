'use strict';
const sea = require('internal/sea');
const { TextDecoder } = require('internal/encoding');
const { Blob } = require('buffer');
const slice = Function.call.bind(ArrayBuffer.prototype.slice);
function string(value, name) {
  if (typeof value !== 'string') throw Object.assign(new TypeError(`The "${name}" argument must be of type string`), { code: 'ERR_INVALID_ARG_TYPE' });
}
function getRawAsset(key) {
  string(key, 'key');
  return sea.asset(key);
}
function getAsset(key, encoding) {
  if (encoding !== undefined) string(encoding, 'encoding');
  const asset = getRawAsset(key);
  if (encoding === undefined) return slice(asset, 0);
  let decoder;
  try { decoder = new TextDecoder(encoding); }
  catch (error) {
    if (error instanceof RangeError) {
      error.code = 'ERR_ENCODING_NOT_SUPPORTED';
      error.message = `The "${encoding}" encoding is not supported`;
    }
    throw error;
  }
  return decoder.decode(asset);
}
function getAssetAsBlob(key, options) { return new Blob([getRawAsset(key)], options); }
module.exports = { isSea: sea.isSea, getAsset, getRawAsset, getAssetAsBlob, getAssetKeys: sea.keys };
