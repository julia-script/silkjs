// Adapted from Node.js v24.22.1 lib/internal/test_runner/utils.js.
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
  ArrayPrototypeFlatMap,
  ArrayPrototypeForEach,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePop,
  ArrayPrototypeReduce,
  MathFloor,
  MathMax,
  MathMin,
  NumberPrototypeToFixed,
  SafeMap,
  StringPrototypePadEnd,
  StringPrototypePadStart,
  StringPrototypeRepeat,
  StringPrototypeSlice,
  StringPrototypeSplit,
} = require('internal/per_context/primordials');
const { relative, sep } = require('path');
const { green, yellow, red, white } = require('internal/util/colors');

const coverageColors = {
  __proto__: null,
  high: green,
  medium: yellow,
  low: red,
};

const memo = new SafeMap();
function addTableLine(prefix, width) {
  const key = `${prefix}-${width}`;
  let value = memo.get(key);
  if (value === undefined) {
    value = `${prefix}${StringPrototypeRepeat('-', width)}\n`;
    memo.set(key, value);
  }

  return value;
}

const kHorizontalEllipsis = '\u2026';
function truncateStart(string, width) {
  return string.length > width ? `${kHorizontalEllipsis}${StringPrototypeSlice(string, string.length - width + 1)}` : string;
}

function truncateEnd(string, width) {
  return string.length > width ? `${StringPrototypeSlice(string, 0, width - 1)}${kHorizontalEllipsis}` : string;
}

function formatLinesToRanges(values) {
  return ArrayPrototypeMap(ArrayPrototypeReduce(values, (prev, current, index, array) => {
    if ((index > 0) && ((current - array[index - 1]) === 1)) {
      prev[prev.length - 1][1] = current;
    } else {
      prev.push([current]);
    }
    return prev;
  }, []), (range) => ArrayPrototypeJoin(range, '-'));
}

function getUncoveredLines(lines) {
  return ArrayPrototypeFlatMap(lines, (line) => (line.count === 0 ? line.line : []));
}

function formatUncoveredLines(lines, table) {
  if (table) return ArrayPrototypeJoin(formatLinesToRanges(lines), ' ');
  return ArrayPrototypeJoin(lines, ', ');
}

const kColumns = ['line %', 'branch %', 'funcs %'];
const kColumnsKeys = ['coveredLinePercent', 'coveredBranchPercent', 'coveredFunctionPercent'];
const kSeparator = ' | ';

function buildFileTree(summary) {
  const tree = { __proto__: null };
  let treeDepth = 1;
  let longestFile = 0;

  ArrayPrototypeForEach(summary.files, (file) => {
    let longestPart = 0;
    const parts = StringPrototypeSplit(relative(summary.workingDirectory, file.path), sep);
    let current = tree;

    ArrayPrototypeForEach(parts, (part, index) => {
      current[part] ||= { __proto__: null };
      current = current[part];
      // If this is the last part, add the file to the tree
      if (index === parts.length - 1) {
        current.file = file;
      }
      // Keep track of the longest part for padding
      longestPart = MathMax(longestPart, part.length);
    });

    treeDepth = MathMax(treeDepth, parts.length);
    longestFile = MathMax(longestPart, longestFile);
  });

  return { __proto__: null, tree, treeDepth, longestFile };
}

