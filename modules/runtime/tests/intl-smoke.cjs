'use strict';
// Intl contracts the runtime relies on, run under TZ=UTC with an en-US default locale.
// Each case is compared with Node 24 (ICU); run with both executables and diff the output.
const results = [];
function check(name, run) {
  let value;
  try { value = run(); } catch (error) { value = `${error.constructor.name}: ${error.message}`; }
  results.push([name, value]);
}
const date = new Date(Date.UTC(2024, 0, 15, 13, 5, 9, 45));

check('global descriptor', () => {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'Intl');
  return [d.writable, d.enumerable, d.configurable, Object.prototype.toString.call(Intl)];
});
check('constructors', () => ['Collator', 'DateTimeFormat', 'DisplayNames', 'DurationFormat', 'ListFormat', 'Locale',
  'NumberFormat', 'PluralRules', 'RelativeTimeFormat', 'Segmenter'].map(name => typeof Intl[name]));
check('getCanonicalLocales', () => Intl.getCanonicalLocales(['EN-us', 'zh-hant-tw', 'pt-BR']));
check('supportedLocalesOf', () => Intl.NumberFormat.supportedLocalesOf(['en-US', 'de', 'ja-JP']));
check('invalid tag', () => Intl.getCanonicalLocales('en_US'));

check('number en-US', () => new Intl.NumberFormat('en-US').format(1234567.891));
check('number de-DE', () => new Intl.NumberFormat('de-DE').format(1234567.891));
check('number fr-FR', () => new Intl.NumberFormat('fr-FR').format(1234567.891));
check('number en-IN', () => new Intl.NumberFormat('en-IN').format(1234567.891));
check('currency', () => [
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(-1234.5),
  new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(1234.5),
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5),
]);
check('percent', () => new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(0.1234));
check('compact', () => [1234, 1234567, 1.5e9].map(n => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(n)));
check('unit', () => new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer-per-hour', unitDisplay: 'long' }).format(50));
check('significant', () => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(123456));
check('formatToParts', () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).formatToParts(1234.5).map(p => p.type + ':' + p.value));
check('bigint format', () => new Intl.NumberFormat('en-US').format(12345678901234567890n));
check('formatRange', () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).formatRange(3, 5));
check('number resolvedOptions', () => {
  const o = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).resolvedOptions();
  return [o.locale, o.numberingSystem, o.style, o.currency, o.minimumFractionDigits, o.maximumFractionDigits];
});
check('toLocaleString number', () => [(1234.5).toLocaleString(), (1234.5).toLocaleString('de-DE'), 12345n.toLocaleString('en-US')]);

check('date default', () => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(date));
check('date styles', () => [
  new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(date),
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(date),
  new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'UTC' }).format(date),
  new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(date),
]);
check('date components', () => new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date));
check('date time zone', () => [
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', timeZoneName: 'short' }).format(date),
  new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', timeZoneName: 'short' }).format(date),
]);
check('date formatToParts', () => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }).formatToParts(date).map(p => p.type + ':' + p.value));
check('date formatRange', () => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(date, new Date(date.getTime() + 3 * 864e5)));
check('date resolvedOptions', () => {
  const o = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions();
  return [o.locale, o.calendar, o.numberingSystem, o.timeZone];
});
check('date toLocale*', () => [date.toLocaleDateString('en-US', { timeZone: 'UTC' }), date.toLocaleTimeString('en-US', { timeZone: 'UTC' }), date.toLocaleString('en-US', { timeZone: 'UTC' })]);
check('invalid date', () => new Date(NaN).toLocaleString());
check('bad time zone', () => new Intl.DateTimeFormat('en-US', { timeZone: 'Mars/Base' }));

check('collator', () => ['b', 'a', 'B', 'ä', 'z'].sort(new Intl.Collator('en').compare));
check('collator de', () => ['z', 'ä', 'a'].sort(new Intl.Collator('de').compare));
check('collator sv', () => ['z', 'ä', 'a'].sort(new Intl.Collator('sv').compare));
check('collator numeric', () => ['10', '9', '1'].sort(new Intl.Collator('en', { numeric: true }).compare));
check('collator base', () => new Intl.Collator('en', { sensitivity: 'base' }).compare('a', 'A'));
check('localeCompare', () => ['a'.localeCompare('b'), 'a'.localeCompare('a'), 'résumé'.localeCompare('resume', 'en', { sensitivity: 'base' })]);

check('plural', () => [0, 1, 2, 5].map(n => new Intl.PluralRules('en-US').select(n)));
check('plural ordinal', () => [1, 2, 3, 4, 11, 21].map(n => new Intl.PluralRules('en-US', { type: 'ordinal' }).select(n)));
check('plural ru', () => [1, 2, 5, 21].map(n => new Intl.PluralRules('ru').select(n)));
check('relative', () => [
  new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'),
  new Intl.RelativeTimeFormat('en').format(3, 'week'),
  new Intl.RelativeTimeFormat('es').format(-2, 'hour'),
]);
check('list', () => [
  new Intl.ListFormat('en', { type: 'conjunction' }).format(['a', 'b', 'c']),
  new Intl.ListFormat('en', { type: 'disjunction' }).format(['a', 'b']),
  new Intl.ListFormat('de').format(['a', 'b', 'c']),
]);
check('display names', () => [
  new Intl.DisplayNames(['en'], { type: 'region' }).of('BR'),
  new Intl.DisplayNames(['en'], { type: 'language' }).of('pt-BR'),
  new Intl.DisplayNames(['en'], { type: 'currency' }).of('JPY'),
]);
check('segmenter graphemes', () => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('é👍🏽a')].map(s => s.segment));
check('segmenter words', () => [...new Intl.Segmenter('en', { granularity: 'word' }).segment('Hello, world! 42')].filter(s => s.isWordLike).map(s => s.segment));
check('locale', () => {
  const l = new Intl.Locale('en-Latn-US', { calendar: 'gregory', hourCycle: 'h12' });
  return [l.toString(), l.language, l.script, l.region, l.baseName, l.maximize().toString(), new Intl.Locale('zh').maximize().toString(), new Intl.Locale('en-Latn-US').minimize().toString()];
});
check('duration', () => new Intl.DurationFormat('en', { style: 'long' }).format({ hours: 1, minutes: 46, seconds: 40 }));
check('supportedValuesOf', () => ['calendar', 'currency', 'unit'].map(key => Intl.supportedValuesOf(key).length > 0));

check('vm realm', () => {
  const vm = require('vm');
  return vm.runInNewContext('[typeof Intl, (1234.5).toLocaleString("de-DE"), new Intl.NumberFormat("en-US").format(1e6), Intl === outer]', { outer: Intl });
});
check('navigator.language', () => typeof navigator.language === 'string' && navigator.language.length > 1);

for (const [name, value] of results) console.log(name + ' = ' + JSON.stringify(value));
