// console adapted from Node.js v24.22.1 lib/internal/console/constructor.js, global.js,
// lib/internal/cli_table.js and the console timers of lib/internal/util/debuglog.js,
// without primordials, plus a direct path that writes plain text for the untouched
// process streams straight to their descriptors.
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
const types = require('util/types');
const { validateArray, validateInteger, validateObject, validateOneOf } = require('internal/validators');
const { channel } = require('diagnostics_channel');
// The formatter loads with the first value that needs it: text alone does not.
let util;
// Calls take their arguments with Reflect.apply, not spread: user code may have
// replaced the array iterator.
const ReflectApply = Reflect.apply;
const arrayConcat = Array.prototype.concat;
const ArrayPrototypeConcat = (array, items) => ReflectApply(arrayConcat, array, [items]);
const formatWithOptions = (...args) => ReflectApply((util ||= require('util')).formatWithOptions, undefined, args);
const inspect = (...args) => ReflectApply((util ||= require('util')).inspect, undefined, args);
let width;
const getStringWidth = text => (width ||= require('internal/readline/width')).getStringWidth(text);
const inspectorConsole = require('internal/inspector_console');
// node.console trace events, as Node's console and internal/util/debuglog emit them.
const kTraceBegin = 98, kTraceEnd = 101, kTraceInstant = 110, kTraceCount = 67;
let traceEvents;
function traceConsole(phase, name, data) {
  traceEvents ||= require('internal/trace_events');
  traceEvents.trace(phase, 'node,node.console', name, 0, data);
}

const { codes: { ERR_CONSOLE_WRITABLE_STREAM, ERR_INCOMPATIBLE_OPTION_PAIR }, isStackOverflowError } = require('internal/errors');

const onLog = channel('console.log');
const onWarn = channel('console.warn');
const onError = channel('console.error');
const onInfo = channel('console.info');
const onDebug = channel('console.debug');

const kMaxGroupIndentation = 1000;
const kCounts = Symbol('counts');
const kGroupIndentationWidth = Symbol('kGroupIndentWidth');
const kGroupIndentationString = Symbol('kGroupIndentationString');
const kFormatForStderr = Symbol('kFormatForStderr');
const kFormatForStdout = Symbol('kFormatForStdout');
const kGetInspectOptions = Symbol('kGetInspectOptions');
const kColorMode = Symbol('kColorMode');
const kIsConsole = Symbol('kIsConsole');
const kWriteToConsole = Symbol('kWriteToConsole');
const kBindProperties = Symbol('kBindProperties');
const kBindStreamsEager = Symbol('kBindStreamsEager');
const kBindStreamsLazy = Symbol('kBindStreamsLazy');
const kUseStdout = Symbol('kUseStdout');
const kUseStderr = Symbol('kUseStderr');

// The process console while its streams are the untouched process streams
// (internal/stdio direct): _stdout and _stderr are then still unread.
let globalConsole;
const untouched = { [kUseStdout]: false, [kUseStderr]: false };
// What formatWithOptions makes of args when every one is a string and the first
// holds no format specifier: the strings joined by spaces. Undefined otherwise.
function plainText(args) {
  if (args.length === 1) return typeof args[0] === 'string' ? args[0] : undefined;
  if (args.length === 0 || typeof args[0] !== 'string' || args[0].includes('%')) return undefined;
  for (let i = 1; i < args.length; i++) if (typeof args[i] !== 'string') return undefined;
  return args.join(' ');
}
// Text for an untouched process stream goes straight to its descriptor.
function direct(console, streamSymbol, args) {
  if (console !== globalConsole || !untouched[streamSymbol]) return false;
  let text = plainText(args);
  if (text === undefined) return false;
  const indent = console[kGroupIndentationString];
  if (indent !== '') text = indent + text.replace(/\n/g, '\n' + indent);
  const written = require('internal/stdio').direct(streamSymbol === kUseStdout ? 1 : 2, text + '\n');
  if (typeof written === 'boolean') return written;
  // A pipe took part of the line: the rest follows it through the stream.
  console[kWriteToConsole](streamSymbol, written, true);
  return true;
}

