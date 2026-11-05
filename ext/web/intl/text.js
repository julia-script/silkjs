'use strict';
const c = require('internal/web/intl/common');
function Collator(locales, opts) {
  const o = c.options(opts), loc = c.locale(locales, o, ['co', 'kf', 'kn']);
  const usage = c.option(o, 'usage', ['sort', 'search'], 'sort');
  const sensitivity = c.option(o, 'sensitivity', ['base', 'accent', 'case', 'variant'], 'variant');
  const ignorePunctuation = o.ignorePunctuation === undefined ? /^th(?:-|$)/.test(loc) : Boolean(o.ignorePunctuation);
  const collation = c.unicodeType(o.collation, 'collation');
  const numeric = o.numeric === undefined ? /-kn(?:-true)?(?:-|$)/.test(loc) : Boolean(o.numeric);
  const caseFirst = c.option(o, 'caseFirst', ['upper', 'lower', 'false'], /-kf-upper(?:-|$)/.test(loc) ? 'upper' : /-kf-lower(?:-|$)/.test(loc) ? 'lower' : 'false');
  let actual = loc;
  if (collation !== undefined) actual = c.extension(actual, 'co', collation);
  if (usage === 'search') actual = c.extension(actual, 'co', 'search');
  const flags = ['base', 'accent', 'case', 'variant'].indexOf(sensitivity) + (numeric ? 16 : 0) + ({ false: 0, upper: 32, lower: 64 }[caseFirst]) + (ignorePunctuation ? 128 : 0);
  const state = c.config('Collator', actual, '', flags);
  c.call(state, 12);
  const nativeCollation = usage === 'search' ? 'default' : c.native(8, ['collation', actual]);
  const resolvedCollation = ({ phonebook: 'phonebk', traditional: 'trad', dictionary: 'dict', gb2312han: 'gb2312' }[nativeCollation] || nativeCollation);
  return c.set(new.target ? this : Object.create(Collator.prototype), 'Collator', state, { locale: loc, usage, sensitivity, ignorePunctuation, collation: resolvedCollation, numeric, caseFirst });
}
Object.defineProperty(Collator.prototype, 'compare', { configurable: true, get() { const slot = c.get(this, 'Collator'); if (!slot.bound) slot.bound = (a, b) => c.call(slot.state, 10, c.string(a), 0, 0, c.string(b)); return slot.bound; } });
c.finish(Collator, 'Collator');
const relativeUnits = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'];
class RelativeTimeFormat {
  constructor(locales, opts) {
    const o = c.options(opts), loc = c.locale(locales, o, ['nu']), style = c.option(o, 'style', ['long', 'short', 'narrow'], 'long'), numeric = c.option(o, 'numeric', ['always', 'auto'], 'always');
    const numbering = c.unicodeType(o.numberingSystem, 'numberingSystem');
    const actual = numbering === undefined || !c.native(8, ['numberingSystemValid', numbering]) ? loc : c.extension(loc, 'nu', numbering);
    const state = c.config('RelativeTimeFormat', actual, '', ['long', 'short', 'narrow'].indexOf(style) + (numeric === 'auto' ? 4 : 0));
    c.call(state, 52);
    c.set(this, 'RelativeTimeFormat', state, { locale: loc, style, numeric, numberingSystem: c.native(8, ['numberingSystem', actual]) });
  }
  format(value, unit) { return relative(this, value, unit, false); }
  formatToParts(value, unit) { return relative(this, value, unit, true); }
}
function relative(receiver, value, unit, asParts) {
  const { state } = c.get(receiver, 'RelativeTimeFormat'), number = c.number(value);
  if (!Number.isFinite(number)) throw new RangeError('Invalid relative time');
  unit = c.string(unit).replace(/s$/, '');
  const index = relativeUnits.indexOf(unit);
  if (index < 0) throw new RangeError('Invalid relative time unit');
  const result = c.call(state, 50, undefined, number, index);
  return asParts ? c.parts(result, 'relative', false, number, unit) : result[0];
}
c.finish(RelativeTimeFormat, 'RelativeTimeFormat');
class ListFormat {
  constructor(locales, opts) {
    const o = c.options(opts), loc = c.locale(locales, o), type = c.option(o, 'type', ['conjunction', 'disjunction', 'unit'], 'conjunction'), style = c.option(o, 'style', ['long', 'short', 'narrow'], 'long');
    const state = c.config('ListFormat', loc, '', ['conjunction', 'disjunction', 'unit'].indexOf(type) + 4 * ['long', 'short', 'narrow'].indexOf(style));
    c.call(state, 62);
    c.set(this, 'ListFormat', state, { locale: loc, type, style });
  }
  format(list) { return listData(this, list)[0]; }
  formatToParts(list) { return c.parts(listData(this, list), 'list'); }
}
function listData(receiver, list) {
  const { state } = c.get(receiver, 'ListFormat'), strings = [];
  if (list !== undefined) for (const value of list) { if (typeof value !== 'string') throw new TypeError('List elements must be strings'); strings.push(value); }
  return c.call(state, 60, strings.join(''), strings.length, 0, strings.map(s => s.length));
}
c.finish(ListFormat, 'ListFormat');
const displayTypes = ['language', 'region', 'script', 'currency', 'calendar', 'dateTimeField'];
const dateTimeFields = ['era', 'year', 'quarter', 'month', 'weekOfYear', 'weekday', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecond', 'timeZoneName'];
class DisplayNames {
  constructor(locales, opts) {
    if (opts === undefined) throw new TypeError('DisplayNames options are required');
    const o = c.options(opts), loc = c.locale(locales, o), style = c.option(o, 'style', ['long', 'short', 'narrow'], 'long');
    const type = c.option(o, 'type', displayTypes, undefined);
    if (type === undefined) throw new TypeError('DisplayNames type is required');
    const fallback = c.option(o, 'fallback', ['code', 'none'], 'code'), languageDisplay = c.option(o, 'languageDisplay', ['dialect', 'standard'], 'dialect');
    const state = c.config('DisplayNames', loc, '', (languageDisplay === 'dialect' ? 1 : 0) + (style !== 'long' ? 2 : 0) + (fallback === 'none' ? 4 : 0) + (style === 'narrow' ? 8 : 0));
    c.call(state, 72);
    const r = { locale: loc, style, type, fallback }; if (type === 'language') r.languageDisplay = languageDisplay;
    c.set(this, 'DisplayNames', state, r);
  }
  of(value) {
    const { state, resolved: r } = c.get(this, 'DisplayNames'); let code = c.string(value), index = 0;
    if (r.type === 'language') code = c.canonical(code);
    if (r.type === 'region') { if (!/^(?:[a-z]{2}|\d{3})$/i.test(code)) throw new RangeError('Invalid region'); code = code.toUpperCase(); }
    if (r.type === 'script') { if (!/^[a-z]{4}$/i.test(code)) throw new RangeError('Invalid script'); code = code[0].toUpperCase() + code.slice(1).toLowerCase(); }
    if (r.type === 'currency') { if (!/^[a-z]{3}$/i.test(code)) throw new RangeError('Invalid currency'); code = code.toUpperCase(); }
    if (r.type === 'calendar') { code = c.unicodeType(code, 'calendar'); if (code === 'gregory') code = 'gregorian'; if (code === 'ethioaa') code = 'ethiopic-amete-alem'; }
    if (r.type === 'dateTimeField') { index = dateTimeFields.indexOf(code); if (index < 0) throw new RangeError('Invalid dateTimeField'); }
    const result = c.call(state, 70, code, displayTypes.indexOf(r.type), index);
    return r.fallback === 'none' && (!result || result === code) ? undefined : result;
  }
}
c.finish(DisplayNames, 'DisplayNames');
const segmentSlots = new WeakMap();
function segmentRecord(s, index) { const begin = index === 0 ? 0 : s.boundaries[index - 2], end = s.boundaries[index]; const result = { segment: s.input.slice(begin, end), index: begin, input: s.input }; if (s.granularity === 'word') result.isWordLike = s.boundaries[index + 1] >= 100; return result; }
class Segments {
  constructor(input, granularity, boundaries) { segmentSlots.set(this, { input, granularity, boundaries }); }
  containing(index) {
    const s = segmentSlots.get(this); if (!s) throw new TypeError('Incompatible Segments receiver');
    index = c.number(index); if (Number.isNaN(index)) index = 0; index = Math.trunc(index);
    if (index < 0 || index >= s.input.length) return undefined;
    let low = 0, high = s.boundaries.length / 2;
    while (low < high) { const mid = (low + high) >>> 1; if (s.boundaries[mid * 2] <= index) low = mid + 1; else high = mid; }
    return segmentRecord(s, low * 2);
  }
  [Symbol.iterator]() {
    const s = segmentSlots.get(this); if (!s) throw new TypeError('Incompatible Segments receiver');
    let index = 0;
    return { next() { if (index >= s.boundaries.length) return { value: undefined, done: true }; const value = segmentRecord(s, index); index += 2; return { value, done: false }; }, [Symbol.iterator]() { return this; }, [Symbol.toStringTag]: 'Segmenter String Iterator' };
  }
}
Object.defineProperty(Segments.prototype, Symbol.toStringTag, { value: 'Intl.Segments', configurable: true });
class Segmenter {
  constructor(locales, opts) {
    const o = c.options(opts), loc = c.locale(locales, o), granularity = c.option(o, 'granularity', ['grapheme', 'word', 'sentence'], 'grapheme');
    const state = c.config('Segmenter', loc, '', { grapheme: 0, word: 1, sentence: 3 }[granularity]);
    c.call(state, 82); c.set(this, 'Segmenter', state, { locale: loc, granularity });
  }
  segment(value) { const { state, resolved } = c.get(this, 'Segmenter'), input = c.string(value); return new Segments(input, resolved.granularity, c.call(state, 80, input)); }
}
c.finish(Segmenter, 'Segmenter');
module.exports = { Collator, RelativeTimeFormat, ListFormat, DisplayNames, Segmenter };
