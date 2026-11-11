'use strict';

// The parts of Node.js lib/internal/url.js that the ported modules use.
const { URL, urlToHttpOptions } = require('url');

// Like Node: an object is a URL when it has the shape of one, whatever realm made it.
function isURL(self) {
  return Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined);
}

module.exports = { URL, urlToHttpOptions, isURL };