const optionsMap = new WeakMap();
function Console(options /* or: stdout, stderr, ignoreErrors = true */) {
  // new.target is checked to construct without new and to keep a custom
  // instanceof for the global console.
  if (new.target === undefined) return Reflect.construct(Console, arguments);

  if (!options || typeof options.write === 'function') {
    options = { stdout: options, stderr: arguments[1], ignoreErrors: arguments[2] };
  }
  const { stdout, stderr = stdout, ignoreErrors = true, colorMode = 'auto', inspectOptions, groupIndentation } = options;
  if (!stdout || typeof stdout.write !== 'function') throw new ERR_CONSOLE_WRITABLE_STREAM('stdout');
  if (!stderr || typeof stderr.write !== 'function') throw new ERR_CONSOLE_WRITABLE_STREAM('stderr');
  validateOneOf(colorMode, 'colorMode', ['auto', true, false]);
  if (groupIndentation !== undefined) validateInteger(groupIndentation, 'groupIndentation', 0, kMaxGroupIndentation);
  if (inspectOptions !== undefined) {
    validateObject(inspectOptions, 'options.inspectOptions');
    const inspectOptionsMap = types.isMap(inspectOptions) ? inspectOptions : new Map([[stdout, inspectOptions], [stderr, inspectOptions]]);
    for (const value of inspectOptionsMap.values()) {
      if (value.colors !== undefined && options.colorMode !== undefined)
        throw new ERR_INCOMPATIBLE_OPTION_PAIR('options.inspectOptions.color', 'colorMode');
    }
    optionsMap.set(this, inspectOptionsMap);
  }
  // Methods are taken from the instance so that a subclass can override them.
  for (const key of Object.keys(Console.prototype)) {
    this[key] = bindMethod(this[key], this, key, key);
  }
  this[kBindStreamsEager](stdout, stderr);
  this[kBindProperties](ignoreErrors, colorMode, groupIndentation);
}

// Binds a method to its console. The inspector sees each outermost call as type.
function bindMethod(method, receiver, type, name) {
  const bound = { [name]: (...args) => inspectorConsole.call(type, args, receiver, method) }[name];
  Object.defineProperty(bound, 'name', { value: name });
  return bound;
}

const consolePropAttributes = { writable: true, enumerable: false, configurable: true };

// global.console instanceof global.console.Console
Object.defineProperty(Console, Symbol.hasInstance, {
  value: { [Symbol.hasInstance](instance) { return instance[kIsConsole]; } }[Symbol.hasInstance],
});

const kColorInspectOptions = { colors: true };
const kNoColorInspectOptions = {};

