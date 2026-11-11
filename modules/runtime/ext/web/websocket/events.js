'use strict';

const { Event } = require('internal/path_events/event_target');
const messageState = new WeakMap();
const closeState = new WeakMap();
const errorState = new WeakMap();
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function state(map, value) {
  const record = map.get(value);
  if (!record) throw new TypeError('Illegal invocation');
  return record;
}
function unsigned(value, modulus) {
  const number = +value;
  return Number.isFinite(number) ? ((Math.trunc(number) % modulus) + modulus) % modulus : 0;
}
// WebIDL checks of Node's MessageEvent: source and every port must be MessagePorts.
function notPort(value, name) {
  return new TypeError(`MessageEvent constructor: Expected ${name} ("${require('util').inspect(value)}") to be an instance of MessagePort.`);
}
function messagePort(value, name) {
  if (value !== null && !(value instanceof require('internal/worker/ports').MessagePort)) throw notPort(value, name);
  return value;
}
function messagePorts(value) {
  if (value === undefined) return [];
  if (value === null || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`MessageEvent constructor: eventInitDict.ports (${require('util').inspect(value)}) is not iterable.`);
  }
  const ports = Array.from(value);
  for (let i = 0; i < ports.length; i++) {
    if (ports[i] === null) throw notPort(null, `eventInitDict.ports[${i}]`);
    messagePort(ports[i], `eventInitDict.ports[${i}]`);
  }
  return ports;
}
class MessageEvent extends Event {
  constructor(type, options = {}) {
    if (!arguments.length) throw new TypeError('MessageEvent requires a type');
    super(type, options);
    options ??= {};
    messageState.set(this, {
      data: options.data === undefined ? null : options.data,
      origin: options.origin === undefined ? '' : string(options.origin),
      lastEventId: options.lastEventId === undefined ? '' : string(options.lastEventId),
      source: messagePort(options.source ?? null, 'eventInitDict.source'),
      ports: Object.freeze(messagePorts(options.ports)),
    });
  }
  get data() { return state(messageState, this).data; }
  get origin() { return state(messageState, this).origin; }
  get lastEventId() { return state(messageState, this).lastEventId; }
  get source() { return state(messageState, this).source; }
  get ports() { return state(messageState, this).ports; }
}
class CloseEvent extends Event {
  constructor(type, options = {}) {
    if (!arguments.length) throw new TypeError('CloseEvent requires a type');
    super(type, options);
    closeState.set(this, {
      wasClean: !!options?.wasClean,
      code: unsigned(options?.code ?? 0, 65536),
      reason: options?.reason === undefined ? '' : string(options.reason),
    });
  }
  get wasClean() { return state(closeState, this).wasClean; }
  get code() { return state(closeState, this).code; }
  get reason() { return state(closeState, this).reason; }
}
class ErrorEvent extends Event {
  constructor(type, options = {}) {
    if (!arguments.length) throw new TypeError('ErrorEvent requires a type');
    super(type, options);
    errorState.set(this, {
      message: options?.message === undefined ? '' : string(options.message),
      filename: options?.filename === undefined ? '' : string(options.filename),
      lineno: unsigned(options?.lineno ?? 0, 4294967296),
      colno: unsigned(options?.colno ?? 0, 4294967296),
      error: options?.error ?? null,
    });
  }
  get message() { return state(errorState, this).message; }
  get filename() { return state(errorState, this).filename; }
  get lineno() { return state(errorState, this).lineno; }
  get colno() { return state(errorState, this).colno; }
  get error() { return state(errorState, this).error; }
}
for (const Constructor of [MessageEvent, CloseEvent, ErrorEvent]) {
  Object.defineProperty(Constructor.prototype, Symbol.toStringTag, { value: Constructor.name, configurable: true });
  for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
    if (key !== 'constructor') Object.defineProperty(Constructor.prototype, key, { enumerable: true });
  }
}
module.exports = { MessageEvent, CloseEvent, ErrorEvent, string };
