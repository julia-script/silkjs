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
    // Its column counts in the script's own text, before any column offset.
    // An eval's code is V8's "<anonymous_script>" in the message, or the name its
    // sourceURL comment gives, which its frames show.
    // A module link error spans its import name, which V8 underlines whole.
    if (thrown !== undefined) {
      let name = thrown[0];
      if ((name === '' || name === '<input>') && typeof thrown[3] === 'string') name = evalScriptName(error) || '<anonymous_script>';
      return { name, line: thrown[1], column: thrown[2], text: thrown[3], textColumn: true, length: thrown[4] };
    }
  }
  if (error === null || typeof error !== 'object') return undefined;
  // A script that did not compile: V8's message points at the bad token.
  if (!fromPromise && error instanceof SyntaxError) {
    const { file, line, column } = host.syntaxOrigin;
    const fileName = error[file], lineNumber = error[line], columnNumber = error[column];
    if (typeof fileName === 'string' && Number.isInteger(lineNumber)) {
      return { name: fileName, line: lineNumber, column: columnNumber, text: undefined };
    }
  }
  try { void error.stack; } catch { return undefined; }
  const frame = require('internal/error_stack').origin(error);
  if (frame === undefined) return undefined;
  return { name: frame.scriptName, line: frame.lineNumber, column: frame.columnNumber, text: undefined };
}
function evalScriptName(error) {
  if (error === null || typeof error !== 'object') return undefined;
  try { void error.stack; } catch { return undefined; }
  const frame = require('internal/error_stack').origin(error);
  return frame?.isEval && frame.scriptMetadata?.sourceURL ? frame.scriptName : undefined;
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
  return source.split(/\r\n|[\n\r\u2028\u2029]/)[line - 1];
}
// GetErrorSource: "<script>:<line>\n<source line>\n<caret>\n". A script compiled
// with a column offset (vm's columnOffset) underlines its first line without it.
// scriptSource is that script's text, for a site in it whose function kept none.
function arrow(error, fromPromise, scriptName, lineOffset = 0, columnOffset = 0, scriptSource = undefined) {
  const where = site(error, fromPromise);
  if (where === undefined || typeof where.name !== 'string' || !where.name || !(where.line > 0)) return undefined;
  // Under --enable-source-maps the line comes from the original source.
  if (host.builtinLoaded('internal/source_maps')) {
    const maps = require('internal/source_maps');
    if (maps.getSourceMapsSupport().enabled) {
      try {
        const mapped = maps.errorSource(where.name, where.line, where.column - 1);
        if (typeof mapped === 'string') return mapped;
      } catch {}
    }
  }
  let text = where.text;
  if (typeof text !== 'string' && typeof scriptSource === 'string' && where.name === scriptName) {
    text = scriptSource.split(/\r\n|[\n\r\u2028\u2029]/)[where.line - lineOffset - 1];
  }
  if (typeof text !== 'string') text = fileLine(where.name, where.line);
  if (typeof text !== 'string') return undefined;
  const result = where.name + ':' + where.line + '\n' + text + '\n';
  const shift = !where.textColumn && where.name === scriptName && where.line === lineOffset + 1 ? columnOffset : 0;
  const start = where.column - 1 - shift;
  if (!(start >= 0) || start >= text.length) return result;
  let underline = '';
  for (let index = 0; index < start; index++) underline += text[index] === '\t' ? '\t' : ' ';
  const span = where.length > 1 ? Math.min(where.length, text.length - start) : 1;
  return result + underline + '^'.repeat(span) + '\n';
}
function stringOf(value) {
  try { return String(value); } catch { return '<toString() threw exception>'; }
}
// fatalExceptionStackEnhancers.afterInspector.
function inspected(error) {
  // Node's afterInspector reads the stack first: when that throws there is no trace.
  let originalStack;
  try { originalStack = error.stack; } catch { return undefined; }
  const { inspect } = require('util');
  // afterInspector: colors where shouldColorize(process.stderr) says so (FORCE_COLOR
  // among others), or by inspect's default.
  let colors = inspect.defaultOptions.colors;
  try { colors = require('internal/util/colors').shouldColorize(process.stderr) || colors; } catch {}
  try {
    return inspect(error, { colors, customInspect: false, depth: Math.max(inspect.defaultOptions.depth, 5) });
  } catch {
    return originalStack;
  }
}
// An error's message takes the stack the error captured when it was made, as V8's
// CreateMessage does, in PrintStackTrace's lines.
function errorTrace(error) {
  const frames = require('internal/error_stack').framesOf(error);
  if (!Array.isArray(frames)) return host.captureCallSites(-7, error);
  let text = '';
  for (const frame of frames) {
    const where = frame.scriptName + ':' + frame.lineNumber + ':' + frame.columnNumber;
    text += '    at ' + (frame.functionName ? frame.functionName + ' (' + where + ')' : where) + '\n';
  }
  return text;
}
function format(error, fromPromise) {
  const object = error !== null && (typeof error === 'object' || typeof error === 'function');
  const nativeError = object && require('util/types').isNativeError(error);
  // --trace-uncaught: read the throw-site stack before any getter below throws over it.
  const thrownAt = host.traceUncaught && !nativeError ? host.captureCallSites(-7, error) : undefined;
  let source;
  try {
    // GetErrorSource prints an arrow the error was given (setArrowMessage) first.
    const given = object ? error[host.privateSymbols.arrow_message_private_symbol] : undefined;
    if (!host.decoratedErrors.has(error)) source = (typeof given === 'string' ? given : undefined) ?? host.errorArrows.get(error) ?? arrow(error, fromPromise);
  } catch {}
  let text = '';
  // AppendExceptionLine prints the source of anything but an error at once.
  if (source !== undefined && !nativeError) { text += '\n' + source; source = undefined; }
  // fatalExceptionStackEnhancers.beforeInspector: an unhandled 'error' event names its emitter.
  if (object) {
    try {
      const enhance = error[require('internal/errors').kEnhanceStackBeforeInspector];
      if (typeof enhance === 'function') error.stack = enhance();
    } catch {}
  }
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
    if (!host.traceUncaught) {
      const program = require('path').basename(process.argv0 || 'node', '.exe') || 'node';
      text += '(Use `' + program + ' --trace-uncaught ...` to show where the exception was thrown)\n';
    }
  }
  // --trace-uncaught: the stack the value was thrown with, as PrintStackTrace writes it.
  if (host.traceUncaught) {
    const thrown = nativeError ? errorTrace(error) : thrownAt;
    if (typeof thrown === 'string') text += 'Thrown at:\n' + thrown + '\n';
  }
  // --no-extra-info-on-fatal-exception leaves out the version line.
  if (host.extraInfoOnFatalException === false) return text;
  return text + '\nNode.js ' + process.version + '\n';
}

// FormatCaughtException: what node.cc prints for an exception a TryCatch of its own
// caught, as the snapshot builder's: the source line, the error as V8's
// ToDetailString gives it (Error.prototype.toString for an error), then the frames.
function caught(error) {
  let source;
  try { source = arrow(error, false); } catch {}
  let text = source === undefined ? '' : source + '\n';
  let reason;
  try {
    reason = require('util/types').isNativeError(error) ? Error.prototype.toString.call(error) : String(error);
  } catch { reason = '<toString() threw exception>'; }
  text += reason + '\n';
  let stack;
  try { stack = error !== null && typeof error === 'object' ? error.stack : undefined; } catch {}
  if (typeof stack === 'string') {
    for (const line of stack.split('\n')) if (line.startsWith('    at ')) text += line + '\n';
  }
  return text;
}

module.exports = { format, caught, arrow };
