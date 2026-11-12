// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
//
'use strict';
const host = require('internal/host');
const native = (operation, args = []) => host.osNative(operation, args);
const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_UNKNOWN_CREDENTIAL } } = require('internal/errors');
const { validateUint32 } = require('internal/validators');
const invalid = (name, expected, value) => new ERR_INVALID_ARG_TYPE(name, expected, value);
// node_credentials.cc reports a failed set*id/setgroups/initgroups call with
// env->ThrowErrnoException: "CODE, strerror" and a positive errno.
function credentialCall(operation, args) {
  try { return native(operation, args); }
  catch (cause) {
    if (typeof cause.errno !== 'number' || cause.syscall !== operation) throw cause;
    const errno = Math.abs(cause.errno);
    throw Object.assign(new Error(`${cause.code}, ${host.strerror(errno)}`), { errno, code: cause.code, syscall: operation });
  }
}
function uint32(value, name) {
  validateUint32(value, name);
  return value;
}
function validateId(value, name) {
  if (typeof value === 'number') return uint32(value, name);
  if (typeof value !== 'string') throw invalid(name, ['number', 'string'], value);
  return value;
}
function unknown(value, group) {
  return new ERR_UNKNOWN_CREDENTIAL(group ? 'Group' : 'User', value);
}
function resolve(value, group) {
  if (typeof value === 'number') return value;
  const id = native(group ? 'resolveGroup' : 'resolveUser', [value]);
  if (id === -1) throw unknown(value, group);
  return id;
}
function usage(operation, previous) {
  if (previous) {
    for (const key of ['user', 'system']) {
      const value = previous[key];
      if (typeof value !== 'number' || !(value >= 0 && value <= Number.MAX_SAFE_INTEGER)) {
        if (key === 'user' && (typeof previous !== 'object' || Array.isArray(previous))) throw invalid('prevValue', 'object', previous);
        if (typeof value !== 'number') throw invalid(`prevValue.${key}`, 'number', value);
        throw new ERR_INVALID_ARG_VALUE.RangeError(`prevValue.${key}`, value);
      }
    }
  }
  const result = native(operation);
  return { user: result[0] - (previous ? previous.user : 0), system: result[1] - (previous ? previous.system : 0) };
}
const requestKinds = { FSReqCallback: class FSReqCallback {}, FSReqPromise: class FSReqPromise {} };

