'use strict';

const types = require('util/types');
const host = require('internal/host');
const custom = Symbol.for('nodejs.util.inspect.custom');
const colors = { bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29], white: [37, 39], grey: [90, 39], black: [30, 39], blue: [34, 39], cyan: [36, 39], green: [32, 39], magenta: [35, 39], red: [31, 39], yellow: [33, 39] };
const styles = { special: 'cyan', number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'grey', null: 'bold', string: 'green', symbol: 'green', date: 'magenta', regexp: 'red', module: 'underline' };
const defaults = { showHidden: false, depth: 2, colors: false, customInspect: true, showProxy: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 80, compact: 3, sorted: false, getters: false, numericSeparator: false };
function quote(value) {
  const delimiter = !value.includes("'") ? "'" : !value.includes('"') ? '"' : !value.includes('`') && !value.includes('${') ? '`' : "'";
  return delimiter + value.replace(/[\\\x00-\x1f\x7f-\x9f'"`\u2028\u2029]/g, c => {
    if (c === delimiter || c === '\\') return '\\' + c;
    const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v' };
    if (escapes[c]) return escapes[c];
    const n = c.charCodeAt(0);
    return n < 32 || n >= 127 ? (n <= 255 ? '\\x' + n.toString(16).padStart(2, '0') : '\\u' + n.toString(16).padStart(4, '0')) : c;
  }) + delimiter;
}
function inspect(value, options, depth, color) {
  const opts = Object.assign({}, defaults, typeof options === 'boolean' ? { showHidden: options } : options);
  if (arguments.length > 2 && depth !== undefined) opts.depth = depth;
  if (arguments.length > 3 && color !== undefined) opts.colors = color;
  const active = new Set();
  const references = new Map();
  let referenceId = 0;
  const style = (text, kind) => {
    const pair = opts.colors && colors[styles[kind]];
    return pair ? '\x1b[' + pair[0] + 'm' + text + '\x1b[' + pair[1] + 'm' : text;
  };
  function primitive(v) {
    if (typeof v === 'string') {
      const max = opts.maxStringLength === null ? Infinity : Math.max(0, opts.maxStringLength);
      return style(quote(v.slice(0, max)), 'string') + (v.length > max ? '... ' + (v.length - max) + ' more character' + (v.length - max === 1 ? '' : 's') : '');
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
      let text = Object.is(v, -0) ? '-0' : String(v);
      if (opts.numericSeparator) text = text.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
      return style(text + (typeof v === 'bigint' ? 'n' : ''), typeof v);
    }
    return style(String(v), v === null ? 'null' : typeof v);
  }
  function join(prefix, open, entries, close, level) {
    if (!entries.length) return prefix + open + close;
    const single = prefix + open + ' ' + entries.join(', ') + ' ' + close;
    if (opts.compact !== false && !single.includes('\n') && single.replace(/\x1b\[[\d;]*m/g, '').length + level * 2 <= opts.breakLength) return single;
    const pad = '  '.repeat(level + 1);
    return prefix + open + '\n' + pad + entries.join(',\n' + pad) + '\n' + '  '.repeat(level) + close;
  }
  function format(v, remaining, level) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return primitive(v);
    if (active.has(v)) {
      if (!references.has(v)) references.set(v, ++referenceId);
      return style('[Circular *' + references.get(v) + ']', 'special');
    }
    if (types.isProxy(v) && typeof host.getProxyDetails === 'function') {
      const details = host.getProxyDetails(v);
      if (details === null) return style('<Revoked Proxy>', 'special');
      if (opts.showProxy) {
        active.add(v);
        try {
          const next = remaining === null ? null : remaining - 1;
          return join('Proxy ', '[', details.map(item => format(item, next, level + 1)), ']', level);
        } finally { active.delete(v); }
      }
      return format(details[0], remaining, level);
    }
    if (opts.customInspect && typeof v[custom] === 'function' && v[custom] !== inspect && !(v.constructor && v.constructor.prototype === v)) {
      const result = v[custom](remaining, Object.assign({}, opts, { stylize: style }), inspect);
      if (result !== v) return typeof result === 'string' ? result : format(result, remaining, level);
    }
    const array = Array.isArray(v);
    const map = types.isMap(v);
    const set = types.isSet(v);
    const typed = types.isTypedArray(v);
    const ctor = v.constructor && typeof v.constructor === 'function' ? v.constructor.name : '';
    if (remaining !== null && remaining < 0) {
      if (types.isRegExp(v)) return style(RegExp.prototype.toString.call(v), 'regexp');
      return style('[' + (array ? 'Array' : ctor || 'Object') + ']', 'special');
    }
    active.add(v);
    try {
      let prefix = '';
      let open = '{';
      let close = '}';
      const entries = [];
      const skip = new Set();
      const next = remaining === null ? null : remaining - 1;
      const max = opts.maxArrayLength === null ? Infinity : Math.max(0, opts.maxArrayLength);
      if (array || typed) {
        open = '['; close = ']';
        if (typed) prefix = ctor + '(' + v.length + ') ';
        let holes = 0;
        const count = Math.min(v.length, max);
        for (let i = 0; i < count; i++) {
          skip.add(String(i));
          if (!Object.prototype.hasOwnProperty.call(v, i)) { holes++; continue; }
          if (holes) { entries.push(style('<' + holes + ' empty item' + (holes === 1 ? '' : 's') + '>', 'undefined')); holes = 0; }
          entries.push(property(v, String(i), next, level, true));
        }
        if (holes) entries.push(style('<' + holes + ' empty item' + (holes === 1 ? '' : 's') + '>', 'undefined'));
        if (v.length > count) entries.push('... ' + (v.length - count) + ' more item' + (v.length - count === 1 ? '' : 's'));
        for (let i = 0, own = Object.keys(v); i < own.length; i++) { const k = own[i]; if (/^(0|[1-9]\d*)$/.test(k) && Number(k) < v.length) skip.add(k); }
        if (!opts.showHidden) skip.add('length');
      } else if (map || set) {
        prefix = (map ? 'Map' : 'Set') + '(' + v.size + ') ';
        let count = 0;
        const iterator = map ? Map.prototype.entries.call(v) : Set.prototype.values.call(v);
        for (const item of iterator) {
          if (count++ >= max) break;
          entries.push(map ? format(item[0], next, level + 1) + ' => ' + format(item[1], next, level + 1) : format(item, next, level + 1));
        }
        if (v.size > max) entries.push('... ' + (v.size - max) + ' more items');
      } else if (types.isDate(v)) {
        const time = Date.prototype.getTime.call(v);
        prefix = style(Number.isNaN(time) ? 'Invalid Date' : Date.prototype.toISOString.call(v), 'date');
      } else if (types.isRegExp(v)) {
        prefix = style(RegExp.prototype.toString.call(v), 'regexp');
      } else if (types.isNativeError(v) || v instanceof Error) {
        prefix = typeof v.stack === 'string' ? v.stack : '[' + Error.prototype.toString.call(v) + ']';
        skip.add('name'); skip.add('message'); skip.add('stack');
        for (let key$i = 0, key$a = ['cause', 'errors']; key$i < key$a.length; key$i++) { const key = key$a[key$i]; if (Object.prototype.hasOwnProperty.call(v, key)) entries.push(property(v, key, next, level, false)); }
        skip.add('cause'); skip.add('errors');
      } else if (typeof v === 'function') {
        prefix = style('[' + (types.isAsyncFunction(v) ? 'AsyncFunction' : types.isGeneratorFunction(v) ? 'GeneratorFunction' : 'Function') + (v.name ? ': ' + v.name : ' (anonymous)') + ']', 'special');
      } else if (types.isBoxedPrimitive(v)) {
        let inner;
        for (let proto$i = 0, proto$a = [Number.prototype, String.prototype, Boolean.prototype, BigInt.prototype, Symbol.prototype]; proto$i < proto$a.length; proto$i++) { const proto = proto$a[proto$i]; 
          try { inner = proto.valueOf.call(v); break; } catch {}
        }
        prefix = '[' + (typeof inner === 'bigint' ? 'BigInt' : typeof inner === 'symbol' ? 'Symbol' : ctor) + ': ' + primitive(inner) + ']';
        if (typeof inner === 'string') for (let i = 0; i < inner.length; i++) skip.add(String(i));
      } else if (types.isAnyArrayBuffer(v)) {
        prefix = ctor + ' ';
        let bytes;
        try { bytes = new Uint8Array(v); } catch { bytes = null; }
        entries.push('[Uint8Contents]: ' + (bytes ? '<' + Array.prototype.map.call(bytes.subarray(0, max), n => n.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? ' ... ' + (bytes.length - max) + ' more bytes' : '') + '>' : '<detached>'));
        entries.push('byteLength: ' + (bytes ? bytes.length : 0));
      } else if (types.isDataView(v)) {
        prefix = 'DataView ';
        entries.push('byteLength: ' + v.byteLength, 'byteOffset: ' + v.byteOffset, 'buffer: ' + format(v.buffer, next, level + 1));
      } else if (types.isWeakMap(v) || types.isWeakSet(v)) {
        prefix = ctor + ' '; entries.push(style('<items unknown>', 'special'));
      } else if (types.isPromise(v)) {
        const details = host.getPromiseDetails(v);
        prefix = 'Promise ';
        entries.push(details[0] === 0 ? style('<pending>', 'special') : (details[0] === 2 ? style('<rejected>', 'special') + ' ' : '') + format(details[1], next, level + 1));
      } else if (types.isModuleNamespaceObject(v)) {
        prefix = '[Module: null prototype] ';
        // Exports still in their temporal dead zone read as <uninitialized>, as in Node.
        const exported = Reflect.ownKeys(v).filter(k => typeof k === 'string' || opts.showHidden);
        for (let key$i = 0, key$a = exported; key$i < key$a.length; key$i++) { const key = key$a[key$i]; 
          let rendered;
          try { rendered = format(v[key], next, level + 1); }
          catch (error) { if (!(error instanceof ReferenceError)) throw error; rendered = style('<uninitialized>', 'special'); }
          const name = typeof key === 'symbol' ? '[' + style(String(key), 'symbol') + ']' : /^[A-Za-z_$][\w$]*$/.test(key) ? key : style(quote(key), 'string');
          entries.push(name + ': ' + rendered);
        }
        for (let key$i = 0, key$a = exported; key$i < key$a.length; key$i++) { const key = key$a[key$i]; skip.add(key); }
      } else if (Object.getPrototypeOf(v) === null) {
        prefix = '[Object: null prototype] ';
      } else if (ctor && ctor !== 'Object') {
        prefix = ctor + ' ';
      }
      let keys = types.isModuleNamespaceObject(v) ? [] : opts.showHidden ? Reflect.ownKeys(v) : Reflect.ownKeys(v).filter(k => Object.prototype.propertyIsEnumerable.call(v, k));
      keys = keys.filter(k => !skip.has(k));
      if (opts.sorted) keys.sort(typeof opts.sorted === 'function' ? opts.sorted : (a, b) => String(a).localeCompare(String(b)));
      for (let key$i = 0, key$a = keys; key$i < key$a.length; key$i++) { const key = key$a[key$i]; entries.push(property(v, key, next, level, false)); }
      if (opts.sorted && (map || set)) entries.sort(typeof opts.sorted === 'function' ? opts.sorted : undefined);
      let result;
      if (prefix && !prefix.endsWith(' ')) result = entries.length ? join(prefix + ' ', open, entries, close, level) : prefix;
      else result = join(prefix, open, entries, close, level);
      if (references.has(v)) result = style('<ref *' + references.get(v) + '>', 'special') + ' ' + result;
      return result;
    } finally { active.delete(v); }
  }
  function property(object, key, remaining, level, bare) {
    const d = Object.getOwnPropertyDescriptor(object, key);
    let rendered;
    if ('value' in d) rendered = format(d.value, remaining, level + 1);
    else if (d.get && (opts.getters === true || opts.getters === 'get' && !d.set || opts.getters === 'set' && d.set)) {
      try { rendered = '[Getter' + (d.set ? '/Setter' : '') + ': ' + format(d.get.call(object), remaining, level + 1) + ']'; }
      catch (error) { rendered = '[Getter: <Inspection threw (' + error.message + ')>]'; }
    } else rendered = style(d.get ? d.set ? '[Getter/Setter]' : '[Getter]' : '[Setter]', 'special');
    if (bare) return rendered;
    const name = typeof key === 'symbol' ? '[' + style(String(key), 'symbol') + ']' : !d.enumerable ? '[' + key + ']' : /^[A-Za-z_$][\w$]*$/.test(key) ? key : style(quote(key), 'string');
    return name + ': ' + rendered;
  }
  return format(value, opts.depth, 0);
}
inspect.custom = custom;
inspect.colors = colors;
inspect.styles = styles;
Object.defineProperty(inspect, 'defaultOptions', { enumerable: true, get: () => defaults, set(value) { if (!value || typeof value !== 'object') throw new TypeError('The options must be an object'); Object.assign(defaults, value); } });
module.exports = { inspect };
