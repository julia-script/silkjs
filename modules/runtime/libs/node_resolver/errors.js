'use strict';

// Node's own errors (internal/errors in Node) for the module loader and the compile
// cache: a code, a stack that reads "Name [CODE]: message" and a toString that reads
// the same. Each base type gets one subclass carrying that toString, so the errors
// stay plain to structured clone. Private to the loader until the runtime has a
// shared internal/errors.
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

module.exports = { codedError };
