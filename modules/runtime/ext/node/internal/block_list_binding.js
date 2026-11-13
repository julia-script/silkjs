'use strict';

// internalBinding('block_list'): src/node_sockaddr.cc's SocketAddressBase and
// SocketAddressBlockListWrap. As in Node, a BlockList handle and its clones (in
// this thread or another) share one rule list: here the rules live in a growable
// SharedArrayBuffer, which a clone shares, guarded by a lock word in it.

const {
  ArrayPrototypePush,
  AtomicsCompareExchange,
  AtomicsExchange,
  AtomicsNotify,
  AtomicsStore,
  AtomicsSub,
  AtomicsWait,
  Int32Array,
  NumberPrototypeToString,
  ObjectGetOwnPropertyDescriptor,
  ReflectApply,
  SharedArrayBuffer,
  StringPrototypeCharCodeAt,
  StringPrototypeIndexOf,
  TypedArrayPrototypeCopyWithin,
  TypedArrayPrototypeSlice,
  Uint8Array,
} = require('internal/per_context/primordials');
// primordials has no SharedArrayBuffer methods (nor has Node's).
const sharedByteLength = ObjectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const sharedGrow = SharedArrayBuffer.prototype.grow;
const { markTransferMode, kClone, kDeserialize } = require('internal/worker/js_transferable');
const { codes: { ERR_INVALID_ADDRESS } } = require('internal/errors');

// The platform's address family numbers (sys/socket.h).
const AF_INET = 2;
const AF_INET6 = process.platform === 'darwin' ? 30 : process.platform === 'win32' ? 23 : 10;

// --- uv_inet_pton / uv_inet_ntop ---------------------------------------------

function digit(code) { return code >= 48 && code <= 57; }
function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

// inet_pton4: four decimal octets, no leading zeros. Writes into out at offset.
function parseIPv4Into(text, start, end, out, offset) {
  let octets = 0;
  let value = -1;
  for (let i = start; i < end; i++) {
    const code = StringPrototypeCharCodeAt(text, i);
    if (digit(code)) {
      if (value === 0) return false;
      value = (value === -1 ? 0 : value * 10) + (code - 48);
      if (value > 255) return false;
    } else if (code === 46 && value !== -1 && octets < 3) {
      out[offset + octets++] = value;
      value = -1;
    } else {
      return false;
    }
  }
  if (value === -1 || octets !== 3) return false;
  out[offset + 3] = value;
  return true;
}

// inet_pton6, with libuv's scope id ("%eth0") accepted and dropped.
function parseIPv6Into(text, out) {
  let end = StringPrototypeIndexOf(text, '%');
  if (end === -1) end = text.length;
  const words = new Uint8Array(16);
  let at = 0;
  let gap = -1;
  let i = 0;
  if (end >= 2 && StringPrototypeCharCodeAt(text, 0) === 58) {
    if (StringPrototypeCharCodeAt(text, 1) !== 58) return false;
    i = 1;
  }
  let groupStart = i;
  let value = 0;
  let digits = 0;
  for (; i < end; i++) {
    const code = StringPrototypeCharCodeAt(text, i);
    const hex = hexValue(code);
    if (hex !== -1) {
      if (++digits > 4) return false;
      value = (value << 4) | hex;
      continue;
    }
    if (code === 58) {
      if (digits === 0) {
        if (i !== groupStart || gap !== -1) return false;
        gap = at;
        groupStart = i + 1;
        continue;
      }
      if (i + 1 === end || at + 2 > 16) return false;
      words[at++] = value >> 8;
      words[at++] = value & 0xff;
      value = 0;
      digits = 0;
      groupStart = i + 1;
      continue;
    }
    if (code === 46 && at + 4 <= 16) {
      if (!parseIPv4Into(text, groupStart, end, words, at)) return false;
      at += 4;
      digits = 0;
      break;
    }
    return false;
  }
  if (digits !== 0) {
    if (at + 2 > 16) return false;
    words[at++] = value >> 8;
    words[at++] = value & 0xff;
  }
  if (gap !== -1) {
    if (at === 16) return false;
    const moved = at - gap;
    for (let k = 1; k <= moved; k++) {
      words[16 - k] = words[gap + moved - k];
      words[gap + moved - k] = 0;
    }
    at = 16;
  }
  if (at !== 16) return false;
  for (let k = 0; k < 16; k++) out[k] = words[k];
  return true;
}

