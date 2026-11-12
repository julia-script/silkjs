// Adapted from Node.js v24.22.1 lib/internal/net.js by tools/port_node_net.py.
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

'use strict';

const {
  RegExp,
  RegExpPrototypeTest,
  Symbol,
} = require('internal/per_context/primordials');

const Buffer = require('buffer').Buffer;
const { writeSync } = require('fs');

// IPv4 Segment
const v4Seg = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);

// IPv6 Segment
const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp('^(?:' +
  `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
  `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
  `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
  `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
  `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
  `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
  `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
  `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
')(?:%[0-9a-zA-Z-.:]{1,})?$');

/**
 * @param {string} s
 * @returns {boolean}
 */
function isIPv4(s) {
  // TODO(aduh95): Replace RegExpPrototypeTest with RegExpPrototypeExec when it
  // no longer creates a perf regression in the dns benchmark.
  // eslint-disable-next-line node-core/avoid-prototype-pollution
  return RegExpPrototypeTest(IPv4Reg, s);
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isIPv6(s) {
  // TODO(aduh95): Replace RegExpPrototypeTest with RegExpPrototypeExec when it
  // no longer creates a perf regression in the dns benchmark.
  // eslint-disable-next-line node-core/avoid-prototype-pollution
  return RegExpPrototypeTest(IPv6Reg, s);
}

/**
 * @param {string} s
 * @returns {4|6|0}
 */
function isIP(s) {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}

function makeSyncWrite(fd) {
  return function(chunk, enc, cb) {
    if (enc !== 'buffer')
      chunk = Buffer.from(chunk, enc);

    this._handle.bytesWritten += chunk.length;

    // silkjs: fs.writeSync reports the same UVException that Node builds from ctx.
    try {
      writeSync(fd, chunk, 0, chunk.length, null);
    } catch (ex) {
      return cb(ex);
    }
    cb();
  };
}

/**
 * https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
 * https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
 * https://www.iana.org/assignments/special-use-domain-names/special-use-domain-names.xhtml
 * @param {string} host
 * @returns {boolean}
 */
function isLoopback(host) {
  const hostLower = host.toLowerCase();

  return (
    hostLower === 'localhost' ||
    hostLower.startsWith('127.') ||
    hostLower === '[::1]' ||
    hostLower === '::1' ||
    hostLower === '[0:0:0:0:0:0:0:1]' ||
    hostLower === '0:0:0:0:0:0:0:1'
  );
}

module.exports = {
  kReinitializeHandle: Symbol('kReinitializeHandle'),
  // The TLSSocket a transport socket carries: net.client.socket publishes it, as Node's
  // TLSSocket is the socket that connects.
  kClientSocketOwner: Symbol('kClientSocketOwner'),
  kSetNoDelay: Symbol('kSetNoDelay'),
  kSetKeepAlive: Symbol('kSetKeepAlive'),
  kSetKeepAliveInitialDelay: Symbol('kSetKeepAliveInitialDelay'),
  kSetKeepAliveInterval: Symbol('kSetKeepAliveInterval'),
  kSetKeepAliveCount: Symbol('kSetKeepAliveCount'),
  isIP,
  isIPv4,
  isIPv6,
  makeSyncWrite,
  normalizedArgsSymbol: Symbol('normalizedArgs'),
  isLoopback,
};
