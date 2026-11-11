'use strict';
const host = require('internal/host');
const packet = require('internal/dns/packet');
const darwin = host.rawOS.platform === 'darwin';
const constants = { ADDRCONFIG: darwin ? 0x400 : 0x20, ALL: darwin ? 0x100 : 0x10, V4MAPPED: darwin ? 0x800 : 8 };
const codes = ['SUCCESS', 'ENODATA', 'EFORMERR', 'ESERVFAIL', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED', 'EBADQUERY', 'EBADNAME', 'EBADFAMILY', 'EBADRESP', 'ECONNREFUSED', 'ETIMEOUT', 'EOF', 'EFILE', 'ENOMEM', 'EDESTRUCTION', 'EBADSTR', 'EBADFLAGS', 'ENONAME', 'EBADHINTS', 'ENOTINITIALIZED', 'ELOADIPHLPAPI', 'EADDRGETNETWORKPARAMS', 'ECANCELLED', 'ESERVICE', 'ENOSERVER'];
const errors = {};
for (const code of codes.slice(1)) errors[code === 'EOF' ? 'EOF' : code.slice(1)] = code;
let defaultOrder = 'verbatim', defaultResolver;
function native(op, args) {
  if (op !== 'dnsLookup' && op !== 'dnsLookupService' && op !== 'dnsQuery') return host.net(op, args);
  const { AsyncResource } = require('async_hooks');
  const resource = new AsyncResource(op === 'dnsLookup' ? 'GETADDRINFOREQWRAP' : op === 'dnsLookupService' ? 'GETNAMEINFOREQWRAP' : 'QUERYWRAP');
  const cb = args[args.length - 1];
  args[args.length - 1] = (...values) => {
    const result = host.invokeResource(resource, cb, undefined, values);
    host.checkpoint();
    return result;
  };
  try { return host.net(op, args); }
  catch (e) { resource.emitDestroy(); throw e; }
}
const { codes: { ERR_INVALID_ARG_VALUE }, validateArray, validateFunction, validateInt32, validateNumber, validateString, validateUint32 } = require('internal/validators');
const { codes: { ERR_INVALID_IP_ADDRESS }, makeError, validatePort } = require('internal/net/errors');
function validateStringWithoutNullBytes(value, name) {
  validateString(value, name);
  if (value.includes('\0')) throw new ERR_INVALID_ARG_VALUE(name, value, 'must be a string without null bytes');
}
function invalid(name, type) { const e = new TypeError(`The "${name}" argument must be ${type}`); e.code = 'ERR_INVALID_ARG_TYPE'; return e; }
function valueError(name, value) { const e = new TypeError(`The argument '${name}' is invalid. Received ${String(value)}`); e.code = 'ERR_INVALID_ARG_VALUE'; return e; }
function range(name, value) { const e = new RangeError(`The value of "${name}" is out of range. Received ${value}`); e.code = 'ERR_OUT_OF_RANGE'; return e; }
function integer(value, name, min, max) { if (typeof value !== 'number') throw invalid(name, 'a number'); if (!Number.isInteger(value) || value < min || value > max) throw range(name, value); return value; }
function callback(cb) { if (typeof cb !== 'function') throw invalid('callback', 'a function'); return cb; }
function string(value, name) { if (typeof value !== 'string') throw invalid(name, 'a string'); if (value.includes('\0')) throw valueError(name, value); return value; }
function object(value, name) { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(name, 'an object'); return value; }
function isIP(value) { return typeof value === 'string' ? native('isIP', [value]) : 0; }
function later(fn, ...args) { require('process').nextTick(fn, ...args); }
function ascii(hostname) { return /[^\x00-\x7f]/.test(hostname) ? require('internal/web/url').domainToASCII(hostname) : hostname; }
function error(code, syscall, hostname, errno) {
  if (code === 'EAI_NONAME' || code === 'EAI_NODATA') code = 'ENOTFOUND';
  const e = new Error(`${syscall} ${code}${hostname === undefined ? '' : ' ' + hostname}`);
  e.errno = errno === undefined ? code : errno; e.code = code; e.syscall = syscall;
  if (hostname !== undefined) e.hostname = hostname;
  return e;
}
function order(value) { if (!['verbatim', 'ipv4first', 'ipv6first'].includes(value)) throw valueError('order', value); return value; }
function setDefaultResultOrder(value) { defaultOrder = order(value); }
function getDefaultResultOrder() { return defaultOrder; }
function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  else if (options === undefined || options === null) options = {};
  else if (typeof options === 'number') options = { family: options };
  else object(options, 'options');
  callback(cb);
  if (hostname !== null && hostname !== undefined) string(hostname, 'hostname');
  let family = options.family === undefined ? 0 : options.family;
  if (family === 'IPv4') family = 4; if (family === 'IPv6') family = 6;
  if (![0, 4, 6].includes(family)) throw valueError('options.family', family);
  let hints = 0;
  if (options.hints != null) {
    validateNumber(options.hints, 'options.hints');
    hints = options.hints >>> 0;
    if (hints & ~(constants.ADDRCONFIG | constants.ALL | constants.V4MAPPED)) throw new ERR_INVALID_ARG_VALUE('hints', hints);
  }
  if (options.all !== undefined && typeof options.all !== 'boolean') throw invalid('options.all', 'a boolean');
  if (options.verbatim !== undefined && typeof options.verbatim !== 'boolean') throw invalid('options.verbatim', 'a boolean');
  const resultOrder = options.order !== undefined ? order(options.order) : options.verbatim !== undefined ? options.verbatim ? 'verbatim' : 'ipv4first' : defaultOrder;
  const all = options.all === true;
  if (!hostname) { later(() => all ? cb(null, []) : cb(null, null, family === 6 ? 6 : 4)); return; }
  const literal = isIP(hostname);
  if (literal) { later(() => all ? cb(null, [{ address: hostname, family: literal }]) : cb(null, hostname, literal)); return; }
  native('dnsLookup', [ascii(hostname), family, hints, (status, data, code) => {
    if (status) { cb(error(code, 'getaddrinfo', hostname, status)); return; }
    let addresses = data.trim().split('\n').filter(Boolean).map(line => ({ address: line.slice(2), family: Number(line[0]) }));
    const seen = new Set(); addresses = addresses.filter(item => { const key = item.family + ':' + item.address; if (seen.has(key)) return false; seen.add(key); return true; });
    if (resultOrder !== 'verbatim') { const first = resultOrder === 'ipv4first' ? 4 : 6; addresses = addresses.filter(a => a.family === first).concat(addresses.filter(a => a.family !== first)); }
    if (!addresses.length) { cb(error('ENOTFOUND', 'getaddrinfo', hostname)); return; }
    if (all) cb(null, addresses); else cb(null, addresses[0].address, addresses[0].family);
  }]);
}
function lookupService(address, port, cb) {
  if (arguments.length !== 3) { const e = new TypeError('The address, port, and callback arguments must be specified'); e.code = 'ERR_MISSING_ARGS'; throw e; }
  string(address, 'address'); if (!isIP(address)) throw valueError('address', address);
  if (typeof port === 'string' && port.trim() !== '') port = Number(port);
  integer(port, 'port', 0, 65535); callback(cb);
  native('dnsLookupService', [address, port, (status, data, code) => {
    if (status) { cb(error(code, 'getnameinfo', address, status)); return; }
    const at = data.indexOf('\n'); cb(null, data.slice(0, at), data.slice(at + 1));
  }]);
}
// The c-ares ChannelWrap contract of Node's ResolverBase over the native resolver.
const DNS_ESETSRVPENDING = -1000;
const IANA_DNS_PORT = 53;
const IPv6RE = /^\[([^[\]]*)\]/;
const addrSplitRE = /(^.+?)(?::(\d+))?$/;
class ChannelWrap {
  constructor(timeout, tries) {
    const id = native('dnsCreate', [timeout, tries]); if (id < 0) throw error(codes[-id] || 'UNKNOWN', 'ares_init_options');
    this.id = id;
    this.pending = 0;
    finalizers.register(this, id);
  }
  cancel() { native('dnsCancel', [this.id]); }
  getServers() {
    const csv = native('dnsServers', [this.id]);
    return csv ? csv.split(',').map(server => {
      const v6 = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(server);
      if (v6) return [v6[1], Number(v6[2] || IANA_DNS_PORT)];
      const at = server.lastIndexOf(':');
      return at === -1 ? [server, IANA_DNS_PORT] : [server.slice(0, at), Number(server.slice(at + 1))];
    }) : [];
  }
  setServers(servers) {
    if (this.pending) return DNS_ESETSRVPENDING;
    return native('dnsSetServers', [this.id, servers.map(([family, address, port]) => `${family === 6 ? `[${address}]` : address}:${port}`).join(',')]);
  }
  setLocalAddress(first, second) {
    const firstFamily = isIP(first);
    if (!firstFamily) throw makeError(TypeError, 'ERR_INVALID_ARG_VALUE', `Invalid IP address.`);
    let ipv4 = firstFamily === 4 ? first : '0.0.0.0';
    let ipv6 = firstFamily === 6 ? first : '::';
    if (second !== undefined) {
      const secondFamily = isIP(second);
      if (!secondFamily) throw makeError(TypeError, 'ERR_INVALID_ARG_VALUE', `Invalid IP address.`);
      if (secondFamily === firstFamily) throw makeError(TypeError, 'ERR_INVALID_ARG_VALUE', `Cannot specify two IPv${firstFamily} addresses.`);
      if (secondFamily === 4) ipv4 = second; else ipv6 = second;
    }
    const status = native('dnsLocal', [this.id, ipv4, ipv6]); if (status) throw error('EINVAL', 'setLocalAddress', undefined, status);
  }
}
function strerror(status) {
  return status === DNS_ESETSRVPENDING ? 'There are pending queries.' : codes[status] || String(status);
}
const finalizers = new FinalizationRegistry(id => native('dnsDestroy', [id]));
class Resolver {
  constructor(options = undefined) {
    let { timeout = -1, tries = 4, maxTimeout = 0 } = { ...options };
    validateInt32(timeout, 'options.timeout', -1);
    validateInt32(tries, 'options.tries', 1);
    validateUint32(maxTimeout, 'options.maxTimeout');
    this._handle = new ChannelWrap(timeout + 0, tries);
  }
  cancel() { this._handle.cancel(); }
  getServers() {
    return (this._handle.getServers() || []).map(val => {
      if (!val[1] || val[1] === IANA_DNS_PORT) return val[0];
      return `${isIP(val[0]) === 6 ? `[${val[0]}]` : val[0]}:${val[1]}`;
    });
  }
  setServers(servers) {
    validateArray(servers, 'servers');
    const newSet = [];
    servers.forEach((serv, index) => {
      validateString(serv, `servers[${index}]`);
      let ipVersion = isIP(serv);
      if (ipVersion !== 0) return newSet.push([ipVersion, serv, IANA_DNS_PORT]);
      const match = IPv6RE.exec(serv);
      // Check for an IPv6 in brackets.
      if (match) {
        ipVersion = isIP(match[1]);
        if (ipVersion !== 0) {
          const port = Number.parseInt(serv.replace(addrSplitRE, '$2')) || IANA_DNS_PORT;
          validatePort(port);
          return newSet.push([ipVersion, match[1], port]);
        }
      }
      // addr::port
      const addrSplitMatch = addrSplitRE.exec(serv);
      if (addrSplitMatch) {
        const hostIP = addrSplitMatch[1];
        const port = Number.parseInt(addrSplitMatch[2]) || IANA_DNS_PORT;
        ipVersion = isIP(hostIP);
        if (ipVersion !== 0) {
          validatePort(port);
          return newSet.push([ipVersion, hostIP, port]);
        }
      }
      throw new ERR_INVALID_IP_ADDRESS(serv);
    });
    const orig = (this._handle.getServers() || []).map(val => [isIP(val[0]), ...val]);
    const errorNumber = this._handle.setServers(newSet);
    if (errorNumber !== 0) {
      // Reset the servers to the old servers, because the resolver probably unset them.
      this._handle.setServers(orig);
      throw makeError(Error, 'ERR_DNS_SET_SERVERS_FAILED', `c-ares failed to set servers: "${strerror(errorNumber)}" [${servers}]`);
    }
  }
  setLocalAddress(ipv4, ipv6) {
    validateStringWithoutNullBytes(ipv4, 'ipv4');
    if (ipv6 !== undefined) validateStringWithoutNullBytes(ipv6, 'ipv6');
    this._handle.setLocalAddress(ipv4, ipv6);
  }
  resolve(hostname, rrtype, cb) {
    if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
    if (rrtype === undefined) rrtype = 'A';
    validateString(rrtype, 'rrtype');
    if (!Object.prototype.hasOwnProperty.call(packet.types, rrtype)) throw new ERR_INVALID_ARG_VALUE('rrtype', rrtype);
    return query(this, hostname, rrtype, {}, cb);
  }
  reverse(ip, cb) {
    validateStringWithoutNullBytes(ip, 'name'); validateFunction(cb, 'callback');
    const family = isIP(ip); if (!family) throw new ERR_INVALID_ARG_VALUE('ip', ip);
    return query(this, packet.reverseName(ip, family), 'PTR', {}, cb, ip, 'getHostByAddr');
  }
}
function resolverState(resolver) { const entry = resolver instanceof Resolver ? resolver._handle : undefined; if (!(entry instanceof ChannelWrap)) { const e = new TypeError('Value of this must be of type Resolver'); e.code = 'ERR_INVALID_THIS'; throw e; } return entry; }
function query(resolver, hostname, rrtype, options, cb, display = hostname, syscall = 'query' + rrtype[0] + rrtype.slice(1).toLowerCase()) {
  validateStringWithoutNullBytes(hostname, 'name'); validateFunction(cb, 'callback'); object(options, 'options');
  if (options.ttl !== undefined && typeof options.ttl !== 'boolean') throw invalid('options.ttl', 'a boolean');
  const ttl = options.ttl === true;
  const entry = resolverState(resolver); entry.pending++;
  try {
    native('dnsQuery', [entry.id, ascii(hostname), packet.types[rrtype], (status, data) => {
      resolverState(resolver).pending--;
      if (status) { cb(error(codes[status] || 'UNKNOWN', syscall, display)); return; }
      let result;
      try { result = packet.decode(data, rrtype, ttl); }
      catch (e) { cb(error(e.code || 'EBADRESP', syscall, display)); return; }
      cb(null, result);
    }]);
  } catch (e) { entry.pending--; throw e; }
}
const methods = { resolve4: 'A', resolve6: 'AAAA', resolveAny: 'ANY', resolveCaa: 'CAA', resolveCname: 'CNAME', resolveMx: 'MX', resolveNaptr: 'NAPTR', resolveNs: 'NS', resolvePtr: 'PTR', resolveSoa: 'SOA', resolveSrv: 'SRV', resolveTxt: 'TXT', resolveTlsa: 'TLSA' };
for (const [method, rrtype] of Object.entries(methods)) {
  Object.defineProperty(Resolver.prototype, method, { configurable: true, writable: true, value: function(hostname, options, cb) {
    if (rrtype === 'A' || rrtype === 'AAAA') { if (typeof options === 'function') { cb = options; options = {}; } else if (options === undefined || options === null) options = {}; }
    else { cb = options; options = {}; }
    return query(this, hostname, rrtype, options, cb);
  } });
}
function defaultInstance() { if (!defaultResolver) defaultResolver = new Resolver(); return defaultResolver; }
const publicMethods = ['resolve', 'reverse', ...Object.keys(methods)];
const api = Object.assign({ Resolver, lookup, lookupService, setDefaultResultOrder, getDefaultResultOrder }, constants, errors);
for (const name of [...publicMethods, 'getServers']) api[name] = (...args) => defaultInstance()[name](...args);
// Like Node, dns.setServers replaces the default resolver, so queries already sent keep theirs.
api.setServers = function setServers(servers) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  defaultResolver = resolver;
};
// Like Node's dns.promises, invalid arguments throw at the call; only the query rejects.
function promisifyCall(fn, receiver, args, shape) {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  fn.apply(receiver, args.concat([(err, ...values) => { if (err) reject(err); else resolve(shape ? shape(values) : values[0]); }]));
  return promise;
}
function lookupPromise(hostname, options) { return promisifyCall(lookup, undefined, [hostname, options], values => Array.isArray(values[0]) ? values[0] : { address: values[0], family: values[1] }); }
function lookupServicePromise(address, port) { return promisifyCall(lookupService, undefined, [address, port], values => ({ hostname: values[0], service: values[1] })); }
class PromiseResolver extends Resolver {}
for (const method of publicMethods) {
  Object.defineProperty(PromiseResolver.prototype, method, { configurable: true, writable: true, value: function(...args) { return promisifyCall(Resolver.prototype[method], this, args); } });
}
const promises = Object.assign({ Resolver: PromiseResolver, lookup: lookupPromise, lookupService: lookupServicePromise, setDefaultResultOrder, getDefaultResultOrder, getServers: api.getServers, setServers: api.setServers }, constants, errors);
for (const method of publicMethods) promises[method] = (...args) => promisifyCall(Resolver.prototype[method], defaultInstance(), args);
const custom = Symbol.for('nodejs.util.promisify.custom');
lookup[custom] = lookupPromise; lookupService[custom] = lookupServicePromise;
api.promises = promises;
module.exports = api;