// The address bytes (4 or 16), or null when text is not an address of the family.
function parseAddress(text, family) {
  if (family === 4) {
    const bytes = new Uint8Array(4);
    return parseIPv4Into(text, 0, text.length, bytes, 0) ? bytes : null;
  }
  const bytes = new Uint8Array(16);
  return parseIPv6Into(text, bytes) ? bytes : null;
}

function formatIPv4(bytes, offset) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

// inet_ntop6: the longest run of two or more zero words becomes "::"; an
// IPv4-compatible or IPv4-mapped address ends in dotted decimal.
function formatIPv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) ArrayPrototypePush(words, (bytes[i] << 8) | bytes[i + 1]);
  let base = -1;
  let len = 0;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > len && j - i >= 2) { base = i; len = j - i; }
    i = j === i ? i + 1 : j;
  }
  let text = '';
  for (let i = 0; i < 8; i++) {
    if (base !== -1 && i >= base && i < base + len) {
      if (i === base) text += ':';
      continue;
    }
    if (i !== 0) text += ':';
    if (i === 6 && base === 0 && (len === 6 || (len === 7 && words[7] !== 1) || (len === 5 && words[5] === 0xffff))) {
      return text + formatIPv4(bytes, 12);
    }
    text += NumberPrototypeToString(words[i], 16);
  }
  if (base !== -1 && base + len === 8) text += ':';
  return text;
}

function formatAddress(family, bytes) {
  return family === 4 ? formatIPv4(bytes, 0) : formatIPv6(bytes);
}

// --- SocketAddressBase ---------------------------------------------------------

const kMappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

class SocketAddress {
  #family = 4;
  #bytes = undefined;
  #port = 0;
  #flowlabel = 0;

  constructor(address, port, type, flowlabel) {
    markTransferMode(this, true, false);
    // A deserialized handle gets its state from kDeserialize.
    if (address === undefined) return;
    const family = type === AF_INET ? 4 : 6;
    const bytes = parseAddress(`${address}`, family);
    if (bytes === null) throw new ERR_INVALID_ADDRESS();
    this.#family = family;
    this.#bytes = bytes;
    this.#port = port & 0xffff;
    this.#flowlabel = family === 6 ? flowlabel >>> 0 : 0;
  }

