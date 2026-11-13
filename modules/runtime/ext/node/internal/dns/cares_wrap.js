'use strict';

// A JavaScript emulation of internalBinding('cares_wrap'), which Node.js v24 lib/dns.js and
// lib/internal/dns/* use. It follows src/cares_wrap.cc: the same request objects, return
// values and oncomplete arguments, over the runtime's resolver (src/ext/dns_native.silk).
// getaddrinfo and getnameinfo fail with libuv's UV_EAI_* numbers; queries fail with c-ares
// code strings ('ENOTFOUND', ...), as ParseError reports them.

const host = require('internal/host');
const packet = require('internal/dns/packet');

const darwin = host.rawOS.platform === 'darwin';
const AI_ADDRCONFIG = darwin ? 0x400 : 0x20;
const AI_ALL = darwin ? 0x100 : 0x10;
const AI_V4MAPPED = darwin ? 0x800 : 8;
const DNS_ORDER_VERBATIM = 0;
const DNS_ORDER_IPV4_FIRST = 1;
const DNS_ORDER_IPV6_FIRST = 2;

// c-ares status codes, by number (ares.h).
const codes = ['SUCCESS', 'ENODATA', 'EFORMERR', 'ESERVFAIL', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED',
  'EBADQUERY', 'EBADNAME', 'EBADFAMILY', 'EBADRESP', 'ECONNREFUSED', 'ETIMEOUT', 'EOF', 'EFILE',
  'ENOMEM', 'EDESTRUCTION', 'EBADSTR', 'EBADFLAGS', 'ENONAME', 'EBADHINTS', 'ENOTINITIALIZED',
  'ELOADIPHLPAPI', 'EADDRGETNETWORKPARAMS', 'ECANCELLED', 'ESERVICE', 'ENOSERVER'];
// ares_strerror's texts, by number.
const messages = ['Successful completion', 'DNS server returned answer with no data',
  'DNS server claims query was misformatted', 'DNS server returned general failure',
  'Domain name not found', 'DNS server does not implement requested operation',
  'DNS server refused query', 'Misformatted DNS query', 'Misformatted domain name',
  'Unsupported address family', 'Misformatted DNS reply', 'Could not contact DNS servers',
  'Timeout while contacting DNS servers', 'End of file', 'Error reading file', 'Out of memory',
  'Channel is being destroyed', 'Misformatted string', 'Illegal flags specified',
  'Given hostname is not numeric', 'Illegal hints flags specified', 'c-ares library initialization not yet performed',
  'Error loading iphlpapi.dll', 'Could not find GetNetworkParams function', 'DNS query cancelled',
  'Invalid service name or number', 'No DNS servers were configured'];
// cares_wrap.cc's own code for setServers while queries are pending.
const DNS_ESETSRVPENDING = -1000;
const IANA_DNS_PORT = 53;

function strerror(code) {
  if (code === DNS_ESETSRVPENDING) return 'There are pending queries.';
  return messages[code] ?? 'unknown';
}

// Native callbacks run in the request's async resource, as a ReqWrap's MakeCallback does.
function native(op, type, args) {
  const { AsyncResource } = require('async_hooks');
  const resource = new AsyncResource(type);
  const cb = args[args.length - 1];
  args[args.length - 1] = (...values) => {
    const result = host.invokeResource(resource, cb, undefined, values);
    host.checkpoint();
    return result;
  };
  try { return host.net(op, args); }
  catch (e) { resource.emitDestroy(); throw e; }
}

class GetAddrInfoReqWrap {}
class GetNameInfoReqWrap {}
class QueryReqWrap {}

function isIP(value) { return typeof value === 'string' ? host.net('isIP', [value]) : 0; }
// GetAddrInfo and QueryWrap::Send convert a hostname with ada::idna::to_ascii.
function ascii(hostname) {
  return /[^\x00-\x7f]/.test(hostname) ? require('internal/url').domainToASCII(hostname) : hostname;
}

// getaddrinfo with ai_socktype SOCK_STREAM: one entry per address, in the order asked for.
function getaddrinfo(req, hostname, family, hints, order) {
  native('dnsLookup', 'GETADDRINFOREQWRAP', [ascii(hostname), family, hints, (status, data) => {
    if (status) { req.oncomplete(status, []); return; }
    const seen = new Set();
    let v4 = [], v6 = [];
    const all = [];
    for (const line of data.split('\n')) {
      if (!line) continue;
      const address = line.slice(2);
      if (seen.has(address)) continue;
      seen.add(address);
      all.push(address);
      if (line[0] === '4') v4.push(address); else v6.push(address);
    }
    const addresses = order === DNS_ORDER_IPV4_FIRST ? v4.concat(v6) :
      order === DNS_ORDER_IPV6_FIRST ? v6.concat(v4) : all;
    req.oncomplete(0, addresses);
  }]);
  return 0;
}

