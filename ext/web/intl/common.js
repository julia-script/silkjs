'use strict';
const { intlNative } = require('internal/host');
const native = (op, args = []) => intlNative(op, args);
const slots = new WeakMap();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function primitive(value, hint = 'number') {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') throw new TypeError('Invalid Symbol.toPrimitive');
    const result = exotic.call(value, hint);
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return result;
    throw new TypeError('Cannot convert object to primitive');
  }
  for (const key of hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString']) {
    const method = value[key];
    if (typeof method !== 'function') continue;
    const result = method.call(value);
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return result;
  }
  throw new TypeError('Cannot convert object to primitive');
}
function string(value) { const v = primitive(value, 'string'); if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol to a string'); return String(v); }
function number(value) { const v = primitive(value); if (typeof v === 'bigint') throw new TypeError('Cannot convert a BigInt to a number'); return Number(v); }
function options(value) {
  if (value === undefined) return Object.create(null);
  if (value === null) throw new TypeError('Options must not be null');
  return Object(value);
}
function option(o, name, allowed, fallback) {
  const value = o[name];
  if (value === undefined) return fallback;
  const text = string(value);
  if (!allowed.includes(text)) throw new RangeError(`Invalid ${name}: ${text}`);
  return text;
}
function integer(o, name, min, max, fallback) {
  const value = o[name];
  if (value === undefined) return fallback;
  const n = number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`Invalid ${name}`);
  return Math.floor(n);
}
function canonical(tag) {
  tag = string(tag);
  if (!/^(?:[A-Za-z]{2,3}|[A-Za-z]{5,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-x(?:-[A-Za-z0-9]{1,8})+)?$/.test(tag)) throw new RangeError(`Invalid language tag: ${tag}`);
  const pieces = tag.toLowerCase().split('-');
  const singleton = new Set(), variants = new Set();
  let extension = false;
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i];
    if (p === 'x') break;
    if (p.length === 1) { if (singleton.has(p)) throw new RangeError('Duplicate extension'); singleton.add(p); extension = true; }
    else if (!extension && (p.length >= 5 || /^\d...$/.test(p))) { if (variants.has(p)) throw new RangeError('Duplicate variant'); variants.add(p); }
  }
  return native(1, [tag]);
}
function getCanonicalLocales(locales) {
  if (locales === undefined) return [];
  if (typeof locales === 'string' || localeInstances.has(locales)) locales = [locales];
  const object = Object(locales), length = Math.min(Math.max(Math.floor(Number(object.length) || 0), 0), Number.MAX_SAFE_INTEGER), result = [];
  for (let i = 0; i < length; i++) if (i in object) {
    const value = object[i];
    if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) throw new TypeError('Locale must be a string or object');
    const tag = canonical(value);
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}
const localeInstances = new WeakSet();
let available;
function supported(tag) {
  if (!available) available = new Set(native(5));
  let base = tag.replace(/-[0-9a-z]-.*$/i, '');
  while (base) { if (available.has(base)) return base; const at = base.lastIndexOf('-'); if (at < 0) return undefined; base = base.slice(0, at); }
  return undefined;
}
function supportedLocalesOf(locales, opts) {
  const list = getCanonicalLocales(locales), o = options(opts);
  option(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
  return list.filter(supported);
}
function locale(locales, o, relevant = []) {
  option(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
  const list = getCanonicalLocales(locales), requested = list.find(supported);
  if (requested === undefined) return native(4);
  let result = supported(requested);
  const match = requested.match(/-u((?:-[a-z0-9]{2,8})+)/);
  if (!match) return result;
  const fields = match[1].slice(1).split('-');
  for (let i = 0; i < fields.length;) {
    const key = fields[i++], values = [];
    while (i < fields.length && fields[i].length > 2) values.push(fields[i++]);
    if (!relevant.includes(key)) continue;
    const value = values.join('-');
    if (key === 'nu' && !native(8, ['numberingSystemValid', value])) continue;
    if (key === 'hc' && !['h11', 'h12', 'h23', 'h24'].includes(value)) continue;
    if (key === 'kf' && !['upper', 'lower', 'false'].includes(value)) continue;
    if (key === 'kn' && !['', 'true', 'false'].includes(value)) continue;
    if (key === 'co') {
      const names = native(8, ['collations', result]).map(v => ({ phonebook: 'phonebk', traditional: 'trad', dictionary: 'dict', gb2312han: 'gb2312' }[v] || v));
      if (value === 'standard' || value === 'search' || !names.includes(value)) continue;
    }
    if (key === 'ca') {
      const names = native(8, ['calendars', result]).map(v => ({ gregorian: 'gregory', 'ethiopic-amete-alem': 'ethioaa' }[v] || v));
      if (!names.includes(value)) continue;
    }
    result = extension(result, key, value || 'true');
  }
  return result;
}
function extension(tag, key, value) {
  if (value === undefined) return tag;
  const parts = tag.split('-');
  const x = parts.indexOf('x'), privateUse = x < 0 ? [] : parts.splice(x);
  let u = parts.indexOf('u');
  if (u < 0) { parts.push('u'); u = parts.length - 1; }
  let end = u + 1; while (end < parts.length && parts[end].length !== 1) end++;
  let at = parts.indexOf(key, u + 1);
  if (at >= end) at = -1;
  if (at >= 0) { let stop = at + 1; while (stop < end && parts[stop].length > 2) stop++; parts.splice(at, stop - at); end -= stop - at; }
  parts.splice(end, 0, key, ...String(value).split('-'));
  return canonical(parts.concat(privateUse).join('-'));
}
function unicodeType(value, name) {
  if (value === undefined) return undefined;
  const s = string(value);
  if (!/^[a-z0-9]{3,8}(?:-[a-z0-9]{3,8})*$/i.test(s)) throw new RangeError(`Invalid ${name}`);
  return s.toLowerCase();
}
function config(kind, loc, skeleton = '', flags = 0, extra = '') {
  return { kind, locale: loc, skeleton, flags, extra, key: JSON.stringify([kind, loc, skeleton, flags, extra]) };
}
function call(s, op, text, n = 0, n2 = 0, extra = s.extra) {
  return native(op, [s.key, s.locale, s.skeleton, text, n, n2, s.flags, extra]);
}
function set(object, type, state, resolved) { slots.set(object, { type, state, resolved }); return object; }
function get(object, type) { const slot = slots.get(object); if (!slot || slot.type !== type) throw new TypeError(`Incompatible Intl.${type} receiver`); return slot; }
function resolved(type) { return function resolvedOptions() { const r = get(this, type).resolved; const out = { ...r }; if (r.pluralCategories) out.pluralCategories = r.pluralCategories.slice(); return out; }; }
function finish(C, type) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: `Intl.${type}`, configurable: true });
  Object.defineProperty(C, 'supportedLocalesOf', { value: supportedLocalesOf, writable: true, configurable: true });
  Object.defineProperty(C.prototype, 'resolvedOptions', { value: resolved(type), writable: true, configurable: true });
  return C;
}
const numberFields = ['integer', 'fraction', 'decimal', 'exponentSeparator', 'exponentMinusSign', 'exponentInteger', 'group', 'currency', 'percentSign', 'unit', 'sign', 'unit', 'compact', 'approximatelySign'];
const dateFields = ['era', 'year', 'month', 'day', 'hour', 'hour', 'minute', 'second', 'fractionalSecond', 'weekday', 'day', 'day', 'literal', 'literal', 'dayPeriod', 'hour', 'hour', 'timeZoneName', 'year', 'weekday', 'year', 'day', 'literal', 'timeZoneName', 'timeZoneName', 'weekday', 'month', 'literal', 'literal', 'timeZoneName', 'yearName', 'timeZoneName', 'timeZoneName', 'timeZoneName', 'relatedYear', 'dayPeriod', 'dayPeriod', 'literal'];
function parts(data, kind, range = false, number = 0, unit) {
  const text = data[0], fields = [], spans = [], cuts = new Set([0, text.length]);
  for (let i = 1; i < data.length; i += 4) {
    const [category, field, start, end] = data.slice(i, i + 4);
    if (start === end) continue;
    if (category >= 0x1000) spans.push({ field, start, end });
    else if ((kind === 'date' && category === 1) || (kind === 'number' && category === 2) || (kind === 'relative' && category === 2) || (kind === 'list' && category === 3 && field === 1)) fields.push({ field, start, end });
    else continue;
    cuts.add(start); cuts.add(end);
  }
  const sorted = [...cuts].sort((a, b) => a - b), output = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i], end = sorted[i + 1], value = text.slice(start, end);
    let chosen;
    for (const field of fields) if (field.start <= start && field.end >= end && (!chosen || field.end - field.start <= chosen.end - chosen.start)) chosen = field;
    let type = !chosen ? 'literal' : kind === 'list' ? 'element' : kind === 'date' ? dateFields[chosen.field] || 'literal' : numberFields[chosen.field] || 'literal';
    if (type === 'sign') type = /[-\u2212]/.test(value) ? 'minusSign' : 'plusSign';
    if (type === 'integer' && Number.isNaN(number)) type = 'nan';
    if (type === 'integer' && typeof number === 'number' && !Number.isFinite(number) && !Number.isNaN(number)) type = 'infinity';
    const part = { type, value };
    if (kind === 'relative' && type !== 'literal') part.unit = unit;
    if (range) { const span = spans.find(s => s.start <= start && s.end >= end); part.source = span ? span.field === 0 ? 'startRange' : 'endRange' : 'shared'; }
    const previous = output[output.length - 1];
    if (previous && previous.type === part.type && previous.source === part.source && previous.unit === part.unit && type !== 'element') previous.value += value;
    else output.push(part);
  }
  return output;
}
module.exports = { native, own, primitive, string, number, options, option, integer, canonical, getCanonicalLocales, localeInstances, supportedLocalesOf, locale, extension, unicodeType, config, call, set, get, resolved, finish, parts };
