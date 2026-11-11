// Silk support for the Node.js v24.22.1 debugger client (MIT; see PROVENANCE.json).
'use strict';

// Pieces of Node's internal/util and the errors binding that the `node inspect`
// client (internal/debugger/*, Node.js v24.22.1) uses.

// Mirrors internal/util's cross-realm-safe replace; every regex here is a literal.
function SideEffectFreeRegExpPrototypeSymbolReplace(regex, string, replacement) {
  return RegExp.prototype[Symbol.replace].call(new RegExp(regex.source, regex.flags), string, replacement);
}
function isObjectLiteral(code) {
  return /^\s*{/.exec(code) !== null && /;\s*$/.exec(code) === null;
}

module.exports = {
  customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
  SideEffectFreeRegExpPrototypeSymbolReplace,
  isObjectLiteral,
  exitCodes: { kNoFailure: 0, kGenericUserError: 1, kInvalidCommandLineArgument: 9 },
  debuglog: (name) => require('util').debuglog(name),
};