function install(process) {
  // Do not replace bootstrap's EventEmitter, scheduling, hrtime, stdio, argv,
  // environment, exit machinery or runtime version metadata.
  Object.defineProperty(process, 'ppid', {
    get() { return native('ppid'); },
    set(value) { Object.defineProperty(process, 'ppid', { value, enumerable: true, configurable: true, writable: true }); },
    enumerable: true, configurable: true,
  });
  process.execPath = native('execPath');
  if (process.features === undefined) process.features = host.processFeatures;
  process.getuid = function getuid() { return native('getuid'); };
  process.geteuid = function geteuid() { return native('geteuid'); };
  process.getgid = function getgid() { return native('getgid'); };
  process.getegid = function getegid() { return native('getegid'); };
  process.getgroups = function getgroups() { return native('getgroups'); };
  for (const operation of ['setuid', 'seteuid', 'setgid', 'setegid']) {
    const group = operation.endsWith('gid');
    process[operation] = { [operation](id) {
      validateId(id, 'id');
      credentialCall(operation, [resolve(id, group)]);
    } }[operation];
  }
  process.setgroups = function setgroups(groups) {
    if (!Array.isArray(groups)) throw invalid('groups', 'Array', groups);
    for (let i = 0; i < groups.length; i++) validateId(groups[i], `groups[${i}]`);
    const ids = [];
    for (let i = 0; i < groups.length; i++) ids.push(resolve(groups[i], true));
    credentialCall('setgroups', [ids]);
  };
  process.initgroups = function initgroups(user, extraGroup) {
    validateId(user, 'user');
    validateId(extraGroup, 'extraGroup');
    // Looking up a name first also detects a nonexistent user on systems where
    // initgroups itself would otherwise succeed with only the extra group.
    // Node looks the group up before passing a user name to initgroups.
    const gid = resolve(extraGroup, true);
    const uid = resolve(user, false);
    try { credentialCall('initgroups', [uid, gid]); }
    catch (error) {
      if (error.syscall === 'uv_os_get_passwd2' && (error.code === 'ENOENT' || error.code === 'ESRCH')) throw unknown(user, false);
      throw error;
    }
  };
  process.umask = function umask(mask) {
    if (mask !== undefined) {
      if (typeof mask === 'string') {
        if (!/^[0-7]+$/.test(mask)) throw new ERR_INVALID_ARG_VALUE('mask', mask, 'must be a 32-bit unsigned integer or an octal string');
        mask = parseInt(mask, 8);
      }
      uint32(mask, 'mask');
    }
    return native('umask', [mask]);
  };
  process.cpuUsage = function cpuUsage(previous) { return usage('cpuUsage', previous); };
  process.threadCpuUsage = function threadCpuUsage(previous) { return usage('threadCpuUsage', previous); };
  process.resourceUsage = function resourceUsage() {
    const result = native('resourceUsage');
    return {
      userCPUTime: result[0], systemCPUTime: result[1], maxRSS: result[2],
      sharedMemorySize: result[3], unsharedDataSize: result[4], unsharedStackSize: result[5],
      minorPageFault: result[6], majorPageFault: result[7], swappedOut: result[8],
      fsRead: result[9], fsWrite: result[10], ipcSent: result[11], ipcReceived: result[12],
      signalsCount: result[13], voluntaryContextSwitches: result[14], involuntaryContextSwitches: result[15],
    };
  };
  process.memoryUsage = function memoryUsage() {
    const rss = native('rss');
    const heap = host.heapStatistics();
    return { rss, heapTotal: heap.heapTotal, heapUsed: heap.heapUsed, external: heap.external, arrayBuffers: heap.arrayBuffers };
  };
  process.memoryUsage.rss = function rss() { return native('rss'); };
  process.constrainedMemory = function constrainedMemory() { return native('constrainedMemory'); };
  process.availableMemory = function availableMemory() { return native('availableMemory'); };
  const refSymbol = Symbol.for('nodejs.ref');
  const unrefSymbol = Symbol.for('nodejs.unref');
  const call = Function.prototype.call.bind(Function.prototype.call);
  process.ref = function ref(value) {
    if (value == null) return;
    const fn = value[refSymbol] || value.ref;
    if (typeof fn === 'function') call(fn, value);
  };
  process.unref = function unref(value) {
    if (value == null) return;
    const fn = value[unrefSymbol] || value.unref;
    if (typeof fn === 'function') call(fn, value);
  };
  process.getActiveResourcesInfo = function getActiveResourcesInfo() { return host.activeResources(); };
  process._getActiveHandles = function _getActiveHandles() {
    return require('internal/net/transport').activeOwners();
  };
  process._getActiveRequests = function _getActiveRequests() {
    // The native requests stay native; each pending one is listed by its kind.
    const requests = [];
    for (const name of host.activeResources())
      if (name === 'FSReqCallback' || name === 'FSReqPromise') requests.push(new requestKinds[name]());
    return requests;
  };
  Object.defineProperty(process, 'finalization', {
    configurable: true, enumerable: true,
    get() {
      const value = require('internal/process_finalization').createFinalization(process);
      Object.defineProperty(process, 'finalization', { value, writable: true, configurable: true, enumerable: true });
      return value;
    },
  });
  process.report = require('internal/process_report').createReport(process);
  // A method, as Node's C++ function: no prototype, not a constructor.
  process.abort = { abort() { native('abort'); } }.abort;
  process.execve = require('internal/process/per_thread').execve;
}
module.exports = { install };
