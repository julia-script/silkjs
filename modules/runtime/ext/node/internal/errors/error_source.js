// Adapted from Node.js v24.22.1 lib/internal/errors/error_source.js: positions
// come from internal/error_stack (host.errorStackState), source maps from internal/source_maps.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  FunctionPrototypeBind,
  StringPrototypeSlice,
} = require('internal/per_context/primordials');

const { builtinLoaded, errorStackState: { getErrorSourcePositions } } = require('internal/host');

// Source maps are off until internal/source_maps loads to switch them on.
function sourceMaps() {
  return builtinLoaded('internal/source_maps') ? require('internal/source_maps') : undefined;
}

/**
 * Get the source location of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed. The resolution is based on the structured
 * error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {{sourceLine: string, startColumn: number}|undefined}
 */
function getErrorSourceLocation(error) {
  const pos = getErrorSourcePositions(error);
  if (pos === undefined) {
    return;
  }
  const {
    sourceLine,
    scriptResourceName,
    lineNumber,
    startColumn,
  } = pos;

  // Source map is not enabled. Return the source line directly.
  const maps = sourceMaps();
  if (maps === undefined || !maps.getSourceMapsSupport().enabled) {
    return { sourceLine, startColumn };
  }

  const sm = maps.findSourceMap(scriptResourceName);
  if (sm === undefined) {
    return;
  }
  const {
    originalLine,
    originalColumn,
    originalSource,
  } = sm.findEntry(lineNumber - 1, startColumn);
  const originalSourceLine = getSourceLine(sm, originalSource, originalLine);

  if (!originalSourceLine) {
    return;
  }

  return {
    sourceLine: originalSourceLine,
    startColumn: originalColumn,
  };
}

// The text of line `line` (0-based) of a source map's original source: its
// sourcesContent, as Node's source_map_cache getSourceLine reads it.
function getSourceLine(sm, originalSource, line) {
  const { sources, sourcesContent } = sm.payload;
  const index = sources === undefined ? -1 : sources.indexOf(originalSource);
  const content = index === -1 || sourcesContent === undefined ? undefined : sourcesContent[index];
  if (typeof content !== 'string') return;
  return content.split(/\r?\n/)[line];
}

const memberAccessTokens = [ '.', '?.', '[', ']' ];
const memberNameTokens = [ 'name', 'string', 'num' ];
let tokenizer;
/**
 * Get the first expression in a code string at the startColumn.
 * @param {string} code source code line
 * @param {number} startColumn which column the error is constructed
 * @returns {string}
 */
function getFirstExpression(code, startColumn) {
  // Lazy load acorn.
  if (tokenizer === undefined) {
    const Parser = require('internal/repl/acorn').Parser;
    tokenizer = FunctionPrototypeBind(Parser.tokenizer, Parser);
  }

  let lastToken;
  let firstMemberAccessNameToken;
  let terminatingCol;
  let parenLvl = 0;
  // Tokenize the line to locate the expression at the startColumn.
  // The source line may be an incomplete JavaScript source, so do not parse the source line.
  for (const token of tokenizer(code, { ecmaVersion: 'latest' })) {
    // Peek before the startColumn.
    if (token.start < startColumn) {
      // There is a semicolon. This is a statement before the startColumn, so reset the memo.
      if (token.type.label === ';') {
        firstMemberAccessNameToken = null;
        continue;
      }
      // Try to memo the member access expressions before the startColumn, so that the
      // returned source code contains more info:
      //   assert.ok(value)
      //          ^ startColumn
      // The member expression can also be like
      //   assert['ok'](value) or assert?.ok(value)
      //               ^ startColumn      ^ startColumn
      if (memberAccessTokens.includes(token.type.label) && lastToken?.type.label === 'name') {
        // First member access name token must be a 'name'.
        firstMemberAccessNameToken ??= lastToken;
      } else if (!memberAccessTokens.includes(token.type.label) &&
        !memberNameTokens.includes(token.type.label)) {
        // Reset the memo if it is not a simple member access.
        // For example: assert[(() => 'ok')()](value)
        //                                    ^ startColumn
        firstMemberAccessNameToken = null;
      }
      lastToken = token;
      continue;
    }
    // Now after the startColumn, this must be an expression.
    if (token.type.label === '(') {
      parenLvl++;
      continue;
    }
    if (token.type.label === ')') {
      parenLvl--;
      if (parenLvl === 0) {
        // A matched closing parenthesis found after the startColumn,
        // terminate here. Include the token.
        //   (assert.ok(false), assert.ok(true))
        //           ^ startColumn
        terminatingCol = token.start + 1;
        break;
      }
      continue;
    }
    if (token.type.label === ';') {
      // A semicolon found after the startColumn, terminate here.
      //   assert.ok(false); assert.ok(true));
      //          ^ startColumn
      terminatingCol = token;
      break;
    }
    // If no semicolon found after the startColumn. The string after the
    // startColumn must be the expression.
    //   assert.ok(false)
    //          ^ startColumn
  }
  const start = firstMemberAccessNameToken?.start ?? startColumn;
  return StringPrototypeSlice(code, start, terminatingCol);
}

/**
 * Get the source expression of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed, or the source location may be incorrect. The
 * resolution is based on the structured error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {string|undefined}
 */
function getErrorSourceExpression(error) {
  const loc = getErrorSourceLocation(error);
  if (loc === undefined) {
    return;
  }
  const { sourceLine, startColumn } = loc;
  return getFirstExpression(sourceLine, startColumn);
}

module.exports = {
  getErrorSourceLocation,
  getErrorSourceExpression,
};
