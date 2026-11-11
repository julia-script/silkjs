'use strict';
// Node's internal/util customPromisifyArgs: a callback API that reports several
// values names them here, and util.promisify resolves with an object of them.
module.exports = { customPromisifyArgs: Symbol('customPromisifyArgs') };
