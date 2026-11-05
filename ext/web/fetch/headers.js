'use strict';

const { TextEncoder, TextDecoder } = require('internal/web/encoding');

const states = new WeakMap();
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function string(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}
function scalar(value) {
  const text = string(value);
  return text.toWellFormed ? text.toWellFormed() : new TextDecoder().decode(new TextEncoder().encode(text));
}
function byteString(value) {
  const text = string(value);
  if (/[^\x00-\xff]/.test(text)) throw new TypeError('Header contains a character outside the ByteString range');
  return text;
}
function nameOf(name) {
  name = byteString(name);
  if (!token.test(name)) throw new TypeError('Invalid header name: ' + name);
  return name.toLowerCase();
}
function valueOf(value) {
  value = byteString(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (/[\0\r\n]/.test(value)) throw new TypeError('Invalid header value');
  return value;
}
function state(value) {
  const result = states.get(value);
  if (!result) throw new TypeError('Illegal Headers invocation');
  return result;
}
function mutable(value) {
  const result = state(value);
  if (result.immutable) throw new TypeError('immutable');
  return result;
}
function sorted(value) {
  const result = [];
  for (const [name, values] of [...state(value).list].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    if (name === 'set-cookie') for (const item of values) result.push([name, item]);
    else result.push([name, values.join(name === 'cookie' ? '; ' : ', ')]);
  }
  return result;
}
class Headers {
  constructor(init = undefined) {
    states.set(this, { list: new Map(), immutable: false });
    if (init == null) return;
    if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('Headers init must be an object');
    if (init[Symbol.iterator] !== undefined) {
      for (const pair of init) {
        if (pair == null || typeof pair === 'string' || typeof pair[Symbol.iterator] !== 'function') throw new TypeError('Header entry must be a pair');
        const values = Array.from(pair);
        if (values.length !== 2) throw new TypeError('Header entry must contain exactly two items');
        this.append(values[0], values[1]);
      }
    } else for (const name of Object.keys(init)) this.append(name, init[name]);
  }
  append(name, value) {
    if (arguments.length < 2) throw new TypeError('Headers.append requires two arguments');
    name = nameOf(name); value = valueOf(value);
    const list = mutable(this).list;
    const values = list.get(name);
    if (values) values.push(value); else list.set(name, [value]);
  }
  delete(name) {
    if (!arguments.length) throw new TypeError('Headers.delete requires an argument');
    name = nameOf(name); mutable(this).list.delete(name);
  }
  get(name) {
    if (!arguments.length) throw new TypeError('Headers.get requires an argument');
    name = nameOf(name);
    const values = state(this).list.get(name);
    return values ? values.join(name === 'cookie' ? '; ' : ', ') : null;
  }
  getSetCookie() { return (state(this).list.get('set-cookie') || []).slice(); }
  has(name) {
    if (!arguments.length) throw new TypeError('Headers.has requires an argument');
    return state(this).list.has(nameOf(name));
  }
  set(name, value) {
    if (arguments.length < 2) throw new TypeError('Headers.set requires two arguments');
    name = nameOf(name); value = valueOf(value); mutable(this).list.set(name, [value]);
  }
  *entries() { state(this); for (let index = 0; ; index++) { const entry = sorted(this)[index]; if (!entry) return; yield entry; } }
  *keys() { for (const [key] of this.entries()) yield key; }
  *values() { for (const [, value] of this.entries()) yield value; }
  forEach(callback, thisArg) {
    state(this);
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  [Symbol.iterator]() { return this.entries(); }
}
function immutable(headers) { state(headers).immutable = true; return headers; }
function rawHeaders(headers) {
  const result = Object.create(null);
  for (const [name, values] of state(headers).list) result[name] = name === 'set-cookie' ? values.slice() : values.join(name === 'cookie' ? '; ' : ', ');
  return result;
}
module.exports = { Headers, immutable, rawHeaders, string, scalar, token, byteString };
