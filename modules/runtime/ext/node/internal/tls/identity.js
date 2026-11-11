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
// Hostname policy adapted from Node.js v24 lib/tls.js.

'use strict';
const net = require('net');
const { domainToASCII, URL } = require('url');
const { isArray: ArrayIsArray } = Array;
const { parse: JSONParse } = JSON;
const { fromCharCode: StringFromCharCode } = String;
// cares_wrap canonicalizeIP: inet_pton then uv_inet_ntop; undefined when not an address.
function canonicalizeIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return undefined;
  let text = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const words = [...left, ...Array(tail === null ? 0 : 8 - left.length - right.length).fill('0'), ...right].map(w => parseInt(w, 16));
  // The longest run of two or more zero words becomes '::' (uv's inet_ntop6).
  let best = { base: -1, len: 0 }, cur = { base: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) { if (cur.base === -1) cur = { base: i, len: 1 }; else cur.len++; }
    else if (cur.base !== -1) { if (best.base === -1 || cur.len > best.len) best = cur; cur = { base: -1, len: 0 }; }
  }
  if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) { if (i === best.base) out += ':'; continue; }
    if (i !== 0) out += ':';
    if (i === 6 && best.base === 0 && (best.len === 6 || (best.len === 7 && words[7] !== 1) || (best.len === 5 && words[5] === 0xffff))) {
      out += `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
      break;
    }
    out += words[i].toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}
class ERR_TLS_CERT_ALTNAME_FORMAT extends SyntaxError {
  constructor() { super('Invalid subject alternative name string'); this.code = 'ERR_TLS_CERT_ALTNAME_FORMAT'; }
}
class ERR_TLS_CERT_ALTNAME_INVALID extends Error {
  constructor(reason, host, cert) { super('Hostname/IP does not match certificate\'s altnames: ' + reason); this.code = 'ERR_TLS_CERT_ALTNAME_INVALID'; this.reason = reason; this.host = host; this.cert = cert; }
}
function unfqdn(host) {
  return host.replace(/[.]$/, '');
}

// String#toLowerCase() is locale-sensitive so we use
// a conservative version that only lowercases A-Z.
function toLowerCase(c) {
  return StringFromCharCode(32 + c.charCodeAt(0));
}

function splitHost(host) {
  return unfqdn(host).replace(/[A-Z]/g, toLowerCase).split('.');
}

function check(hostParts, pattern, wildcards) {
  // Empty strings, null, undefined, etc. never match.
  if (!pattern)
    return false;

  const patternParts = splitHost(pattern);

  if (hostParts.length !== patternParts.length)
    return false;

  // Pattern has empty components, e.g. "bad..example.com".
  if (patternParts.includes(''))
    return false;

  // RFC 6125 allows IDNA U-labels (Unicode) in names but we have no
  // good way to detect their encoding or normalize them so we simply
  // reject them.  Control characters and blanks are rejected as well
  // because nothing good can come from accepting them.
  const isBad = (s) => /[^\u0021-\u007F]/u.test(s);
  if (patternParts.some(isBad))
    return false;

  // Check host parts from right to left first.
  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i])
      return false;
  }

  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split('*', 3);

  // Short-circuit when the subdomain does not contain a wildcard.
  // RFC 6125 does not allow wildcard substitution for components
  // containing IDNA A-labels (Punycode) so match those verbatim.
  if (patternSubdomainParts.length === 1 ||
      patternSubdomain.includes('xn--'))
    return hostSubdomain === patternSubdomain;

  if (!wildcards)
    return false;

  // More than one wildcard is always wrong.
  if (patternSubdomainParts.length > 2)
    return false;

  // *.tld wildcards are not allowed.
  if (patternParts.length <= 2)
    return false;

  const { 0: prefix, 1: suffix } = patternSubdomainParts;

  if (prefix.length + suffix.length > hostSubdomain.length)
    return false;

  if (!hostSubdomain.startsWith(prefix))
    return false;

  if (!hostSubdomain.endsWith(suffix))
    return false;

  return true;
}

// This pattern is used to determine the length of escaped sequences within
// the subject alt names string. It allows any valid JSON string literal.
// This MUST match the JSON specification (ECMA-404 / RFC8259) exactly.
const jsonStringPattern =
  // eslint-disable-next-line no-control-regex
  /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

function splitEscapedAltNames(altNames) {
  const result = [];
  let currentToken = '';
  let offset = 0;
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(',', offset);
    const nextQuote = altNames.indexOf('"', offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      // There is a quote character and there is no separator before the quote.
      currentToken += altNames.substring(offset, nextQuote);
      const match = jsonStringPattern.exec(altNames.substring(nextQuote));
      if (!match) {
        throw new ERR_TLS_CERT_ALTNAME_FORMAT();
      }
      currentToken += JSONParse(match[0]);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      // There is a separator and no quote before it.
      currentToken += altNames.substring(offset, nextSep);
      result.push(currentToken);
      currentToken = '';
      offset = nextSep + 2;
    } else {
      currentToken += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}

exports.checkServerIdentity = function checkServerIdentity(hostname, cert) {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames = [];
  const ips = [];

  hostname = '' + hostname;
  const hostnameASCII = domainToASCII(hostname);

  // Remove trailing dots for error messages and matching.
  hostname = unfqdn(hostname);
  const hostnameASCIIWithoutFQDN = unfqdn(hostnameASCII);
  const hostnameIsIP = net.isIP(hostname);
  const hostnameASCIIIsIP = net.isIP(hostnameASCIIWithoutFQDN);

  if (altNames) {
    const splitAltNames = altNames.includes('"') ?
      splitEscapedAltNames(altNames) :
      altNames.split(', ');
    splitAltNames.forEach((name) => {
      if (name.startsWith('DNS:')) {
        dnsNames.push(name.slice(4));
      } else if (name.startsWith('IP Address:')) {
        ips.push(canonicalizeIP(name.slice(11)));
      }
    });
  }

  // Non-canonical IP address spellings can be interpreted differently by
  // domainToASCII() and the operating system resolver. Reject them instead of
  // validating a certificate against an address that may not be the peer.
  if (!hostnameIsIP && hostnameASCIIIsIP) {
    return new ERR_TLS_CERT_ALTNAME_INVALID(
      'Host is a non-canonical IP address', hostname, cert);
  }

  let valid = false;
  let reason = 'Unknown reason';

  // An IP literal must not be IDNA-normalized: domainToASCII() returns '' for
  // an IPv6 literal (it is not a domain), so matching against the normalized
  // host would skip IP-SAN matching for IPv6 entirely. Match IP hosts against
  // the original hostname (net.isIP() rejects non-ASCII, so there is no IDNA
  // confusion to guard against here); the normalized form is kept for the
  // DNS-name path below.
  if (hostnameIsIP) {
    valid = ips.includes(canonicalizeIP(hostname));
    if (!valid) {
      reason =
        `IP: ${hostname} is not in the cert's list: ` + ips.join(', ');
    }
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(hostnameASCIIWithoutFQDN);
    const wildcard = (pattern) => check(hostParts, pattern, true);

    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid)
        reason =
          `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
    } else {
      // Match against Common Name only if no supported identifiers exist.
      const cn = subject.CN;

      if (ArrayIsArray(cn))
        valid = cn.some(wildcard);
      else if (cn)
        valid = wildcard(cn);

      if (!valid)
        reason = `Host: ${hostname}. is not cert's CN: ${cn}`;
    }
  } else {
    reason = 'Cert does not contain a DNS name';
  }

  if (!valid) {
    return new ERR_TLS_CERT_ALTNAME_INVALID(reason, hostname, cert);
  }
};

