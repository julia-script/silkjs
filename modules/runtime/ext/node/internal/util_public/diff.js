// Adapted from Node.js public utility implementation.
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
  ArrayIsArray,
  ArrayPrototypeReverse,
} = require('internal/util_public/primordials');

const { validateStringArray, validateString } = require('internal/util_public/support');
const { myersDiff } = require('internal/util_public/myers_diff');

function validateInput(value, name) {
  if (!ArrayIsArray(value)) {
    validateString(value, name);
    return;
  }

  validateStringArray(value, name);
}

/**
 * Generate a difference report between two values
 * @param {Array | string} actual - The first value to compare
 * @param {Array | string} expected - The second value to compare
 * @returns {Array} - An array of differences between the two values.
 *   The returned data is an array of arrays, where each sub-array has two elements:
 *   1. The operation to perform: -1 for delete, 0 for no-op, 1 for insert
 *   2. The value to perform the operation on
 */
function diff(actual, expected) {
  if (actual === expected) {
    return [];
  }

  validateInput(actual, 'actual');
  validateInput(expected, 'expected');

  return ArrayPrototypeReverse(myersDiff(actual, expected));
}

module.exports = {
  diff,
};
