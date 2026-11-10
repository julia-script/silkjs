'use strict';

// Parsing, canonicalization, token compilation and matching are supplied by the
// pinned MIT urlpattern-polyfill; this boundary implements Node's WebIDL surface.
const { URLPattern: Pattern } = require('internal/web/vendor/urlpattern');
const { URL } = require('internal/web/url');
const patterns = new WeakMap();
const components = ['hash', 'hostname', 'password', 'pathname', 'port', 'protocol', 'search', 'username'];
const initMembers = ['baseURL', ...components];
function failure(code, message) { return Object.assign(new TypeError(message), { code }); }
function invalid(name) { return failure('ERR_INVALID_ARG_TYPE', `The "${name}" argument has an invalid type`); }
function usvString(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  const text = String(value);
  let result = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
    }
    result += text.slice(start, i) + '\ufffd';
    start = i + 1;
  }
  return start ? result + text.slice(start) : text;
}
function input(value) {
  if (typeof value === 'string') return usvString(value);
  if (value == null) return {};
  if (typeof value !== 'object' && typeof value !== 'function') throw invalid('input');
  const init = {};
  // WebIDL dictionaries read inherited members in lexicographic order and omit
  // undefined members; reading here also preserves exceptions from user getters.
  for (const key of initMembers) {
    const member = value[key];
    if (member !== undefined) init[key] = usvString(member);
  }
  return init;
}
function options(value) {
  if (value == null) return { ignoreCase: false };
  if (typeof value !== 'object' && typeof value !== 'function') throw invalid('options');
  return { ignoreCase: Boolean(value.ignoreCase) };
}
function baseURL(value) {
  if (value != null && typeof value !== 'string') throw invalid('baseURL');
  return usvString(value);
}
function state(receiver) {
  const pattern = patterns.get(receiver);
  if (!pattern) throw failure('ERR_INVALID_THIS', 'Value of "this" must be of type URLPattern');
  return pattern;
}
function URLPattern(value = {}, base, opts) {
  if (!new.target) throw failure('ERR_CONSTRUCT_CALL_REQUIRED', 'Class constructor URLPattern cannot be invoked without new');
  const normalized = input(value);
  let baseValue, settings;
  if (arguments.length >= 3 || typeof base === 'string') {
    baseValue = baseURL(base);
    settings = options(opts);
  } else {
    settings = options(base);
  }
  try {
    if (baseValue !== undefined) {
      if (typeof normalized !== 'string') throw new TypeError('A base URL cannot be provided with a dictionary input');
      new URL(baseValue);
    }
    patterns.set(this, baseValue === undefined ? new Pattern(normalized, settings) : new Pattern(normalized, baseValue, settings));
  } catch (cause) {
    throw failure('ERR_INVALID_URL_PATTERN', cause.message);
  }
}
function match(receiver, value, base, exec) {
  const pattern = state(receiver);
  const normalized = input(value);
  const baseValue = base === undefined ? undefined : baseURL(base);
  if (baseValue !== undefined) {
    if (typeof normalized !== 'string') throw failure('ERR_OPERATION_FAILED', 'A base URL cannot be provided with a dictionary input');
    try { new URL(baseValue); } catch { return exec ? null : false; }
  }
  if (!exec) return pattern.test(normalized, baseValue);
  const result = pattern.exec(normalized, baseValue);
  if (result === null) return null;
  const ordered = {};
  for (const key of ['hash', 'hostname', 'inputs', 'password', 'pathname', 'port', 'protocol', 'search', 'username']) {
    ordered[key] = key === 'inputs' ? result.inputs : { groups: result[key].groups, input: result[key].input };
  }
  return ordered;
}
Object.defineProperties(URLPattern.prototype, {
  exec: { value: function exec(value = {}, base) { return match(this, value, base, true); }, writable: true, enumerable: true, configurable: true },
  test: { value: function test(value = {}, base) { return match(this, value, base, false); }, writable: true, enumerable: true, configurable: true },
  hasRegExpGroups: { get() { return state(this).hasRegExpGroups; }, enumerable: true, configurable: true },
  [Symbol.toStringTag]: { value: 'URLPattern', configurable: true },
});
for (const component of components) {
  Object.defineProperty(URLPattern.prototype, component, {
    get() { return state(this)[component]; }, enumerable: true, configurable: true,
  });
}
module.exports = { URLPattern };
