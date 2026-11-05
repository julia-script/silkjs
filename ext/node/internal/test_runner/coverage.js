'use strict';

const host = require('internal/host');
const path = require('path');
const { fileURLToPath } = require('url');
const fields = ['Line', 'Branch', 'Function'];
const percent = (covered, total) => total === 0 ? 100 : covered * 100 / total;
function metrics(file) {
  for (const [kind, entries] of [['Line', file.lines], ['Branch', file.branches], ['Function', file.functions]]) {
    file[`total${kind}Count`] = entries.length;
    file[`covered${kind}Count`] = entries.filter(entry => entry.count > 0).length;
    file[`covered${kind}Percent`] = percent(file[`covered${kind}Count`], entries.length);
  }
  return file;
}
function selected(filename, options, workingDirectory) {
  const relative = path.relative(workingDirectory, filename).split(path.sep).join('/');
  const match = pattern => path.matchesGlob(relative, pattern) || path.matchesGlob(filename, pattern);
  const include = options.coverageIncludeGlobs;
  if (include !== undefined && !(Array.isArray(include) ? include : [include]).some(match)) return false;
  const exclude = options.coverageExcludeGlobs;
  if (exclude !== undefined) return !(Array.isArray(exclude) ? exclude : [exclude]).some(match);
  return !relative.split('/').some(part => part === 'node_modules' || part === 'test' || part === 'tests') &&
    !/(?:^|\/)(?:test[-.]|[^/]*[._-]test\.)/.test(relative);
}
function summarize(files, options, workingDirectory) {
  const totals = {};
  for (const kind of fields) {
    totals[`total${kind}Count`] = 0;
    totals[`covered${kind}Count`] = 0;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    metrics(file);
    for (const kind of fields) {
      totals[`total${kind}Count`] += file[`total${kind}Count`];
      totals[`covered${kind}Count`] += file[`covered${kind}Count`];
    }
  }
  for (const kind of fields) totals[`covered${kind}Percent`] = percent(totals[`covered${kind}Count`], totals[`total${kind}Count`]);
  return { workingDirectory, files, totals, thresholds: { line: options.lineCoverage ?? 0, branch: options.branchCoverage ?? 0, function: options.functionCoverage ?? 0 } };
}
function take(options, workingDirectory) {
  const files = new Map();
  for (const [, url, name, count, locations] of host.testCoverageTake()) {
    if (!url || url.startsWith('node:') || url.startsWith('internal/') || url[0] === '<' || !locations.length) continue;
    const filename = url.startsWith('file:') ? fileURLToPath(url) : path.resolve(workingDirectory, url);
    if (!selected(filename, options, workingDirectory)) continue;
    let file = files.get(filename);
    if (!file) files.set(filename, file = { path: filename, functions: [], branches: [], lines: new Map() });
    // Compiler positions, not source scanning, distinguish anonymous functions and
    // repeated instantiations. Script identities are process-local, not merge keys.
    const start = locations.reduce((value, location) => Math.min(value, location[3]), Infinity);
    const first = locations.reduce((value, location) => Math.min(value, location[1]), Infinity);
    const end = locations.reduce((value, location) => Math.max(value, location[3]), 0);
    const key = `${name}:${start}:${end}`;
    file.functions.push({ name, line: first + 1, count, key });
    for (const [pc, line, column, sourcePosition, visits, taken, fallthrough, conditional] of locations) {
      const number = line + 1;
      // Several instructions implement one expression. The largest observed visit
      // count counts line executions without charging every VM instruction as a hit.
      file.lines.set(number, Math.max(file.lines.get(number) || 0, visits));
      if (conditional) {
        file.branches.push({ line: number, column, count: taken, key: `${key}:${pc}:0`, block: `${key}:${pc}`, branch: 0, sourcePosition });
        file.branches.push({ line: number, column, count: fallthrough, key: `${key}:${pc}:1`, block: `${key}:${pc}`, branch: 1, sourcePosition });
      }
    }
  }
  return merge([summarize([...files.values()].map(file => ({ ...file, lines: [...file.lines].map(([line, count]) => ({ line, count })) })), options, workingDirectory)], options, workingDirectory);
}
function merge(summaries, options, workingDirectory) {
  const files = new Map();
  for (const summary of summaries) for (const input of summary.files) {
    let file = files.get(input.path);
    if (!file) files.set(input.path, file = { path: input.path, lines: new Map(), functions: new Map(), branches: new Map() });
    for (const kind of ['lines', 'functions', 'branches']) for (const entry of input[kind]) {
      const key = kind === 'lines' ? entry.line : entry.key;
      const previous = file[kind].get(key);
      if (previous) previous.count += entry.count;
      else file[kind].set(key, { ...entry });
    }
  }
  return summarize([...files.values()].map(file => ({ path: file.path, lines: [...file.lines.values()].sort((a, b) => a.line - b.line), functions: [...file.functions.values()], branches: [...file.branches.values()] })), options, workingDirectory);
}
function publish(stream, summary) {
  let success = true;
  for (const kind of fields) {
    const threshold = summary.thresholds[kind.toLowerCase()];
    const actual = summary.totals[`covered${kind}Percent`];
    if (actual < threshold) {
      success = false;
      process.exitCode = 1;
      stream.publish('test:diagnostic', { nesting: 0, level: 'error', message: `${actual.toFixed(2)}% ${kind.toLowerCase()} coverage does not meet threshold of ${threshold}%.` });
    }
  }
  stream.publish('test:coverage', { nesting: 0, summary });
  return success;
}
module.exports = { take, merge, publish };
