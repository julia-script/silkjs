'use strict';

const host = require('internal/host');
const native = host.inspectorNative;
const quote = JSON.stringify;
const own = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function protocolError(code, message) { return Object.assign(new Error(message), { protocolCode: code }); }
function unsupported(method) { throw protocolError(-32601, `'${method}' wasn't found`); }
function inspect(value, limit) { return limit === undefined ? native(9, value) : native(9, value, limit); }
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
// V8's descriptions for arrays and errors. Only own data properties are read, so
// no getter or proxy trap runs (proxies have their own subtype).
function describe(value, info) {
  if (info.subtype === 'array') return `Array(${value.length})`;
  if (info.subtype === 'error') {
    const stack = Object.getOwnPropertyDescriptor(value, 'stack');
    if (stack && typeof stack.value === 'string') return stack.value;
  }
  return info.description;
}
class RemoteValues {
  constructor(prefix) { this.prefix = prefix; this.next = 1; this.entries = new Map(); }
  remote(value, group = '', returnByValue = false, generatePreview = false, context) {
    const info = inspect(value, generatePreview ? 64 : 0);
    const simple = primitive(value, info.description);
    if (simple && typeof value !== 'symbol') return simple;
    const result = simple || { type: info.type || typeof value, description: describe(value, info) || (typeof value === 'function' ? 'function' : 'Object') };
    if (info.subtype) result.subtype = info.subtype;
    if (info.className) result.className = info.className;
    if (returnByValue) result.value = byValue(value);
    else {
      const objectId = `${this.prefix}:${this.next++}`;
      this.entries.set(objectId, { value, group, context });
      result.objectId = objectId;
    }
    if (generatePreview && typeof value !== 'symbol') result.preview = preview(info);
    return result;
  }
  scope(frameId, scope, depth, context) {
    const objectId = `${this.prefix}:${this.next++}`;
    this.entries.set(objectId, { group: 'backtrace', context, scope: { frameId, scope, depth } });
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
        if (binding.kind === 0 || !scope.scope.includes(binding.scope) || binding.depth !== scope.depth || params.accessorPropertiesOnly) continue;
        result.push({ name: binding.name, configurable: false, enumerable: true, writable: !binding.isConst, isOwn: true,
          value: binding.isUninitialized ? { type: 'undefined', description: '<uninitialized>' } : this.remote(binding.value, entry.group, false, params.generatePreview, entry.context) });
      }
      return { result, internalProperties };
    }
    let value = entry.value, first = true;
    while (value !== null && value !== undefined && !visited.has(value)) {
      visited.add(value);
      const info = inspect(value);
      for (const property of info.properties || []) {
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
function preview(info) {
  const properties = [];
  let overflow = false;
  for (const property of info.properties || []) {
    if (!property.enumerable || typeof property.name !== 'string') continue;
    if (properties.length === 5) { overflow = true; break; }
    const value = own(property, 'value') ? inspect(property.value) : { type: 'accessor', description: '(...)' };
    properties.push({ name: property.name, type: value.type, ...(value.subtype ? { subtype: value.subtype } : {}), value: own(property, 'value') ? format(property.value, 0, new Set(), { remaining: 160 }) : '(...)' });
  }
  return { type: info.type, ...(info.subtype ? { subtype: info.subtype } : {}), description: info.description, overflow, properties };
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
module.exports = { RemoteValues, inspect, format, byValue, protocolError, unsupported };
