'use strict';

// Node's lib/punycode.js: the vendored code (internal/deps/punycode, which the
// runtime's own users such as tr46 load directly) behind a warning outside node_modules.
const { isInsideNodeModules } = require('internal/inside_node_modules');

if (!isInsideNodeModules()) {
	process.emitWarning(
		'The `punycode` module is deprecated. Please use a userland ' +
		'alternative instead.',
		'DeprecationWarning',
		'DEP0040',
	);
}

module.exports = require('internal/deps/punycode');
