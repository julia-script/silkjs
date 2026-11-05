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
function invalid(name, type) {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${type}`), { code: 'ERR_INVALID_ARG_TYPE' });
}
function integer(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw invalid(name, 'number');
  if (!Number.isInteger(value) || value < min || value > max)
    throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`), { code: 'ERR_OUT_OF_RANGE' });
  return value;
}
function native(op, args = []) {
  try { return host.osNative(op, args); }
  catch (cause) {
    if (typeof cause.errno !== 'number') throw cause;
    const message = cause.message.slice(cause.message.indexOf(': ') + 2, cause.message.lastIndexOf(', '));
    const info = { errno: cause.errno, code: cause.code, message, syscall: cause.syscall };
    const error = new Error(`A system error occurred: ${info.syscall} returned ${info.code} (${info.message})`);
    Object.assign(error, { code: 'ERR_SYSTEM_ERROR', info, errno: info.errno, syscall: info.syscall });
    throw error;
  }
}
const uname = native('uname');
function arch() { return host.arch; }
function platform() { return host.platform; }
function availableParallelism() { return native('availableParallelism'); }
function freemem() { return native('freemem'); }
function totalmem() { return native('totalmem'); }
function hostname() { return native('hostname'); }
function homedir() { return native('homedir'); }
function tmpdir() {
  // Node's POSIX precedence differs from uv_os_tmpdir (which only uses TMPDIR).
  let path = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
function type() { return uname[0]; }
function release() { return uname[1]; }
function version() { return uname[2]; }
function machine() { return uname[3]; }
function uptime() { return native('uptime'); }
const byteOrder = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 1 ? 'BE' : 'LE';
function endianness() { return byteOrder; }
function loadavg() { return native('loadavg'); }
function cpus() {
  const data = native('cpus');
  const result = [];
  for (let i = 0; i < data.length; i += 7)
    result.push({ model: data[i], speed: data[i + 1], times: { user: data[i + 2], nice: data[i + 3], sys: data[i + 4], idle: data[i + 5], irq: data[i + 6] } });
  return result;
}
function cidr(address, mask, family) {
  let bytes;
  if (family === 'IPv4') bytes = mask.split('.').map(Number);
  else {
    const halves = mask.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const words = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    bytes = [];
    for (const word of words) { const n = parseInt(word, 16); bytes.push(n >>> 8, n & 255); }
  }
  let bits = 0;
  let zero = false;
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) {
    if (byte & (1 << bit)) { if (zero) return null; bits++; } else zero = true;
  }
  return `${address}/${bits}`;
}
function networkInterfaces() {
  const data = native('networkInterfaces');
  const result = {};
  for (let i = 0; i < data.length; i += 7) {
    const name = data[i];
    const family = data[i + 3] === 4 ? 'IPv4' : 'IPv6';
    const entry = { address: data[i + 1], netmask: data[i + 2], family, mac: data[i + 4], internal: data[i + 5], cidr: cidr(data[i + 1], data[i + 2], family) };
    if (data[i + 6] !== -1) entry.scopeid = data[i + 6];
    if (Object.prototype.hasOwnProperty.call(result, name)) result[name].push(entry);
    else Object.defineProperty(result, name, { value: [entry], enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function getPriority(pid) { return native('getPriority', [integer(pid === undefined ? 0 : pid, 'pid')]); }
function setPriority(pid, priority) {
  if (priority === undefined) { priority = pid; pid = 0; }
  native('setPriority', [integer(pid, 'pid'), integer(priority, 'priority', -20, 19)]);
}
function userInfo(options) {
  let encoding = options && typeof options === 'object' ? options.encoding : undefined;
  // os.userInfo uses Node's native ParseEncoding, which defaults unknown and
  // non-string encodings to UTF-8 rather than Buffer's throwing validation.
  encoding = typeof encoding === 'string' ? encoding.split('\0', 1)[0].toLowerCase() : 'utf8';
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) encoding = 'utf8';
  const data = native('userInfo');
  const convert = value => value === null ? null : encoding === 'buffer' ? Buffer.from(value) : Buffer.from(value).toString(encoding);
  return { uid: data[0], gid: data[1], username: convert(data[2]), homedir: convert(data[3]), shell: convert(data[4]) };
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
