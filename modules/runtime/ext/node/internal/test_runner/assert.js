// Adapted from Node.js v24.22.1 lib/internal/test_runner/assert.js by tools/port_test_runner.py.
'use strict';
const {
  SafeMap,
} = require('internal/per_context/primordials');
const {
  validateFunction,
  validateString,
} = require('internal/validators');
const assert = require('assert');
const methodsToCopy = [
  'deepEqual',
  'deepStrictEqual',
  'doesNotMatch',
  'doesNotReject',
  'doesNotThrow',
  'equal',
  'fail',
  'ifError',
  'match',
  'notDeepEqual',
  'notDeepStrictEqual',
  'notEqual',
  'notStrictEqual',
  'partialDeepStrictEqual',
  'rejects',
  'strictEqual',
  'throws',
];
let assertMap;

function getAssertionMap() {
  if (assertMap === undefined) {
    assertMap = new SafeMap();

    for (let i = 0; i < methodsToCopy.length; i++) {
      assertMap.set(methodsToCopy[i], assert[methodsToCopy[i]]);
    }
  }

  return assertMap;
}

function register(name, fn) {
  validateString(name, 'name');
  validateFunction(fn, 'fn');
  const map = getAssertionMap();
  map.set(name, fn);
}

module.exports = { getAssertionMap, register };