function getCoverageReport(pad, summary, symbol, color, table) {
  const prefix = `${pad}${symbol}`;
  let report = `${color}${prefix}start of coverage report\n`;

  let filePadLength;
  let columnPadLengths = [];
  let uncoveredLinesPadLength;
  let tableWidth;

  // Create a tree of file paths
  const { tree, treeDepth, longestFile } = buildFileTree(summary);
  if (table) {
    // Calculate expected column sizes based on the tree
    filePadLength = table && longestFile;
    filePadLength += (treeDepth - 1);
    if (color) {
      filePadLength += 2;
    }
    filePadLength = MathMax(filePadLength, 'all files'.length);
    if (filePadLength > (process.stdout.columns / 2)) {
      filePadLength = MathFloor(process.stdout.columns / 2);
    }
    const fileWidth = filePadLength + 2;

    columnPadLengths = ArrayPrototypeMap(kColumns, (column) => (table ? MathMax(column.length, 6) : 0));
    const columnsWidth = ArrayPrototypeReduce(columnPadLengths, (acc, columnPadLength) => acc + columnPadLength + 3, 0);

    uncoveredLinesPadLength = table && ArrayPrototypeReduce(summary.files, (acc, file) =>
      MathMax(acc, formatUncoveredLines(getUncoveredLines(file.lines), table).length), 0);
    uncoveredLinesPadLength = MathMax(uncoveredLinesPadLength, 'uncovered lines'.length);
    const uncoveredLinesWidth = uncoveredLinesPadLength + 2;

    tableWidth = fileWidth + columnsWidth + uncoveredLinesWidth;

    const availableWidth = (process.stdout.columns || Infinity) - prefix.length;
    const columnsExtras = tableWidth - availableWidth;
    if (table && columnsExtras > 0) {
      filePadLength = MathMin(availableWidth * 0.5, filePadLength);
      uncoveredLinesPadLength = MathMax(availableWidth - columnsWidth - (filePadLength + 2) - 2, 1);
      tableWidth = availableWidth;
    } else {
      uncoveredLinesPadLength = Infinity;
    }
  }

  function getCell(string, width, pad, truncate, coverage) {
    if (!table) return string;

    let result = string;
    if (pad) result = pad(result, width);
    if (truncate) result = truncate(result, width);
    if (color && coverage !== undefined) {
      if (coverage > 90) return `${coverageColors.high}${result}${color}`;
      if (coverage > 50) return `${coverageColors.medium}${result}${color}`;
      return `${coverageColors.low}${result}${color}`;
    }
    return result;
  }

  function writeReportLine({ file, depth = 0, coveragesColumns, fileCoverage, uncoveredLines }) {
    const fileColumn = `${prefix}${StringPrototypeRepeat(' ', depth)}${getCell(file, filePadLength - depth, StringPrototypePadEnd, truncateStart, fileCoverage)}`;
    const coverageColumns = ArrayPrototypeJoin(ArrayPrototypeMap(coveragesColumns, (coverage, j) => {
      const coverageText = typeof coverage === 'number' ? NumberPrototypeToFixed(coverage, 2) : coverage;
      return getCell(coverageText, columnPadLengths[j], StringPrototypePadStart, false, coverage);
    }), kSeparator);

    const uncoveredLinesColumn = getCell(uncoveredLines, uncoveredLinesPadLength, false, truncateEnd);

    return `${fileColumn}${kSeparator}${coverageColumns}${kSeparator}${uncoveredLinesColumn}\n`;
  }

  function printCoverageBodyTree(tree, depth = 0) {
    for (const key in tree) {
      if (tree[key].file?.path) {
        const file = tree[key].file;
        const fileName = ArrayPrototypePop(StringPrototypeSplit(file.path, sep));

        let fileCoverage = 0;
        const coverages = ArrayPrototypeMap(kColumnsKeys, (columnKey) => {
          const percent = file[columnKey];
          fileCoverage += percent;
          return percent;
        });
        fileCoverage /= kColumnsKeys.length;

        const uncoveredLines = formatUncoveredLines(getUncoveredLines(file.lines), table);

        report += writeReportLine({
          __proto__: null,
          file: fileName,
          depth: depth,
          coveragesColumns: coverages,
          fileCoverage: fileCoverage,
          uncoveredLines: uncoveredLines,
        });
      } else {
        report += writeReportLine({
          __proto__: null,
          file: key,
          depth: depth,
          coveragesColumns: ArrayPrototypeMap(columnPadLengths, () => ''),
          fileCoverage: undefined,
          uncoveredLines: '',
        });
        printCoverageBodyTree(tree[key], depth + 1);
      }
    }
  }

  // -------------------------- Coverage Report --------------------------
  if (table) report += addTableLine(prefix, tableWidth);

  // Print the header
  report += writeReportLine({
    __proto__: null,
    file: 'file',
    coveragesColumns: kColumns,
    fileCoverage: undefined,
    uncoveredLines: 'uncovered lines',
  });

  if (table) report += addTableLine(prefix, tableWidth);

  // Print the body
  printCoverageBodyTree(tree);

  if (table) report += addTableLine(prefix, tableWidth);

  // Print the footer
  const allFilesCoverages = ArrayPrototypeMap(kColumnsKeys, (columnKey) => summary.totals[columnKey]);
  report += writeReportLine({
    __proto__: null,
    file: 'all files',
    coveragesColumns: allFilesCoverages,
    fileCoverage: undefined,
    uncoveredLines: '',
  });

  if (table) report += addTableLine(prefix, tableWidth);

  report += `${prefix}end of coverage report\n`;
  if (color) {
    report += white;
  }
  return report;
}


module.exports = { getCoverageReport };