Object.defineProperties(Console.prototype, {
  [kBindStreamsEager]: {
    ...consolePropAttributes,
    value(stdout, stderr) {
      Object.defineProperties(this, {
        _stdout: { ...consolePropAttributes, value: stdout },
        _stderr: { ...consolePropAttributes, value: stderr },
      });
    },
  },
  [kBindStreamsLazy]: {
    ...consolePropAttributes,
    // The process streams are made on first use only.
    value(object) {
      let stdout;
      let stderr;
      untouched[kUseStdout] = untouched[kUseStderr] = true;
      Object.defineProperties(this, {
        _stdout: {
          enumerable: false, configurable: true,
          get() { untouched[kUseStdout] = false; return stdout ||= object.stdout; },
          set(value) { untouched[kUseStdout] = false; stdout = value; },
        },
        _stderr: {
          enumerable: false, configurable: true,
          get() { untouched[kUseStderr] = false; return stderr ||= object.stderr; },
          set(value) { untouched[kUseStderr] = false; stderr = value; },
        },
      });
    },
  },
  [kBindProperties]: {
    ...consolePropAttributes,
    value(ignoreErrors, colorMode, groupIndentation = 2) {
      Object.defineProperties(this, {
        _stdoutErrorHandler: { ...consolePropAttributes, value: createWriteErrorHandler(this, kUseStdout) },
        _stderrErrorHandler: { ...consolePropAttributes, value: createWriteErrorHandler(this, kUseStderr) },
        _ignoreErrors: { ...consolePropAttributes, value: Boolean(ignoreErrors) },
        _times: { ...consolePropAttributes, value: new Map() },
        // https://console.spec.whatwg.org/#count-map
        [kCounts]: { ...consolePropAttributes, value: new Map() },
        [kColorMode]: { ...consolePropAttributes, value: colorMode },
        [kIsConsole]: { ...consolePropAttributes, value: true },
        [kGroupIndentationWidth]: { ...consolePropAttributes, value: groupIndentation },
        [kGroupIndentationString]: { ...consolePropAttributes, value: '' },
        [Symbol.toStringTag]: { writable: false, enumerable: false, configurable: true, value: 'console' },
      });
    },
  },
  [kWriteToConsole]: {
    ...consolePropAttributes,
    value(streamSymbol, string, framed = false) {
      const ignoreErrors = this._ignoreErrors;
      const useStdout = streamSymbol === kUseStdout;
      const stream = useStdout ? this._stdout : this._stderr;
      const errorHandler = useStdout ? this._stdoutErrorHandler : this._stderrErrorHandler;
      if (!framed) {
        const groupIndent = this[kGroupIndentationString];
        if (groupIndent.length !== 0) {
          if (string.includes('\n')) string = string.replace(/\n/g, `\n${groupIndent}`);
          string = groupIndent + string;
        }
        string += '\n';
      }
      if (ignoreErrors === false) return stream.write(string);
      // An error can come synchronously (files, TTYs) or later (pipes).
      const listens = typeof stream.listenerCount === 'function';
      try {
        // A no-op error handler catches synchronous errors while it is attached.
        if (listens && stream.listenerCount('error') === 0) stream.once('error', noop);
        stream.write(string, errorHandler);
      } catch (e) {
        // Console is a debugging utility: it does not swallow a stack overflow.
        if (isStackOverflowError(e)) throw e;
      } finally {
        if (listens) stream.removeListener('error', noop);
      }
    },
  },
  [kGetInspectOptions]: {
    ...consolePropAttributes,
    value(stream) {
      let color = this[kColorMode];
      if (color === 'auto') color = shouldColorize(stream);
      const inspectOptionsMap = optionsMap.get(this);
      const options = inspectOptionsMap ? inspectOptionsMap.get(stream) : undefined;
      if (options) {
        if (options.colors === undefined) options.colors = color;
        return options;
      }
      return color ? kColorInspectOptions : kNoColorInspectOptions;
    },
  },
  [kFormatForStdout]: {
    ...consolePropAttributes,
    value(args) {
      if (args.length === 1 && typeof args[0] === 'string') return args[0];
      // Not spread: user code may have replaced the array iterator.
      return ReflectApply(formatWithOptions, undefined, ArrayPrototypeConcat([this[kGetInspectOptions](this._stdout)], args));
    },
  },
  [kFormatForStderr]: {
    ...consolePropAttributes,
    value(args) {
      if (args.length === 1 && typeof args[0] === 'string') return args[0];
      return ReflectApply(formatWithOptions, undefined, ArrayPrototypeConcat([this[kGetInspectOptions](this._stderr)], args));
    },
  },
});

// internal/util/colors shouldColorize
function shouldColorize(stream) {
  if (host.env.FORCE_COLOR !== undefined) return require('internal/tty/colors').getColorDepth() > 2;
  return stream?.isTTY && (typeof stream.getColorDepth === 'function' ? stream.getColorDepth() > 2 : true);
}

// The callback passed to stream.write().
function createWriteErrorHandler(instance, streamSymbol) {
  return (err) => {
    // True only for an error not already emitted (the write callback ran
    // asynchronously). A once listener keeps that error from becoming uncaught
    // without changing what other writes see.
    const stream = streamSymbol === kUseStdout ? instance._stdout : instance._stderr;
    if (err !== null && !stream._writableState?.errorEmitted) {
      if (stream.listenerCount('error') === 0) stream.once('error', noop);
    }
  };
}

function emitWarning(message) {
  if (globalThis.process && typeof process.emitWarning === 'function') process.emitWarning(message);
  else host.stderr.write('Warning: ' + message + '\n');
}

const { formatTime } = require('internal/util/debuglog');
function timeLogImpl(consoleRef, timesStore, implementation, label, args) {
  const start = timesStore.get(label);
  if (start === undefined) {
    emitWarning(`No such label '${label}' for ${implementation}`);
    return;
  }
  const formatted = formatTime(host.now() - start);
  if (args === undefined) consoleRef.log('%s: %s', label, formatted);
  else consoleRef.log('%s: %s', label, formatted, ...args);
}

