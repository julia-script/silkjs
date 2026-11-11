'use strict';

// Pure-JS net.SocketAddress. The handle (this[kHandle]) is a plain,
// structured-cloneable record { family: 4 | 6, bytes: Uint8Array, port, flowlabel }.

const { inspect } = require('util');

const kHandle = Symbol('kHandle');
const kClone = Symbol('kClone');
const kDeserialize = Symbol('kDeserialize');

const { codes: { ERR_INVALID_ARG_VALUE }, validateObject, validateString, validateInteger } = require('internal/validators');
const { makeError, validatePort } = require('internal/net/errors');

// --- inet_pton / inet_ntop ---------------------------------------------------

function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && +p <= 255)) return null;
  return Uint8Array.from(parts, Number);
}

function parseIPv6(text) {
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone); // Scope ids are accepted and dropped.
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = [[], []];
  for (let h = 0; h < halves.length; h++) {
    if (halves[h] === '') continue;
    const groups = halves[h].split(':');
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      if (/^[0-9a-f]{1,4}$/i.test(group)) {
        words[h].push(parseInt(group, 16));
      } else if (h === halves.length - 1 && g === groups.length - 1 && group.includes('.')) {
        const v4 = parseIPv4(group); // An embedded IPv4 tail fills the last two words.
        if (v4 === null) return null;
        words[h].push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        return null;
      }
    }
  }
  const count = words[0].length + words[1].length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const all = [...words[0], ...new Array(8 - count).fill(0), ...words[1]];
  const bytes = new Uint8Array(16);
  all.forEach((w, i) => { bytes[2 * i] = w >> 8; bytes[2 * i + 1] = w & 0xff; });
  return bytes;
}

function formatIPv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  // Longest run (first wins) of two or more zero words becomes '::'.
  let base = -1;
  let len = 0;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > len && j - i >= 2) [base, len] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  if (base === 0 && (len === 6 || (len === 5 && words[5] === 0xffff))) {
    return `::${len === 5 ? 'ffff:' : ''}${bytes.subarray(12).join('.')}`;
  }
  if (base === -1) return words.map((w) => w.toString(16)).join(':');
  const hex = (ws) => ws.map((w) => w.toString(16)).join(':');
  return `${hex(words.slice(0, base))}::${hex(words.slice(base + len))}`;
}

function parseAddress(text, family) {
  return family === 4 ? parseIPv4(text) : parseIPv6(text);
}

function formatAddress(handle) {
  return handle.family === 4 ? handle.bytes.join('.') : formatIPv6(handle.bytes);
}

function createHandle(address, port, family, flowlabel) {
  const bytes = parseAddress(address, family);
  if (bytes === null) throw makeError(Error, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
  return { family, bytes, port, flowlabel: family === 6 ? flowlabel : 0 }; // IPv4 has no flow label.
}

// --- SocketAddress -------------------------------------------------------

class SocketAddress {
  static isSocketAddress(value) {
    return value?.[kHandle] !== undefined;
  }

  constructor(options = {}) {
    validateObject(options, 'options');
    let { family = 'ipv4' } = options;
    const {
      address = (family === 'ipv4' ? '127.0.0.1' : '::'),
      port = 0,
      flowlabel = 0,
    } = options;
    if (typeof family?.toLowerCase === 'function') family = family.toLowerCase();
    if (family !== 'ipv4' && family !== 'ipv6') throw new ERR_INVALID_ARG_VALUE('options.family', options.family);
    validateString(address, 'options.address');
    validatePort(port, 'options.port');
    validateInteger(flowlabel, 'options.flowlabel', 0, 0xFFFFFFFF);
    this[kHandle] = createHandle(address, port | 0, family === 'ipv4' ? 4 : 6, flowlabel);
  }

  get address() {
    return formatAddress(this[kHandle]);
  }

  get port() {
    return this[kHandle].port;
  }

  get family() {
    return this[kHandle].family === 4 ? 'ipv4' : 'ipv6';
  }

  get flowlabel() {
    return this[kHandle].flowlabel;
  }

  [inspect.custom](depth, options) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `SocketAddress ${inspect(this.toJSON(), opts)}`;
  }

  toJSON() {
    return {
      address: this.address,
      port: this.port,
      family: this.family,
      flowlabel: this.flowlabel,
    };
  }

  // Parses "${ip}:${port}" / "[${ipv6}]:${port}"; returns undefined on failure.
  static parse(input) {
    validateString(input, 'input');
    try {
      const { hostname: address, port } = URL.parse(`http://${input}`);
      if (address[0] === '[' && address[address.length - 1] === ']') {
        return new SocketAddress({ address: address.slice(1, -1), port: port | 0, family: 'ipv6' });
      }
      return new SocketAddress({ address, port: port | 0 });
    } catch {
      // Not a valid socket address.
    }
  }

  // Structured clone: the handle is immutable plain data, so a copy is enough.
  [kClone]() {
    return { data: { handle: this[kHandle] }, deserializeInfo: 'internal/socketaddress:InternalSocketAddress' };
  }

  [kDeserialize]({ handle }) {
    this[kHandle] = handle;
  }
}

class InternalSocketAddress {
  constructor(handle) {
    this[kHandle] = handle;
  }
}

InternalSocketAddress.prototype.constructor = SocketAddress;
Object.setPrototypeOf(InternalSocketAddress.prototype, SocketAddress.prototype);

module.exports = {
  SocketAddress,
  InternalSocketAddress,
  kHandle,
  kClone,
  kDeserialize,
  // Shared with internal/blocklist.
  parseAddress,
  formatAddress,
};
