'use strict';

const { Buffer } = require('buffer');
const {
  validateString, validateObject, validateBoolean, validateOneOf,
} = require('internal/util_public/support');
const emptyOptions = Object.freeze(Object.create(null));

let parser;
let warned = false;

function parseTypeScript(source, options) {
  // Amaro's bundled Wasm runs in this realm's Silk WebAssembly implementation.
  // Loading lazily avoids compiling the parser for programs without TypeScript.
  if (parser === undefined) {
    // Node's assertTypeScript, when it loads the parser: Amaro is WebAssembly.
    if (globalThis.WebAssembly === undefined) {
      throw new (require('internal/errors').codes.ERR_WEBASSEMBLY_NOT_SUPPORTED)('TypeScript');
    }
    parser = require('internal/deps/amaro/index').transformSync;
  }
  try {
    return parser(source, options);
  } catch (cause) {
    let code;
    if (cause?.code === 'UnsupportedSyntax') code = 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
    else if (cause?.code === 'InvalidSyntax') code = 'ERR_INVALID_TYPESCRIPT_SYNTAX';
    else throw cause;
    const error = new SyntaxError(cause.message);
    error.code = code;
    const stack = error.stack;
    const newline = stack.indexOf('\n');
    error.stack = `${cause.filename}:${cause.startLine}\n${cause.snippet}\nSyntaxError [${code}]: ${cause.message}${newline < 0 ? '' : stack.slice(newline)}`;
    // Node's decorateErrorWithSnippet: the stack leads with where the syntax is, so a
    // fatal report prints no arrow for where it was thrown.
    require('internal/host').decoratedErrors.add(error);
    throw error;
  }
}

function processTypeScriptCode(source, options) {
  const { code, map } = parseTypeScript(source, options);
  if (map) {
    return `${code}\n\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}`;
  }
  return options.filename ? `${code}\n\n//# sourceURL=${options.filename}` : code;
}

function stripTypeScriptTypes(code, options = emptyOptions) {
  if (!warned) {
    warned = true;
    process.emitWarning('stripTypeScriptTypes is an experimental feature and might change at any time', 'ExperimentalWarning');
  }
  validateString(code, 'code');
  validateObject(options, 'options');
  // Preserve Node's observable getter and validation order.
  const { sourceMap = false, sourceUrl = '' } = options;
  let { mode = 'strip' } = options;
  validateOneOf(mode, 'options.mode', ['strip', 'transform']);
  validateBoolean(sourceMap, 'options.sourceMap');
  validateString(sourceUrl, 'options.sourceUrl');
  if (mode === 'strip') {
    validateOneOf(sourceMap, 'options.sourceMap', [false, undefined]);
    mode = 'strip-only';
  }
  return processTypeScriptCode(code, { mode, sourceMap, filename: sourceUrl });
}

// Loader entry point. Returns JavaScript; it never evaluates the supplied source.
// Module-system selection, CLI option policy and compilation belong to the loader.
function stripTypeScriptModuleTypes(source, filename, mode = 'strip-only', sourceMap = false, sourceURL = filename) {
  validateString(source, 'source');
  validateString(filename, 'filename');
  validateOneOf(mode, 'mode', ['strip-only', 'transform']);
  validateBoolean(sourceMap, 'sourceMap');
  validateString(sourceURL, 'sourceURL');
  if (/^(?:.*)[\\/]node_modules[\\/]/.test(filename)) {
    const error = new Error(`Stripping types is currently unsupported for files under node_modules, for "${filename}"`);
    error.code = 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING';
    throw error;
  }
  return processTypeScriptCode(source, { mode, sourceMap, filename: sourceURL });
}

module.exports = { stripTypeScriptTypes, stripTypeScriptModuleTypes };
