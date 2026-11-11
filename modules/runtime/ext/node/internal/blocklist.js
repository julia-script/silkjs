'use strict';

// Pure-JS net.BlockList. The handle (this[kHandle]) is a plain record of rule
// lists, each newest first: { addresses: [addr], subnets: [{ network, prefix }],
// ranges: [{ start, end }] }, where every address is a SocketAddress handle.

const { inspect } = require('util');
const {
  SocketAddress,
  InternalSocketAddress,
  kHandle: kSocketAddressHandle,
  kClone,
  kDeserialize,
  parseAddress,
  formatAddress,
} = require('internal/socketaddress');
const {
  codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE }, validateArray, validateInteger, validateString,
} = require('internal/errors');

const kHandle = Symbol('kHandle');

// --- Address arithmetic (IPv4-mapped IPv6 addresses match IPv4 both ways) ----

const kMappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

// The IPv4 bytes of an IPv4 or IPv4-mapped IPv6 address, else null.
function ipv4Bytes({ family, bytes }) {
  if (family === 4) return bytes;
  return kMappedPrefix.every((b, i) => bytes[i] === b) ? bytes.subarray(12) : null;
}

// -1, 0 or 1; NaN when an IPv4 address meets an IPv6 address that is not mapped.
function compare(a, b) {
  const [x, y] = a.family === b.family ? [a.bytes, b.bytes] : [ipv4Bytes(a), ipv4Bytes(b)];
  if (x === null || y === null) return NaN;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function identical(a, b) {
  return a.family === b.family && a.bytes.every((byte, i) => byte === b.bytes[i]);
}

function inSubnet(address, network, prefix) {
  let x = address.bytes;
  if (address.family !== network.family) {
    x = network.family === 6 ? Uint8Array.of(...kMappedPrefix, ...x) : ipv4Bytes(address);
    if (x === null) return false;
  }
  const y = network.bytes;
  const whole = prefix >> 3;
  for (let i = 0; i < whole; i++) {
    if (x[i] !== y[i]) return false;
  }
  const mask = (0xff00 >> (prefix & 7)) & 0xff;
  return mask === 0 || (x[whole] & mask) === (y[whole] & mask);
}

function matches(list, address) {
  return list.addresses.some((a) => compare(a, address) === 0) ||
    list.subnets.some(({ network, prefix }) => inSubnet(address, network, prefix)) ||
    list.ranges.some(({ start, end }) => compare(address, start) >= 0 && compare(address, end) <= 0);
}

function familyName(address) {
  return address.family === 4 ? 'IPv4' : 'IPv6';
}

function rulesOf(list) {
  return [
    ...list.addresses.map((a) => `Address: ${familyName(a)} ${formatAddress(a)}`),
    ...list.subnets.map(({ network, prefix }) => `Subnet: ${familyName(network)} ${formatAddress(network)}/${prefix}`),
    ...list.ranges.map(({ start, end }) => `Range: ${familyName(start)} ${formatAddress(start)}-${formatAddress(end)}`),
  ];
}

// Re-adding an equal address replaces that rule in place.
function addAddressHandle({ addresses }, handle) {
  const index = addresses.findIndex((a) => compare(a, handle) === 0);
  if (index === -1) addresses.unshift(handle);
  else addresses[index] = handle;
}

function removeFirst(rules, predicate) {
  const index = rules.findIndex(predicate);
  if (index !== -1) rules.splice(index, 1);
}

// --- Argument handling -----------------------------------------------------

function toHandle(value, name, family) {
  if (!SocketAddress.isSocketAddress(value)) {
    validateString(value, name);
    validateString(family, 'family');
    value = new SocketAddress({ address: value, family });
  }
  return value[kSocketAddressHandle];
}

function toSubnet(network, prefix, family) {
  network = toHandle(network, 'network', family);
  validateInteger(prefix, 'prefix', 0, network.family === 4 ? 32 : 128);
  return { network, prefix: prefix + 0 }; // Coerce -0 to +0.
}

function parseCIDR(cidr) {
  validateString(cidr, 'cidr');
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) {
    throw new ERR_INVALID_ARG_VALUE('cidr', cidr, 'must contain a prefix length (e.g. "10.0.0.0/8")');
  }
  const address = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  const prefix = parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || `${prefix}` !== prefixStr) {
    throw new ERR_INVALID_ARG_VALUE('cidr', cidr, 'prefix length must be a valid integer');
  }
  return { address, prefix, family: address.includes(':') ? 'ipv6' : 'ipv4' };
}

