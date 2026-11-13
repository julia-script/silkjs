'use strict';

// Node's lib/internal/modules/esm/assert.js: the import attributes each module format
// takes, checked by the runtime loader for every import request.
const host = require('internal/host');

// The HTML spec has an implied default type of `'javascript'`.
const kImplicitTypeAttribute = 'javascript';

/**
 * Whether importAttributes fit a module of format at url: true, or the import
 * attribute error Node throws.
 * @param {string} url
 * @param {string} format
 * @param {Record<string, string>} [importAttributes]
 * @returns {true}
 */
function validateAttributes(url, format, importAttributes = { __proto__: null }) {
  return host.loader.validateAttributes(format, url, importAttributes);
}

module.exports = {
  kImplicitTypeAttribute,
  validateAttributes,
};
