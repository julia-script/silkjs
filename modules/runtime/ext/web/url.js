'use strict';

// URL and URLSearchParams over the native WHATWG URL parser (silk.url, src/ext/url_native.silk).
// A URL is the record the natives return: its href, which is ASCII, and the positions of its
// parts; the getters are slices of the href.
const host = require('internal/host');
const { urlParse, urlCanParse, urlUpdate, urlFormParse, urlFormSerialize, urlDomainToASCII, urlDomainToUnicode } = host;
const { createObjectURL, revokeObjectURL } = require('internal/web/blob');
const { validateString, codes: { ERR_INVALID_ARG_TYPE } } = require('internal/path_events/support');

const NONE = -1;
const SET_PROTOCOL = 1, SET_USERNAME = 2, SET_PASSWORD = 3, SET_HOST = 4, SET_HOSTNAME = 5;
const SET_PORT = 6, SET_PATHNAME = 7, SET_SEARCH = 8, SET_HASH = 9;
const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');

function failure(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}
function invalidURL(input, base) {
  const error = failure('ERR_INVALID_URL', 'Invalid URL');
  error.input = input;
  if (base !== undefined) error.base = base;
  return error;
}
function missing(name, count, given) {
  return new TypeError(`Failed to execute '${name}': ${count} argument${count === 1 ? '' : 's'} required, but only ${given} present.`);
}
// WebIDL USVString: ToString, then lone surrogates become U+FFFD.
function usv(value) {
  const text = typeof value === 'string' ? value : `${value}`;
  return text.isWellFormed() ? text : text.toWellFormed();
}
// ToString alone, for text that only goes to the natives: they read lone surrogates as U+FFFD.
function text(value) {
  return typeof value === 'string' ? value : `${value}`;
}

// application/x-www-form-urlencoded parsing and serializing are native. A list is flat:
// [name0, value0, name1, value1, ...], all USVStrings, so U+D800 can join them for the native.
function parseForm(text) {
  return text === '' ? [] : urlFormParse(text);
}
function serializeForm(list) {
  return list.length === 0 ? '' : urlFormSerialize(list.join('\ud800'));
}

let listOf, attach, reset;

