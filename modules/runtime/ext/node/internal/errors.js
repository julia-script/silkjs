'use strict';

// Node's own errors (internal/errors in Node): a code, a stack that reads
// "Name [CODE]: message" and a toString that reads the same. Each base type gets one
// subclass carrying that toString, so the errors stay plain to structured clone.
const host = require('internal/host');

function nodeErrorString() { return `${this.name} [${this.code}]: ${this.message}`; }
const classes = new Map();
function classFor(Base) {
  let Class = classes.get(Base);
  if (Class === undefined) {
    Class = class extends Base {};
    Object.defineProperty(Class, 'name', { value: Base.name });
    Object.defineProperty(Class.prototype, 'toString', { value: nodeErrorString, writable: true, configurable: true });
    classes.set(Base, Class);
  }
  return Class;
}

function codedError(Base, code, message, properties) {
  const error = new (classFor(Base))(message);
  Object.defineProperty(error, host.kIsNodeError, { value: true });
  error.code = code;
  if (properties) Object.assign(error, properties);
  return error;
}

const { codes: { ERR_INVALID_ARG_TYPE } } = require('internal/path_events/support');
function invalidArgType(name, expected, value) { return new ERR_INVALID_ARG_TYPE(name, expected, value); }

function invalidArgValue(name, value, reason = 'is invalid') {
  let inspected = require('util').inspect(value);
  if (inspected.length > 128) inspected = inspected.slice(0, 128) + '...';
  return codedError(TypeError, 'ERR_INVALID_ARG_VALUE',
    `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`);
}

module.exports = { codedError, invalidArgType, invalidArgValue };
