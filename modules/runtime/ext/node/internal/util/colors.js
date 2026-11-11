// Adapted from Node.js v24.22.1 lib/internal/util/colors.js.
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

let internalTTy;
function lazyInternalTTY() {
  internalTTy ??= require('internal/tty/colors');
  return internalTTy;
}

module.exports = {
  blue: '',
  green: '',
  white: '',
  red: '',
  gray: '',
  clear: '',
  reset: '',
  hasColors: false,
  shouldColorize(stream) {
    if (process.env.FORCE_COLOR !== undefined) {
      return lazyInternalTTY().getColorDepth() > 2;
    }
    return stream?.isTTY && (
      typeof stream.getColorDepth === 'function' ?
        stream.getColorDepth() > 2 : true);
  },
  refresh() {
    if (module.exports.shouldColorize(process.stderr)) {
      module.exports.blue = '\u001b[34m';
      module.exports.green = '\u001b[32m';
      module.exports.white = '\u001b[39m';
      module.exports.yellow = '\u001b[33m';
      module.exports.red = '\u001b[31m';
      module.exports.gray = '\u001b[90m';
      module.exports.clear = '\u001bc';
      module.exports.reset = '\u001b[0m';
      module.exports.hasColors = true;
    } else {
      module.exports.blue = '';
      module.exports.green = '';
      module.exports.white = '';
      module.exports.yellow = '';
      module.exports.red = '';
      module.exports.gray = '';
      module.exports.clear = '';
      module.exports.reset = '';
      module.exports.hasColors = false;
    }
  },
};

module.exports.refresh();
