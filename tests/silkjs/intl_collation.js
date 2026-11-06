// flags: --experimental
// Intl.Collator with the CLDR root collation and locale tailorings: Swedish and Finnish
// letters after z, Czech ch, German phonebook, Spanish traditional, Danish aa, French
// Canadian backwards accents, Turkish dotless i, Chinese pinyin, stroke and zhuyin, the
// Japanese and Korean orders, search usage and per-locale defaults. Expected values come
// from Node 24 (ICU 77), except that an explicit collation which is also the locale's
// default (zh-u-co-pinyin) resolves to its name, as test262 expects, not to "default".
function assert(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}
const sorted = (locale, options, words) => [...words].sort(new Intl.Collator(locale, options).compare);
assert(sorted("sv", {}, ["z", "ä", "a", "å", "ö", "o", "Ø", "w", "v"]), ["a", "o", "v", "w", "z", "å", "ä", "ö", "Ø"], "sv {}");
assert(sorted("sv-u-co-trad", {}, ["w", "v", "Wa", "Va", "ü", "y"]), ["v", "w", "Va", "Wa", "y", "ü"], "sv-u-co-trad {}");
assert(sorted("de", {}, ["z", "ä", "a", "Äpfel", "Apfel", "ö", "o"]), ["a", "ä", "Apfel", "Äpfel", "o", "ö", "z"], "de {}");
assert(sorted("de-u-co-phonebk", {}, ["Äb", "Ae", "Af", "Müller", "Mueller", "Muff"]), ["Ae", "Äb", "Af", "Mueller", "Müller", "Muff"], "de-u-co-phonebk {}");
assert(sorted("cs", {}, ["ch", "c", "d", "h", "č", "i", "Ch"]), ["c", "č", "d", "h", "ch", "Ch", "i"], "cs {}");
assert(sorted("es", {}, ["ñ", "n", "o", "ll", "l", "m"]), ["l", "ll", "m", "n", "ñ", "o"], "es {}");
assert(sorted("es-u-co-trad", {}, ["ll", "l", "m", "ch", "c", "d"]), ["c", "ch", "d", "l", "ll", "m"], "es-u-co-trad {}");
assert(sorted("da", {}, ["aa", "å", "z", "Æ", "ø", "a", "A"]), ["A", "a", "z", "Æ", "ø", "å", "aa"], "da {}");
assert(sorted("fi", {}, ["w", "v", "å", "ä", "ö", "z"]), ["v", "w", "z", "å", "ä", "ö"], "fi {}");
assert(sorted("lt", {}, ["y", "i", "j", "k"]), ["i", "y", "j", "k"], "lt {}");
assert(sorted("pl", {}, ["ł", "l", "m", "ś", "s", "t", "ż", "ź", "z"]), ["l", "ł", "m", "s", "ś", "t", "z", "ź", "ż"], "pl {}");
assert(sorted("tr", {}, ["ı", "i", "I", "İ", "h", "j", "ç", "c", "d"]), ["c", "ç", "d", "h", "ı", "I", "i", "İ", "j"], "tr {}");
assert(sorted("fr-CA", {}, ["cote", "côte", "coté", "côté"]), ["cote", "côte", "coté", "côté"], "fr-CA {}");
assert(sorted("en", {}, ["cote", "côte", "coté", "côté", "b", "B", "a", "A"]), ["a", "A", "b", "B", "cote", "coté", "côte", "côté"], "en {}");
assert(sorted("en", {"caseFirst": "upper"}, ["a", "A", "b", "B", "ab", "Ab"]), ["A", "a", "Ab", "ab", "B", "b"], "en {\"caseFirst\": \"upper\"}");
assert(sorted("en", {"numeric": true}, ["a10", "a2", "a1", "b"]), ["a1", "a2", "a10", "b"], "en {\"numeric\": true}");
assert(sorted("en", {"ignorePunctuation": true}, ["a-c", "ab", "a b", "ac"]), ["ab", "a b", "a-c", "ac"], "en {\"ignorePunctuation\": true}");
assert(sorted("ru", {}, ["ё", "е", "ж", "a", "я"]), ["е", "ё", "ж", "я", "a"], "ru {}");
assert(sorted("ja", {}, ["か", "カ", "が", "あ", "亜", "ア", "ｱ", "一"]), ["あ", "ア", "ｱ", "か", "カ", "が", "亜", "一"], "ja {}");
assert(sorted("ko", {}, ["나", "가", "다", "한", "韓", "가나"]), ["가", "가나", "나", "다", "한", "韓"], "ko {}");
assert(sorted("zh", {}, ["中", "国", "人", "一", "大", "阿"]), ["阿", "大", "国", "人", "一", "中"], "zh {}");
assert(sorted("zh-Hant", {}, ["中", "国", "人", "一", "大", "阿"]), ["一", "人", "大", "中", "国", "阿"], "zh-Hant {}");
assert(sorted("zh-u-co-zhuyin", {}, ["中", "国", "人", "一", "大", "阿"]), ["大", "国", "中", "人", "阿", "一"], "zh-u-co-zhuyin {}");
assert(sorted("zh-u-co-unihan", {}, ["中", "国", "人", "一", "大", "阿"]), ["一", "中", "人", "国", "大", "阿"], "zh-u-co-unihan {}");
assert(sorted("th", {}, ["ก", "ข", "เก", "กา", "ก-"]), ["ก", "ก-", "กา", "เก", "ข"], "th {}");
assert(sorted("ar", {}, ["ب", "ا", "ت", "a"]), ["ا", "ب", "ت", "a"], "ar {}");
assert(sorted("en-u-co-emoji", {}, ["😀", "😃", "👍", "🐶", "a"]), ["😀", "😃", "👍", "🐶", "a"], "en-u-co-emoji {}");
assert(new Intl.Collator("sv").resolvedOptions(), {"locale": "sv", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "default", "numeric": false, "caseFirst": "false"}, "sv resolvedOptions");
assert(new Intl.Collator("da").resolvedOptions(), {"locale": "da", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "default", "numeric": false, "caseFirst": "upper"}, "da resolvedOptions");
assert(new Intl.Collator("th").resolvedOptions(), {"locale": "th", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": true, "collation": "default", "numeric": false, "caseFirst": "false"}, "th resolvedOptions");
assert(new Intl.Collator("de-u-co-phonebk").resolvedOptions(), {"locale": "de-u-co-phonebk", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "phonebk", "numeric": false, "caseFirst": "false"}, "de-u-co-phonebk resolvedOptions");
assert(new Intl.Collator("zh-u-co-pinyin").resolvedOptions(), {"locale": "zh-u-co-pinyin", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "pinyin", "numeric": false, "caseFirst": "false"}, "zh-u-co-pinyin resolvedOptions");
assert(new Intl.Collator("zh-Hant-u-co-stroke").resolvedOptions(), {"locale": "zh-Hant-u-co-stroke", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "stroke", "numeric": false, "caseFirst": "false"}, "zh-Hant-u-co-stroke resolvedOptions");
assert(new Intl.Collator("zh-TW-u-co-pinyin").resolvedOptions(), {"locale": "zh-TW-u-co-pinyin", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "pinyin", "numeric": false, "caseFirst": "false"}, "zh-TW-u-co-pinyin resolvedOptions");
assert(new Intl.Collator("es-u-co-trad").resolvedOptions(), {"locale": "es-u-co-trad", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "trad", "numeric": false, "caseFirst": "false"}, "es-u-co-trad resolvedOptions");
assert(new Intl.Collator("en-u-kn-kf-upper").resolvedOptions(), {"locale": "en-u-kf-upper-kn", "usage": "sort", "sensitivity": "variant", "ignorePunctuation": false, "collation": "default", "numeric": true, "caseFirst": "upper"}, "en-u-kn-kf-upper resolvedOptions");
assert(new Intl.Locale("de").getCollations(), ["emoji", "eor", "phonebk"], "de getCollations");
assert(new Intl.Locale("sv").getCollations(), ["emoji", "eor", "trad"], "sv getCollations");
assert(new Intl.Locale("es").getCollations(), ["emoji", "eor", "trad"], "es getCollations");
assert(new Intl.Locale("zh").getCollations(), ["emoji", "eor", "pinyin", "stroke", "unihan", "zhuyin"], "zh getCollations");
assert(new Intl.Locale("ja").getCollations(), ["emoji", "eor", "unihan"], "ja getCollations");
assert(new Intl.Locale("ko").getCollations(), ["emoji", "eor", "searchjl", "unihan"], "ko getCollations");
assert(new Intl.Locale("en").getCollations(), ["emoji", "eor"], "en getCollations");
assert(new Intl.Locale("ar").getCollations(), ["compat", "emoji", "eor"], "ar getCollations");
assert(new Intl.Locale("si").getCollations(), ["dict", "emoji", "eor"], "si getCollations");
assert(new Intl.Locale("ln").getCollations(), ["emoji", "eor", "phonetic"], "ln getCollations");
assert(new Intl.Collator("da", { usage: 'search', sensitivity: 'base' }).compare("aa", "å"), 0, "da search");
assert(new Intl.Collator("de", { usage: 'search', sensitivity: 'base' }).compare("ä", "a"), 1, "de search");
assert(new Intl.Collator("sv", { usage: 'search', sensitivity: 'base' }).compare("ä", "æ"), 0, "sv search");
assert('ä'.localeCompare('z', 'sv'), 1, 'localeCompare sv');
assert('ä'.localeCompare('z', 'de'), -1, 'localeCompare de');
// Strings past Latin-1 on the fast pass (Czech ch, Uzbek oʻ next to a euro sign), Norwegian
// for nb and nn, Japanese contexts after voiced kana, keycap emoji, and one bound compare.
assert(sorted("cs", {}, ["Chž", "chč", "ch€", "cič", "cž", "c€", "hč", "h€", "č€"]), ["c€", "cič", "cž", "č€", "h€", "hč", "ch€", "chč", "Chž"], "cs {} c€");
assert(sorted("uz", {}, ["gʻ€", "g€", "h€", "o'€", "oʻ€", "o‘€", "o€", "z€"]), ["g€", "h€", "o€", "z€", "o'€", "oʻ€", "o‘€", "gʻ€"], "uz {} g€");
assert(sorted("uz", {}, ["g", "gʻ", "h", "o", "o'", "oʻ", "o‘", "z"]), ["g", "h", "o", "z", "o'", "oʻ", "o‘", "gʻ"], "uz {} g");
assert(sorted("nb", {}, ["a", "aa", "z", "Æ", "ä", "å", "ö", "ø"]), ["a", "z", "Æ", "ä", "ø", "ö", "å", "aa"], "nb {} a");
assert(sorted("nn", {}, ["a", "aa", "z", "Æ", "å", "ø"]), ["a", "z", "Æ", "ø", "å", "aa"], "nn {} a");
assert(sorted("ja", {}, ["かあ", "かー", "カア", "カイ", "カー", "ガア", "ガー", "キイ", "キー"]), ["かー", "カー", "かあ", "カア", "ガー", "ガア", "カイ", "キー", "キイ"], "ja {} カー");
assert(sorted("ru", {}, ["Ёж", "еж", "ель", "жук", "иод", "йод", "яр", "ёж"]), ["еж", "ёж", "Ёж", "ель", "жук", "иод", "йод", "яр"], "ru {} еж");
assert(sorted("el", {}, ["Αλφα", "άλφα", "αλφα", "βήτα", "ωμέγα"]), ["αλφα", "Αλφα", "άλφα", "βήτα", "ωμέγα"], "el {} αλφα");
assert(sorted("zh", {}, ["上海", "中国", "中文", "人民", "大家", "日本"]), ["大家", "人民", "日本", "上海", "中国", "中文"], "zh {} 大家");
assert(sorted("ko", {}, ["ㄱ", "가", "가나", "각", "까", "나"]), ["ㄱ", "가", "가나", "각", "까", "나"], "ko {} ㄱ");
assert(sorted("en", {"sensitivity": "base"}, ["Resume", "resume", "resume€", "rèsumé€", "résumé"]), ["Resume", "resume", "résumé", "resume€", "rèsumé€"], "en {\"sensitivity\": \"base\"} résumé");
assert(sorted("de", {}, ["ae", "az", "áb", "ä", "b", "ä"]), ["ä", "ä", "áb", "ae", "az", "b"], "de {} ä");
assert(sorted("en", {"collation": "emoji"}, ["#", "#⃣", "#️⃣", "a", "😀"]), ["#", "😀", "#⃣", "#️⃣", "a"], "en {\"collation\": \"emoji\"} #");
const bound = new Intl.Collator("en");
assert(bound.compare === bound.compare, true, "compare is bound once");
assert(["b", "a", "c"].sort(bound.compare), ["a", "b", "c"], "bound compare sorts");
assert('ガー'.localeCompare('カー', 'ja', { sensitivity: 'base' }), 0, 'ja long vowel after voiced kana');
let thrown = false;
try { ["b", { toString() { throw new Error("boom"); } }].sort(bound.compare); } catch (e) { thrown = e.message === "boom"; }
assert(thrown, true, 'sort with a Collator compare converts non-strings');
