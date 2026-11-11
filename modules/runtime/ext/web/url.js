'use strict';

const whatwg = require('internal/web/vendor/whatwg-url/index');
const { URL, URLSearchParams } = whatwg;
let tr46Module;
const tr46 = { toUnicode: (...args) => (tr46Module ||= require('internal/web/vendor/tr46/index')).toUnicode(...args) };
const { createObjectURL, revokeObjectURL } = require('internal/web/blob');
const { validateString, codes: { ERR_INVALID_ARG_TYPE } } = require('internal/path_events/support');
const idnaOptions = { checkHyphens: false, checkBidi: true, checkJoiners: true, useSTD3ASCIIRules: false, transitionalProcessing: false, verifyDNSLength: false };
Object.defineProperties(URL, {
  createObjectURL: { value: createObjectURL, writable: true, configurable: true },
  revokeObjectURL: { value: revokeObjectURL, writable: true, configurable: true },
});
function failure(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}
function domainToASCII(domain) {
  if (arguments.length === 0) throw failure('ERR_MISSING_ARGS', 'The "domain" argument must be specified');
  if (typeof domain === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  domain = String(domain);
  if (!domain) return '';
  const url = whatwg.parseURL('ws://x');
  const parsed = whatwg.basicURLParse(domain, { url, stateOverride: 'hostname' });
  return parsed === null ? '' : whatwg.serializeHost(url.host);
}
function domainToUnicode(domain) {
  if (arguments.length === 0) throw failure('ERR_MISSING_ARGS', 'The "domain" argument must be specified');
  const ascii = domainToASCII(domain);
  return ascii ? tr46.toUnicode(ascii, idnaOptions).domain : '';
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
  if (!windows && url.hostname !== '') throw failure('ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty');
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
  if (!windows && url.hostname !== '') throw failure('ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty');
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
  return Buffer.from(whatwg.percentDecodeBytes(Buffer.from(path)));
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
  unsafeProtocol: new Set(['javascript', 'javascript:']),
  hostlessProtocol: new Set(['javascript', 'javascript:']),
  slashedProtocol: new Set(['http', 'http:', 'https', 'https:', 'ftp', 'ftp:', 'gopher', 'gopher:', 'file', 'file:', 'ws', 'ws:', 'wss', 'wss:']),
};
