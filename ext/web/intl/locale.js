'use strict';
const c = require('internal/web/intl/common');
const { units } = require('internal/web/intl/number');
const localeSlots = new WeakMap();
const calendarName = name => ({ gregorian: 'gregory', 'ethiopic-amete-alem': 'ethioaa' }[name] || name);
const collationName = name => ({ dictionary: 'dict', gb2312han: 'gb2312', phonebook: 'phonebk', traditional: 'trad' }[name] || name);
const weekDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function parse(tag) {
  const parts = tag.split('-'), extension = parts.findIndex((p, i) => i > 0 && p.length === 1), base = extension < 0 ? parts : parts.slice(0, extension);
  const result = { tag, baseName: base.join('-'), language: base[0] };
  if (base[1] && /^[A-Z][a-z]{3}$/.test(base[1])) result.script = base[1];
  result.region = base.slice(1).find(p => /^(?:[A-Z]{2}|\d{3})$/.test(p));
  const u = parts.indexOf('u');
  if (u >= 0) {
    for (let i = u + 1; i < parts.length && parts[i].length > 1;) {
      if (parts[i].length !== 2) { i++; continue; }
      const key = parts[i++], values = [];
      while (i < parts.length && parts[i].length > 2) values.push(parts[i++]);
      const value = values.join('-');
      if (key === 'ca') result.calendar = value;
      if (key === 'co') result.collation = value;
      if (key === 'hc') result.hourCycle = value;
      if (key === 'fw') result.firstDayOfWeek = value;
      if (key === 'kf') result.caseFirst = value;
      if (key === 'nu') result.numberingSystem = value;
      if (key === 'kn') result.numeric = value === '' || value === 'true';
    }
  }
  if (result.numeric === undefined) result.numeric = false;
  return result;
}
function get(receiver) { const s = localeSlots.get(receiver); if (!s) throw new TypeError('Incompatible Intl.Locale receiver'); return s; }
class Locale {
  constructor(tag, opts) {
    if (typeof tag !== 'string' && (typeof tag !== 'object' || tag === null)) throw new TypeError('Locale tag must be a string or object');
    let canonical = c.canonical(tag); const o = c.options(opts), parsed = parse(canonical);
    const language = o.language === undefined ? parsed.language : c.string(o.language), script = o.script === undefined ? parsed.script : c.string(o.script), region = o.region === undefined ? parsed.region : c.string(o.region);
    if (!/^(?:[a-z]{2,3}|[a-z]{5,8})$/i.test(language)) throw new RangeError('Invalid language');
    if (script !== undefined && !/^[a-z]{4}$/i.test(script)) throw new RangeError('Invalid script');
    if (region !== undefined && !/^(?:[a-z]{2}|\d{3})$/i.test(region)) throw new RangeError('Invalid region');
    const variants = parsed.baseName.split('-').slice(1).filter(p => p !== parsed.script && p !== parsed.region);
    const extension = canonical.slice(parsed.baseName.length);
    canonical = c.canonical([language, script, region, ...variants].filter(x => x !== undefined).join('-') + extension);
    for (const [name, key] of [['calendar', 'ca'], ['collation', 'co'], ['numberingSystem', 'nu']]) { const value = c.unicodeType(o[name], name); if (value !== undefined) canonical = c.extension(canonical, key, value); }
    for (const [name, key, allowed] of [['hourCycle', 'hc', ['h11', 'h12', 'h23', 'h24']], ['caseFirst', 'kf', ['upper', 'lower', 'false']]]) { const value = c.option(o, name, allowed, undefined); if (value !== undefined) canonical = c.extension(canonical, key, value); }
    if (o.numeric !== undefined) canonical = c.extension(canonical, 'kn', Boolean(o.numeric) ? 'true' : 'false');
    let firstDay = o.firstDayOfWeek;
    if (firstDay !== undefined) {
      firstDay = c.string(firstDay);
      if (/^[0-7]$/.test(firstDay)) firstDay = weekDays[(Number(firstDay) + 6) % 7];
      canonical = c.extension(canonical, 'fw', c.unicodeType(firstDay, 'firstDayOfWeek'));
    }
    localeSlots.set(this, parse(canonical));
    c.localeInstances.add(this);
  }
  toString() { return get(this).tag; }
  maximize() { return new Locale(c.native(2, [get(this).tag])); }
  minimize() { return new Locale(c.native(3, [get(this).tag])); }
  getCalendars() { const s = get(this); return s.calendar ? [s.calendar] : c.native(8, ['calendars', s.tag]).map(calendarName); }
  getCollations() { const s = get(this); return s.collation ? [s.collation] : c.native(8, ['collations', s.tag]).filter(x => x !== 'standard' && x !== 'search').map(collationName); }
  getHourCycles() { const s = get(this); return [s.hourCycle || c.native(8, ['hourCycle', s.tag])]; }
  getNumberingSystems() { const s = get(this); return [s.numberingSystem || c.native(8, ['numberingSystem', s.tag])]; }
  getTextInfo() { return { direction: c.native(8, ['direction', get(this).tag]) }; }
  getTimeZones() { const s = get(this); return s.region === undefined ? undefined : c.native(8, ['timeZones', s.region]).sort(); }
  getWeekInfo() {
    const s = get(this), data = c.native(8, ['weekInfo', s.tag]), day = n => n === 1 ? 7 : n - 1;
    return { firstDay: weekDays.indexOf(s.firstDayOfWeek) + 1 || day(data[0]), weekend: data.slice(1).map(day).sort((a, b) => a - b) };
  }
}
for (const key of ['baseName', 'language', 'script', 'region', 'calendar', 'collation', 'firstDayOfWeek', 'hourCycle', 'caseFirst', 'numeric', 'numberingSystem']) Object.defineProperty(Locale.prototype, key, { configurable: true, get() { return get(this)[key]; } });
for (const [key, method] of [['calendars', 'getCalendars'], ['collations', 'getCollations'], ['hourCycles', 'getHourCycles'], ['numberingSystems', 'getNumberingSystems'], ['textInfo', 'getTextInfo'], ['timeZones', 'getTimeZones'], ['weekInfo', 'getWeekInfo']]) {
  const read = Locale.prototype[method];
  Object.defineProperty(Locale.prototype, key, { configurable: true, get() { return read.call(this); } });
}
Object.defineProperty(Locale.prototype, Symbol.toStringTag, { value: 'Intl.Locale', configurable: true });
function supportedValuesOf(key) {
  key = c.string(key);
  if (key === 'unit') return Object.keys(units).sort();
  if (!['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone'].includes(key)) throw new RangeError(`Invalid supportedValuesOf key: ${key}`);
  let values = c.native(6, [key]);
  if (key === 'calendar') values = values.map(calendarName);
  if (key === 'collation') values = values.filter(v => v !== 'standard' && v !== 'search').map(collationName);
  if (key === 'numberingSystem') values = values.filter(v => c.native(8, ['numberingSystemValid', v]));
  return [...new Set(values)].sort();
}
module.exports = { Locale, supportedValuesOf, calendarName, collationName };