function getnameinfo(req, address, port) {
  native('dnsLookupService', 'GETNAMEINFOREQWRAP', [address, port, (status, data) => {
    if (status) { req.oncomplete(status); return; }
    const at = data.indexOf('\n');
    req.oncomplete(0, data.slice(0, at), data.slice(at + 1));
  }]);
  return 0;
}

// The canonical text of an IP address, or undefined.
function canonicalizeIP(ip) {
  const family = isIP(ip);
  if (family === 4) return ip.split('.').map(Number).join('.');
  if (family === 6) {
    const { parseAddress, formatAddress } = require('internal/block_list_binding');
    const bytes = parseAddress(ip, 6);
    return bytes ? formatAddress(6, bytes) : undefined;
  }
  return undefined;
}

const finalizers = new FinalizationRegistry(id => host.net('dnsDestroy', [id]));

// ares_sysconfig_files.c: the order ares_gethostbyaddr consults the hosts file ('f')
// and DNS ('b'). resolv.conf's lookup line, then the hosts entries of nsswitch.conf,
// netsvc.conf and svc.conf, each replacing what came before; "fb" without any.
function configLookup(values) {
  let order = '';
  for (const value of values) {
    const name = value.toLowerCase();
    const ch = ['dns', 'bind', 'bind4', 'bind6', 'resolv', 'resolve'].includes(name) ? 'b' :
      ['files', 'file', 'local', 'local4', 'local6'].includes(name) ? 'f' : '';
    if (ch && !order.includes(ch)) order += ch;
  }
  return order;
}
function configLines(path) {
  try { return host.readText(path).split('\n'); } catch { return []; }
}
function sysconfigLookups() {
  let lookups = '';
  for (const line of configLines('/etc/resolv.conf')) {
    const text = line.trim();
    if (text[0] === '#' || text[0] === ';') continue;
    const match = /^(\S+)\s+(.*)$/.exec(text);
    if (match === null || (match[1] !== 'lookup' && match[1] !== 'hostresorder')) continue;
    const order = configLookup(match[2].trim().split(/[ \t]+/));
    if (order) lookups = order;
  }
  for (const [path, separator, split] of [['/etc/nsswitch.conf', ':', /[ \t]+/],
    ['/etc/netsvc.conf', '=', ','], ['/etc/svc.conf', '=', ',']]) {
    for (const line of configLines(path)) {
      if (line[0] === '#') continue;
      const at = line.indexOf(separator);
      if (at === -1 || line.slice(0, at).trim() !== 'hosts') continue;
      const order = configLookup(line.slice(at + 1).trim().split(split).map(value => value.trim()));
      if (order) lookups = order;
    }
  }
  return lookups || 'fb';
}

