'use strict';

// internalBinding('url') (Node.js v24.22.1 src/node_url.cc, over ada) for lib/internal/url.js,
// on the runtime's WHATWG URL natives (src/ext/url_native.silk, silk.url). Parse and update
// return the href and write ada's url_aggregator offsets into urlComponents, as node_url.cc does.

const {
  urlParse, urlCanParse, urlUpdate, urlDomainToASCII, urlDomainToUnicode, urlIdnaToASCII,
} = require('internal/host');

// urlComponents: protocol_end, username_end, host_start, host_end, port, pathname_start,
// search_start, hash_start, scheme_type. ada uses uint32_t(-1) for an omitted port, search or hash.
const urlComponents = new Uint32Array(9);
const OMITTED = 4294967295;
const NOT_SPECIAL = 1;

// ThrowInvalidURL in node_errors.h: a plain TypeError, with the input and any base.
function invalidURL(input, base) {
  const error = new TypeError('Invalid URL');
  error.code = 'ERR_INVALID_URL';
  error.input = input;
  if (base !== undefined) error.base = base;
  return error;
}

// (input, base, raiseException) -> href, or undefined (or a throw) when it does not parse.
function parse(input, base, raiseException) {
  const href = urlParse(input, base, urlComponents);
  if (href === undefined && raiseException) throw invalidURL(input, base);
  return href;
}

function canParse(input, base) {
  return urlCanParse(input, base);
}

// updateActions in lib/internal/url.js, mapped to the natives' setter numbers.
const kHref = 9;
const setters = [1 /* protocol */, 4 /* host */, 5 /* hostname */, 6 /* port */, 2 /* username */,
  3 /* password */, 7 /* pathname */, 8 /* search */, 9 /* hash */];

// (href, action, value) -> the new href, or false when an href does not parse.
function update(href, action, value) {
  if (action === kHref) return urlParse(value, undefined, urlComponents) ?? false;
  return urlUpdate(href, setters[action], value, urlComponents);
}

// ada's host_start is the '@' before the host when the URL has credentials.
function hostStart(href) {
  const start = urlComponents[2];
  return href[start] === '@' ? start + 1 : start;
}

// The characters PathToFileURL escapes before it sets the path, RFC 1738's unsafe ones and what
// the path setter keeps or the parser strips. A backslash is a separator on Windows.
const fileEscapes = {
  __proto__: null, '\t': '%09', '\n': '%0A', '\r': '%0D', ' ': '%20', '"': '%22', '#': '%23',
  '%': '%25', '?': '%3F', '[': '%5B', '\\': '%5C', ']': '%5D', '^': '%5E', '|': '%7C', '~': '%7E',
};

// PathToFileURL: escapes the path, then sets the path (and, for a UNC path, the host) of file://.
function pathToFileURL(path, windows, hostname) {
  let escaped = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    const escape = c === '\\' && windows ? undefined : fileEscapes[c];
    escaped += escape ?? c;
  }
  const href = urlUpdate('file://', 7, escaped, urlComponents);
  if (hostname === undefined) return href;
  // ada's set_hostname refuses a forbidden host, and PathToFileURL throws for it.
  if (!urlCanParse(`file://${hostname}/`, undefined)) throw invalidURL(path);
  return urlUpdate(href, 5, hostname, urlComponents);
}

// url.format(URL, options): the href without the parts left out, the host in Unicode if asked.
function format(href, hash, unicode, search, auth) {
  let text = urlParse(href, undefined, urlComponents);
  if (!hash) text = urlUpdate(text, 9, '', urlComponents);
  if (!search) text = urlUpdate(text, 8, '', urlComponents);
  if (!auth) {
    text = urlUpdate(text, 2, '', urlComponents);
    text = urlUpdate(text, 3, '', urlComponents);
  }
  // ada::idna::to_unicode changes only domains: a special URL's host that is not an IPv6 address.
  if (!unicode || urlComponents[8] === NOT_SPECIAL) return text;
  const start = hostStart(text), end = urlComponents[3];
  if (end === start || text[start] === '[') return text;
  return text.slice(0, start) + urlDomainToUnicode(text.slice(start, end)) + text.slice(end);
}

const specialOrigins = { __proto__: null, 'http:': true, 'https:': true, 'ws:': true, 'wss:': true, 'ftp:': true };
// The origin of a URL string, without making a URL object.
function getOrigin(input) {
  const href = urlParse(input, undefined, urlComponents);
  if (href === undefined) throw invalidURL(input);
  const protocol = href.slice(0, urlComponents[0]);
  if (specialOrigins[protocol]) return `${protocol}//${href.slice(hostStart(href), urlComponents[5])}`;
  if (protocol === 'blob:') {
    const search = urlComponents[6], hash = urlComponents[7];
    const end = search !== OMITTED ? search : hash !== OMITTED ? hash : href.length;
    const inner = urlParse(href.slice(urlComponents[5], end), undefined, urlComponents);
    if (inner !== undefined) {
      const innerProtocol = inner.slice(0, urlComponents[0]);
      if (innerProtocol === 'http:' || innerProtocol === 'https:') {
        return `${innerProtocol}//${inner.slice(hostStart(inner), urlComponents[5])}`;
      }
    }
  }
  return 'null';
}

module.exports = {
  urlComponents,
  parse,
  canParse,
  update,
  pathToFileURL,
  format,
  getOrigin,
  domainToASCII: urlDomainToASCII,
  domainToUnicode: urlDomainToUnicode,
  // internalBinding('encoding_binding').toASCII, which lib/url.js uses.
  toASCII: urlIdnaToASCII,
};
