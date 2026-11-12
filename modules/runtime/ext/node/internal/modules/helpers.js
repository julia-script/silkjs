'use strict';

// The parts of Node's lib/internal/modules/helpers.js the REPL and eval use.
const { ArrayPrototypeForEach, ObjectDefineProperty, ObjectPrototypeHasOwnProperty, StringPrototypeIncludes } =
  require('internal/per_context/primordials');
const host = require('internal/host');

// The module-scoped require of mod: resolution, paths, main, cache and extensions
// are the loader's own, as for a module the loader compiled.
function makeRequireFunction(mod) {
  const Module = require('module');
  if (mod instanceof Module !== true) {
    const { ERR_INVALID_ARG_TYPE } = require('internal/errors').codes;
    throw new ERR_INVALID_ARG_TYPE('mod', 'Module', mod);
  }
  return host.loader.requireFor(mod.filename, mod);
}

// Eval and REPL scopes get every public top-level builtin as a lazy, non-enumerable
// binding. Assignment removes the accessor so the replacement is an ordinary property.
function addBuiltinLibsToObject(object, dummyModuleName) {
  const Module = require('module');
  const { builtinModules } = Module;
  const dummyModule = new Module(dummyModuleName);
  ArrayPrototypeForEach(builtinModules, (name) => {
    if (name[0] === '_' || StringPrototypeIncludes(name, '/') || ObjectPrototypeHasOwnProperty(object, name)) return;
    const setReal = (val) => {
      delete object[name];
      object[name] = val;
    };
    ObjectDefineProperty(object, name, {
      __proto__: null,
      get: () => {
        const lib = dummyModule.require(name);
        try {
          ObjectDefineProperty(object, name, {
            __proto__: null, get: () => lib, set: setReal, configurable: true, enumerable: false,
          });
        } catch {
          // Loading still succeeds if the caller froze the original accessor.
        }
        return lib;
      },
      set: setReal,
      configurable: true,
      enumerable: false,
    });
  });
}

module.exports = { makeRequireFunction, addBuiltinLibsToObject };