// internal/cli_table
const tableChars = {
  middleMiddle: '─', rowMiddle: '┼', topRight: '┐', topLeft: '┌', leftMiddle: '├', topMiddle: '┬',
  bottomRight: '┘', bottomLeft: '└', bottomMiddle: '┴', rightMiddle: '┤', left: '│ ', right: ' │', middle: ' │ ',
};
function renderRow(row, columnWidths) {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    const needed = columnWidths[i] - getStringWidth(cell);
    out += cell + ' '.repeat(Math.ceil(needed));
    if (i !== row.length - 1) out += tableChars.middle;
  }
  return out + tableChars.right;
}
function cliTable(head, columns) {
  const rows = [];
  const columnWidths = head.map(h => getStringWidth(h));
  const longestColumn = Math.max(...columns.map(a => a.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longestColumn; j++) {
      if (rows[j] === undefined) rows[j] = [];
      const value = rows[j][i] = Object.prototype.hasOwnProperty.call(column, j) ? column[j] : '';
      columnWidths[i] = Math.max(columnWidths[i] || 0, getStringWidth(value));
    }
  }
  const divider = columnWidths.map(i => tableChars.middleMiddle.repeat(i + 2));
  let result = tableChars.topLeft + divider.join(tableChars.topMiddle) + tableChars.topRight + '\n' +
    renderRow(head, columnWidths) + '\n' +
    tableChars.leftMiddle + divider.join(tableChars.rowMiddle) + tableChars.rightMiddle + '\n';
  for (const row of rows) result += `${renderRow(row, columnWidths)}\n`;
  return result + tableChars.bottomLeft + divider.join(tableChars.bottomMiddle) + tableChars.bottomRight;
}

const keyKey = 'Key';
const valuesKey = 'Values';
const indexKey = '(index)';
const iterKey = '(iteration index)';
const isArray = v => Array.isArray(v) || types.isTypedArray(v) || require('buffer').Buffer.isBuffer(v);
function noop() {}

