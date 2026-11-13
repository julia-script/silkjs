'use strict';

const { TextEncoder, TextDecoder } = require('internal/encoding');

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
// A token is ASCII, so a name that passes the token test is a ByteString too; the
// ByteString check only decides which error a bad name throws.
function checkedName(name) {
  name = string(name);
  if (!token.test(name)) { byteString(name); throw new TypeError('Invalid header name: ' + name); }
  return name;
}
function nameOf(name) { return checkedName(name).toLowerCase(); }
// Bytes a value can hold untouched: no NUL, CR, LF or tab, nothing above 0xff.
const plain = /[^\x20-\x7e\x80-\xff]/;
function valueOf(value) {
  value = string(value);
  const last = value.length - 1;
  if (!plain.test(value) && (last < 0 || value.charCodeAt(0) !== 32 && value.charCodeAt(last) !== 32)) return value;
  value = byteString(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (/[\0\r\n]/.test(value)) throw new TypeError('Invalid header value');
  return value;
}
function state(value) {
  const result = states.get(value);
  // undici's webidl.brandCheck.
  if (!result) throw Object.assign(new TypeError('Illegal invocation'), { code: 'ERR_INVALID_THIS' });
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
    states.set(this, { list: new Map(), names: new Map(), immutable: false });
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
    const given = checkedName(name); value = valueOf(value);
    name = given.toLowerCase();
    const current = mutable(this), list = current.list;
    const values = list.get(name);
    // undici's HeadersList keeps the name a header was first given with, for inspection.
    if (values) values.push(value); else { list.set(name, [value]); current.names?.set(name, given); }
  }
  delete(name) {
    if (!arguments.length) throw new TypeError('Headers.delete requires an argument');
    name = nameOf(name);
    const current = mutable(this);
    current.list.delete(name); current.names?.delete(name);
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
    const given = checkedName(name); value = valueOf(value);
    name = given.toLowerCase();
    const current = mutable(this);
    current.list.set(name, [value]); current.names?.set(name, given);
  }
  *entries() { state(this); for (let index = 0; ; index++) { const entry = sorted(this)[index]; if (!entry) return; yield entry; } }
  *keys() { for (const [key] of this.entries()) yield key; }
  *values() { for (const [, value] of this.entries()) yield value; }
  forEach(callback, thisArg) {
    state(this);
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  // undici's Headers: the header list's entries under the names they were given.
  [Symbol.for('nodejs.util.inspect.custom')](depth, options) {
    const current = state(this), entries = {};
    for (const [name, values] of current.list) entries[current.names?.get(name) ?? name] = values.join(name === 'cookie' ? '; ' : ', ');
    options.depth ??= depth;
    return `Headers ${require('internal/util/inspect').formatWithOptions(options, entries)}`;
  }
}
// WebIDL pair iterators: @@iterator is the entries method itself.
Object.defineProperty(Headers.prototype, Symbol.iterator, { __proto__: null, value: Headers.prototype.entries, writable: true, configurable: true });
function immutable(headers) { state(headers).immutable = true; return headers; }
function rawHeaders(headers) {
  const result = Object.create(null);
  for (const [name, values] of state(headers).list) result[name] = name === 'set-cookie' ? values.slice() : values.join(name === 'cookie' ? '; ' : ', ');
  return result;
}
// Headers of a request that the native server parsed: fields[start..] holds lower-case names and
// their values, which the parser already checked.
function parsedHeaders(fields, start) {
  const headers = Object.create(Headers.prototype);
  const list = new Map();
  for (let index = start; index < fields.length; index += 2) {
    const name = fields[index], values = list.get(name);
    if (values === undefined) list.set(name, [fields[index + 1]]); else values.push(fields[index + 1]);
  }
  states.set(headers, { list, immutable: false });
  return headers;
}
// A mutable copy of headers, without validating again what it already holds.
function copyHeaders(headers) {
  const copy = Object.create(Headers.prototype);
  const list = new Map();
  for (const [name, values] of state(headers).list) list.set(name, values.slice());
  states.set(copy, { list, immutable: false });
  return copy;
}
// The name -> values map of `headers`, for serializing a response.
function headerList(headers) { return state(headers).list; }
module.exports = { Headers, immutable, rawHeaders, parsedHeaders, headerList, copyHeaders, string, scalar, token, byteString };
