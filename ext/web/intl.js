'use strict';
const common = require('internal/web/intl/common');
const { NumberFormat, PluralRules } = require('internal/web/intl/number');
const { DateTimeFormat } = require('internal/web/intl/datetime');
const { Collator, RelativeTimeFormat, ListFormat, DisplayNames, Segmenter } = require('internal/web/intl/text');
const { Locale, supportedValuesOf } = require('internal/web/intl/locale');
const Intl = {};
for (const [name, value] of Object.entries({ getCanonicalLocales: common.getCanonicalLocales, supportedValuesOf, Collator, DateTimeFormat, NumberFormat, PluralRules, RelativeTimeFormat, ListFormat, DisplayNames, Locale, Segmenter })) {
  Object.defineProperty(Intl, name, { value, writable: true, configurable: true });
  if (value.prototype && name !== 'getCanonicalLocales' && name !== 'supportedValuesOf') {
    Object.defineProperty(value, 'length', { value: name === 'Locale' ? 1 : 0, configurable: true });
    for (const key of Object.getOwnPropertyNames(value.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(value.prototype, key);
      if (descriptor.enumerable) Object.defineProperty(value.prototype, key, { ...descriptor, enumerable: false });
    }
  }
}
Object.defineProperty(common.supportedLocalesOf, 'length', { value: 1, configurable: true });
Object.defineProperty(Intl, Symbol.toStringTag, { value: 'Intl', configurable: true });
function installIntl(target = globalThis) {
  common.native(0, [Intl]);
  const define = (object, name, value) => Object.defineProperty(object, name, { value, writable: true, configurable: true });
  define(target, 'Intl', Intl);
  const numberValue = target.Number.prototype.valueOf;
  define(target.Number.prototype, 'toLocaleString', function toLocaleString(locales, options) { const value = numberValue.call(this); return new NumberFormat(locales, options).format(value); });
  if (target.BigInt) {
    const bigintValue = target.BigInt.prototype.valueOf;
    define(target.BigInt.prototype, 'toLocaleString', function toLocaleString(locales, options) { const value = bigintValue.call(this); return new NumberFormat(locales, options).format(value); });
  }
  define(target.String.prototype, 'localeCompare', function localeCompare(other, locales, options) { if (this === null || this === undefined) throw new TypeError('String receiver is null or undefined'); const a = common.string(this), b = common.string(other); return new Collator(locales, options).compare(a, b); });
  const dateValue = target.Date.prototype.getTime;
  function dateOptions(value, kind) {
    const input = common.options(value), options = Object.create(input);
    if (kind === 'date' && input.timeStyle !== undefined) throw new TypeError('timeStyle is not valid for toLocaleDateString');
    if (kind === 'time' && input.dateStyle !== undefined) throw new TypeError('dateStyle is not valid for toLocaleTimeString');
    const date = ['weekday', 'year', 'month', 'day'], time = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'];
    const keys = kind === 'date' ? date : kind === 'time' ? time : date.concat(time);
    if (input.dateStyle === undefined && input.timeStyle === undefined && !keys.some(key => input[key] !== undefined)) {
      if (kind !== 'time') for (const key of ['year', 'month', 'day']) Object.defineProperty(options, key, { value: 'numeric', enumerable: true, configurable: true });
      if (kind !== 'date') for (const key of ['hour', 'minute', 'second']) Object.defineProperty(options, key, { value: 'numeric', enumerable: true, configurable: true });
    }
    return options;
  }
  for (const [name, kind] of [['toLocaleString', 'all'], ['toLocaleDateString', 'date'], ['toLocaleTimeString', 'time']]) {
    const method = function (locales, options) { const value = dateValue.call(this); if (Number.isNaN(value)) return 'Invalid Date'; return new DateTimeFormat(locales, dateOptions(options, kind)).format(value); };
    Object.defineProperty(method, 'name', { value: name, configurable: true });
    Object.defineProperty(method, 'length', { value: 0, configurable: true });
    define(target.Date.prototype, name, method);
  }
  Object.defineProperty(target.Number.prototype.toLocaleString, 'length', { value: 0, configurable: true });
  if (target.BigInt) Object.defineProperty(target.BigInt.prototype.toLocaleString, 'length', { value: 0, configurable: true });
  Object.defineProperty(target.String.prototype.localeCompare, 'length', { value: 1, configurable: true });
  return Intl;
}
module.exports = { Intl };
// Bootstrap/VM setup call this explicitly; it is not another web-global export.
Object.defineProperty(module.exports, 'installIntl', { value: installIntl });