function validateRuleData(data) {
  if (!Array.isArray(data) || !data.every((n) => typeof n === 'string')) {
    throw new ERR_INVALID_ARG_TYPE('data', ['string', 'string[]'], data);
  }
}

// Accepts the rule strings produced by `rules`, e.g. 'Address: IPv4 10.0.0.5',
// 'Range: IPv4 10.0.0.1-10.0.0.10' or 'Subnet: IPv6 2001:db8:1234::/48'.
// Unrecognised entries are ignored.
function parseRules(blockList, data) {
  const v4 = '(\\d{1,3}(?:\\.\\d{1,3}){3})';
  const v6 = '([0-9a-fA-F:.]{1,45})';
  for (const item of data) {
    let match;
    if (item.includes('IPv4')) {
      if ((match = item.match(new RegExp(`Subnet: IPv4 ${v4}/(\\d{1,2})`)))) {
        blockList.addSubnet(match[1], parseInt(match[2]));
        continue;
      }
      if ((match = item.match(new RegExp(`Address: IPv4 ${v4}`)))) {
        blockList.addAddress(match[1]);
        continue;
      }
      if ((match = item.match(new RegExp(`Range: IPv4 ${v4}-${v4}`)))) {
        blockList.addRange(match[1], match[2]);
        continue;
      }
    }
    if (item.includes('IPv6')) {
      if ((match = item.match(new RegExp(`Subnet: IPv6 ${v6}/([0-9]{1,3})`, 'i')))) {
        blockList.addSubnet(match[1], parseInt(match[2]), 'ipv6');
      } else if ((match = item.match(new RegExp(`Address: IPv6 ${v6}`, 'i')))) {
        blockList.addAddress(match[1], 'ipv6');
      } else if ((match = item.match(new RegExp(`Range: IPv6 ${v6}-${v6}`, 'i')))) {
        blockList.addRange(match[1], match[2], 'ipv6');
      }
    }
  }
}

// --- Shared handles for structured clone -------------------------------------
// Clones in the same realm share one handle (as Node shares the native handle);
// a clone that lands in another realm gets its own copy of the rules.

const realmId = Math.random().toString(36).slice(2);
let nextId = 0;
const sharedHandles = new Map();
const handleCleanup = new FinalizationRegistry((id) => sharedHandles.delete(id));

function shareHandle(handle) {
  if (sharedHandles.get(handle.id)?.deref() !== handle) {
    handle.id = `${realmId}:${nextId++}`;
    sharedHandles.set(handle.id, new WeakRef(handle));
    handleCleanup.register(handle, handle.id);
  }
  return handle;
}

// --- BlockList -------------------------------------------------------------

class BlockList {
  constructor() {
    this[kHandle] = { addresses: [], subnets: [], ranges: [] };
  }

  static isBlockList(value) {
    return value?.[kHandle] !== undefined;
  }

  static PRIVATE_RANGES = Object.freeze([
    // RFC 1918 - Private IPv4
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    // Loopback
    '127.0.0.0/8',
    '::1/128',
    // Link-local
    '169.254.0.0/16',
    'fe80::/10',
    // Unique local (ULA)
    'fc00::/7',
  ]);

