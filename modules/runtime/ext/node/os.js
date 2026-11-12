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
const { Buffer } = require('buffer');
const darwin = host.platform === 'darwin';
const { validateInteger } = require('internal/validators');
function integer(value, name, min = -2147483648, max = 2147483647) {
  validateInteger(value, name, min, max);
  return value;
}
// lib/os.js: each call reads the binding's function then, so a patched binding is used.
const binding = require('internal/os_binding');
function systemError(ctx) {
  // Node's os.js throws ERR_SYSTEM_ERROR with the context the binding filled.
  return new (require('internal/errors').codes.ERR_SYSTEM_ERROR)(ctx);
}
function checked(name, ...args) {
  const ctx = {};
  const result = binding[name](...args, ctx);
  if (result === undefined) throw systemError(ctx);
  return result;
}
// Read on first use: a heap image may hold this module, loaded on another machine.
let unameFields;
const uname = () => unameFields ||= checked('getOSInformation');
function arch() { return host.arch; }
function platform() { return host.platform; }
function availableParallelism() { return binding.getAvailableParallelism(); }
function freemem() { return binding.getFreeMem(); }
function totalmem() { return binding.getTotalMem(); }
function hostname() { return checked('getHostname'); }
function homedir() { return checked('getHomeDirectory'); }
function tmpdir() {
  // Node's POSIX precedence differs from uv_os_tmpdir (which only uses TMPDIR).
  let path = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
function type() { return uname()[0]; }
function version() { return uname()[1]; }
function release() { return uname()[2]; }
function machine() { return uname()[3]; }
function uptime() { return checked('getUptime'); }
function endianness() { return binding.isBigEndian ? 'BE' : 'LE'; }
function loadavg() {
  const values = [0, 0, 0];
  binding.getLoadAvg(values);
  return values;
}
function cpus() {
  const data = binding.getCPUs();
  const result = [];
  for (let i = 0; i < data.length; i += 7)
    result.push({ model: data[i], speed: data[i + 1], times: { user: data[i + 2], nice: data[i + 3], sys: data[i + 4], idle: data[i + 5], irq: data[i + 6] } });
  return result;
}
function networkInterfaces() {
  const data = checked('getInterfaceAddresses');
  const result = {};
  for (let i = 0; i < data.length; i += 7) {
    const name = data[i];
    const family = data[i + 3];
    const entry = { address: data[i + 1], netmask: data[i + 2], family, mac: data[i + 4], internal: data[i + 5], cidr: require('internal/util').getCIDR(data[i + 1], data[i + 2], family) };
    if (data[i + 6] !== -1) entry.scopeid = data[i + 6];
    if (Object.prototype.hasOwnProperty.call(result, name)) result[name].push(entry);
    else Object.defineProperty(result, name, { value: [entry], enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function getPriority(pid) { return checked('getPriority', integer(pid === undefined ? 0 : pid, 'pid')); }
function setPriority(pid, priority) {
  if (priority === undefined) { priority = pid; pid = 0; }
  integer(pid, 'pid'); integer(priority, 'priority', -20, 19);
  const ctx = {};
  if (binding.setPriority(pid, priority, ctx) !== 0) throw systemError(ctx);
}
function userInfo(options) {
  return checked('getUserInfo', options);
}
// These are platform ABI constants, not sampled system state. Linux values are
// the asm-generic errno/signal ABI used by the supported x64/arm64 targets.
const errno = Object.assign(Object.create(null), {
  E2BIG: 7, EACCES: 13, EBADF: 9, EBUSY: 16, ECHILD: 10, EDOM: 33,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EINTR: 4, EINVAL: 22, EIO: 5,
  EISDIR: 21, EMFILE: 24, EMLINK: 31, ENFILE: 23, ENODEV: 19,
  ENOENT: 2, ENOEXEC: 8, ENOMEM: 12, ENOSPC: 28, ENOTDIR: 20,
  ENOTTY: 25, ENXIO: 6, EPERM: 1, EPIPE: 32, ERANGE: 34, EROFS: 30,
  ESPIPE: 29, ESRCH: 3, EXDEV: 18,
}, darwin ? {
  EADDRINUSE: 48, EADDRNOTAVAIL: 49, EAFNOSUPPORT: 47, EAGAIN: 35, EALREADY: 37,
  EBADMSG: 94, ECANCELED: 89, ECONNABORTED: 53, ECONNREFUSED: 61, ECONNRESET: 54,
  EDEADLK: 11, EDESTADDRREQ: 39, EDQUOT: 69, EHOSTUNREACH: 65, EIDRM: 90,
  EILSEQ: 92, EINPROGRESS: 36, EISCONN: 56, ELOOP: 62, EMSGSIZE: 40,
  EMULTIHOP: 95, ENAMETOOLONG: 63, ENETDOWN: 50, ENETRESET: 52, ENETUNREACH: 51,
  ENOBUFS: 55, ENODATA: 96, ENOLCK: 77, ENOLINK: 97, ENOMSG: 91,
  ENOPROTOOPT: 42, ENOSR: 98, ENOSTR: 99, ENOSYS: 78, ENOTCONN: 57,
  ENOTEMPTY: 66, ENOTSOCK: 38, ENOTSUP: 45, EOPNOTSUPP: 102, EOVERFLOW: 84,
  EPROTO: 100, EPROTONOSUPPORT: 43, EPROTOTYPE: 41, ETIME: 101, ETIMEDOUT: 60,
  ETXTBSY: 26, EWOULDBLOCK: 35, ESTALE: 70,
} : {
  EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11, EALREADY: 114,
  EBADMSG: 74, ECANCELED: 125, ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104,
  EDEADLK: 35, EDESTADDRREQ: 89, EDQUOT: 122, EHOSTUNREACH: 113, EIDRM: 43,
  EILSEQ: 84, EINPROGRESS: 115, EISCONN: 106, ELOOP: 40, EMSGSIZE: 90,
  EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101,
  ENOBUFS: 105, ENODATA: 61, ENOLCK: 37, ENOLINK: 67, ENOMSG: 42,
  ENOPROTOOPT: 92, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107,
  ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, EOPNOTSUPP: 95, EOVERFLOW: 75,
  EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ETIME: 62, ETIMEDOUT: 110,
  ETXTBSY: 26, EWOULDBLOCK: 11, ESTALE: 116,
});
const signals = Object.assign(Object.create(null), {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGIOT: 6, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
}, darwin ? {
  SIGBUS: 10, SIGUSR1: 30, SIGUSR2: 31, SIGCHLD: 20, SIGCONT: 19,
  SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 16,
  SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
  SIGIO: 23, SIGINFO: 29, SIGSYS: 12,
} : {
  SIGBUS: 7, SIGUSR1: 10, SIGUSR2: 12, SIGCHLD: 17, SIGSTKFLT: 16,
  SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
  SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
});
Object.freeze(signals);
const constants = Object.assign(Object.create(null), {
  UV_UDP_REUSEADDR: 4,
  dlopen: Object.assign(Object.create(null), { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: darwin ? 8 : 256, RTLD_LOCAL: darwin ? 4 : 0, RTLD_DEEPBIND: 8 }),
  errno, signals,
  priority: Object.assign(Object.create(null), { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }),
});
if (darwin) delete constants.dlopen.RTLD_DEEPBIND;
for (const fn of [arch, availableParallelism, endianness, freemem, homedir, hostname, platform, release, tmpdir, totalmem, type, uptime, version, machine])
  fn[Symbol.toPrimitive] = () => fn();
module.exports = { arch, availableParallelism, cpus, endianness, freemem, getPriority, homedir, hostname, loadavg, networkInterfaces, platform, release, setPriority, tmpdir, totalmem, type, userInfo, uptime, version, machine };
Object.defineProperties(module.exports, {
  constants: { value: constants, enumerable: true },
  EOL: { value: '\n', enumerable: true, configurable: true },
  devNull: { value: '/dev/null', enumerable: true, configurable: true },
});