  detail(object) {
    object.address = formatAddress(this.#family, this.#bytes);
    object.port = this.#port;
    object.family = this.#family === 4 ? AF_INET : AF_INET6;
    object.flowlabel = this.#flowlabel;
    return object;
  }

  flowlabel() { return this.#flowlabel; }

  [kClone]() {
    return {
      data: { family: this.#family, bytes: this.#bytes, port: this.#port, flowlabel: this.#flowlabel },
      deserializeInfo: 'internal/block_list_binding:SocketAddress',
    };
  }

  [kDeserialize]({ family, bytes, port, flowlabel }) {
    this.#family = family;
    this.#bytes = bytes;
    this.#port = port;
    this.#flowlabel = flowlabel;
  }

  static family(handle) { return handle.#family; }
  static bytes(handle) { return handle.#bytes; }
}

const familyOf = SocketAddress.family;
const bytesOf = SocketAddress.bytes;
delete SocketAddress.family;
delete SocketAddress.bytes;

// --- The shared rule list --------------------------------------------------------
//
// Int32 words: [0] the lock (0 free, 1 held, 2 held with waiters), [1] the rule
// count. Rules follow from byte kHeader, kRule bytes each, oldest first:
// u8 type, u8 family (4 or 6), u8 prefix, a pad byte, then the 16 bytes of the
// address (start of a range, network of a subnet) and the 16 bytes of a range's end.

const kHeader = 16;
const kRule = 40;
const kAddress = 1;
const kRange = 2;
const kSubnet = 3;
// Rule lists grow in place up to this size (about a hundred thousand rules);
// the bytes are reserved, not committed, until the list grows into them.
const kMaxBytes = 4 * 1024 * 1024;

function createStorage() {
  return new SharedArrayBuffer(kHeader + 8 * kRule, { __proto__: null, maxByteLength: kMaxBytes });
}

// A futex mutex (Drepper, "Futexes Are Tricky"): 0 free, 1 held, 2 held with waiters.
function lock(words) {
  let state = AtomicsCompareExchange(words, 0, 0, 1);
  if (state === 0) return;
  if (state !== 2) state = AtomicsExchange(words, 0, 2);
  while (state !== 0) {
    AtomicsWait(words, 0, 2);
    state = AtomicsExchange(words, 0, 2);
  }
}

function unlock(words) {
  if (AtomicsSub(words, 0, 1) !== 1) {
    AtomicsStore(words, 0, 0);
    AtomicsNotify(words, 0, 1);
  }
}

// The 16 address bytes of an address, IPv4 in the first four.
function addressBytes(handle) { return bytesOf(handle); }

function sameBytes(bytes, at, other, length) {
  for (let i = 0; i < length; i++) {
    if (bytes[at + i] !== other[i]) return false;
  }
  return true;
}

// Whether the 16 bytes at offset are an IPv4-mapped IPv6 address.
function mappedIPv4(bytes, at) {
  for (let i = 0; i < 12; i++) {
    if (bytes[at + i] !== kMappedPrefix[i]) return false;
  }
  return true;
}

// SocketAddress::compare: -1, 0 or 1, or 2 when the families do not compare
// (IPv4 against an IPv6 address that is not IPv4-mapped).
function compareAt(family, bytes, rules, at, ruleFamily) {
  let x = bytes;
  let xAt = 0;
  let yAt = at;
  let length = 4;
  if (family === ruleFamily) {
    length = family === 4 ? 4 : 16;
  } else if (family === 6) {
    if (!mappedIPv4(bytes, 0)) return 2;
    xAt = 12;
  } else {
    if (!mappedIPv4(rules, at)) return 2;
    yAt = at + 12;
  }
  for (let i = 0; i < length; i++) {
    const a = x[xAt + i];
    const b = rules[yAt + i];
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

// SocketAddress::is_in_network.
function inNetwork(family, bytes, rules, at, ruleFamily, prefix) {
  let xAt = 0;
  let yAt = at;
  let bits = prefix;
  if (family !== ruleFamily) {
    if (family === 6) {
      if (!mappedIPv4(bytes, 0)) return false;
      xAt = 12;
    } else {
      // An IPv4 address against an IPv6 network: compare as ::ffff:a.b.c.d.
      for (let i = 0; i < 12 && bits > 0; i++, bits -= 8) {
        const mask = bits >= 8 ? 0xff : (0xff00 >> bits) & 0xff;
        if ((kMappedPrefix[i] & mask) !== (rules[at + i] & mask)) return false;
      }
      if (bits <= 0) return true;
      yAt = at + 12;
    }
  }
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff00 >> bits) & 0xff;
    if ((bytes[xAt + i] & mask) !== (rules[yAt + i] & mask)) return false;
  }
  return true;
}

function familyName(family) { return family === 4 ? 'IPv4' : 'IPv6'; }

function ruleText(rules, at) {
  const type = rules[at];
  const family = rules[at + 1];
  const length = family === 4 ? 4 : 16;
  const first = formatAddress(family, TypedArrayPrototypeSlice(rules, at + 4, at + 4 + length));
  if (type === kAddress) return `Address: ${familyName(family)} ${first}`;
  if (type === kSubnet) return `Subnet: ${familyName(family)} ${first}/${rules[at + 2]}`;
  const last = formatAddress(family, TypedArrayPrototypeSlice(rules, at + 20, at + 20 + length));
  return `Range: ${familyName(family)} ${first}-${last}`;
}

class BlockList {
  #storage = undefined;

  constructor() {
    markTransferMode(this, true, false);
  }

  #buffer() {
    return this.#storage ??= createStorage();
  }

  // Runs fn(words, bytes) under the list's lock.
  #locked(fn) {
    const buffer = this.#buffer();
    const words = new Int32Array(buffer, 0, 2);
    lock(words);
    try {
      return fn(words, new Uint8Array(buffer));
    } finally {
      unlock(words);
    }
  }

  #find(words, rules, type, family, first, second, prefix) {
    const count = words[1];
    const length = family === 4 ? 4 : 16;
    for (let index = 0; index < count; index++) {
      const at = kHeader + index * kRule;
      if (rules[at] !== type || rules[at + 1] !== family) continue;
      if (!sameBytes(rules, at + 4, first, length)) continue;
      if (type === kRange && !sameBytes(rules, at + 20, second, length)) continue;
      if (type === kSubnet && rules[at + 2] !== prefix) continue;
      return index;
    }
    return -1;
  }

  #append(words, type, family, first, second, prefix) {
    const buffer = this.#buffer();
    const count = words[1];
    const needed = kHeader + (count + 1) * kRule;
    const size = ReflectApply(sharedByteLength, buffer, []);
    if (needed > size) {
      let grown = size * 2;
      if (grown > kMaxBytes) grown = kMaxBytes;
      if (grown < needed) grown = needed;
      ReflectApply(sharedGrow, buffer, [grown]);
    }
    const rules = new Uint8Array(buffer);
    const at = kHeader + count * kRule;
    rules[at] = type;
    rules[at + 1] = family;
    rules[at + 2] = prefix;
    const length = family === 4 ? 4 : 16;
    for (let i = 0; i < 16; i++) {
      rules[at + 4 + i] = i < length ? first[i] : 0;
      rules[at + 20 + i] = second !== undefined && i < length ? second[i] : 0;
    }
    words[1] = count + 1;
  }

  #remove(words, rules, index) {
    const count = words[1];
    TypedArrayPrototypeCopyWithin(rules, kHeader + index * kRule, kHeader + (index + 1) * kRule, kHeader + count * kRule);
    words[1] = count - 1;
  }

