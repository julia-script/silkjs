'use strict';

// The parts of Node.js lib/internal/url.js that the ported modules use.
const { URL, urlToHttpOptions, fileURLToPath, pathToFileURL } = require('url');

// Like Node: an object is a URL when it has the shape of one, whatever realm made it.
function isURL(self) {
  return Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined);
}

// URL.parse without a lookup of the global URL, which user code can replace.
function URLParse(input, base) {
  return URL.parse(input, base);
}

module.exports = { URL, URLParse, urlToHttpOptions, isURL, fileURLToPath, pathToFileURL };
