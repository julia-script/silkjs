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
const host = require('internal/host');
const { kEmptyObject, validateString } = require('internal/path_events/support');
const isWindows = host.platform === 'win32';
const isMacOS = host.platform === 'darwin';
const SafeMap = Map;
const lazyMinimatch = () => require('internal/path_events/minimatch');

function createMatcher(pattern, options = kEmptyObject) {
  const opts = {
    __proto__: null,
    nocase: isWindows || isMacOS,
    windowsPathsNoEscape: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    platform: host.platform,
    nocaseMagicOnly: true,
    ...options,
  };
  return new (lazyMinimatch().Minimatch)(pattern, opts);
}

const kGlobPatternCacheLimit = 250;
const patternFnCache = new SafeMap();

/**
 * Check if a path matches a glob pattern
 * @param {string} path the path to check
 * @param {string} pattern the glob pattern to match
 * @param {boolean} windows whether the path is on a Windows system, defaults to `isWindows`
 * @returns {boolean}
 */
function matchGlobPattern(path, pattern, windows = isWindows) {
  validateString(path, 'path');
  validateString(pattern, 'pattern');

  const cacheKey = `${windows ? 'win32' : 'posix'}:${pattern}`;
  let matcher;
  if (patternFnCache.has(cacheKey)) {
    matcher = patternFnCache.get(cacheKey);
  } else {
    matcher = createMatcher(pattern, {
      kEmptyObject,
      platform: windows ? 'win32' : 'posix',
    });
    patternFnCache.set(cacheKey, matcher);

    if (patternFnCache.size >= kGlobPatternCacheLimit) {
      patternFnCache.delete(patternFnCache.keys().next().value);
    }
  }

  return matcher.match(path);
}

module.exports = { createMatcher, matchGlobPattern };
