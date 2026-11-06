// flags: --experimental
// Intl data generated from CLDR and IANA: plural rules for every locale, list patterns,
// numeric collation and the full time zone database. Expected values match Node 22
// except where ECMA-402 now differs from ICU: pluralCategories order and time zone links,
// which keep their case-normalized name.
function assert(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}
const numbers = [0, 1, 2, 3, 5, 11, 21, 22, 100, 1.5];
const cardinal = (locale) => numbers.map((n) => new Intl.PluralRules(locale).select(n));
assert(cardinal('en'), ['other', 'one', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other'], 'en cardinal');
assert(cardinal('ru'), ['many', 'one', 'few', 'few', 'many', 'many', 'one', 'few', 'many', 'other'], 'ru cardinal');
assert(cardinal('ar'), ['zero', 'one', 'two', 'few', 'few', 'many', 'many', 'many', 'other', 'other'], 'ar cardinal');
assert(cardinal('cy'), ['zero', 'one', 'two', 'few', 'other', 'other', 'other', 'other', 'other', 'other'], 'cy cardinal');
assert(cardinal('he'), ['other', 'one', 'two', 'other', 'other', 'other', 'other', 'other', 'other', 'other'], 'he cardinal');
assert(cardinal('pt-PT'), ['other', 'one', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other'], 'pt-PT cardinal');
const ordinal = (locale) => [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map((n) => new Intl.PluralRules(locale, { type: 'ordinal' }).select(n));
assert(ordinal('en'), ['one', 'two', 'few', 'other', 'other', 'other', 'other', 'one', 'two', 'few', 'one'], 'en ordinal');
assert(ordinal('sv'), ['one', 'one', 'other', 'other', 'other', 'other', 'other', 'one', 'one', 'other', 'one'], 'sv ordinal');
assert(new Intl.PluralRules('en', { minimumFractionDigits: 1 }).select(1), 'other', 'visible fraction digits');
assert(new Intl.PluralRules('fr', { notation: 'compact' }).select(1000000), 'many', 'compact exponent');
assert(new Intl.PluralRules('fr').selectRange(0, 1), 'one', 'fr range');
assert(new Intl.PluralRules('ru').resolvedOptions().pluralCategories, ['one', 'few', 'many', 'other'], 'category order');

const list = (locale, options, items) => new Intl.ListFormat(locale, options).format(items);
assert(list('en', {}, ['a', 'b', 'c']), 'a, b, and c', 'en list');
assert(list('de', {}, ['a', 'b', 'c']), 'a, b und c', 'de list');
assert(list('ja', {}, ['a', 'b', 'c']), 'a、b、c', 'ja list');
assert(list('ar', {}, ['a', 'b', 'c']), 'a وb وc', 'ar list');
assert(list('es', { type: 'disjunction' }, ['a', 'b']), 'a o b', 'es disjunction');
assert(list('hi', { type: 'unit', style: 'narrow' }, ['a', 'b', 'c', 'd']), 'a, b, c d', 'hi narrow unit');
assert(new Intl.ListFormat('en').formatToParts(['x', 'y', 'z']).map((part) => part.value), ['x', ', ', 'y', ', and ', 'z'], 'list parts');

assert(['a10', 'a2', 'a1'].sort(new Intl.Collator('en', { numeric: true }).compare), ['a1', 'a2', 'a10'], 'numeric collation');

const zone = (timeZone) => new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
assert(zone('america/new_york'), 'America/New_York', 'case-normalized zone');
assert(zone('utc'), 'UTC', 'UTC');
assert(zone('etc/gmt'), 'Etc/GMT', 'links keep their name');
assert(zone('+0530'), '+05:30', 'offset zone');
let threw = false;
try { zone('Foo/Bar'); } catch (error) { threw = error instanceof RangeError; }
assert(threw, true, 'unknown zone');
const hour = (timeZone, date) => new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date);
const summer = new Date(Date.UTC(2026, 6, 4, 12));
assert([hour('America/Chicago', summer), hour('Australia/Sydney', summer), hour('Asia/Kathmandu', summer), hour('Pacific/Chatham', summer)], ['07', '22', '17', '00'], 'IANA offsets');
assert(hour('America/Chicago', new Date(Date.UTC(2030, 0, 15, 0))), '18', 'rule-derived transitions');
