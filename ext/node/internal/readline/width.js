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

// Node src/node_i18n.cc's column-width rules, implemented with Unicode data
// and ECMAScript properties instead of a V8/ICU binding. Like Node's default,
// ambiguous characters are narrow and emoji sequences are expanded.
const { inspect, stripVTControlCharacters } = require('util');
const fullWidthRanges = require('internal/readline/width_data');
const emojiPresentation = /\p{Emoji_Presentation}/u;
const zeroWidth = /[\p{Cc}\p{Cf}\p{Me}\p{Mn}\p{Emoji_Modifier}]/u;

function isFullWidthCodePoint(code) {
  let low = 0;
  let high = (fullWidthRanges.length >> 1) - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = fullWidthRanges[middle * 2];
    const end = fullWidthRanges[middle * 2 + 1];
    if (code < start) high = middle - 1;
    else if (code > end) low = middle + 1;
    else return true;
  }
  return false;
}
function getStringWidth(str, removeControlChars = true) {
  if (removeControlChars) str = stripVTControlCharacters(str);
  str = str.normalize('NFC');
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0);
    if (isFullWidthCodePoint(code) || emojiPresentation.test(char)) width += 2;
    else if (code === 0xad || !zeroWidth.test(char)) width++;
  }
  return width;
}
module.exports = { inspect, stripVTControlCharacters, getStringWidth };
