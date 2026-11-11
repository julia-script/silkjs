'use strict';

// Node's internalBinding('uv') (src/uv.cc): the UV_* error numbers, errname, getErrorMap
// and getErrorMessage, read from the host's libuv-style error table.

const { getSystemErrorMap, getSystemErrorMessage } = require('internal/util_public/system');

const map = getSystemErrorMap();
const binding = {
  errname(err) {
    const entry = map.get(err);
    return entry ? entry[0] : `Unknown system error ${err}`;
  },
  getErrorMap() { return getSystemErrorMap(); },
  getErrorMessage(err) { return getSystemErrorMessage(err); },
};
for (const { 0: errno, 1: { 0: name } } of map) binding[`UV_${name}`] = errno;

module.exports = binding;
