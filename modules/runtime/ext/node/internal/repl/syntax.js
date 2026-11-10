'use strict';
const { Parser, tokTypes } = require('internal/repl/acorn');

function Recoverable(err) { this.err = err; }
Object.setPrototypeOf(Recoverable.prototype, SyntaxError.prototype);
Object.setPrototypeOf(Recoverable, SyntaxError);

// Follow Node's parser-token rule, not engine-specific SyntaxError messages:
// partial numeric tokens and invalid escapes must not enter multiline mode.
function isRecoverableError(error, code) {
  if (/^\s*\{/.test(code) && isRecoverableError(error, `(${code}`)) return true;
  let recoverable = false;
  const RecoveryParser = Parser.extend(Base => class extends Base {
    nextToken() {
      super.nextToken();
      if (this.type === tokTypes.eof) recoverable = true;
    }
    raise(pos, message) {
      if (message === 'Unterminated template' || message === 'Unterminated comment') recoverable = true;
      if (message === 'Unterminated string constant' && /\\(?:\r\n?|\n|\u2028|\u2029)$/.test(this.input.slice(this.lastTokStart, this.pos))) recoverable = true;
      super.raise(pos, message);
    }
  });
  try {
    RecoveryParser.parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
    return false;
  } catch { return recoverable; }
}
function isValidSyntax(code) {
  for (const source of [code, `_=${code}`]) {
    try {
      Parser.parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
      return true;
    } catch {}
  }
  return false;
}
function identifiers(pattern, names) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': names.add(pattern.name); break;
    case 'RestElement': identifiers(pattern.argument, names); break;
    case 'AssignmentPattern': identifiers(pattern.left, names); break;
    case 'ArrayPattern': for (const item of pattern.elements) identifiers(item, names); break;
    case 'ObjectPattern': for (const item of pattern.properties) identifiers(item.value || item.argument, names); break;
  }
}
function rememberBindings(code, names) {
  let ast;
  try { ast = Parser.parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true }); }
  catch { return; }
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) identifiers(declaration.id, names);
    } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      identifiers(statement.id, names);
    }
  }
}
module.exports = { Recoverable, isRecoverableError, isValidSyntax, rememberBindings };
