'use strict';

// makeContextifyScript of Node's lib/internal/vm.js, over the vm module's Script.
// The runtime has no V8 code cache, so cachedData and produceCachedData are
// ignored, and each script is its own host-defined option.
const kInternalImportModuleDynamically = Symbol('kInternalImportModuleDynamically');

function makeContextifyScript(code, filename, lineOffset, columnOffset, cachedData,
                              produceCachedData, parsingContext, hostDefinedOptionId,
                              importModuleDynamically) {
  const { Script } = require('vm');
  const options = { __proto__: null, filename, lineOffset, columnOffset };
  if (importModuleDynamically !== undefined) options[kInternalImportModuleDynamically] = importModuleDynamically;
  return new Script(code, options);
}

module.exports = { kInternalImportModuleDynamically, makeContextifyScript };
