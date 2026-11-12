'use strict';

// Node's internalBinding('os') (src/node_os.cc) over the runtime's os natives. A call that
// can fail fills ctx with errno, code, message and syscall and returns undefined, and
// lib/os.js turns that into ERR_SYSTEM_ERROR.

const host = require('internal/host');
const { Buffer } = require('buffer');

function call(ctx, op, args = []) {
  try { return host.osNative(op, args); }
  catch (cause) {
    if (typeof cause.errno !== 'number' || ctx === undefined) throw cause;
    ctx.errno = cause.errno;
    ctx.code = cause.code;
    ctx.message = cause.message.slice(cause.message.indexOf(': ') + 2, cause.message.lastIndexOf(', '));
    ctx.syscall = cause.syscall;
    return undefined;
  }
}

function getHostname(ctx) { return call(ctx, 'hostname'); }
function getHomeDirectory(ctx) { return call(ctx, 'homedir'); }
function getUptime(ctx) { return call(ctx, 'uptime'); }
function getTotalMem() { return call(undefined, 'totalmem'); }
function getFreeMem() { return call(undefined, 'freemem'); }
function getAvailableParallelism() { return call(undefined, 'availableParallelism'); }
// [model, speed, user, nice, sys, idle, irq] for each CPU.
function getCPUs() { return call(undefined, 'cpus'); }
function getLoadAvg(array) {
  const values = call(undefined, 'loadavg');
  array[0] = values[0]; array[1] = values[1]; array[2] = values[2];
}
// [sysname, version, release, machine], as uv_os_uname gives them to node_os.cc.
function getOSInformation(ctx) {
  const fields = call(ctx, 'uname');
  return fields === undefined ? undefined : [fields[0], fields[2], fields[1], fields[3]];
}
// [name, address, netmask, family, mac, internal, scopeid] for each address.
function getInterfaceAddresses(ctx) {
  const data = call(ctx, 'networkInterfaces');
  if (data === undefined) return undefined;
  const result = [];
  for (let i = 0; i < data.length; i += 7) {
    result.push(data[i], data[i + 1], data[i + 2], data[i + 3] === 4 ? 'IPv4' : 'IPv6', data[i + 4], data[i + 5], data[i + 6]);
  }
  return result;
}
function getUserInfo(options, ctx) {
  let encoding = options && typeof options === 'object' ? options.encoding : undefined;
  // ParseEncoding: unknown and non-string encodings are UTF-8, not a validation error.
  encoding = typeof encoding === 'string' ? encoding.split('\0', 1)[0].toLowerCase() : 'utf8';
  if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) encoding = 'utf8';
  const data = call(ctx, 'userInfo');
  if (data === undefined) return undefined;
  const convert = value => value === null ? null : encoding === 'buffer' ? Buffer.from(value) : Buffer.from(value).toString(encoding);
  return { uid: data[0], gid: data[1], username: convert(data[2]), homedir: convert(data[3]), shell: convert(data[4]) };
}
function getPriority(pid, ctx) { return call(ctx, 'getPriority', [pid]); }
// 0, or the error code with ctx filled.
function setPriority(pid, priority, ctx) {
  ctx.errno = undefined;
  call(ctx, 'setPriority', [pid, priority]);
  return ctx.errno === undefined ? 0 : ctx.errno;
}

module.exports = {
  getHostname, getHomeDirectory, getUptime, getTotalMem, getFreeMem, getAvailableParallelism, getCPUs,
  getLoadAvg, getOSInformation, getInterfaceAddresses, getUserInfo, getPriority, setPriority,
  isBigEndian: new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 1,
};
