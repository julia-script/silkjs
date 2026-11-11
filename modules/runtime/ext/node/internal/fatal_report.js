'use strict';

// The text Node's ReportFatalException writes to stderr for an exception nothing
// handled (src/node_errors.cc): the source line it came from with a caret under
// the column, the error as util.inspect shows it, and the Node.js version.
const host = require('internal/host');

// Where the exception happened. A value a throw statement threw points at that
// statement, as V8's message does; anything else (an engine error, a rejection
// reason) at the first frame of its own stack.
function site(error, fromPromise) {
  if (!fromPromise) {
    const thrown = host.captureCallSites(-4, error);
    if (thrown !== undefined) return { name: thrown[0], line: thrown[1], column: thrown[2], text: thrown[3] };
  }
  if (error === null || typeof error !== 'object') return undefined;
  try { void error.stack; } catch { return undefined; }
  const frame = require('internal/error_stack').origin(error);
  if (frame === undefined) return undefined;
  return { name: frame.scriptName, line: frame.lineNumber, column: frame.columnNumber, text: undefined };
}
// The line'th line of the script a frame names, read from its file.
function fileLine(name, line) {
  let path = name;
  if (path.startsWith('file:')) {
    try { path = require('url').fileURLToPath(path); } catch { return undefined; }
  }
  if (!require('path').isAbsolute(path)) return undefined;
  let source;
  try { source = require('fs').readFileSync(path, 'utf8'); } catch { return undefined; }
  return source.split(/\r\n|[\n\r  ]/)[line - 1];
}
// GetErrorSource: "<script>:<line>\n<source line>\n<caret>\n".
function arrow(error, fromPromise) {
  const where = site(error, fromPromise);
  if (where === undefined || typeof where.name !== 'string' || !where.name || !(where.line > 0)) return undefined;
  const text = typeof where.text === 'string' ? where.text : fileLine(where.name, where.line);
  if (typeof text !== 'string') return undefined;
  const result = where.name + ':' + where.line + '\n' + text + '\n';
  const start = where.column - 1;
  if (!(start >= 0) || start >= text.length) return result;
  let underline = '';
  for (let index = 0; index < start; index++) underline += text[index] === '\t' ? '\t' : ' ';
  return result + underline + '^\n';
}
function stringOf(value) {
  try { return String(value); } catch { return '<toString() threw exception>'; }
}
// fatalExceptionStackEnhancers.afterInspector.
function inspected(error) {
  const { inspect } = require('util');
  let colors = inspect.defaultOptions.colors;
  try { colors = colors || (process.stderr.isTTY === true && process.stderr.hasColors?.() === true); } catch {}
  try {
    return inspect(error, { colors, customInspect: false, depth: Math.max(inspect.defaultOptions.depth, 5) });
  } catch {
    try { return error.stack; } catch { return undefined; }
  }
}
function format(error, fromPromise) {
  const object = error !== null && (typeof error === 'object' || typeof error === 'function');
  const nativeError = object && require('util/types').isNativeError(error);
  let source;
  try { source = arrow(error, fromPromise); } catch {}
  let text = '';
  // AppendExceptionLine prints the source of anything but an error at once.
  if (source !== undefined && !nativeError) { text += '\n' + source; source = undefined; }
  const trace = object ? inspected(error) : undefined;
  if (typeof trace === 'string' && trace.length > 0) {
    text += (source === undefined ? '' : source + '\n') + trace + '\n';
  } else {
    let message, name;
    if (object) {
      try { message = error.message; name = error.name; } catch {}
    }
    if (message === undefined || name === undefined) text += stringOf(error) + '\n';
    else text += (source === undefined ? '' : source + '\n') + stringOf(name) + ': ' + stringOf(message) + '\n';
    const program = require('path').basename(process.argv0 || 'node', '.exe') || 'node';
    text += '(Use `' + program + ' --trace-uncaught ...` to show where the exception was thrown)\n';
  }
  return text + '\nNode.js ' + process.version + '\n';
}

module.exports = { format };
