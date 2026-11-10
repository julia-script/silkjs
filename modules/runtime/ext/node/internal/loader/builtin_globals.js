'use strict';
const Module = require('module');

// Eval and REPL scopes share Node's lazy, non-enumerable builtin bindings.
// Assignment removes the accessor so the replacement is an ordinary property.
module.exports = function addBuiltinGlobals(object, label) {
  const loader = new Module(label);
  for (const name of Module.builtinModules) {
    if (name.startsWith('_') || name.includes('/') || Object.hasOwn(object, name)) continue;
    const assign = value => { delete object[name]; object[name] = value; };
    Object.defineProperty(object, name, {
      configurable: true, enumerable: false,
      get() {
        const value = loader.require(name);
        try {
          Object.defineProperty(object, name, {
            configurable: true, enumerable: false, get: () => value, set: assign,
          });
        } catch {
          // Loading still succeeds if the caller froze the original accessor.
        }
        return value;
      },
      set: assign,
    });
  }
};
