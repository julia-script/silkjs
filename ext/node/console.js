'use strict';

const host = require('internal/host');
const { formatWithOptions, inspect, stripVTControlCharacters } = require('util');
const types = require('util/types');
const inspectorConsole = require('internal/inspector_console');
function invalid(name, expected) { const error = new TypeError('The "' + name + '" argument must be ' + expected); error.code = 'ERR_INVALID_ARG_TYPE'; return error; }
function warning(message) {
  if (globalThis.process && typeof process.emitWarning === 'function') process.emitWarning(message);
  else host.stderr.write('Warning: ' + message + '\n');
}
function duration(value) {
  if (value < 1000) return value.toFixed(3).replace(/\.?0+$/, '') + 'ms';
  if (value < 60000) return (value / 1000).toFixed(3) + 's';
  const seconds = Math.floor(value / 1000) % 60;
  const minutes = Math.floor(value / 60000) % 60;
  const fraction = Math.floor(value % 1000).toString().padStart(3, '0');
  return (value >= 3600000 ? Math.floor(value / 3600000) + ':' + String(minutes).padStart(2, '0') : String(minutes)) + ':' + String(seconds).padStart(2, '0') + '.' + fraction + (value >= 3600000 ? ' (h:mm:ss.mmm)' : ' (m:ss.mmm)');
}
class Console {
  constructor(stdout, stderr, ignoreErrors = true) {
    let options;
    if (stdout && typeof stdout.write === 'function') options = { stdout, stderr, ignoreErrors };
    else options = stdout || {};
    stdout = options.stdout;
    stderr = options.stderr || stdout;
    if (!stdout || typeof stdout.write !== 'function') throw invalid('stdout', 'an object with a write function');
    if (!stderr || typeof stderr.write !== 'function') throw invalid('stderr', 'an object with a write function');
    const mode = options.colorMode === undefined ? 'auto' : options.colorMode;
    if (mode !== 'auto' && typeof mode !== 'boolean') { const error = new TypeError('The argument \'colorMode\' is invalid'); error.code = 'ERR_INVALID_ARG_VALUE'; throw error; }
    if (options.inspectOptions !== undefined && (!options.inspectOptions || typeof options.inspectOptions !== 'object')) throw invalid('options.inspectOptions', 'an object');
    if (options.colorMode !== undefined && options.inspectOptions && options.inspectOptions.colors !== undefined) { const error = new TypeError('Option "inspectOptions.colors" cannot be used in combination with option "colorMode"'); error.code = 'ERR_INCOMPATIBLE_OPTION_PAIR'; throw error; }
    const indentation = options.groupIndentation === undefined ? 2 : options.groupIndentation;
    if (typeof indentation !== 'number') throw invalid('groupIndentation', 'of type number');
    if (!Number.isInteger(indentation) || indentation < 0 || indentation > 1000) { const error = new RangeError('The value of "groupIndentation" is out of range. It must be >= 0 && <= 1000'); error.code = 'ERR_OUT_OF_RANGE'; throw error; }
    Object.defineProperties(this, {
      _stdout: { value: stdout, writable: true, configurable: true }, _stderr: { value: stderr, writable: true, configurable: true },
      _ignoreErrors: { value: options.ignoreErrors === undefined ? true : !!options.ignoreErrors, writable: true },
      _colorMode: { value: mode }, _inspectOptions: { value: options.inspectOptions || {} },
      _counts: { value: new Map() }, _times: { value: new Map() }, _groupIndent: { value: '', writable: true }, _groupIndentation: { value: indentation },
    });
    for (const key of Object.getOwnPropertyNames(Console.prototype)) if (key !== 'constructor' && !key.startsWith('_')) {
      const method = this[key];
      this[key] = (...args) => inspectorConsole.call(key, args, this, method);
    }
  }
  _options(stream) {
    const supplied = this._inspectOptions instanceof Map ? this._inspectOptions.get(stream) || {} : this._inspectOptions;
    return Object.assign({ colors: this._colorMode === 'auto' ? !!stream.isTTY && (typeof stream.getColorDepth !== 'function' || stream.getColorDepth() > 1) : this._colorMode }, supplied);
  }
  _write(stream, text) {
    text = this._groupIndent + text.replace(/\n/g, '\n' + this._groupIndent) + '\n';
    if (!this._ignoreErrors) { stream.write(text); return; }
    let onError;
    if (typeof stream.once === 'function' && typeof stream.removeListener === 'function') {
      onError = () => {};
      stream.once('error', onError);
    }
    try {
      stream.write(text, error => {
        if (error && typeof stream.once === 'function' && (!stream.listenerCount || stream.listenerCount('error') === 0)) stream.once('error', () => {});
      });
    } catch (error) {
      if (error instanceof RangeError && /call stack|recursion/i.test(error.message)) throw error;
    } finally {
      if (onError) stream.removeListener('error', onError);
    }
  }
  log(...args) { this._write(this._stdout, formatWithOptions(this._options(this._stdout), ...args)); }
  info(...args) { this.log(...args); }
  debug(...args) { this.log(...args); }
  warn(...args) { this._write(this._stderr, formatWithOptions(this._options(this._stderr), ...args)); }
  error(...args) { this.warn(...args); }
  dir(object, options) { this._write(this._stdout, inspect(object, Object.assign({}, this._options(this._stdout), { customInspect: false }, options))); }
  dirxml(...args) { this.log(...args); }
  assert(value, ...args) { if (!value) this.warn(args.length ? 'Assertion failed: ' + formatWithOptions(this._options(this._stderr), ...args) : 'Assertion failed'); }
  trace(...args) {
    const error = new Error(formatWithOptions(this._options(this._stderr), ...args));
    error.name = 'Trace';
    if (Error.captureStackTrace) Error.captureStackTrace(error, this.trace);
    this._write(this._stderr, error.stack || String(error));
  }
  clear() { if (this._stdout.isTTY && host.env.TERM !== 'dumb') this._stdout.write('\x1b[1;1H\x1b[0J'); }
  count(label = 'default') { label = String(label); const count = (this._counts.get(label) || 0) + 1; this._counts.set(label, count); this.log(label + ': ' + count); }
  countReset(label = 'default') { label = String(label); if (!this._counts.delete(label)) warning('Count for \'' + label + '\' does not exist'); }
  time(label = 'default') { label = String(label); if (this._times.has(label)) warning('Label \'' + label + '\' already exists for console.time()'); else this._times.set(label, host.now()); }
  timeLog(label = 'default', ...args) {
    label = String(label);
    if (!this._times.has(label)) { warning('No such label \'' + label + '\' for console.timeLog()'); return; }
    this.log(label + ': ' + duration(host.now() - this._times.get(label)), ...args);
  }
  timeEnd(label = 'default') {
    label = String(label);
    if (!this._times.has(label)) { warning('No such label \'' + label + '\' for console.timeEnd()'); return; }
    this.log(label + ': ' + duration(host.now() - this._times.get(label)));
    this._times.delete(label);
  }
  group(...args) { if (args.length) this.log(...args); this._groupIndent += ' '.repeat(this._groupIndentation); }
  groupCollapsed(...args) { this.group(...args); }
  groupEnd() { this._groupIndent = this._groupIndent.slice(0, Math.max(0, this._groupIndent.length - this._groupIndentation)); }
  table(data, properties) {
    if (properties !== undefined && !Array.isArray(properties)) throw invalid('properties', 'an instance of Array');
    if (data === null || typeof data !== 'object') { this.log(data); return; }
    const map = types.isMap(data), set = types.isSet(data);
    const rows = [];
    const columns = [];
    let valueColumn = false;
    const add = key => { if (!columns.includes(key)) columns.push(key); };
    if (properties) for (const key of properties) add(String(key));
    if (map) {
      columns.push('Key', 'Values');
      let index = 0;
      for (const [key, value] of data) rows.push([String(index++), { Key: key, Values: value }]);
    } else if (set) {
      columns.push('Values');
      let index = 0;
      for (const value of data) rows.push([String(index++), { Values: value }]);
    } else {
      for (const key of Object.keys(data)) {
        const value = data[key];
        if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
          if (!properties) for (const name of Object.keys(value)) add(name);
          rows.push([key, value]);
        } else { valueColumn = true; rows.push([key, { Values: value }]); }
      }
      if (valueColumn) add('Values');
    }
    const options = Object.assign({}, this._options(this._stdout), { depth: 0, maxArrayLength: 3, breakLength: Infinity });
    const grid = [[map || set ? '(iteration index)' : '(index)', ...columns]];
    for (const [key, value] of rows) grid.push([key, ...columns.map(column => Object.prototype.hasOwnProperty.call(value, column) ? inspect(value[column], options) : '')]);
    const width = text => {
      let count = 0;
      for (const char of stripVTControlCharacters(text)) {
        const code = char.codePointAt(0);
        if (/\p{Mark}/u.test(char) || code === 0x200d || code >= 0xfe00 && code <= 0xfe0f) continue;
        count += code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300) ? 2 : 1;
      }
      return count;
    };
    const widths = grid[0].map((_, index) => Math.max(...grid.map(row => width(row[index]))));
    const border = (left, join, right) => left + widths.map(n => '─'.repeat(n + 2)).join(join) + right;
    const line = row => '│ ' + row.map((text, i) => { const pad = widths[i] - width(text); return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2)); }).join(' │ ') + ' │';
    const output = [border('┌', '┬', '┐'), line(grid[0]), border('├', '┼', '┤'), ...grid.slice(1).map(line), border('└', '┴', '┘')];
    this._write(this._stdout, output.join('\n'));
  }
}
const instance = new Console({ stdout: host.stdout, stderr: host.stderr });
instance.Console = Console;
module.exports = instance;
