'use strict';

// Policy lives in a private builtin closure. The host retains checkNative in a
// one-shot native slot; mutating process.permission cannot change enforcement.
const host = require('internal/host');
const { Buffer } = require('buffer');
const uncurry = fn => Function.prototype.call.bind(fn);
const slice = uncurry(String.prototype.slice);
const starts = uncurry(String.prototype.startsWith);
const indexOf = uncurry(String.prototype.indexOf);
function split(text, separator) {
  const parts = []; let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === separator) { push(parts, slice(text, start, i)); start = i + 1; }
  }
  return parts;
}
const join = uncurry(Array.prototype.join);
function push(array, ...values) {
  for (let i = 0; i < values.length; i++) define(array, array.length, { value: values[i], writable: true, enumerable: true, configurable: true });
}
const pop = uncurry(Array.prototype.pop);
const bufferText = uncurry(Buffer.prototype.toString);
const isBuffer = Buffer.isBuffer;
const own = uncurry(Object.prototype.hasOwnProperty);
const keys = Object.keys;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const apply = Reflect.apply;
const ErrorClass = Error;
const TypeErrorClass = TypeError;
const rawStat = host.rawOS.stat;
const rawCwd = host.rawOS.getcwd;
const writingFlags = host.rawOS.O_CREAT | host.rawOS.O_TRUNC | host.rawOS.O_APPEND;
const names = freeze({ 'fs': 'FileSystem', 'fs.read': 'FileSystemRead', 'fs.write': 'FileSystemWrite',
  child: 'ChildProcess', worker: 'WorkerThreads', addon: 'Addon', wasi: 'WASI', inspector: 'Inspector',
  'openssl.store': 'OpenSSLStore' });
const suggestions = freeze({ 'fs.read': '--allow-fs-read', 'fs.write': '--allow-fs-write',
  child: '--allow-child-process', worker: '--allow-worker', addon: '--allow-addons',
  wasi: '--allow-wasi', inspector: '--allow-inspector', 'openssl.store': '--allow-openssl-store' });
const flags = freeze({ '--permission': 'enforce',
  '--permission-audit': 'audit', '--allow-child-process': 'child', '--allow-worker': 'worker',
  '--allow-addons': 'addon', '--allow-wasi': 'wasi', '--allow-inspector': 'inspector',
  '--allow-openssl-store': 'openssl.store' });
const optionEntries = [];
for (const name of keys(flags)) push(optionEntries, [name, false], ['--no-' + slice(name, 2), false]);
push(optionEntries, ['--allow-fs-read', true], ['--allow-fs-write', true]);
const state = create(null);
state.enforce = false;
state.audit = false;
let readGrants = [];
let writeGrants = [];
let initialized = false;
let addonsDisabled = false;
let channels;
let publishing = false;

