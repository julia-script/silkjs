'use strict';
const c = require('internal/web/intl/common');
const units = {
  acre: 'area-acre', bit: 'digital-bit', byte: 'digital-byte', celsius: 'temperature-celsius', centimeter: 'length-centimeter', day: 'duration-day', degree: 'angle-degree', fahrenheit: 'temperature-fahrenheit', 'fluid-ounce': 'volume-fluid-ounce', foot: 'length-foot', gallon: 'volume-gallon', gigabit: 'digital-gigabit', gigabyte: 'digital-gigabyte', gram: 'mass-gram', hectare: 'area-hectare', hour: 'duration-hour', inch: 'length-inch', kilobit: 'digital-kilobit', kilobyte: 'digital-kilobyte', kilogram: 'mass-kilogram', kilometer: 'length-kilometer', liter: 'volume-liter', megabit: 'digital-megabit', megabyte: 'digital-megabyte', meter: 'length-meter', microsecond: 'duration-microsecond', mile: 'length-mile', 'mile-scandinavian': 'length-mile-scandinavian', milliliter: 'volume-milliliter', millimeter: 'length-millimeter', millisecond: 'duration-millisecond', minute: 'duration-minute', month: 'duration-month', nanosecond: 'duration-nanosecond', ounce: 'mass-ounce', percent: 'concentr-percent', petabyte: 'digital-petabyte', pound: 'mass-pound', second: 'duration-second', stone: 'mass-stone', terabit: 'digital-terabit', terabyte: 'digital-terabyte', week: 'duration-week', yard: 'length-yard', year: 'duration-year'
};
function unitSkeleton(unit) {
  const split = unit.split('-per-');
  if (split.length > 2 || split.some(x => !units[x])) throw new RangeError(`Invalid unit: ${unit}`);
  return `measure-unit/${units[split[0]]}` + (split[1] ? ` per-measure-unit/${units[split[1]]}` : '');
}
const roundingModes = { ceil: 'ceiling', floor: 'floor', expand: 'up', trunc: 'down', halfCeil: 'half-ceiling', halfFloor: 'half-floor', halfExpand: 'half-up', halfTrunc: 'half-down', halfEven: 'half-even' };
function precision(o, r, minDefault, maxDefault, compact = false) {
  const minInteger = c.integer(o, 'minimumIntegerDigits', 1, 21, 1);
  const minFraction = c.integer(o, 'minimumFractionDigits', 0, 100, undefined);
  const maxFraction = c.integer(o, 'maximumFractionDigits', 0, 100, undefined);
  const minSignificant = c.integer(o, 'minimumSignificantDigits', 1, 21, undefined);
  const maxSignificant = c.integer(o, 'maximumSignificantDigits', 1, 21, undefined);
  const priority = c.option(o, 'roundingPriority', ['auto', 'morePrecision', 'lessPrecision'], 'auto');
  const increment = c.integer(o, 'roundingIncrement', 1, 5000, 1);
  if (![1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].includes(increment)) throw new RangeError('Invalid roundingIncrement');
  const mode = c.option(o, 'roundingMode', Object.keys(roundingModes), 'halfExpand');
  const trailing = c.option(o, 'trailingZeroDisplay', ['auto', 'stripIfInteger'], 'auto');
  r.minimumIntegerDigits = minInteger;
  let minimum = minFraction === undefined ? Math.min(minDefault, maxFraction === undefined ? maxDefault : maxFraction) : minFraction;
  let maximum = maxFraction === undefined ? Math.max(maxDefault, minimum) : maxFraction;
  let minSig = minSignificant === undefined ? 1 : minSignificant, maxSig = maxSignificant === undefined ? 21 : maxSignificant;
  let significant = minSignificant !== undefined || maxSignificant !== undefined;
  let effectivePriority = priority;
  if (compact && !significant && minFraction === undefined && maxFraction === undefined && priority === 'auto') {
    minimum = 0; maximum = 0; minSig = 1; maxSig = 2; effectivePriority = 'morePrecision';
  }
  if (maximum < minimum || maxSig < minSig) throw new RangeError('Invalid digit range');
  let p = maximum === 0 ? 'precision-integer' : '.' + '0'.repeat(minimum) + '#'.repeat(maximum - minimum);
  if (significant || effectivePriority !== 'auto') {
    const s = '@'.repeat(minSig) + '#'.repeat(maxSig - minSig);
    if (effectivePriority === 'auto') p = s;
    else p += '/' + s + (effectivePriority === 'morePrecision' ? 'r' : 's');
    r.minimumSignificantDigits = minSig; r.maximumSignificantDigits = maxSig;
  }
  if (!significant || effectivePriority !== 'auto') { r.minimumFractionDigits = minimum; r.maximumFractionDigits = maximum; }
  if (increment !== 1) {
    if (significant || effectivePriority !== 'auto' || minimum !== maximum) throw new RangeError('Rounding increment requires equal fraction digits');
    let value = String(increment).padStart(maximum + 1, '0');
    if (maximum) value = value.slice(0, -maximum) + '.' + value.slice(-maximum);
    p = 'precision-increment/' + value;
  }
  if (trailing === 'stripIfInteger') p += '/w';
  r.roundingIncrement = increment; r.roundingMode = mode; r.roundingPriority = effectivePriority; r.trailingZeroDisplay = trailing;
  return `${p} integer-width/+${'0'.repeat(minInteger)} rounding-mode-${roundingModes[mode]}`;
}
function setup(locales, opts, plural = false) {
  const o = c.options(opts), loc = c.locale(locales, o, plural ? [] : ['nu']), r = { locale: loc };
  let actualLocale = loc;
  const numbering = c.unicodeType(o.numberingSystem, 'numberingSystem');
  if (numbering !== undefined && c.native(8, ['numberingSystemValid', numbering])) actualLocale = c.extension(loc, 'nu', numbering);
  if (plural) {
    r.type = c.option(o, 'type', ['cardinal', 'ordinal'], 'cardinal');
    const skeleton = precision(o, r, 0, 3);
    const state = c.config('PluralRules', actualLocale, skeleton, r.type === 'ordinal' ? 1 : 0);
    r.pluralCategories = c.call(state, 42).sort((a, b) => ['zero', 'one', 'two', 'few', 'many', 'other'].indexOf(a) - ['zero', 'one', 'two', 'few', 'many', 'other'].indexOf(b));
    return { state, r };
  }
  r.numberingSystem = c.native(8, ['numberingSystem', actualLocale]);
  r.style = c.option(o, 'style', ['decimal', 'percent', 'currency', 'unit'], 'decimal');
  const currency = o.currency === undefined ? undefined : c.string(o.currency).toUpperCase();
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new RangeError('Invalid currency');
  const currencyDisplay = c.option(o, 'currencyDisplay', ['code', 'symbol', 'narrowSymbol', 'name'], 'symbol');
  const currencySign = c.option(o, 'currencySign', ['standard', 'accounting'], 'standard');
  const unit = o.unit === undefined ? undefined : c.string(o.unit);
  if (unit !== undefined) unitSkeleton(unit);
  const unitDisplay = c.option(o, 'unitDisplay', ['short', 'narrow', 'long'], 'short');
  let skeleton = '', minimum = 0, maximum = 3;
  if (r.style === 'currency') {
    if (!currency) throw new TypeError('currency is required');
    r.currency = currency; r.currencyDisplay = currencyDisplay; r.currencySign = currencySign;
    minimum = maximum = c.native(8, ['currencyDigits', currency]);
    skeleton = `currency/${currency} ` + ({ code: 'unit-width-iso-code', symbol: 'unit-width-short', narrowSymbol: 'unit-width-narrow', name: 'unit-width-full-name' }[currencyDisplay]);
  }
  if (r.style === 'unit') {
    if (!unit) throw new TypeError('unit is required');
    r.unit = unit; r.unitDisplay = unitDisplay;
    skeleton = unitSkeleton(unit) + ' unit-width-' + ({ short: 'short', narrow: 'narrow', long: 'full-name' }[unitDisplay]);
  }
  if (r.style === 'percent') { skeleton = 'percent scale/100'; maximum = 0; }
  r.notation = c.option(o, 'notation', ['standard', 'scientific', 'engineering', 'compact'], 'standard');
  const compactDisplay = c.option(o, 'compactDisplay', ['short', 'long'], 'short');
  if (r.notation === 'compact') { r.compactDisplay = compactDisplay; skeleton += ` compact-${compactDisplay}`; }
  else if (r.notation !== 'standard') skeleton += ' ' + r.notation;
  skeleton += ' ' + precision(o, r, minimum, maximum, r.notation === 'compact');
  let grouping = o.useGrouping;
  if (grouping === undefined || grouping === true || grouping === 'true' || grouping === 'false') grouping = r.notation === 'compact' ? 'min2' : 'auto';
  else if (grouping !== false) grouping = c.option({ grouping }, 'grouping', ['auto', 'always', 'min2'], 'auto');
  r.useGrouping = grouping;
  skeleton += ' ' + (grouping === false ? 'group-off' : grouping === 'always' ? 'group-on-aligned' : grouping === 'min2' ? 'group-min2' : 'group-auto');
  r.signDisplay = c.option(o, 'signDisplay', ['auto', 'never', 'always', 'exceptZero', 'negative'], 'auto');
  const accounting = r.style === 'currency' && currencySign === 'accounting';
  const signs = accounting ? { auto: 'sign-accounting', never: 'sign-never', always: 'sign-accounting-always', exceptZero: 'sign-accounting-except-zero', negative: 'sign-accounting-negative' } : { auto: 'sign-auto', never: 'sign-never', always: 'sign-always', exceptZero: 'sign-except-zero', negative: 'sign-negative' };
  skeleton += ' ' + signs[r.signDisplay];
  const state = c.config('NumberFormat', actualLocale, skeleton.trim());
  // Creation validates the skeleton and populates the native configuration cache.
  c.call(state, 22);
  return { state, r };
}
function numeric(value) {
  value = c.primitive(value);
  if (typeof value === 'bigint') return { text: String(value), n: value };
  if (typeof value === 'string' && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return { text: value.trim(), n: Number(value) };
  return { text: undefined, n: Number(value) };
}
function numberData(receiver, value) { const { state } = c.get(receiver, 'NumberFormat'), n = numeric(value); return { data: c.call(state, 20, n.text, typeof n.n === 'bigint' ? 0 : n.n), n: n.text === undefined ? n.n : n.text }; }
function NumberFormat(locales, opts) { const { state, r } = setup(locales, opts); return c.set(new.target ? this : Object.create(NumberFormat.prototype), 'NumberFormat', state, r); }
Object.defineProperty(NumberFormat.prototype, 'format', { configurable: true, get() { const slot = c.get(this, 'NumberFormat'); if (!slot.bound) slot.bound = value => numberData(this, value).data[0]; return slot.bound; } });
Object.defineProperty(NumberFormat.prototype, 'formatToParts', { configurable: true, writable: true, value: function formatToParts(value) { const { data, n } = numberData(this, value); return c.parts(data, 'number', false, n); } });
function numberRange(receiver, start, end, asParts) {
  const { state } = c.get(receiver, 'NumberFormat');
  if (start === undefined || end === undefined) throw new TypeError('Range endpoints are required');
  const a = numeric(start), b = numeric(end);
  if (Number.isNaN(a.n) || Number.isNaN(b.n)) throw new RangeError('Invalid number range');
  const decimal = a.text !== undefined || b.text !== undefined;
  const text = item => item.text === undefined ? Object.is(item.n, -0) ? '-0' : String(item.n) : item.text;
  const data = decimal ? c.call(state, 21, text(a), 0, 0, text(b)) : c.call(state, 21, undefined, a.n, b.n);
  return asParts ? c.parts(data, 'number', true, a.text === undefined ? a.n : a.text) : data[0];
}
NumberFormat.prototype.formatRange = function formatRange(start, end) { return numberRange(this, start, end, false); };
NumberFormat.prototype.formatRangeToParts = function formatRangeToParts(start, end) { return numberRange(this, start, end, true); };
c.finish(NumberFormat, 'NumberFormat');
class PluralRules {
  constructor(locales, opts) { const { state, r } = setup(locales, opts, true); c.set(this, 'PluralRules', state, r); }
  select(value) { const { state } = c.get(this, 'PluralRules'); return c.call(state, 40, undefined, c.number(value)); }
  selectRange(start, end) { const { state } = c.get(this, 'PluralRules'); if (start === undefined || end === undefined) throw new TypeError('Range endpoints are required'); const a = c.number(start), b = c.number(end); if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('Invalid range'); return c.call(state, 41, undefined, a, b); }
}
c.finish(PluralRules, 'PluralRules');
module.exports = { NumberFormat, PluralRules, units, precision };
