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

// Readline's in-memory history, adapted from Node lib/internal/repl/history.js.
// Persistent REPL history is outside readline's public API.
const { validateNumber, codes: { ERR_INVALID_ARG_TYPE } } = require('internal/readline/support');
const { reverseString } = require('internal/readline/utils');
const uncurryThis = Function.prototype.call.bind(Function.prototype.bind, Function.prototype.call);
const ArrayPrototypeIndexOf = uncurryThis(Array.prototype.indexOf);
const ArrayPrototypePop = uncurryThis(Array.prototype.pop);
const ArrayPrototypeShift = uncurryThis(Array.prototype.shift);
const ArrayPrototypeSplice = uncurryThis(Array.prototype.splice);
const ArrayPrototypeUnshift = uncurryThis(Array.prototype.unshift);
const StringPrototypeStartsWith = uncurryThis(String.prototype.startsWith);
const StringPrototypeTrim = uncurryThis(String.prototype.trim);
const kContext = Symbol('kContext');
const kRemoveHistoryDuplicates = Symbol('kRemoveHistoryDuplicates');
const kSize = Symbol('kSize');
const kHistory = Symbol('kHistory');
const kIndex = Symbol('kIndex');
const kIsFlushing = Symbol('kIsFlushing');
const kNormalizeLineEndings = Symbol('kNormalizeLineEndings');

class ReplHistory {
  constructor(context, options = {}) {
    if (options.history !== undefined && !Array.isArray(options.history)) {
      throw new ERR_INVALID_ARG_TYPE('history', 'Array', options.history);
    }
    if (options.size !== undefined) validateNumber(options.size, 'size', 0);
    this[kContext] = context;
    this[kRemoveHistoryDuplicates] = options.removeHistoryDuplicates || false;
    this[kSize] = options.size ?? context.historySize ?? 30;
    this[kHistory] = options.history ?? [];
    this[kIndex] = -1;
    this[kIsFlushing] = false;
  }
  addHistory(isMultiline, lastCommandErrored) {
    const line = this[kContext].line;

    if (line.length === 0) return '';

    // If the history is disabled then return the line
    if (this[kSize] === 0) return line;

    // If the trimmed line is empty then return the line
    if (StringPrototypeTrim(line).length === 0) return line;

    // This is necessary because each line would be saved in the history while creating
    // a new multiline, and we don't want that.
    if (isMultiline && this[kIndex] === -1) {
      ArrayPrototypeShift(this[kHistory]);
    } else if (lastCommandErrored) {
      // If the last command errored and we are trying to edit the history to fix it
      // remove the broken one from the history
      ArrayPrototypeShift(this[kHistory]);
    }

    const normalizedLine = ReplHistory[kNormalizeLineEndings](line, '\n', '\r');

    if (this[kHistory].length === 0 || this[kHistory][0] !== normalizedLine) {
      if (this[kRemoveHistoryDuplicates]) {
        // Remove older history line if identical to new one
        const dupIndex = ArrayPrototypeIndexOf(this[kHistory], normalizedLine);
        if (dupIndex !== -1) ArrayPrototypeSplice(this[kHistory], dupIndex, 1);
      }

      // Add the new line to the history
      ArrayPrototypeUnshift(this[kHistory], normalizedLine);

      // Only store so many
      if (this[kHistory].length > this[kSize])
        ArrayPrototypePop(this[kHistory]);
    }

    this[kIndex] = -1;

    const finalLine = isMultiline ? reverseString(this[kHistory][0]) : this[kHistory][0];

    // The listener could change the history object, possibly
    // to remove the last added entry if it is sensitive and should
    // not be persisted in the history, like a password
    // Emit history event to notify listeners of update
    this[kContext].emit('history', this[kHistory]);

    return finalLine;
  }

  canNavigateToNext() {
    return this[kIndex] > -1 && this[kHistory].length > 0;
  }

  navigateToNext(substringSearch) {
    if (!this.canNavigateToNext()) {
      return null;
    }
    const search = substringSearch || '';
    let index = this[kIndex] - 1;

    while (
      index >= 0 &&
      (!StringPrototypeStartsWith(this[kHistory][index], search) ||
        this[kContext].line === this[kHistory][index])
    ) {
      index--;
    }

    this[kIndex] = index;

    if (index === -1) {
      return search;
    }

    return ReplHistory[kNormalizeLineEndings](this[kHistory][index], '\r', '\n');
  }

  canNavigateToPrevious() {
    return this[kHistory].length !== this[kIndex] && this[kHistory].length > 0;
  }

  navigateToPrevious(substringSearch = '') {
    if (!this.canNavigateToPrevious()) {
      return null;
    }
    const search = substringSearch || '';
    let index = this[kIndex] + 1;

    while (
      index < this[kHistory].length &&
      (!StringPrototypeStartsWith(this[kHistory][index], search) ||
        this[kContext].line === this[kHistory][index])
    ) {
      index++;
    }

    this[kIndex] = index;

    if (index === this[kHistory].length) {
      return search;
    }

    return ReplHistory[kNormalizeLineEndings](this[kHistory][index], '\r', '\n');
  }

  get size() { return this[kSize]; }
  get isFlushing() { return this[kIsFlushing]; }
  get history() { return this[kHistory]; }
  set history(value) { this[kHistory] = value; }
  get index() { return this[kIndex]; }
  set index(value) { this[kIndex] = value; }
  static [kNormalizeLineEndings](line, from, to) {
    return reverseString(line, from, to);
  }
}
module.exports = { ReplHistory };
