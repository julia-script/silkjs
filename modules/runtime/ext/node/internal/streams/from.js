// Adapted from Node.js v24.11.0 for Silk QuickJS.
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
  PromisePrototypeThen,
  SymbolAsyncIterator,
  SymbolIterator,
} = require('internal/streams/primordials');
const { Buffer } = require('buffer');

const {
  ERR_INVALID_ARG_TYPE,
  ERR_STREAM_NULL_VALUES,
} = require('internal/streams/support').codes;

function from(Readable, iterable, opts) {
  let iterator;
  if (typeof iterable === 'string' || iterable instanceof Buffer) {
    return new Readable({
      objectMode: true,
      ...opts,
      read() {
        this.push(iterable);
        this.push(null);
      },
    });
  }

  let isAsync;
  if (iterable?.[SymbolAsyncIterator]) {
    isAsync = true;
    iterator = iterable[SymbolAsyncIterator]();
  } else if (iterable?.[SymbolIterator]) {
    isAsync = false;
    iterator = iterable[SymbolIterator]();
  } else {
    throw new ERR_INVALID_ARG_TYPE('iterable', ['Iterable'], iterable);
  }


  const readable = new Readable({
    objectMode: true,
    highWaterMark: 1,
    // TODO(ronag): What options should be allowed?
    ...opts,
  });

  // Flag to protect against _read
  // being called before last iteration completion.
  let reading = false;
  let isAsyncValues = false;

  readable._read = function() {
    if (!reading) {
      reading = true;

      if (isAsync) {
        nextAsync();
      } else if (isAsyncValues) {
        nextSyncWithAsyncValues();
      } else {
        nextSyncWithSyncValues();
      }
    }
  };

  readable._destroy = function(error, cb) {
    PromisePrototypeThen(
      close(error),
      () => process.nextTick(cb, error), // nextTick is here in case cb throws
      (e) => process.nextTick(cb, e || error),
    );
  };

  async function close(error) {
    const hadError = (error !== undefined) && (error !== null);
    const hasThrow = typeof iterator.throw === 'function';
    if (hadError && hasThrow) {
      const { value, done } = await iterator.throw(error);
      await value;
      if (done) {
        return;
      }
    }
    if (typeof iterator.return === 'function') {
      const { value } = await iterator.return();
      await value;
    }
  }

  // There are a lot of duplication here, it's done on purpose for performance
  // reasons - avoid await when not needed.

  function nextSyncWithSyncValues() {
    for (;;) {
      try {
        const { value, done } = iterator.next();

        if (done) {
          readable.push(null);
          return;
        }

        if (value &&
          typeof value.then === 'function') {
          return changeToAsyncValues(value);
        }

        if (value === null) {
          reading = false;
          throw new ERR_STREAM_NULL_VALUES();
        }

        if (readable.push(value)) {
          continue;
        }

        reading = false;
      } catch (err) {
        readable.destroy(err);
      }
      break;
    }
  }

  async function changeToAsyncValues(value) {
    isAsyncValues = true;

    try {
      const res = await value;

      if (res === null) {
        reading = false;
        throw new ERR_STREAM_NULL_VALUES();
      }

      if (readable.push(res)) {
        nextSyncWithAsyncValues();
        return;
      }

      reading = false;
    } catch (err) {
      readable.destroy(err);
    }
  }

  async function nextSyncWithAsyncValues() {
    for (;;) {
      try {
        const { value, done } = iterator.next();

        if (done) {
          readable.push(null);
          return;
        }

        const res = (value &&
          typeof value.then === 'function') ?
          await value :
          value;

        if (res === null) {
          reading = false;
          throw new ERR_STREAM_NULL_VALUES();
        }

        if (readable.push(res)) {
          continue;
        }

        reading = false;
      } catch (err) {
        readable.destroy(err);
      }
      break;
    }
  }

  async function nextAsync() {
    for (;;) {
      try {
        const { value, done } = await iterator.next();

        if (done) {
          readable.push(null);
          return;
        }

        if (value === null) {
          reading = false;
          throw new ERR_STREAM_NULL_VALUES();
        }

        if (readable.push(value)) {
          continue;
        }

        reading = false;
      } catch (err) {
        readable.destroy(err);
      }
      break;
    }
  }
  return readable;
}

module.exports = from;