// ares_hosts_file.c: the hosts file as c-ares reads it. A line's names join the entry of
// an address or name already seen, so an entry holds every name of its addresses; a
// reverse lookup answers the entry's names after the first (its hostent aliases).
function hostsKey(text) {
  const family = isIP(text);
  return family === 0 ? null : canonicalizeIP(text);
}
function hostsFileAliases(ip, family) {
  const key = family === 4 ? canonicalizeIP(ip) : hostsKey(ip);
  const byAddress = new Map(), byName = new Map();
  for (const raw of configLines('/etc/hosts')) {
    const line = raw.trimStart();
    if (line === '' || line[0] === '#') continue;
    const fields = line.split(/[ \t\r\f\v]+/).filter(Boolean);
    const comment = fields.findIndex(field => field[0] === '#');
    if (comment !== -1) fields.length = comment;
    const address = hostsKey(fields[0]);
    if (address === null) continue;
    const names = fields.slice(1).filter(name => /^[A-Za-z0-9\-._/*]+$/.test(name));
    if (names.length === 0) continue;
    let entry = byAddress.get(address);
    const added = [];
    if (entry === undefined) {
      entry = names.map(name => byName.get(name.toLowerCase())).find(found => found !== undefined);
      if (entry === undefined) entry = { names: [] };
      byAddress.set(address, entry);
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (byName.has(lower)) continue;
      entry.names.push(name);
      added.push(lower);
    }
    for (const lower of added) byName.set(lower, entry);
  }
  const entry = byAddress.get(key);
  return entry === undefined ? null : entry.names.slice(1, 101);
}

class ChannelWrap {
  #id;
  #lookups;
  #pending = 0;
  constructor(timeout, tries) {
    const id = host.net('dnsCreate', [timeout, tries]);
    if (id < 0) {
      const err = new Error(`ares_init_options: ${strerror(-id)}`);
      err.code = codes[-id] ?? 'UNKNOWN';
      throw err;
    }
    this.#id = id;
    finalizers.register(this, id);
  }
  cancel() { host.net('dnsCancel', [this.#id]); }
  getServers() {
    const csv = host.net('dnsServers', [this.#id]);
    if (!csv) return [];
    return csv.split(',').map(server => {
      const v6 = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(server);
      if (v6) return [v6[1], Number(v6[2] || IANA_DNS_PORT)];
      const at = server.lastIndexOf(':');
      return at === -1 ? [server, IANA_DNS_PORT] : [server.slice(0, at), Number(server.slice(at + 1))];
    });
  }
  setServers(servers) {
    if (this.#pending) return DNS_ESETSRVPENDING;
    return host.net('dnsSetServers', [this.#id, servers.map(([family, address, port]) =>
      `${family === 6 ? `[${address}]` : address}:${port}`).join(',')]);
  }
  setLocalAddress(first, second) {
    const { codedError } = require('internal/validators');
    const invalid = message => codedError(TypeError, 'ERR_INVALID_ARG_VALUE', message);
    const firstFamily = isIP(first);
    if (!firstFamily) throw invalid('Invalid IP address.');
    let ipv4 = firstFamily === 4 ? first : '0.0.0.0';
    let ipv6 = firstFamily === 6 ? first : '::';
    if (second !== undefined) {
      const secondFamily = isIP(second);
      if (!secondFamily) throw invalid('Invalid IP address.');
      if (secondFamily === firstFamily) throw invalid(`Cannot specify two IPv${firstFamily} addresses.`);
      if (secondFamily === 4) ipv4 = second; else ipv6 = second;
    }
    host.net('dnsLocal', [this.#id, ipv4, ipv6]);
  }
  // QueryWrap: oncomplete(code string) on failure, else (0, records) and, for A and AAAA,
  // the ttls as a third argument.
  _query(req, name, rrtype) {
    // c-ares refuses .onion names (RFC 7686) with ARES_ENOTFOUND before any
    // packet is sent; Node completes such a query from an immediate.
    if (/\.onion\.?$/i.test(name)) {
      setImmediate(() => req.oncomplete('ENOTFOUND'));
      return 0;
    }
    this.#pending++;
    try {
      native('dnsQuery', 'QUERYWRAP', [this.#id, ascii(name), packet.types[rrtype], (status, data) => {
        this.#pending--;
        if (status) { req.oncomplete(codes[status] ?? 'UNKNOWN'); return; }
        let records;
        try { records = packet.decode(data, rrtype, true); }
        catch (e) { req.oncomplete(e.code || 'EBADRESP'); return; }
        if (rrtype === 'A' || rrtype === 'AAAA') {
          req.oncomplete(0, records.map(record => record.address), records.map(record => record.ttl));
        } else {
          req.oncomplete(0, records);
        }
      }]);
    } catch (e) { this.#pending--; throw e; }
    return 0;
  }
  getHostByAddr(req, ip) {
    const family = isIP(ip);
    // GetHostByAddrWrap::Send: an address uv_inet_pton cannot read is UV_EINVAL.
    if (!family) return require('internal/uv_binding').UV_EINVAL;
    // ares_gethostbyaddr's next_lookup: each source in the channel's lookup order in
    // turn. A DNS failure other than a cancel moves on to the next source; when none
    // has the address, the query fails with ENOTFOUND.
    this.#lookups ??= sysconfigLookups();
    const lookups = this.#lookups;
    const next = index => {
      for (; index < lookups.length; index++) {
        if (lookups[index] === 'f') {
          const names = hostsFileAliases(ip, family);
          // A c-ares callback made inside the call is deferred, as QueryWrap does.
          if (names !== null) { setImmediate(() => req.oncomplete(0, names)); return; }
          continue;
        }
        const at = index + 1;
        this._query({
          oncomplete(status, records) {
            if (status === 0 || status === 'ECANCELLED' || status === 'EDESTRUCTION') req.oncomplete(status, records);
            else next(at);
          },
        }, packet.reverseName(ip, family), 'PTR');
        return;
      }
      setImmediate(() => req.oncomplete('ENOTFOUND'));
    };
    next(0);
    return 0;
  }
}
const queries = { queryAny: 'ANY', queryA: 'A', queryAaaa: 'AAAA', queryCaa: 'CAA', queryCname: 'CNAME',
  queryMx: 'MX', queryNs: 'NS', queryTlsa: 'TLSA', queryTxt: 'TXT', querySrv: 'SRV', queryPtr: 'PTR',
  queryNaptr: 'NAPTR', querySoa: 'SOA' };
for (const [method, rrtype] of Object.entries(queries)) {
  Object.defineProperty(ChannelWrap.prototype, method, {
    configurable: true, writable: true,
    value: { [method](req, name) { return this._query(req, name, rrtype); } }[method],
  });
}

module.exports = {
  AI_ADDRCONFIG, AI_ALL, AI_V4MAPPED,
  DNS_ORDER_VERBATIM, DNS_ORDER_IPV4_FIRST, DNS_ORDER_IPV6_FIRST,
  ChannelWrap, GetAddrInfoReqWrap, GetNameInfoReqWrap, QueryReqWrap,
  getaddrinfo, getnameinfo, canonicalizeIP, strerror,
};
