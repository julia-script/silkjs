'use strict';

const host = require('internal/host');
const native = host.inspectorNative;
const quote = JSON.stringify;
const own = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function protocolError(code, message) { return Object.assign(new Error(message), { protocolCode: code }); }
function unsupported(method) { throw protocolError(-32601, `'${method}' wasn't found`); }
function inspect(value, limit) { return limit === undefined ? native(9, value) : native(9, value, limit); }
// V8 RemoteObject className/description/subtype (src/inspector/value-mirror.cc),
// computed only through brand checks, own data descriptors and built-in getters
// so describing a value never runs user code.
const uncurry = Function.prototype.bind.bind(Function.prototype.call);
const functionSource = uncurry(Function.prototype.toString);
const dateText = uncurry(Date.prototype.toString);
const getter = (target, name) => uncurry(Object.getOwnPropertyDescriptor(target, name).get);
const regexpSource = getter(RegExp.prototype, 'source'), regexpFlags = getter(RegExp.prototype, 'flags');
const mapSize = getter(Map.prototype, 'size'), setSize = getter(Set.prototype, 'size');
const typedLength = getter(Object.getPrototypeOf(Uint8Array.prototype), 'length');
const bufferLength = getter(ArrayBuffer.prototype, 'byteLength');
const sharedLength = typeof SharedArrayBuffer === 'function' ? getter(SharedArrayBuffer.prototype, 'byteLength') : null;
const viewLength = getter(DataView.prototype, 'byteLength');
const mapEntries = uncurry(Map.prototype.entries), setValues = uncurry(Set.prototype.values);
const mapNext = uncurry(Object.getPrototypeOf(new Map().entries()).next), setNext = uncurry(Object.getPrototypeOf(new Set().values()).next);
// The first limit entries through the built-in iterators (never Symbol.iterator).
function collectionEntries(value, map, limit) {
  const iterator = map ? mapEntries(value) : setValues(value), next = map ? mapNext : setNext, items = [];
  for (let step = next(iterator); !step.done && items.length < limit; step = next(iterator)) items.push(step.value);
  return items;
}
let types;
function brands() { return types ||= require('util').types; }
function ownData(target, name) {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, name);
  return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
}
function className(value, info = inspect(value, 0)) {
  if (info.subtype === 'proxy') {
    const details = host.getProxyDetails(value);
    return details === null || details[0] === null || (typeof details[0] !== 'object' && typeof details[0] !== 'function') ? 'Object' : className(details[0]);
  }
  let prototype = info.prototype, seen = 0;
  while (prototype !== null && prototype !== undefined && seen++ < 64) {
    const next = inspect(prototype, 0);
    if (next.subtype === 'proxy') break;
    const constructor = ownData(prototype, 'constructor');
    if (typeof constructor === 'function') {
      const name = ownData(constructor, 'name');
      if (typeof name === 'string' && name) return name;
    }
    prototype = next.prototype;
  }
  return typeof value === 'function' ? 'Function' : 'Object';
}
function subtypeOf(value, info) {
  if (info.subtype) return info.subtype;
  if (typeof value !== 'object' || value === null) return undefined;
  const is = brands();
  if (is.isWeakMap(value)) return 'weakmap';
  if (is.isWeakSet(value)) return 'weakset';
  if (is.isDataView(value)) return 'dataview';
  if (is.isSharedArrayBuffer(value)) return 'arraybuffer';
  if (is.isGeneratorObject(value)) return 'generator';
  if (is.isMapIterator(value) || is.isSetIterator(value)) return 'iterator';
  if (typeof WeakRef === 'function' && is.isWeakRef?.(value)) return 'weakref';
  return undefined;
}
function errorDescription(value, name) {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'stack');
  let stack = descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  if (descriptor && typeof descriptor.get === 'function' && /\[native code\]\s*\}$/.test(functionSource(descriptor.get))) {
    try { stack = Reflect.apply(descriptor.get, value, []); } catch { stack = undefined; }
  }
  if (typeof stack === 'string' && stack) return stack;
  const message = ownData(value, 'message');
  return typeof message === 'string' && message ? `${name}: ${message}` : name;
}
function lengthOf(value) {
  const length = ownData(value, 'length');
  return typeof length === 'number' ? length : 0;
}
function describe(value, info = inspect(value, 0)) {
  const subtype = subtypeOf(value, info);
  const name = className(value, info);
  let description = name;
  try {
    if (subtype === 'proxy') description = `Proxy(${name})`;
    else if (typeof value === 'function') description = functionSource(value);
    else if (subtype === 'array') description = `Array(${lengthOf(value)})`;
    else if (subtype === 'typedarray') description = `${name}(${typedLength(value)})`;
    else if (subtype === 'arraybuffer') description = `${name}(${brands().isSharedArrayBuffer(value) ? sharedLength(value) : bufferLength(value)})`;
    else if (subtype === 'dataview') description = `${name}(${viewLength(value)})`;
    else if (subtype === 'map') description = `${name}(${mapSize(value)})`;
    else if (subtype === 'set') description = `${name}(${setSize(value)})`;
    else if (subtype === 'date') description = dateText(value);
    else if (subtype === 'regexp') description = `/${regexpSource(value)}/${regexpFlags(value)}`;
    else if (subtype === 'error') description = errorDescription(value, name);
  } catch { description = name; }
  return { type: typeof value === 'function' ? 'function' : 'object', subtype, className: name, description };
}
// Integer-indexed keys first, ascending, then the rest in creation order (V8 order).
function ordered(properties = []) {
  const indexed = [], named = [];
  for (const property of properties) {
    const name = property.name;
    if (typeof name === 'string' && /^(?:0|[1-9]\d*)$/.test(name) && Number(name) < 4294967295) indexed.push(property);
    else named.push(property);
  }
  indexed.sort((a, b) => a.name - b.name);
  return indexed.concat(named);
}
function abbreviate(text, max = 100) {
  if (text.length <= max) return text;
  const half = (max - 1) >> 1;
  return text.slice(0, half) + '…' + text.slice(text.length - (max - 1 - half));
}
function previewValue(value) {
  if (value === null) return { type: 'object', subtype: 'null', value: 'null' };
  switch (typeof value) {
    case 'string': return { type: 'string', value: abbreviate(value) };
    case 'number': return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    case 'bigint': return { type: 'bigint', value: `${value}n` };
    case 'boolean': case 'undefined': return { type: typeof value, value: String(value) };
    case 'symbol': return { type: 'symbol', value: inspect(value).description };
    case 'function': return { type: 'function', value: '' };
  }
  const described = describe(value);
  return { type: 'object', value: abbreviate(described.description, 100), ...(described.subtype ? { subtype: described.subtype } : {}) };
}
function primitive(value, description) {
  const type = typeof value;
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  if (type === 'undefined') return { type };
  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      const text = Object.is(value, -0) ? '-0' : String(value);
      return { type, unserializableValue: text, description: text };
    }
    return { type, value, description: String(value) };
  }
  if (type === 'bigint') return { type, unserializableValue: `${value}n`, description: `${value}n` };
  if (type === 'boolean' || type === 'string') return { type, value };
  if (type === 'symbol') return { type, description: description || 'Symbol()' };
}
function byValue(value, seen = new Set(), depth = 0) {
  const simple = primitive(value);
  if (simple) {
    if (simple.unserializableValue !== undefined || simple.type === 'symbol') throw protocolError(-32000, "Object couldn't be returned by value");
    return simple.value;
  }
  if (depth > 100 || seen.has(value)) throw protocolError(-32000, 'Object reference chain is too long');
  const info = inspect(value);
  if (info.subtype === 'proxy' || info.type === 'function') throw protocolError(-32000, "Object couldn't be returned by value");
  seen.add(value);
  const result = info.subtype === 'array' ? [] : Object.create(null);
  for (const property of info.properties || []) {
    if (info.subtype === 'array' && property.name === 'length' && own(property, 'value')) {
      result.length = property.value;
      continue;
    }
    if (typeof property.name !== 'string' || !property.enumerable) continue;
    if (!own(property, 'value')) throw protocolError(-32000, "Object couldn't be returned by value");
    const item = byValue(property.value, seen, depth + 1);
    Object.defineProperty(result, property.name, { value: item, writable: true, enumerable: true, configurable: true });
  }
  seen.delete(value);
  return result;
}
class RemoteValues {
  constructor(prefix) { this.prefix = prefix; this.next = 1; this.entries = new Map(); }
  remote(value, group = '', returnByValue = false, generatePreview = false, context) {
    const info = inspect(value, generatePreview ? 128 : 0);
    const simple = primitive(value, info.description);
    if (simple && typeof value !== 'symbol') return simple;
    let result = simple;
    if (!result) {
      const described = describe(value, info);
      result = { type: described.type };
      if (described.subtype) result.subtype = described.subtype;
      result.className = described.className;
      result.description = described.description;
    }
    if (returnByValue) result.value = byValue(value);
    else {
      const objectId = `${this.prefix}:${this.next++}`;
      this.entries.set(objectId, { value, group, context });
      result.objectId = objectId;
    }
    if (generatePreview && typeof value === 'object') result.preview = preview(value, info);
    return result;
  }
  scope(frameId, scope, depth, context, type) {
    const objectId = `${this.prefix}:${this.next++}`;
    this.entries.set(objectId, { group: 'backtrace', context, scope: { frameId, scope, depth, type } });
    return { type: 'object', className: 'Object', description: 'Object', objectId };
  }
  entry(id) {
    const entry = this.entries.get(id);
    if (!entry) throw protocolError(-32000, 'Could not find object with given id');
    return entry;
  }
  lookup(id) {
    const entry = this.entry(id);
    if (entry.scope) throw protocolError(-32000, 'Cannot access debugger scope as a JavaScript object');
    return entry.value;
  }
  release(id) { this.entries.delete(id); }
  releaseGroup(group) { for (const [id, entry] of this.entries) if (entry.group === group) this.entries.delete(id); }
  clear() { this.entries.clear(); }
  argument(argument) {
    if (argument.objectId !== undefined) return this.lookup(argument.objectId);
    if (argument.unserializableValue !== undefined) {
      const text = argument.unserializableValue;
      if (text === 'NaN') return NaN;
      if (text === 'Infinity') return Infinity;
      if (text === '-Infinity') return -Infinity;
      if (text === '-0') return -0;
      if (/^-?\d+n$/.test(text)) return BigInt(text.slice(0, -1));
      throw protocolError(-32602, 'Invalid unserializable value');
    }
    return argument.value;
  }
  properties(id, params) {
    const entry = this.entry(id), result = [], internalProperties = [], visited = new Set(), names = new Set();
    if (entry.scope) {
      const scope = entry.scope;
      for (const binding of native(30, scope.frameId)) {
        if (scopeType(binding) !== scope.type || !scope.scope.includes(binding.scope) || binding.depth !== scope.depth || params.accessorPropertiesOnly) continue;
        result.push({ name: binding.name, configurable: false, enumerable: true, writable: !binding.isConst, isOwn: true,
          value: binding.isUninitialized ? { type: 'undefined', description: '<uninitialized>' } : this.remote(binding.value, entry.group, false, params.generatePreview, entry.context) });
      }
      return { result, internalProperties };
    }
    let value = entry.value, first = true;
    while (value !== null && value !== undefined && !visited.has(value)) {
      visited.add(value);
      const info = inspect(value);
      for (const property of ordered(info.properties)) {
        const name = property.name;
        if (names.has(name)) continue;
        names.add(name);
        if (params.accessorPropertiesOnly && own(property, 'value')) continue;
        if (params.nonIndexedPropertiesOnly && typeof name === 'string' && /^(0|[1-9]\d*)$/.test(name)) continue;
        const descriptor = { name: typeof name === 'symbol' ? inspect(name).description : String(name), configurable: !!property.configurable, enumerable: !!property.enumerable, isOwn: first };
        if (typeof name === 'symbol') descriptor.symbol = this.remote(name, entry.group, false, false, entry.context);
        if (own(property, 'value')) { descriptor.value = this.remote(property.value, entry.group, false, params.generatePreview, entry.context); descriptor.writable = !!property.writable; }
        if (property.unavailable) descriptor.value = { type: 'undefined', description: property.isUninitialized ? '<uninitialized>' : '<unavailable>' };
        if (property.get !== undefined) descriptor.get = this.remote(property.get, entry.group, false, false, entry.context);
        if (property.set !== undefined) descriptor.set = this.remote(property.set, entry.group, false, false, entry.context);
        result.push(descriptor);
      }
      if (first && info.type === 'function') {
        const location = native(19, value);
        if (location) internalProperties.push({ name: '[[FunctionLocation]]', value: { type: 'object', subtype: 'internal#location', value: { scriptId: location.scriptId, lineNumber: location.lineNumber, columnNumber: location.columnNumber }, description: 'Object' } });
      }
      if (first && info.prototype !== undefined && info.prototype !== null) internalProperties.push({ name: '[[Prototype]]', value: this.remote(info.prototype, entry.group, false, false, entry.context) });
      if (first && info.subtype === 'proxy') {
        const details = host.getProxyDetails(value);
        internalProperties.push({ name: '[[Target]]', value: this.remote(details === null ? null : details[0], entry.group, false, false, entry.context) },
          { name: '[[Handler]]', value: this.remote(details === null ? null : details[1], entry.group, false, false, entry.context) },
          { name: '[[IsRevoked]]', value: this.remote(details === null, entry.group) });
      } else if (first && info.subtype === 'promise') {
        const details = host.getPromiseDetails(value);
        internalProperties.push({ name: '[[PromiseState]]', value: this.remote(['pending', 'fulfilled', 'rejected'][details[0]], entry.group) },
          { name: '[[PromiseResult]]', value: this.remote(details[1], entry.group, false, false, entry.context) });
      }
      if (params.ownProperties) break;
      value = info.prototype;
      first = false;
    }
    return { result, internalProperties };
  }
}
function previewProperties(value, info, limit) {
  const properties = [];
  let overflow = false;
  const list = ordered(info.properties);
  if (info.subtype === 'error') for (const name of ['stack', 'message']) {
    if (properties.some(property => property.name === name)) continue;
    let text;
    if (name === 'stack') { const description = describe(value, info).description; text = description; }
    else text = ownData(value, 'message');
    if (typeof text === 'string') properties.push({ name, ...previewValue(text) });
  }
  for (const property of list) {
    if (!property.enumerable || typeof property.name !== 'string') continue;
    if (info.subtype === 'array' && property.name === 'length') continue;
    if (properties.length >= limit) { overflow = true; break; }
    if (property.unavailable) { properties.push({ name: property.name, type: 'undefined', value: 'undefined' }); continue; }
    if (!own(property, 'value')) { properties.push({ name: property.name, type: 'accessor' }); continue; }
    properties.push({ name: property.name, ...previewValue(property.value) });
  }
  return { properties, overflow: overflow || !!info.overflow };
}
function entryPreview(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    const shown = previewValue(value);
    return { type: shown.type, ...(shown.subtype ? { subtype: shown.subtype } : {}), description: shown.value, overflow: false, properties: [] };
  }
  return preview(value, inspect(value, 64), 5, false);
}
function preview(value, info, limit, withEntries = true) {
  const described = describe(value, info);
  const subtype = described.subtype;
  if (limit === undefined) limit = subtype === 'array' || subtype === 'typedarray' ? 100 : 5;
  const result = { type: described.type, ...(subtype ? { subtype } : {}), description: abbreviate(described.description, 100), overflow: false, properties: [] };
  if (typeof value === 'function' || subtype === 'proxy') return result;
  const shown = previewProperties(value, info, limit);
  result.properties = shown.properties; result.overflow = shown.overflow;
  if (subtype === 'map' || subtype === 'set') {
    result.properties.unshift({ name: 'size', type: 'number', value: String(subtype === 'map' ? mapSize(value) : setSize(value)) });
    if (withEntries) {
      const entries = [];
      const size = subtype === 'map' ? mapSize(value) : setSize(value);
      if (size > 5) result.overflow = true;
      for (const item of collectionEntries(value, subtype === 'map', 5)) {
        entries.push(subtype === 'map' ? { key: entryPreview(item[0]), value: entryPreview(item[1]) } : { value: entryPreview(item) });
      }
      // V8 leaves entries out of an empty collection's preview.
      if (entries.length) result.entries = entries;
    } else if ((subtype === 'map' ? mapSize(value) : setSize(value)) > 0) {
      // A collection inside an entry preview has no entries of its own: V8 marks what it left out.
      result.overflow = true;
    }
  } else if (subtype === 'promise') {
    const details = host.getPromiseDetails(value);
    result.properties.unshift({ name: '[[PromiseState]]', type: 'string', value: ['pending', 'fulfilled', 'rejected'][details[0]] },
      ...(details[0] === 0 ? [] : [{ name: '[[PromiseResult]]', ...previewValue(details[1]) }]));
  }
  return result;
}
function format(value, depth = 2, seen = new Set(), budget = { remaining: 1000 }) {
  if (budget.remaining <= 0) return '…';
  const info = inspect(value, 64), simple = primitive(value, info.description);
  let text;
  if (simple) text = typeof value === 'string' ? quote(value.length > budget.remaining ? value.slice(0, budget.remaining) + '…' : value) : simple.unserializableValue || (value === null ? 'null' : typeof value === 'undefined' ? 'undefined' : simple.description || String(value));
  else if (seen.has(value)) text = '[Circular]';
  else if (depth <= 0 || info.subtype === 'proxy' || typeof value === 'function') text = info.description || (info.subtype === 'array' ? '[Array]' : '[Object]');
  else {
    seen.add(value);
    const items = [], array = info.subtype === 'array';
    for (const property of info.properties || []) {
      if (!property.enumerable || typeof property.name !== 'string') continue;
      if (items.length >= 10 || budget.remaining <= 0) { items.push('…'); break; }
      const key = property.name.length > budget.remaining ? property.name.slice(0, budget.remaining) + '…' : property.name;
      const name = array && /^(0|[1-9]\d*)$/.test(key) ? '' : `${/^[\w$]+$/.test(key) ? key : quote(key)}: `;
      budget.remaining -= name.length;
      items.push(name + (property.unavailable ? property.isUninitialized ? '<uninitialized>' : '<unavailable>' : own(property, 'value') ? format(property.value, depth - 1, seen, budget) : property.get ? '[Getter]' : '[Setter]'));
    }
    seen.delete(value);
    text = array ? `[ ${items.join(', ')} ]` : `{ ${items.join(', ')} }`;
  }
  if (text.length > budget.remaining) text = text.slice(0, Math.max(0, budget.remaining)) + '…';
  budget.remaining -= text.length;
  return text;
}
// The CDP scope a frame binding belongs to, or undefined for bindings V8 never lists:
// the receiver, engine-internal names (new.target, <home_object>) and cached globals.
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
function scopeType(binding) {
  if (binding.kind === 0 || binding.kind === 5 || binding.name === 'this' || !IDENTIFIER.test(binding.name)) return undefined;
  if (binding.kind === 4) return 'module';
  if (binding.kind === 3) return 'closure';
  return binding.isLocal ? 'local' : 'block';
}
module.exports = { scopeType, RemoteValues, inspect, format, byValue, protocolError, unsupported };