  [inspect.custom](depth, options) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `BlockList ${inspect({ rules: this.rules }, opts)}`;
  }

  addAddress(address, family = 'ipv4') {
    addAddressHandle(this[kHandle], toHandle(address, 'address', family));
  }

  addAddresses(addresses, family = 'ipv4') {
    validateArray(addresses, 'addresses');
    validateString(family, 'family');
    addresses.map((address, i) => toHandle(address, `addresses[${i}]`, family))
      .forEach((handle) => addAddressHandle(this[kHandle], handle));
  }

  addRange(start, end, family = 'ipv4') {
    const startHandle = toHandle(start, 'start', family);
    const endHandle = toHandle(end, 'end', family);
    if (compare(startHandle, endHandle) > 0) {
      throw new ERR_INVALID_ARG_VALUE('start', new InternalSocketAddress(startHandle), 'must come before end');
    }
    this[kHandle].ranges.unshift({ start: startHandle, end: endHandle });
  }

  addSubnet(network, prefix, family = 'ipv4') {
    this[kHandle].subnets.unshift(toSubnet(network, prefix, family));
  }

  addCIDR(cidr) {
    const { address, prefix, family } = parseCIDR(cidr);
    this.addSubnet(address, prefix, family);
  }

  addCIDRs(cidrs) {
    validateArray(cidrs, 'cidrs');
    // Parse every entry first so that a bad one leaves the list unchanged.
    const parsed = cidrs.map((cidr, i) => {
      validateString(cidr, `cidrs[${i}]`);
      return parseCIDR(cidr);
    });
    for (const { address, prefix, family } of parsed) this.addSubnet(address, prefix, family);
  }

  removeAddress(address, family = 'ipv4') {
    const handle = toHandle(address, 'address', family);
    removeFirst(this[kHandle].addresses, (a) => compare(a, handle) === 0);
  }

  removeRange(start, end, family = 'ipv4') {
    const startHandle = toHandle(start, 'start', family);
    const endHandle = toHandle(end, 'end', family);
    removeFirst(this[kHandle].ranges, (r) => identical(r.start, startHandle) && identical(r.end, endHandle));
  }

  removeSubnet(network, prefix, family = 'ipv4') {
    const subnet = toSubnet(network, prefix, family);
    removeFirst(this[kHandle].subnets, (s) => s.prefix === subnet.prefix && identical(s.network, subnet.network));
  }

  removeCIDR(cidr) {
    const { address, prefix, family } = parseCIDR(cidr);
    this.removeSubnet(address, prefix, family);
  }

  check(address, family = 'ipv4') {
    if (!SocketAddress.isSocketAddress(address)) {
      validateString(address, 'address');
      validateString(family, 'family');
      const af = family.toLowerCase() === 'ipv4' ? 4 : 6;
      const bytes = parseAddress(address, af);
      return bytes !== null && matches(this[kHandle], { family: af, bytes });
    }
    return matches(this[kHandle], address[kSocketAddressHandle]);
  }

  clear() {
    const handle = this[kHandle];
    handle.addresses.length = handle.subnets.length = handle.ranges.length = 0;
  }

  toJSON() {
    return this.rules;
  }

  fromJSON(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    validateRuleData(data);
    parseRules(this, data);
  }

  get rules() {
    return rulesOf(this[kHandle]);
  }

  get size() {
    const { addresses, subnets, ranges } = this[kHandle];
    return addresses.length + subnets.length + ranges.length;
  }

  [kClone]() {
    return { data: { handle: shareHandle(this[kHandle]) }, deserializeInfo: 'internal/blocklist:InternalBlockList' };
  }

  [kDeserialize]({ handle }) {
    this[kHandle] = sharedHandles.get(handle.id)?.deref() ?? shareHandle(handle);
  }
}

class InternalBlockList {
  constructor(handle) {
    this[kHandle] = handle;
  }
}

InternalBlockList.prototype.constructor = BlockList;
Object.setPrototypeOf(InternalBlockList.prototype, BlockList.prototype);

module.exports = {
  BlockList,
  InternalBlockList,
  kHandle,
  isBlockList: BlockList.isBlockList,
};