function isValueOption(name) { return name === '--allow-fs-read' || name === '--allow-fs-write'; }
function applyOption(arg) {
  const separator = indexOf(arg, '=');
  const name = separator < 0 ? arg : slice(arg, 0, separator);
  if (isValueOption(name)) {
    if (separator < 0 || separator === arg.length - 1) throw new ErrorClass(name + ' requires an argument');
    push(name === '--allow-fs-read' ? readGrants : writeGrants, slice(arg, separator + 1));
    return true;
  }
  const positive = starts(name, '--no-') ? '--' + slice(name, 5) : name;
  if (!own(flags, positive)) return false;
  state[flags[positive]] = positive === name;
  return true;
}
// Node words these as for a string only, although a reference may also be a Buffer.
function invalid(name, value) {
  const error = new TypeErrorClass('The "' + name + '" argument must be of type string. Received ' + require('internal/errors').determineSpecificType(value));
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}
function cwd() {
  const result = rawCwd();
  if (result[1]) throw new ErrorClass('Unable to resolve permission path: getcwd failed');
  return result[0];
}
function normalize(path, base) {
  if (path[0] !== '/') path = (base === undefined ? cwd() : base) + '/' + path;
  const parts = split(path, '/'), result = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '..') pop(result);
    else if (part && part !== '.') push(result, part);
  }
  return '/' + join(result, '/');
}
function filePath(value) {
  if (isBuffer(value)) value = bufferText(value);
  if (typeof value !== 'string') throw invalid('reference', value);
  if (indexOf(value, '\0') !== -1) {
    const error = new TypeErrorClass('Path must not contain null bytes'); error.code = 'ERR_INVALID_ARG_VALUE'; throw error;
  }
  return normalize(value);
}
function grant(value) {
  if (value === '*') return { path: '*', original: '*', prefix: true };
  const original = normalize(value);
  const star = indexOf(original, '*');
  const path = normalize(star < 0 ? original : slice(original, 0, star));
  const info = rawStat(original);
  const directory = !info[1] && (info[0].mode & 0o170000) === 0o040000;
  // A slash before '*' is significant: /tmp/a/* does not grant /tmp/ab.
  const slash = star > 0 && original[star - 1] === '/';
  return { path, original: directory ? (original === '/' ? '/*' : original + '/*') : original,
    prefix: star >= 0, directory: (star < 0 && directory) || slash };
}
function parseGrants(values) {
  const grants = [];
  for (let i = 0; i < values.length; i++) {
    const entry = grant(values[i]);
    if (!matches(grants, entry.original)) push(grants, entry);
  }
  return grants;
}
function matches(grants, path) {
  for (let i = 0; i < grants.length; i++) {
    const item = grants[i];
    if (item.path === '*') return true;
    if (path === item.path) return true;
    if (item.directory && starts(path, item.path === '/' ? '/' : item.path + '/')) return true;
    if (item.prefix && !item.directory && starts(path, item.path)) return true;
  }
  return false;
}
function granted(scope, resource) {
  if (scope === 'fs') return granted('fs.read') && granted('fs.write');
  if (scope === 'fs.read' || scope === 'fs.write') {
    const grants = scope === 'fs.read' ? readGrants : writeGrants;
    if (resource === undefined || resource === null) return matches(grants, '*');
    if (resource === '') return false;
    return matches(grants, filePath(resource));
  }
  return own(names, scope) && state[scope] === true;
}
function has(scope, reference) {
  if (typeof scope !== 'string') throw invalid('scope', scope);
  if (reference != null && typeof reference !== 'string' && !isBuffer(reference)) throw invalid('reference', reference);
  if (reference === null) reference = 'null';
  if (isBuffer(reference)) reference = bufferText(reference);
  if (reference === '') return false;
  const result = granted(scope, reference);
  if (!result && own(names, scope)) publish(scope, reference === undefined ? '' : reference);
  return result;
}
function denied(scope, resource) {
  const flag = suggestions[scope];
  const error = new ErrorClass('Access to this API has been restricted. ' + (flag ? `Use ${flag} to manage permissions.` : ''));
  error.code = 'ERR_ACCESS_DENIED'; error.permission = names[scope]; error.resource = resource;
  return error;
}
function apiDenied(message) {
  const error = new ErrorClass(message);
  error.code = 'ERR_ACCESS_DENIED'; error.permission = ''; error.resource = '';
  return error;
}
function check(scope, resource = '') {
  if (!initialized || (!state.enforce && !state.audit)) return;
  if (granted(scope, resource)) return;
  violation(scope, resource);
}
function canRead(resource) {
  return !initialized || (!state.enforce && !state.audit) || has('fs.read', resource);
}
function violation(scope, resource) {
  const value = typeof resource === 'string' ? resource : isBuffer(resource) ? bufferText(resource) : '';
  publish(scope, value);
  if (state.enforce && !state.audit) throw denied(scope, value);
}
function publish(scope, resource, dropped) {
  if (publishing || !channels) return;
  const channel = channels[scope === 'fs' || scope === 'fs.read' || scope === 'fs.write' ? 'fs' : scope === 'openssl.store' ? 'openssl-store' : scope];
  if (!channel) return;
  publishing = true;
  try { channel.publish({ permission: names[scope], resource: isBuffer(resource) ? bufferText(resource) : resource, drop: dropped }); }
  finally { publishing = false; }
}
function drop(scope, reference) {
  if (typeof scope !== 'string') throw invalid('scope', scope);
  if (reference != null && typeof reference !== 'string' && !isBuffer(reference)) throw invalid('reference', reference);
  if (reference === null) reference = 'null';
  if (isBuffer(reference)) reference = bufferText(reference);
  if (scope === 'fs') {
    dropScope('fs.read', reference); dropScope('fs.write', reference);
  } else if (own(names, scope)) dropScope(scope, reference);
  else return;
  publish(scope, reference == null ? '' : reference, true);
}
function dropScope(scope, reference) {
  if (scope === 'fs.read' || scope === 'fs.write') {
    const grants = scope === 'fs.read' ? readGrants : writeGrants, keep = [];
    const path = reference == null || reference === '' ? null : grant(filePath(reference)).original;
    if (path !== null) {
      if (matches(grants, '*')) return;
      for (let i = 0; i < grants.length; i++) if (grants[i].original !== path) push(keep, grants[i]);
    }
    if (scope === 'fs.read') readGrants = keep; else writeGrants = keep;
  } else if (own(names, scope)) state[scope] = false;
}
function checkFile(op, args) {
  // Every case below checks only with the Permission Model or its audit on.
  if (!initialized || (!state.enforce && !state.audit)) return;
  const path = args[0];
  switch (op) {
    case 'close': case 'read': case 'pread': case 'readv': case 'write': case 'pwrite': case 'writev': case 'fstat': case 'futimes': case 'ftruncate': return;
    case 'fsync': case 'fdatasync': case 'fchmod': case 'fchown':
      if (initialized && state.enforce) throw apiDenied(`${op} API is disabled when Permission Model is enabled.`);
      return;
    case 'lstat':
      if (initialized && state.enforce && !has('fs.read', path)) {
        const error = apiDenied('Access to this API has been restricted');
        error.permission = names['fs.read']; error.resource = isBuffer(path) ? bufferText(path) : path;
        throw error;
      }
      check('fs.read', path); return;
    case 'open': {
      const flags = args[1], mode = flags & 3;
      if (mode !== 1) check('fs.read', path);
      if (mode !== 0 || (flags & writingFlags)) check('fs.write', path);
      return;
    }
    case 'copyFile': case 'copyfile': check('fs.read', path); check('fs.write', args[1]); return;
    case 'rename': case 'link': check('fs.read', path); check('fs.write', path); check('fs.write', args[1]); return;
    case 'symlink':
      if (initialized && state.enforce && !has('fs')) throw apiDenied('fs.symlink API requires full fs.read and fs.write permissions.');
      check('fs.read', path); check('fs.write', path); check('fs.write', args[1]); return;
    case 'access': check('fs.read', path); return;
    case 'mkdir': case 'mkdtemp': case 'unlink': case 'rmdir': case 'chmod': case 'lchmod': case 'chown': case 'lchown': case 'truncate': case 'utimes': case 'lutimes':
      check('fs.write', path); return;
    default: check('fs.read', path);
  }
}
function checkNative(id, op, args, third) {
  if (id === 2000 || id === 2001) return checkFile(op, args);
  if (id === 2002) return check('fs.read', op);
  if (id === 2700 && (op === 'spawn' || op === 'spawnSync')) return check('child', args[0]);
  if (id === 6000 && op === 'startWorker') return check('worker', '');
  if (id === 14000 && op === 1) {
    if (addonsDisabled) {
      const error = new ErrorClass('Cannot load native addon because loading addons is disabled.');
      error.code = 'ERR_DLOPEN_DISABLED';
      throw error;
    }
    return check('addon', '');
  }
  if (id === 10000 && op === 0) return check('wasi', '');
  if (id === 15001 || (id === 15007 && op) || (id === 15020 && op) ||
      (id === 15015 && op === true) || (id === 15017 && op) ||
      (id === 15006 && third === 1)) return check('inspector', '');
  if (id === 7000) {
    if (op === 'enableExtension' && args[1] && initialized && (state.enforce || state.audit)) {
      const error = new ErrorClass('Cannot load SQLite extensions when the permission model is enabled.');
      error.code = 'ERR_LOAD_SQLITE_EXTENSION';
      throw error;
    }
    if (op === 'loadExtension') check('fs.read', args[1]);
  }
}
function wrapHostIO() {
  // Legacy QuickJS IO is never exported to a user module. Wrap its private
  // runtime facade too, so loader/cache/glob/native-consumer paths share policy.
  const os = host.rawOS;
  for (const op of ['open', 'stat', 'lstat', 'access', 'realpath', 'readlink', 'readdir', 'rename', 'symlink', 'mkdir', 'remove', 'utimes', 'chdir']) {
    const fn = os[op];
    if (typeof fn !== 'function') continue;
    os[op] = function(...args) { checkFile(op === 'remove' ? 'unlink' : op, args); return apply(fn, undefined, args); };
  }
  for (const name of ['readFile', 'stat', 'realpath']) {
    const fn = host[name];
    if (typeof fn === 'function') host[name] = function(...args) { check('fs.read', args[0]); return apply(fn, undefined, args); };
  }
  const std = host.rawStd;
  for (const name of ['open', 'loadFile', 'loadScript']) {
    const fn = std[name];
    if (typeof fn !== 'function') continue;
    std[name] = function(...args) {
      if (!initialized || (!state.enforce && !state.audit)) return apply(fn, undefined, args);
      const path = args[0], mode = args[1];
      if (name !== 'open' || indexOf(mode, 'r') !== -1 || indexOf(mode, '+') !== -1) check('fs.read', path);
      if (name === 'open' && (indexOf(mode, 'w') !== -1 || indexOf(mode, 'a') !== -1 || indexOf(mode, '+') !== -1)) check('fs.write', path);
      return apply(fn, undefined, args);
    };
  }
  if (typeof std.popen === 'function') { const fn = std.popen; std.popen = function(...args) { check('child', args[0]); return apply(fn, undefined, args); }; }
}
function initialize(options = {}) {
  if (initialized) return;
  if (!state.enforce && !state.audit && (readGrants.length || writeGrants.length)) {
    const error = new TypeErrorClass('--permission is required');
    error.code = 'ERR_MISSING_OPTION';
    throw error;
  }
  if (state.enforce || state.audit) {
    addonsDisabled = !state.addon;
    freeze(require('path'));
    process.binding = function binding() { throw apiDenied('process.binding'); };
    const warningFlags = [
      ['--allow-addons', 'addon', 'PERM0001'],
      ['--allow-child-process', 'child', 'PERM0002'],
      ['--allow-inspector', 'inspector', 'PERM0004'],
      ['--allow-wasi', 'wasi', 'PERM0005'],
      ['--allow-worker', 'worker', 'PERM0006'],
      ['--allow-openssl-store', 'openssl.store', 'PERM0007'],
    ];
    for (const [flag, scope, code] of warningFlags) if (state[scope]) {
      process.emitWarning(`The flag ${flag} must be used with extreme caution. It could invalidate the permission model.`, 'SecurityWarning', code);
    }
    for (const [flag, grants] of [['--allow-fs-read', readGrants], ['--allow-fs-write', writeGrants]]) {
      if (grants.length === 1 && indexOf(grants[0], ',') !== -1) {
        process.emitWarning(`The ${flag} CLI flag has changed. Passing a comma-separated list of paths is no longer valid. Documentation can be found at https://nodejs.org/api/permissions.html#file-system-permissions`, 'Warning');
      }
    }
  }
  readGrants = parseGrants(readGrants);
  writeGrants = parseGrants(writeGrants);
  const entries = options.entrypoints || [];
  for (let i = 0; i < entries.length; i++) if (typeof entries[i] === 'string' && entries[i]) {
    const entry = grant(entries[i]);
    if (!matches(readGrants, entry.original)) push(readGrants, entry);
  }
  if (state.enforce || state.audit) {
    const channel = require('diagnostics_channel').channel;
    channels = create(null);
    for (const name of ['fs', 'child', 'worker', 'addon', 'wasi', 'inspector', 'openssl-store']) {
      const target = channel('node:permission-model:' + name);
      channels[name] = { publish(message) { target.publish(message); } };
    }
    define(process, 'permission', { value: { has, drop }, enumerable: true, writable: false, configurable: false });
  }
  // Without --permission or --permission-audit every check passes, so host IO and native
  // calls skip the guard entirely instead of calling into JavaScript for each one.
  if (state.enforce || state.audit) {
    wrapHostIO();
    host.installPermissionGuard(checkNative);
  }
  initialized = true;
}
module.exports = { optionEntries, isValueOption, applyOption, initialize, check, canRead, checkFile, checkNative,
  enabled: () => initialized && (state.enforce || state.audit) };
