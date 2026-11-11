// Adapted from Node.js v24.22.1 lib/internal/test_runner/reporter/utils.js.
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
  ArrayPrototypeJoin,
  RegExpPrototypeSymbolSplit,
  SafeMap,
  StringPrototypeRepeat,
  hardenRegExp,
} = require('internal/per_context/primordials');
const colors = require('internal/util/colors');
const { inspectWithNoCustomRetry } = require('internal/test_runner/support');
const indentMemo = new SafeMap();

const inspectOptions = {
  __proto__: null,
  colors: colors.shouldColorize(process.stdout),
  breakLength: Infinity,
};

const reporterUnicodeSymbolMap = {
  '__proto__': null,
  'test:fail': '\u2716 ',
  'test:pass': '\u2714 ',
  'test:diagnostic': '\u2139 ',
  'test:log': '\u2139 ',
  'test:coverage': '\u2139 ',
  'arrow:right': '\u25B6 ',
  'hyphen:minus': '\uFE63 ',
  'warning:alert': '\u26A0 ',
};

const reporterColorMap = {
  '__proto__': null,
  get 'test:fail'() {
    return colors.red;
  },
  get 'test:pass'() {
    return colors.green;
  },
  get 'test:diagnostic'() {
    return colors.blue;
  },
  get 'test:log'() {
    return colors.blue;
  },
  get 'info'() {
    return colors.blue;
  },
  get 'warn'() {
    return colors.yellow;
  },
  get 'error'() {
    return colors.red;
  },
};

function indent(nesting) {
  let value = indentMemo.get(nesting);
  if (value === undefined) {
    value = StringPrototypeRepeat('  ', nesting);
    indentMemo.set(nesting, value);
  }
  return value;
}

function formatError(error, indent) {
  const err = error.code === 'ERR_TEST_FAILURE' ? error.cause : error;
  const message = ArrayPrototypeJoin(
    RegExpPrototypeSymbolSplit(
      hardenRegExp(/\r?\n/),
      inspectWithNoCustomRetry(err, inspectOptions),
    ), `\n${indent}  `);
  return `\n${indent}  ${message}\n`;
}

function formatTestReport(type, data, showErrorDetails = true, prefix = '', indent = '') {
  let color = reporterColorMap[type] ?? colors.white;
  let symbol = reporterUnicodeSymbolMap[type] ?? ' ';
  const { skip, todo, expectFailure } = data;
  const duration_ms = data.details?.duration_ms ? ` ${colors.gray}(${data.details.duration_ms}ms)${colors.white}` : '';
  const replayed = data.details?.passed_on_attempt !== undefined ?
    ` ${colors.gray}(passed on attempt ${data.details.passed_on_attempt})${colors.white}` :
    '';
  let title = `${data.name}${duration_ms}${replayed}`;

  if (skip !== undefined) {
    title += ` # ${typeof skip === 'string' && skip.length ? skip : 'SKIP'}`;
    color = colors.gray;
    symbol = reporterUnicodeSymbolMap['hyphen:minus'];
  } else if (todo !== undefined) {
    title += ` # ${typeof todo === 'string' && todo.length ? todo : 'TODO'}`;
    if (type === 'test:fail') {
      color = colors.yellow;
      symbol = reporterUnicodeSymbolMap['warning:alert'];
    }
  } else if (expectFailure !== undefined) {
    title += ` # EXPECTED FAILURE`;
  }

  const err = showErrorDetails && data.details?.error ? formatError(data.details.error, indent) : '';

  return `${prefix}${indent}${color}${symbol}${title}${colors.white}${err}`;
}

module.exports = {
  __proto__: null,
  reporterUnicodeSymbolMap,
  reporterColorMap,
  formatTestReport,
  indent,
};
