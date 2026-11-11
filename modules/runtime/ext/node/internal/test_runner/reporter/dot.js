// Adapted from Node.js v24.22.1 lib/internal/test_runner/reporter/dot.js.
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
  ArrayPrototypePush,
  MathMax,
} = require('internal/per_context/primordials');
const colors = require('internal/util/colors');
const { getCoverageReport } = require('internal/test_runner/coverage_report');
const {
  formatTestReport,
  reporterColorMap,
  reporterUnicodeSymbolMap,
} = require('internal/test_runner/reporter/utils');

module.exports = async function* dot(source) {
  let count = 0;
  let columns = getLineLength();
  const failedTests = [];
  const diagnostics = [];
  let coverage;
  for await (const { type, data } of source) {
    if (type === 'test:pass') {
      yield `${colors.green}.${colors.reset}`;
    }
    if (type === 'test:fail') {
      yield `${colors.red}X${colors.reset}`;
      ArrayPrototypePush(failedTests, data);
    }
    if ((type === 'test:fail' || type === 'test:pass') && ++count === columns) {
      yield '\n';

      // Getting again in case the terminal was resized.
      columns = getLineLength();
      count = 0;
    }
    if (type === 'test:diagnostic' && data.level === 'error') {
      ArrayPrototypePush(diagnostics, data);
    }
    if (type === 'test:coverage') {
      coverage = data;
    }
  }
  yield '\n';
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      const color = reporterColorMap[diagnostic.level] || reporterColorMap['test:diagnostic'];
      yield `${color}${reporterUnicodeSymbolMap['test:diagnostic']}${diagnostic.message}${colors.white}\n`;
    }
    if (coverage) {
      yield getCoverageReport('', coverage.summary,
                              reporterUnicodeSymbolMap['test:coverage'], colors.blue, true);
    }
  }
  if (failedTests.length > 0) {
    yield `\n${colors.red}Failed tests:${colors.white}\n\n`;
    for (const test of failedTests) {
      yield formatTestReport('test:fail', test);
    }
  }
};

function getLineLength() {
  return MathMax(process.stdout.columns ?? 20, 20);
}
