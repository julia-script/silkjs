'use strict';

// extensionFormatMap of Node's lib/internal/modules/esm/get_format.js: the formats
// the ESM loader gives each file extension, as REPL completion lists them.
const { getOptionValue } = require('internal/options');

const extensionFormatMap = {
  '__proto__': null,
  '.cjs': 'commonjs',
  '.js': 'module',
  '.json': 'json',
  '.mjs': 'module',
  '.wasm': 'wasm',
};

function initializeExtensionFormatMap() {
  if (getOptionValue('--experimental-addon-modules')) {
    extensionFormatMap['.node'] = 'addon';
  }
  if (getOptionValue('--strip-types')) {
    extensionFormatMap['.ts'] = 'module-typescript';
    extensionFormatMap['.mts'] = 'module-typescript';
    extensionFormatMap['.cts'] = 'commonjs-typescript';
  }
}
initializeExtensionFormatMap();

module.exports = { extensionFormatMap, initializeExtensionFormatMap };
