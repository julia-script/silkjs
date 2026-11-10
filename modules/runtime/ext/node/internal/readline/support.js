'use strict';

const shared = require('internal/path_events/support');
const { inspect, promisify } = require('util');

class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = 'is invalid') {
    super(`The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspect(value)}`);
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
}
class ERR_INVALID_CURSOR_POS extends TypeError {
  constructor() {
    super('Cannot set cursor row without setting its column');
    this.code = 'ERR_INVALID_CURSOR_POS';
  }
}
class ERR_USE_AFTER_CLOSE extends Error {
  constructor(name) {
    super(`${name} was closed`);
    this.code = 'ERR_USE_AFTER_CLOSE';
  }
}
function validateUint32(value, name, positive = false) {
  shared.validateInteger(value, name, positive ? 1 : 0, 0xffffffff);
}
function assignFunctionName(name, fn) {
  Object.defineProperty(fn, 'name', { value: typeof name === 'symbol' ? `[${name.description}]` : name, configurable: true });
  return fn;
}
module.exports = {
  ...shared,
  codes: { ...shared.codes, ERR_INVALID_ARG_VALUE, ERR_INVALID_CURSOR_POS, ERR_USE_AFTER_CLOSE },
  validateUint32,
  assignFunctionName,
  promisify,
};
