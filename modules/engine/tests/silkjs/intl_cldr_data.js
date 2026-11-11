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

// Non-Gregorian calendars from CLDR: names, patterns, skeletons, numbering overrides and the
// default calendar of each region. Expected values match Node 24.
const day = new Date(Date.UTC(2026, 2, 20, 13, 5));
assert(new Intl.DateTimeFormat("th", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "20 มีนาคม 2569", "th {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("fa", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "۲۹ اسفند ۱۴۰۴", "fa {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("en-u-ca-japanese", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "March 20, 8 Reiwa", "en-u-ca-japanese {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("ja-u-ca-japanese", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "令和8年3月20日", "ja-u-ca-japanese {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("he-u-ca-hebrew", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "ב׳ בניסן תשפ״ו", "he-u-ca-hebrew {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("en-u-ca-hebrew", { ...{"year": "numeric", "month": "short", "day": "numeric"}, timeZone: 'UTC' }).format(day), "2 Nisan 5786", "en-u-ca-hebrew {\"year\": \"numeric\", \"month\": \"short\", \"day\": \"numeric\"}");
assert(new Intl.DateTimeFormat("en-u-ca-islamic-civil", { ...{"dateStyle": "full"}, timeZone: 'UTC' }).format(day), "Friday, Shawwal 1, 1447 AH", "en-u-ca-islamic-civil {\"dateStyle\": \"full\"}");
assert(new Intl.DateTimeFormat("en-u-ca-coptic", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "Baramhat 11, 1742 AM", "en-u-ca-coptic {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("en-u-ca-roc", { ...{"year": "numeric", "month": "long"}, timeZone: 'UTC' }).format(day), "March 115 Minguo", "en-u-ca-roc {\"year\": \"numeric\", \"month\": \"long\"}");
assert(new Intl.DateTimeFormat("en-u-ca-chinese", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "Second Month 2, 2026(bing-wu)", "en-u-ca-chinese {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("zh-u-ca-chinese", { ...{"dateStyle": "long"}, timeZone: 'UTC' }).format(day), "2026丙午年二月初二", "zh-u-ca-chinese {\"dateStyle\": \"long\"}");
assert(new Intl.DateTimeFormat("ko-u-ca-dangi", { ...{"dateStyle": "medium"}, timeZone: 'UTC' }).format(day), "43. 2. 2.", "ko-u-ca-dangi {\"dateStyle\": \"medium\"}");
assert(new Intl.DateTimeFormat("en-u-ca-chinese", { ...{"era": "long", "year": "numeric", "month": "numeric", "day": "numeric"}, timeZone: 'UTC' }).format(day), "Mo2 2, 2026", "en-u-ca-chinese {\"era\": \"long\", \"year\": \"numeric\", \"month\": \"numeric\", \"day\": \"numeric\"}");
assert(new Intl.DateTimeFormat("en-u-ca-buddhist", { ...{"year": "numeric"}, timeZone: 'UTC' }).format(day), "2569 BE", "en-u-ca-buddhist {\"year\": \"numeric\"}");
assert(["th", "fa", "ps", "en", "ar-SA"].map((locale) => new Intl.DateTimeFormat(locale).resolvedOptions().calendar), ["buddhist", "persian", "persian", "gregory", "gregory"], 'default calendars');

// Flexible day periods from CLDR rules and names. Expected values match Node 24.
assert(new Intl.DateTimeFormat("en", { ...{"hour": "numeric", "dayPeriod": "long"}, timeZone: 'UTC' }).format(new Date('2026-03-20T03:00Z')), "3 in the morning", "en 03:00 {\"hour\": \"numeric\", \"dayPeriod\": \"long\"}");
assert(new Intl.DateTimeFormat("en", { ...{"hour": "numeric", "dayPeriod": "short"}, timeZone: 'UTC' }).format(new Date('2026-03-20T12:30Z')), "12 noon", "en 12:30 {\"hour\": \"numeric\", \"dayPeriod\": \"short\"}");
assert(new Intl.DateTimeFormat("en", { ...{"hour": "numeric", "minute": "numeric", "dayPeriod": "short"}, timeZone: 'UTC' }).format(new Date('2026-03-20T12:30Z')), "12:30 in the afternoon", "en 12:30 {\"hour\": \"numeric\", \"minute\": \"numeric\", \"dayPeriod\": \"short\"}");
assert(new Intl.DateTimeFormat("zh-Hant", { ...{"timeStyle": "short"}, timeZone: 'UTC' }).format(new Date('2026-03-20T13:05Z')), "下午1:05", "zh-Hant 13:05 {\"timeStyle\": \"short\"}");
assert(new Intl.DateTimeFormat("zh", { ...{"hour": "numeric", "dayPeriod": "short"}, timeZone: 'UTC' }).format(new Date('2026-03-20T06:00Z')), "6时", "zh 06:00 {\"hour\": \"numeric\", \"dayPeriod\": \"short\"}");
assert(new Intl.DateTimeFormat("ko", { ...{"hour": "numeric", "dayPeriod": "short"}, timeZone: 'UTC' }).format(new Date('2026-03-20T03:00Z')), "아침 3시", "ko 03:00 {\"hour\": \"numeric\", \"dayPeriod\": \"short\"}");
assert(new Intl.DateTimeFormat("es-CO", { ...{"dayPeriod": "narrow"}, timeZone: 'UTC' }).format(new Date('2026-03-20T12:00Z')), "m.", "es-CO 12:00 {\"dayPeriod\": \"narrow\"}");
assert(new Intl.DateTimeFormat("ja", { ...{"dayPeriod": "long"}, timeZone: 'UTC' }).format(new Date('2026-03-20T22:00Z')), "夜", "ja 22:00 {\"dayPeriod\": \"long\"}");

// Time zone names from CLDR: specific, generic, location and localized GMT forms, as ICU picks
// them. Expected values match Node 24.
const zoneName = (locale, timeZone, kind, when) => new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: kind }).formatToParts(new Date(when)).find((part) => part.type === "timeZoneName").value;
assert(zoneName("en", "America/New_York", "short", "2024-01-15T12:00Z"), "EST", "en America/New_York short 2024-01-15T12:00Z");
assert(zoneName("en", "America/New_York", "long", "2024-07-15T12:00Z"), "Eastern Daylight Time", "en America/New_York long 2024-07-15T12:00Z");
assert(zoneName("en", "America/New_York", "shortGeneric", "2024-07-15T12:00Z"), "ET", "en America/New_York shortGeneric 2024-07-15T12:00Z");
assert(zoneName("en-GB", "America/New_York", "shortGeneric", "2024-07-15T12:00Z"), "New York Time", "en-GB America/New_York shortGeneric 2024-07-15T12:00Z");
assert(zoneName("en", "Europe/Berlin", "shortGeneric", "2024-01-15T12:00Z"), "Germany Time", "en Europe/Berlin shortGeneric 2024-01-15T12:00Z");
assert(zoneName("de", "Europe/Berlin", "short", "2024-07-15T12:00Z"), "MESZ", "de Europe/Berlin short 2024-07-15T12:00Z");
assert(zoneName("en", "America/Sao_Paulo", "longGeneric", "2024-01-15T12:00Z"), "Brasilia Standard Time", "en America/Sao_Paulo longGeneric 2024-01-15T12:00Z");
assert(zoneName("en", "America/Phoenix", "longGeneric", "2024-07-15T12:00Z"), "Mountain Standard Time", "en America/Phoenix longGeneric 2024-07-15T12:00Z");
assert(zoneName("en", "Asia/Kolkata", "shortOffset", "2024-01-15T12:00Z"), "GMT+5:30", "en Asia/Kolkata shortOffset 2024-01-15T12:00Z");
assert(zoneName("sv", "America/New_York", "longOffset", "2024-01-15T12:00Z"), "GMT−05:00", "sv America/New_York longOffset 2024-01-15T12:00Z");
assert(zoneName("fa", "Asia/Tehran", "shortOffset", "2024-01-15T12:00Z"), "‎+۳:۳۰ گرینویچ", "fa Asia/Tehran shortOffset 2024-01-15T12:00Z");
assert(zoneName("fi", "Asia/Kathmandu", "longOffset", "2024-01-15T12:00Z"), "UTC+05.45", "fi Asia/Kathmandu longOffset 2024-01-15T12:00Z");
assert(zoneName("he", "UTC", "shortOffset", "2024-01-15T12:00Z"), "GMT‎+0‎", "he UTC shortOffset 2024-01-15T12:00Z");
assert(zoneName("fr", "UTC", "short", "2024-01-15T12:00Z"), "UTC", "fr UTC short 2024-01-15T12:00Z");
assert(zoneName("en", "Europe/Dublin", "long", "2024-01-15T12:00Z"), "Greenwich Mean Time", "en Europe/Dublin long 2024-01-15T12:00Z");
assert(zoneName("en", "Europe/Dublin", "long", "2024-07-15T12:00Z"), "Irish Standard Time", "en Europe/Dublin long 2024-07-15T12:00Z");
assert(zoneName("en", "America/Chihuahua", "long", "2024-07-15T12:00Z"), "Central Standard Time", "en America/Chihuahua long 2024-07-15T12:00Z");
assert(zoneName("pt-PT", "Africa/Algiers", "shortGeneric", "2024-07-15T12:00Z"), "CET (Argel)", "pt-PT Africa/Algiers shortGeneric 2024-07-15T12:00Z");
assert(zoneName("en", "America/New_York", "long", "1960-07-01T12:00Z"), "GMT-04:00", "en America/New_York long 1960-07-01T12:00Z");
assert(zoneName("ja", "America/Los_Angeles", "longGeneric", "2024-07-15T12:00Z"), "米国太平洋時間", "ja America/Los_Angeles longGeneric 2024-07-15T12:00Z");
assert(zoneName("en", "+00:00", "long", "2024-07-15T12:00Z"), "Greenwich Mean Time", "en +00:00 long 2024-07-15T12:00Z");
assert(zoneName("en", "Etc/GMT", "long", "2024-07-15T12:00Z"), "Coordinated Universal Time", "en Etc/GMT long 2024-07-15T12:00Z");
assert(zoneName("en", "Etc/GMT+5", "long", "2024-07-15T12:00Z"), "GMT-05:00", "en Etc/GMT+5 long 2024-07-15T12:00Z");
assert(zoneName("en", "America/Anguilla", "shortGeneric", "2024-07-15T12:00Z"), "AST", "en America/Anguilla shortGeneric 2024-07-15T12:00Z");
assert(zoneName("en", "Antarctica/Troll", "longGeneric", "2024-07-15T12:00Z"), "Troll Station Time", "en Antarctica/Troll longGeneric 2024-07-15T12:00Z");
assert(new Intl.DateTimeFormat("de", {"timeZone":"UTC","timeZoneName":"short"}).format(new Date("2024-07-15T12:00Z")), "15.7.2024, UTC", "de {\"timeZone\":\"UTC\",\"timeZoneName\":\"short\"}");
assert(new Intl.DateTimeFormat("en", {"timeZone":"America/New_York","dateStyle":"full","timeStyle":"full"}).format(new Date("2024-07-15T12:00Z")), "Monday, July 15, 2024 at 8:00:00 AM Eastern Daylight Time", "en {\"timeZone\":\"America/New_York\",\"dateStyle\":\"full\",\"timeStyle\":\"full\"}");
assert(new Intl.DateTimeFormat("en", {"timeZone":"America/New_York","hour":"numeric","timeZoneName":"shortGeneric"}).format(new Date("2024-07-15T12:00Z")), "8 AM ET", "en {\"timeZone\":\"America/New_York\",\"hour\":\"numeric\",\"timeZoneName\":\"shortGeneric\"}");
