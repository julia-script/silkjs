'use strict';

const { Transform } = require('stream');
function text(value) { return String(value ?? '').replace(/[\r\n]/g, ' '); }
function directive(data) { return data.skip ? ` # SKIP${data.skip === true ? '' : ' ' + text(data.skip)}` : data.todo ? ` # TODO${data.todo === true ? '' : ' ' + text(data.todo)}` : ''; }
function detail(error) { return error?.cause?.stack || error?.stack || String(error); }
function xml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }
function coverageText(summary) {
  const rows = ['start of coverage report', 'file | line % | branch % | funcs %'];
  for (const file of summary.files) rows.push(`${require('path').relative(summary.workingDirectory, file.path)} | ${file.coveredLinePercent.toFixed(2)} | ${file.coveredBranchPercent.toFixed(2)} | ${file.coveredFunctionPercent.toFixed(2)}`);
  const totals = summary.totals;
  rows.push(`all files | ${totals.coveredLinePercent.toFixed(2)} | ${totals.coveredBranchPercent.toFixed(2)} | ${totals.coveredFunctionPercent.toFixed(2)}`, 'end of coverage report');
  return rows.map(row => `# ${row}\n`).join('');
}
async function* tap(source) {
  yield 'TAP version 13\n';
  for await (const { type, data } of source) {
    const indent = '    '.repeat(Math.max(0, data.nesting || 0));
    if (type === 'test:start') yield `${indent}# Subtest: ${text(data.name)}\n`;
    else if (type === 'test:pass' || type === 'test:fail') {
      yield `${indent}${type === 'test:pass' ? 'ok' : 'not ok'} ${data.testNumber} - ${text(data.name).replace(/#/g, '\\#')}${directive(data)}\n`;
      yield `${indent}  ---\n${indent}  duration_ms: ${data.details?.duration_ms ?? 0}\n`;
      if (data.details?.error) {
        const error = data.details.error;
        yield `${indent}  failureType: ${JSON.stringify(error.failureType || 'testCodeFailure')}\n${indent}  error: ${JSON.stringify(error.cause?.message ?? error.message ?? String(error))}\n${indent}  code: ${JSON.stringify(error.code)}\n${indent}  stack: |-\n`;
        for (const line of detail(error).split('\n')) yield `${indent}    ${line}\n`;
      }
      yield `${indent}  ...\n`;
    } else if (type === 'test:plan') yield `${indent}1..${data.count}\n`;
    else if (type === 'test:diagnostic') for (const line of String(data.message).split('\n')) yield `${indent}# ${line}\n`;
    else if (type === 'test:stdout' || type === 'test:stderr') for (const line of String(data.message).trimEnd().split('\n')) yield `# ${line}\n`;
    else if (type === 'test:coverage') yield coverageText(data.summary);
    else if (type === 'test:summary') {
      for (const key of ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) yield `# ${key === 'passed' ? 'pass' : key === 'failed' ? 'fail' : key} ${data.counts[key]}\n`;
      yield `# duration_ms ${data.duration_ms}\n`;
    }
  }
}
async function* dot(source) {
  let count = 0;
  for await (const { type, data } of source) if (type === 'test:pass' || type === 'test:fail') {
    yield type === 'test:fail' && !data.todo && !data.skip ? 'X' : '.';
    if (++count % 20 === 0) yield '\n';
  }
  if (count % 20) yield '\n';
}
class SpecReporter extends Transform {
  constructor(options = {}) { super({ ...options, writableObjectMode: true }); }
  _transform({ type, data }, _encoding, callback) {
    try {
      const indent = '  '.repeat(Math.max(0, data.nesting || 0));
      if (type === 'test:pass' || type === 'test:fail') {
        const failed = type === 'test:fail' && !data.todo && !data.skip;
        this.push(`${indent}${failed ? 'FAIL' : 'PASS'} ${data.name} (${data.details?.duration_ms ?? 0}ms)${directive(data)}\n`);
        if (failed) this.push(detail(data.details.error).split('\n').map(line => indent + '  ' + line).join('\n') + '\n');
      } else if (type === 'test:diagnostic') this.push(`${indent}# ${data.message}\n`);
      else if (type === 'test:stdout' || type === 'test:stderr') this.push(data.message);
      else if (type === 'test:coverage') this.push(coverageText(data.summary));
      else if (type === 'test:summary') {
        for (const key of ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) this.push(`# ${key} ${data.counts[key]}\n`);
        this.push(`# duration_ms ${data.duration_ms}\n`);
      }
      callback();
    } catch (error) { callback(error); }
  }
}
async function* junit(source) {
  const records = [];
  let summary;
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') records.push({ type, data });
    else if (type === 'test:summary') summary = data;
  }
  const failed = records.filter(({ type, data }) => type === 'test:fail' && !data.skip && !data.todo).length;
  const skipped = records.filter(({ data }) => data.skip || data.todo).length;
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${records.length}" failures="${failed}" skipped="${skipped}" time="${(summary?.duration_ms ?? 0) / 1000}">\n<testsuite name="tests" tests="${records.length}" failures="${failed}" skipped="${skipped}">\n`;
  for (const { type, data } of records) {
    yield `<testcase name="${xml(data.name)}" classname="${xml(data.file || '')}" time="${(data.details?.duration_ms ?? 0) / 1000}">`;
    if (data.skip || data.todo) yield `<skipped message="${xml(data.skip || data.todo)}"/>`;
    else if (type === 'test:fail') yield `<failure message="${xml(data.details.error?.message)}" type="${xml(data.details.error?.failureType)}">${xml(detail(data.details.error))}</failure>`;
    yield '</testcase>\n';
  }
  yield '</testsuite>\n</testsuites>\n';
}
class LcovReporter extends Transform {
  constructor(options = {}) { super({ ...options, writableObjectMode: true }); }
  _transform({ type, data }, _encoding, callback) {
    if (type !== 'test:coverage') { callback(); return; }
    // Only consume actual engine coverage; test outcomes contain no coverage information.
    try {
      const { relative } = require('path');
      this.push('TN:\n');
      for (const file of data.summary.files) {
        this.push(`SF:${relative(data.summary.workingDirectory, file.path)}\n`);
        for (let i = 0; i < file.functions.length; i++) {
          const fn = file.functions[i];
          this.push(`FN:${fn.line},${fn.name || `anonymous_${i}`}\n`);
        }
        for (let i = 0; i < file.functions.length; i++) {
          const fn = file.functions[i];
          this.push(`FNDA:${fn.count},${fn.name || `anonymous_${i}`}\n`);
        }
        this.push(`FNF:${file.totalFunctionCount}\nFNH:${file.coveredFunctionCount}\n`);
        const blocks = new Map();
        for (let i = 0; i < file.branches.length; i++) {
          const branch = file.branches[i];
          const key = branch.block ?? i;
          if (!blocks.has(key)) blocks.set(key, blocks.size);
          this.push(`BRDA:${branch.line},${blocks.get(key)},${branch.branch ?? 0},${branch.count}\n`);
        }
        this.push(`BRF:${file.totalBranchCount}\nBRH:${file.coveredBranchCount}\n`);
        for (const line of file.lines.slice().sort((a, b) => a.line - b.line)) this.push(`DA:${line.line},${line.count}\n`);
        this.push(`LH:${file.coveredLineCount}\nLF:${file.totalLineCount}\nend_of_record\n`);
      }
      callback();
    } catch (error) { callback(error); }
  }
}
function spec(options) { return new SpecReporter(options); }
function lcov(options) { return new LcovReporter(options); }
module.exports = { tap, dot, spec, junit, lcov };