class URLSearchParams {
  #list = [];
  #url = null;
  constructor(init = undefined) {
    if (init === undefined) return;
    if ((typeof init === 'object' && init !== null) || typeof init === 'function') {
      const list = this.#list;
      const method = init[Symbol.iterator];
      if (method !== undefined && method !== null) {
        if (typeof method !== 'function') throw new TypeError("Failed to construct 'URLSearchParams': The provided value cannot be converted to a sequence.");
        for (const pair of init) {
          if ((typeof pair !== 'object' || pair === null) && typeof pair !== 'function') {
            throw new TypeError("Failed to construct 'URLSearchParams': The provided value cannot be converted to a sequence.");
          }
          const entry = [...pair];
          if (entry.length !== 2) {
            throw new TypeError("Failed to construct 'URLSearchParams': parameter 1 sequence's element does not contain exactly two elements.");
          }
          list.push(usv(entry[0]), usv(entry[1]));
        }
        return;
      }
      for (const key of Reflect.ownKeys(init)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
        if (descriptor === undefined || !descriptor.enumerable) continue;
        const name = usv(key);
        const value = usv(init[key]);
        let found = false;
        for (let i = 0; i < list.length; i += 2) {
          if (list[i] === name) { list[i + 1] = value; found = true; break; }
        }
        if (!found) list.push(name, value);
      }
      return;
    }
    let source = text(init);
    if (source.charCodeAt(0) === 63) source = source.slice(1);
    this.#list = parseForm(source);
  }
  static {
    listOf = params => params.#list;
    // Ties a URL's query object to it: `update` takes the new query, or null.
    attach = (params, update, query) => {
      params.#url = update;
      params.#list = parseForm(query);
    };
    reset = (params, query) => { params.#list = parseForm(query); };
  }
  #update() {
    if (this.#url === null) return;
    const serialized = serializeForm(this.#list);
    this.#url(serialized === '' ? null : serialized);
  }
  get size() { return this.#list.length / 2; }
  append(name, value) {
    if (value === undefined && arguments.length < 2) throw missing("append' on 'URLSearchParams", 2, arguments.length);
    this.#list.push(usv(name), usv(value));
    this.#update();
  }
  delete(name, value = undefined) {
    if (name === undefined && arguments.length < 1) throw missing("delete' on 'URLSearchParams", 1, 0);
    name = usv(name);
    if (value !== undefined) value = usv(value);
    const list = this.#list;
    let write = 0;
    for (let read = 0; read < list.length; read += 2) {
      if (list[read] === name && (value === undefined || list[read + 1] === value)) continue;
      list[write] = list[read];
      list[write + 1] = list[read + 1];
      write += 2;
    }
    list.length = write;
    this.#update();
  }
  get(name) {
    if (name === undefined && arguments.length < 1) throw missing("get' on 'URLSearchParams", 1, 0);
    name = usv(name);
    const list = this.#list;
    for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
    return null;
  }
  getAll(name) {
    if (name === undefined && arguments.length < 1) throw missing("getAll' on 'URLSearchParams", 1, 0);
    name = usv(name);
    const list = this.#list;
    const output = [];
    for (let i = 0; i < list.length; i += 2) if (list[i] === name) output.push(list[i + 1]);
    return output;
  }
  has(name, value = undefined) {
    if (name === undefined && arguments.length < 1) throw missing("has' on 'URLSearchParams", 1, 0);
    name = usv(name);
    if (value !== undefined) value = usv(value);
    const list = this.#list;
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === name && (value === undefined || list[i + 1] === value)) return true;
    }
    return false;
  }
  set(name, value) {
    if (value === undefined && arguments.length < 2) throw missing("set' on 'URLSearchParams", 2, arguments.length);
    name = usv(name);
    value = usv(value);
    const list = this.#list;
    let found = false;
    let write = 0;
    for (let read = 0; read < list.length; read += 2) {
      if (list[read] === name) {
        if (found) continue;
        found = true;
        list[read + 1] = value;
      }
      list[write] = list[read];
      list[write + 1] = list[read + 1];
      write += 2;
    }
    list.length = write;
    if (!found) list.push(name, value);
    this.#update();
  }
  sort() {
    const list = this.#list;
    const pairs = [];
    for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
    // Array.prototype.sort is stable and compares code units, as the standard asks.
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = 0; i < pairs.length; i++) {
      list[2 * i] = pairs[i][0];
      list[2 * i + 1] = pairs[i][1];
    }
    this.#update();
  }
  forEach(callback, thisArg = undefined) {
    if (callback === undefined && arguments.length < 1) throw missing("forEach' on 'URLSearchParams", 1, 0);
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'URLSearchParams': parameter 1 is not of type 'Function'.");
    const list = this.#list;
    for (let i = 0; i < list.length; i += 2) callback.call(thisArg, list[i + 1], list[i], this);
  }
  entries() { return new URLSearchParamsIterator(this, 0); }
  keys() { return new URLSearchParamsIterator(this, 1); }
  values() { return new URLSearchParamsIterator(this, 2); }
  toString() { return serializeForm(this.#list); }
  [inspectSymbol](depth, options, inspect) {
    if (typeof depth === 'number' && depth < 0) return '[URLSearchParams]';
    inspect ??= require('util').inspect;
    const list = this.#list;
    if (list.length === 0) return 'URLSearchParams {}';
    const inner = [];
    for (let i = 0; i < list.length; i += 2) inner.push(`${inspect(list[i], options)} => ${inspect(list[i + 1], options)}`);
    return `URLSearchParams { ${inner.join(', ')} }`;
  }
}

const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
class URLSearchParamsIterator {
  #params;
  #kind;
  #index = 0;
  constructor(params, kind) {
    this.#params = params;
    this.#kind = kind;
  }
  next() {
    const list = listOf(this.#params);
    const index = this.#index;
    if (index >= list.length) return { value: undefined, done: true };
    this.#index = index + 2;
    const kind = this.#kind;
    return { value: kind === 0 ? [list[index], list[index + 1]] : kind === 1 ? list[index] : list[index + 1], done: false };
  }
}
Object.setPrototypeOf(URLSearchParamsIterator.prototype, IteratorPrototype);
Object.defineProperties(URLSearchParamsIterator.prototype, {
  next: { enumerable: true },
  [Symbol.toStringTag]: { value: 'URLSearchParams Iterator', configurable: true },
});

// new URL(loaded, record) takes a record urlParse returned.
const loaded = {};
const specialOrigin = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

// The serialization in a URL's private state, or undefined for anything that
// is not a URL: Node's isURLInstance and getURLHref, which public accessors
// cannot redirect.
let urlHref;
class URL {
  // [href, schemeEnd, userStart, usernameEnd, passwordEnd, hostStart, hostEnd, port, pathStart,
  // queryStart, fragmentStart, hostKind], NONE for an absent port, query or fragment: one field,
  // since each private field costs a store.
  #c;
  #query = null;
  constructor(url, base = undefined) {
    if (url === loaded) {
      this.#c = base;
      return;
    }
    if (url === undefined && arguments.length < 1) throw new TypeError("Failed to construct 'URL': 1 argument required, but only 0 present.");
    // ToString inline: this is the hot path. The natives read lone surrogates as U+FFFD.
    if (typeof url !== 'string') url = `${url}`;
    if (base !== undefined && typeof base !== 'string') base = `${base}`;
    const record = urlParse(url, base);
    if (record === undefined) throw invalidURL(url, base);
    this.#c = record;
  }
  #set(setter, value) {
    this.#c = urlUpdate(this.#c[0], setter, text(value));
  }
  #queryText() {
    if (this.#c[9] === NONE) return '';
    const end = this.#c[10] === NONE ? this.#c[0].length : this.#c[10];
    return this.#c[0].slice(this.#c[9] + 1, end);
  }
  static parse(url, base = undefined) {
    if (url === undefined && arguments.length < 1) throw new TypeError("Failed to execute 'parse' on 'URL': 1 argument required, but only 0 present.");
    // ToString inline: this is the hot path. The natives read lone surrogates as U+FFFD.
    if (typeof url !== 'string') url = `${url}`;
    if (base !== undefined && typeof base !== 'string') base = `${base}`;
    const record = urlParse(url, base);
    if (record === undefined) return null;
    return new URL(loaded, record);
  }
  static canParse(url, base = undefined) {
    if (url === undefined && arguments.length < 1) throw new TypeError("Failed to execute 'canParse' on 'URL': 1 argument required, but only 0 present.");
    // ToString inline: this is the hot path. The natives read lone surrogates as U+FFFD.
    if (typeof url !== 'string') url = `${url}`;
    if (base !== undefined && typeof base !== 'string') base = `${base}`;
    return urlCanParse(url, base);
  }
  get href() { return this.#c[0]; }
  set href(value) {
    value = text(value);
    const record = urlParse(value, undefined);
    if (record === undefined) throw invalidURL(value);
    this.#c = record;
    if (this.#query !== null) reset(this.#query, this.#queryText());
  }
  toString() { return this.#c[0]; }
  static {
    urlHref = (value) => (value !== null && typeof value === 'object' && #c in value ? value.#c[0] : undefined);
  }
  toJSON() { return this.#c[0]; }
  get origin() {
    const scheme = this.#c[0].slice(0, this.#c[1]);
    if (specialOrigin.has(scheme)) return this.#c[0].slice(0, this.#c[1] + 1) + '//' + this.host;
    if (scheme === 'blob') {
      const inner = URL.parse(this.pathname);
      if (inner !== null && (inner.protocol === 'http:' || inner.protocol === 'https:')) return inner.origin;
    }
    return 'null';
  }
  get protocol() { return this.#c[0].slice(0, this.#c[1] + 1); }
  set protocol(value) { this.#set(SET_PROTOCOL, value); }
  get username() { return this.#c[0].slice(this.#c[2], this.#c[3]); }
  set username(value) { this.#set(SET_USERNAME, value); }
  get password() {
    return this.#c[4] > this.#c[3] ? this.#c[0].slice(this.#c[3] + 1, this.#c[4]) : '';
  }
  set password(value) { this.#set(SET_PASSWORD, value); }
  get host() { return this.#c[11] === 0 ? '' : this.#c[0].slice(this.#c[5], this.#c[8]); }
  set host(value) { this.#set(SET_HOST, value); }
  get hostname() { return this.#c[0].slice(this.#c[5], this.#c[6]); }
  set hostname(value) { this.#set(SET_HOSTNAME, value); }
  get port() { return this.#c[7] === NONE ? '' : `${this.#c[7]}`; }
  set port(value) { this.#set(SET_PORT, value); }
  get pathname() {
    const end = this.#c[9] !== NONE ? this.#c[9] : this.#c[10] !== NONE ? this.#c[10] : this.#c[0].length;
    return this.#c[0].slice(this.#c[8], end);
  }
  set pathname(value) { this.#set(SET_PATHNAME, value); }
  get search() {
    if (this.#c[9] === NONE) return '';
    const end = this.#c[10] === NONE ? this.#c[0].length : this.#c[10];
    return end - this.#c[9] <= 1 ? '' : this.#c[0].slice(this.#c[9], end);
  }
  set search(value) {
    value = text(value);
    this.#set(SET_SEARCH, value);
    // The list comes from the new query, which the parser stripped of tabs and newlines.
    if (this.#query !== null) reset(this.#query, this.#queryText());
  }
  get searchParams() {
    let query = this.#query;
    if (query === null) {
      query = this.#query = new URLSearchParams();
      attach(query, serialized => { this.#c = urlUpdate(this.#c[0], SET_SEARCH, serialized ?? ''); }, this.#queryText());
    }
    return query;
  }
  get hash() {
    if (this.#c[10] === NONE) return '';
    return this.#c[0].length - this.#c[10] <= 1 ? '' : this.#c[0].slice(this.#c[10]);
  }
  set hash(value) { this.#set(SET_HASH, value); }
  [inspectSymbol](depth, options, inspect) {
    if (typeof depth === 'number' && depth < 0) return this;
    inspect ??= require('util').inspect;
    const constructor = this.constructor ?? URL;
    const object = { __proto__: { constructor } };
    for (const key of ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'searchParams', 'hash']) {
      object[key] = this[key];
    }
    return `${constructor.name} ${inspect(object, options)}`;
  }
}

// WebIDL attributes and operations are enumerable, unlike class members.
for (const target of [URL, URL.prototype, URLSearchParams.prototype]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (key === 'constructor' || key === 'prototype' || key === 'length' || key === 'name') continue;
    Object.defineProperty(target, key, { enumerable: true });
  }
}
Object.defineProperties(URL.prototype, {
  [Symbol.toStringTag]: { value: 'URL', configurable: true },
  [inspectSymbol]: { enumerable: false },
});
Object.defineProperties(URLSearchParams.prototype, {
  [Symbol.toStringTag]: { value: 'URLSearchParams', configurable: true },
  [Symbol.iterator]: { value: URLSearchParams.prototype.entries, configurable: true, writable: true },
  [inspectSymbol]: { enumerable: false },
});
Object.defineProperties(URL, {
  createObjectURL: { value: createObjectURL, writable: true, configurable: true, enumerable: true },
  revokeObjectURL: { value: revokeObjectURL, writable: true, configurable: true, enumerable: true },
});

function domainToASCII(domain) {
  if (domain === undefined && arguments.length === 0) throw failure('ERR_MISSING_ARGS', 'The "domain" argument must be specified');
  return urlDomainToASCII(`${domain}`);
}
function domainToUnicode(domain) {
  if (domain === undefined && arguments.length === 0) throw failure('ERR_MISSING_ARGS', 'The "domain" argument must be specified');
  return urlDomainToUnicode(`${domain}`);
}
// Percent-decodes the bytes of a Buffer into a new one; invalid escapes stay as they are.
function percentDecodeBytes(bytes) {
  const output = require('buffer').Buffer.allocUnsafe(bytes.length);
  let written = 0;
  const hex = code => (code >= 48 && code <= 57 ? code - 48 : (code | 32) >= 97 && (code | 32) <= 102 ? (code | 32) - 87 : -1);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 37 && i + 2 < bytes.length) {
      const high = hex(bytes[i + 1]), low = hex(bytes[i + 2]);
      if (high >= 0 && low >= 0) { output[written++] = high * 16 + low; i += 2; continue; }
    }
    output[written++] = byte;
  }
  return output.subarray(0, written);
}
function windowsOption(options) {
  return options?.windows ?? (require('internal/host').platform === 'win32');
}
function fileURL(value) {
  if (typeof value === 'string') value = new URL(value);
  else if (!(value instanceof URL)) throw new ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], value);
  if (value.protocol !== 'file:') throw failure('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
  return value;
}
function fileURLToPath(value, options) {
  const url = fileURL(value);
  const windows = windowsOption(options);
  let path = url.pathname;
  if (windows ? /%(?:2f|5c)/i.test(path) : /%2f/i.test(path)) {
    throw failure('ERR_INVALID_FILE_URL_PATH', 'File URL path must not include encoded ' + (windows ? '\\ or /' : '/') + ' characters');
  }
  if (!windows && url.hostname !== '') throw failure('ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on ' + process.platform);
  path = decodeURIComponent(path);
  if (!windows) return path;
  path = path.replace(/\//g, '\\');
  if (url.hostname) return '\\\\' + domainToUnicode(url.hostname) + path;
  if (!/^\\[a-zA-Z]:/.test(path)) throw failure('ERR_INVALID_FILE_URL_PATH', 'File URL path must be absolute');
  return path.slice(1);
}
function fileURLToPathBuffer(value, options) {
  const url = fileURL(value);
  const windows = windowsOption(options);
  if (!windows && url.hostname !== '') throw failure('ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on ' + process.platform);
  const { Buffer } = require('buffer');
  let path = url.pathname;
  if (windows) {
    path = path.replace(/\//g, '\\');
    if (url.hostname) path = '\\\\' + domainToUnicode(url.hostname) + path;
    else {
      if (!/^\\[a-zA-Z]:/.test(path)) throw failure('ERR_INVALID_FILE_URL_PATH', 'File URL path must be absolute');
      path = path.slice(1);
    }
  }
  return percentDecodeBytes(Buffer.from(path));
}
function encodePath(path) {
  // Protect bytes interpreted as URL delimiters or stripped by the parser;
  // the URL parser itself applies the standard path percent-encode set.
  return path.replace(/[%\\?#\u0000-\u0020\u007f]/g, character => encodeURIComponent(character));
}
function pathToFileURL(path, options) {
  validateString(path, 'path');
  const windows = windowsOption(options);
  const paths = require('path');
  let resolved = windows ? paths.win32.resolve(path) : paths.posix.resolve(path);
  if (windows && path.startsWith('\\\\')) resolved = path;
  if (windows && resolved.startsWith('\\\\')) {
    const prefix = resolved.startsWith('\\\\?\\UNC\\') ? 8 : 2;
    const end = resolved.indexOf('\\', prefix);
    if (end <= prefix) throw failure('ERR_INVALID_ARG_VALUE', 'Missing UNC server or resource path');
    const host = domainToASCII(resolved.slice(prefix, end));
    if (!host || /[\/:]/.test(host)) throw failure('ERR_INVALID_ARG_VALUE', 'Invalid UNC server name');
    return new URL('file://' + host + encodePath(resolved.slice(end).replace(/\\/g, '/')));
  }
  if (/[\/]$/.test(path) || (windows && /\\$/.test(path))) {
    if (!/[\\/]$/.test(resolved)) resolved += '/';
  }
  if (windows) {
    if (resolved.startsWith('\\\\?\\')) resolved = resolved.slice(4);
    resolved = resolved.replace(/\\/g, '/');
    if (!resolved.startsWith('/')) resolved = '/' + resolved;
  }
  return new URL('file://' + encodePath(resolved));
}
function urlToHttpOptions(url) {
  if (url === null || typeof url !== 'object') throw new ERR_INVALID_ARG_TYPE('url', 'Object', url);
  const { hostname, pathname, port, username, password, search } = url;
  const options = {
    __proto__: null, ...url,
    protocol: url.protocol,
    hostname: hostname && hostname[0] === '[' ? hostname.slice(1, -1) : hostname,
    hash: url.hash, search, pathname,
    path: (pathname || '') + (search || ''), href: url.href,
  };
  if (port !== '') options.port = Number(port);
  if (username || password) options.auth = decodeURIComponent(username) + ':' + decodeURIComponent(password);
  return options;
}
function formatURL(href, fragment, unicode, search, auth) {
  const url = new URL(href);
  if (!fragment) url.hash = '';
  if (!search) url.search = '';
  if (!auth) { url.username = ''; url.password = ''; }
  if (!unicode || !url.hostname || url.hostname.startsWith('[')) return url.href;
  const host = domainToUnicode(url.hostname);
  const credentials = url.username || url.password ? url.username + (url.password ? ':' + url.password : '') + '@' : '';
  return url.protocol + '//' + credentials + host + (url.port ? ':' + url.port : '') + url.pathname + url.search + url.hash;
}
module.exports = {
  URL, URLSearchParams, domainToASCII, domainToUnicode,
  fileURLToPath, fileURLToPathBuffer, pathToFileURL, urlToHttpOptions, formatURL,
  isURLInstance: (value) => urlHref(value) !== undefined, getURLHref: (value) => urlHref(value),
  unsafeProtocol: new Set(['javascript', 'javascript:']),
  hostlessProtocol: new Set(['javascript', 'javascript:']),
  slashedProtocol: new Set(['http', 'http:', 'https', 'https:', 'ftp', 'ftp:', 'gopher', 'gopher:', 'file', 'file:', 'ws', 'ws:', 'wss', 'wss:']),
};