const consoleMethods = {
  log(...args) {
    if (onLog.hasSubscribers) onLog.publish(args);
    if (!direct(this, kUseStdout, args)) this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  info(...args) {
    if (onInfo.hasSubscribers) onInfo.publish(args);
    if (!direct(this, kUseStdout, args)) this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  debug(...args) {
    if (onDebug.hasSubscribers) onDebug.publish(args);
    if (!direct(this, kUseStdout, args)) this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  warn(...args) {
    if (onWarn.hasSubscribers) onWarn.publish(args);
    if (!direct(this, kUseStderr, args)) this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },
  error(...args) {
    if (onError.hasSubscribers) onError.publish(args);
    if (!direct(this, kUseStderr, args)) this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },
  dir(object, options) {
    this[kWriteToConsole](kUseStdout, inspect(object, { customInspect: false, ...this[kGetInspectOptions](this._stdout), ...options }));
  },
  time(label = 'default') {
    // Coerces everything other than Symbol to a string.
    label = `${label}`;
    if (this._times.has(label)) {
      emitWarning(`Label '${label}' already exists for console.time()`);
      return;
    }
    this._times.set(label, host.now());
    traceConsole(kTraceBegin, `time::${label}`);
  },
  timeEnd(label = 'default') {
    label = `${label}`;
    const found = this._times.has(label);
    timeLogImpl(this, this._times, 'console.timeEnd()', label);
    this._times.delete(label);
    if (found) traceConsole(kTraceEnd, `time::${label}`);
  },
  timeLog(label = 'default', ...data) {
    label = `${label}`;
    timeLogImpl(this, this._times, 'console.timeLog()', label, data);
    if (this._times.has(label)) traceConsole(kTraceInstant, `time::${label}`);
  },
  trace: function trace(...args) {
    const err = { name: 'Trace', message: this[kFormatForStderr](args) };
    Error.captureStackTrace(err, trace);
    this.error(err.stack);
  },
  // https://console.spec.whatwg.org/#assert
  assert(expression, ...args) {
    if (!expression) {
      if (args.length && typeof args[0] === 'string') args[0] = `Assertion failed: ${args[0]}`;
      else args.unshift('Assertion failed');
      // warn() formats the arguments.
      Reflect.apply(this.warn, this, args);
    }
  },
  // https://console.spec.whatwg.org/#clear
  clear() {
    // Clearing only makes sense when _stdout is a TTY.
    if (this._stdout.isTTY && host.env.TERM !== 'dumb') {
      const { cursorTo, clearScreenDown } = require('readline');
      cursorTo(this._stdout, 0, 0);
      clearScreenDown(this._stdout);
    }
  },
  // https://console.spec.whatwg.org/#count
  count(label = 'default') {
    // label must be a string or coerce to one: a Symbol throws.
    label = `${label}`;
    const counts = this[kCounts];
    let count = counts.get(label);
    if (count === undefined) count = 1;
    else count++;
    counts.set(label, count);
    traceConsole(kTraceCount, `count::${label}`, count);
    this.log(`${label}: ${count}`);
  },
  // https://console.spec.whatwg.org/#countreset
  countReset(label = 'default') {
    const counts = this[kCounts];
    if (!counts.has(label)) {
      emitWarning(`Count for '${label}' does not exist`);
      return;
    }
    counts.delete(`${label}`);
    traceConsole(kTraceCount, `count::${label}`, 0);
  },
  group(...data) {
    if (data.length > 0) Reflect.apply(this.log, this, data);
    this[kGroupIndentationString] += ' '.repeat(this[kGroupIndentationWidth]);
  },
  groupEnd() {
    const currentIndentation = this[kGroupIndentationString];
    this[kGroupIndentationString] = currentIndentation.slice(0, currentIndentation.length - this[kGroupIndentationWidth]);
  },
  // https://console.spec.whatwg.org/#table
  table(tabularData, properties) {
    if (properties !== undefined) validateArray(properties, 'properties');
    if (tabularData === null || typeof tabularData !== 'object') return this.log(tabularData);
    const final = (k, v) => this.log(cliTable(k, v));
    const _inspect = (v) => {
      const depth = v !== null && typeof v === 'object' && !isArray(v) && Object.keys(v).length > 2 ? -1 : 0;
      return inspect(v, { depth, maxArrayLength: 3, breakLength: Infinity, ...this[kGetInspectOptions](this._stdout) });
    };
    const getIndexArray = (length) => Array.from({ length }, (_, i) => _inspect(i));
    let i = 0;
    if (types.isMap(tabularData)) {
      const keys = [];
      const values = [];
      let length = 0;
      for (const { 0: k, 1: v } of tabularData) {
        keys.push(_inspect(k));
        values.push(_inspect(v));
        length++;
      }
      return final([iterKey, keyKey, valuesKey], [getIndexArray(length), keys, values]);
    }
    if (types.isSet(tabularData)) {
      const values = [];
      let length = 0;
      for (const v of tabularData) {
        values.push(_inspect(v));
        length++;
      }
      return final([iterKey, valuesKey], [getIndexArray(length), values]);
    }
    const map = { __proto__: null };
    let hasPrimitives = false;
    const valuesKeyArray = [];
    const indexKeyArray = Object.keys(tabularData);
    for (; i < indexKeyArray.length; i++) {
      const item = tabularData[indexKeyArray[i]];
      const primitive = item === null || (typeof item !== 'function' && typeof item !== 'object');
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        valuesKeyArray[i] = _inspect(item);
      } else {
        const keys = properties || Object.keys(item);
        for (const key of keys) {
          map[key] ??= [];
          if ((primitive && properties) || !Object.prototype.hasOwnProperty.call(item, key)) map[key][i] = '';
          else map[key][i] = _inspect(item[key]);
        }
      }
    }
    const keys = Object.keys(map);
    const values = Object.values(map);
    if (hasPrimitives) {
      keys.push(valuesKey);
      values.push(valuesKeyArray);
    }
    keys.unshift(indexKey);
    values.unshift(indexKeyArray);
    return final(keys, values);
  },
};

for (const method of Reflect.ownKeys(consoleMethods))
  Console.prototype[method] = consoleMethods[method];
Console.prototype.dirxml = Console.prototype.log;
Console.prototype.groupCollapsed = Console.prototype.group;

// https://console.spec.whatwg.org/#console-namespace: the namespace object has
// an empty object as its prototype. Console.prototype is not on its chain, so
// its symbol properties are copied and its methods bound to the namespace.
globalConsole = { __proto__: {} };
for (const prop of Reflect.ownKeys(Console.prototype)) {
  if (prop === 'constructor') continue;
  const desc = Reflect.getOwnPropertyDescriptor(Console.prototype, prop);
  if (typeof desc.value === 'function' && typeof prop === 'string') desc.value = bindMethod(desc.value, globalConsole, prop, desc.value.name);
  Reflect.defineProperty(globalConsole, prop, desc);
}
globalConsole[kBindProperties](true, 'auto');
globalConsole[kBindStreamsLazy](host);
// Node binds the global console to the process streams again in every pre-execution
// (initializeGlobalConsole), so a start from a startup snapshot writes to its own.
if (host.startupSnapshot.isBuildingSnapshotBuffer[0]) {
  require('internal/v8/startup_snapshot').namespace.addSerializeCallback(() => globalConsole[kBindStreamsLazy](host));
}
// Legacy: the Console constructor on the global console.
globalConsole.Console = Console;
module.exports = globalConsole;