  addAddress(address) {
    const family = familyOf(address);
    const bytes = addressBytes(address);
    this.#locked((words, rules) => {
      // As SocketAddressBlockList::AddSocketAddress: an equal address replaces its rule.
      const index = this.#find(words, rules, kAddress, family, bytes, undefined, 0);
      if (index !== -1) this.#remove(words, rules, index);
      this.#append(words, kAddress, family, bytes, undefined, 0);
    });
  }

  addAddresses(addresses) {
    for (let i = 0; i < addresses.length; i++) this.addAddress(addresses[i]);
  }

  addRange(start, end) {
    const family = familyOf(start);
    if (familyOf(end) !== family) return false;
    const first = addressBytes(start);
    const last = addressBytes(end);
    if (compareAt(family, first, last, 0, family) > 0) return false;
    this.#locked((words) => this.#append(words, kRange, family, first, last, 0));
    return true;
  }

  addSubnet(network, prefix) {
    const family = familyOf(network);
    this.#locked((words) => this.#append(words, kSubnet, family, addressBytes(network), undefined, prefix));
  }

  removeAddress(address) {
    const family = familyOf(address);
    const bytes = addressBytes(address);
    this.#locked((words, rules) => {
      const index = this.#find(words, rules, kAddress, family, bytes, undefined, 0);
      if (index !== -1) this.#remove(words, rules, index);
    });
  }

  removeRange(start, end) {
    const family = familyOf(start);
    if (familyOf(end) !== family) return;
    this.#locked((words, rules) => {
      const index = this.#find(words, rules, kRange, family, addressBytes(start), addressBytes(end), 0);
      if (index !== -1) this.#remove(words, rules, index);
    });
  }

  removeSubnet(network, prefix) {
    const family = familyOf(network);
    this.#locked((words, rules) => {
      const index = this.#find(words, rules, kSubnet, family, addressBytes(network), undefined, prefix);
      if (index !== -1) this.#remove(words, rules, index);
    });
  }

  #apply(family, bytes) {
    return this.#locked((words, rules) => {
      // Newest rules first, as Node's list keeps them.
      for (let index = words[1] - 1; index >= 0; index--) {
        const at = kHeader + index * kRule;
        const type = rules[at];
        const ruleFamily = rules[at + 1];
        if (type === kAddress) {
          if (compareAt(family, bytes, rules, at + 4, ruleFamily) === 0) return true;
        } else if (type === kRange) {
          const low = compareAt(family, bytes, rules, at + 4, ruleFamily);
          const high = compareAt(family, bytes, rules, at + 20, ruleFamily);
          if (low !== 2 && high !== 2 && low >= 0 && high <= 0) return true;
        } else if (inNetwork(family, bytes, rules, at + 4, ruleFamily, rules[at + 2])) {
          return true;
        }
      }
      return false;
    });
  }

  check(address) {
    return this.#apply(familyOf(address), addressBytes(address));
  }

  checkString(address, af) {
    const family = af === AF_INET ? 4 : 6;
    const bytes = parseAddress(`${address}`, family);
    if (bytes === null) return false;
    return this.#apply(family, bytes);
  }

  clear() {
    this.#locked((words) => { words[1] = 0; });
  }

  getRules() {
    return this.#locked((words, rules) => {
      const list = [];
      for (let index = words[1] - 1; index >= 0; index--) ArrayPrototypePush(list, ruleText(rules, kHeader + index * kRule));
      return list;
    });
  }

  getSize() {
    return this.#locked((words) => words[1]);
  }

  [kClone]() {
    return { data: { storage: this.#buffer() }, deserializeInfo: 'internal/block_list_binding:BlockList' };
  }

  [kDeserialize]({ storage }) {
    this.#storage = storage;
  }
}

module.exports = {
  AF_INET,
  AF_INET6,
  BlockList,
  SocketAddress,
  // For the runtime's own address handling (net, dns).
  parseAddress,
  formatAddress,
};
