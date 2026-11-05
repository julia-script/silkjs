'use strict';
const c = require('internal/web/intl/common');
const styles = ['full', 'long', 'medium', 'short'];
let timeZoneNames;
const fieldValues = {
  weekday: ['narrow', 'short', 'long'], era: ['narrow', 'short', 'long'], year: ['2-digit', 'numeric'], month: ['2-digit', 'numeric', 'narrow', 'short', 'long'], day: ['2-digit', 'numeric'], dayPeriod: ['narrow', 'short', 'long'], hour: ['2-digit', 'numeric'], minute: ['2-digit', 'numeric'], second: ['2-digit', 'numeric'], timeZoneName: ['short', 'long', 'shortOffset', 'longOffset', 'shortGeneric', 'longGeneric']
};
function setup(locales, opts) {
  const o = c.options(opts), loc = c.locale(locales, o, ['ca', 'nu', 'hc']);
  let actualLocale = loc;
  const calendar = c.unicodeType(o.calendar, 'calendar'), numbering = c.unicodeType(o.numberingSystem, 'numberingSystem');
  if (calendar !== undefined) actualLocale = c.extension(actualLocale, 'ca', calendar);
  if (numbering !== undefined && c.native(8, ['numberingSystemValid', numbering])) actualLocale = c.extension(actualLocale, 'nu', numbering);
  let hourCycle = c.option(o, 'hourCycle', ['h11', 'h12', 'h23', 'h24'], undefined);
  const hour12 = o.hour12 === undefined ? undefined : Boolean(o.hour12);
  if (hour12 !== undefined) hourCycle = hour12 ? 'h12' : 'h23';
  if (hourCycle !== undefined) actualLocale = c.extension(actualLocale, 'hc', hourCycle);
  let timeZone = o.timeZone === undefined ? c.native(7) : c.string(o.timeZone);
  if (/^[+-]/.test(timeZone)) {
    const offset = timeZone.match(/^([+-])(\d{2})(?::?(\d{2}))?$/);
    if (!offset || +offset[2] > 23 || +(offset[3] || 0) > 59) throw new RangeError('Invalid time zone offset');
    timeZone = offset[1] + offset[2] + ':' + (offset[3] || '00');
  } else {
    if (!timeZoneNames) timeZoneNames = new Map(c.native(6, ['timeZoneAll']).map(name => [name.toUpperCase(), name]));
    const known = timeZoneNames.get(timeZone.toUpperCase());
    if (!known || known === 'Etc/Unknown') throw new RangeError(`Invalid time zone: ${timeZone}`);
    timeZone = known;
    timeZone = c.native(8, ['timeZone', timeZone]);
    if (timeZone === 'Etc/UTC' || timeZone === 'Etc/GMT') timeZone = 'UTC';
  }
  const nativeCalendar = c.native(8, ['calendar', actualLocale]);
  const r = { locale: loc, calendar: ({ gregorian: 'gregory', 'ethiopic-amete-alem': 'ethioaa' }[nativeCalendar] || nativeCalendar), numberingSystem: c.native(8, ['numberingSystem', actualLocale]), timeZone };
  const fields = {};
  for (const key of Object.keys(fieldValues)) { const value = c.option(o, key, fieldValues[key], undefined); if (value !== undefined) fields[key] = value; }
  const fractional = c.integer(o, 'fractionalSecondDigits', 1, 3, undefined);
  if (fractional !== undefined) fields.fractionalSecondDigits = fractional;
  c.option(o, 'formatMatcher', ['basic', 'best fit'], 'best fit');
  const dateStyle = c.option(o, 'dateStyle', styles, undefined), timeStyle = c.option(o, 'timeStyle', styles, undefined);
  if ((dateStyle !== undefined || timeStyle !== undefined) && Object.keys(fields).length) throw new TypeError('Cannot combine dateStyle/timeStyle with date components');
  let flags = 0;
  if (dateStyle !== undefined || timeStyle !== undefined) {
    flags = (timeStyle === undefined ? 0 : styles.indexOf(timeStyle) + 1) + 8 * (dateStyle === undefined ? 0 : styles.indexOf(dateStyle) + 1);
    if (dateStyle !== undefined) r.dateStyle = dateStyle;
    if (timeStyle !== undefined) r.timeStyle = timeStyle;
  } else if (!Object.keys(fields).some(k => ['weekday', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'].includes(k))) Object.assign(fields, { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (hourCycle === undefined) hourCycle = c.native(8, ['hourCycle', actualLocale]);
  const chars = {
    weekday: { narrow: 'EEEEE', short: 'EEE', long: 'EEEE' }, era: { narrow: 'GGGGG', short: 'GGG', long: 'GGGG' }, year: { '2-digit': 'yy', numeric: 'y' }, month: { '2-digit': 'MM', numeric: 'M', narrow: 'MMMMM', short: 'MMM', long: 'MMMM' }, day: { '2-digit': 'dd', numeric: 'd' }, dayPeriod: { narrow: 'BBBBB', short: 'B', long: 'BBBB' }, minute: { '2-digit': 'mm', numeric: 'm' }, second: { '2-digit': 'ss', numeric: 's' }, timeZoneName: { short: 'z', long: 'zzzz', shortOffset: 'O', longOffset: 'OOOO', shortGeneric: 'v', longGeneric: 'vvvv' }
  };
  let skeleton = '';
  for (const key of Object.keys(fields)) {
    if (key === 'hour') { const ch = { h11: 'K', h12: 'h', h23: 'H', h24: 'k' }[hourCycle]; skeleton += fields.hour === '2-digit' ? ch + ch : ch; }
    else if (key === 'fractionalSecondDigits') skeleton += 'S'.repeat(fields[key]);
    else skeleton += chars[key][fields[key]];
  }
  if (!skeleton) skeleton = 'yMd';
  const state = c.config('DateTimeFormat', actualLocale, skeleton, flags, /^[+-]/.test(timeZone) ? 'GMT' + timeZone : timeZone);
  const pattern = c.call(state, 32);
  if (fields.hour || timeStyle !== undefined) { r.hourCycle = /K/.test(pattern) ? 'h11' : /h/.test(pattern) ? 'h12' : /k/.test(pattern) ? 'h24' : 'h23'; r.hour12 = r.hourCycle === 'h11' || r.hourCycle === 'h12'; }
  if (!flags) {
    Object.assign(r, fields);
    // ICU's best-pattern selection may widen numeric fields (notably minutes).
    const unquoted = pattern.replace(/'[^']*(?:''[^']*)*'/g, '');
    for (const [key, re] of [['hour', /[hHKk]+/], ['minute', /m+/], ['second', /s+/], ['day', /d+/], ['month', /M+/], ['year', /y+/]]) {
      const match = unquoted.match(re);
      if (match && r[key] && ['numeric', '2-digit'].includes(r[key])) r[key] = match[0].length === 2 ? '2-digit' : 'numeric';
    }
  }
  return { state, r };
}
function DateTimeFormat(locales, opts) { const { state, r } = setup(locales, opts); return c.set(new.target ? this : Object.create(DateTimeFormat.prototype), 'DateTimeFormat', state, r); }
function date(value, missing) { const n = missing && value === undefined ? Date.now() : c.number(value); if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) throw new RangeError('Invalid time value'); return Math.trunc(n); }
function data(receiver, value) { return c.call(c.get(receiver, 'DateTimeFormat').state, 30, undefined, date(value, true)); }
Object.defineProperty(DateTimeFormat.prototype, 'format', { configurable: true, get() { const slot = c.get(this, 'DateTimeFormat'); if (!slot.bound) slot.bound = value => data(this, value)[0]; return slot.bound; } });
DateTimeFormat.prototype.formatToParts = function formatToParts(value) { return c.parts(data(this, value), 'date'); };
function range(receiver, start, end, asParts) {
  const { state } = c.get(receiver, 'DateTimeFormat');
  if (start === undefined || end === undefined) throw new TypeError('Range endpoints are required');
  const a = date(start, false), b = date(end, false);
  if (a > b) throw new RangeError('Invalid time range');
  const result = c.call(state, 31, undefined, a, b);
  return asParts ? c.parts(result, 'date', true) : result[0];
}
DateTimeFormat.prototype.formatRange = function formatRange(start, end) { return range(this, start, end, false); };
DateTimeFormat.prototype.formatRangeToParts = function formatRangeToParts(start, end) { return range(this, start, end, true); };
c.finish(DateTimeFormat, 'DateTimeFormat');
module.exports = { DateTimeFormat };
