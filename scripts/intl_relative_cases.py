"""Real-engine RelativeTimeFormat contracts and pinned-C differential inputs."""
import itertools
import json


def js(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def wrapped(body):
    return 'JSON.stringify((function(){try{return ["ok",(function(){'+body+'})()]}catch(e){return ["error",e.name]}})())'


def cases():
    result = []

    def add(name, body, expected=None, independent=False, portable=True):
        result.append(('relative/'+name, wrapped(body), ['ok', expected] if independent else None, portable))

    def error(name, body, kind):
        result.append(('relative/'+name, wrapped(body), ['error', kind], True))

    add('default', 'return new Intl.RelativeTimeFormat().resolvedOptions()',
        {'locale': 'en-US', 'style': 'long', 'numeric': 'always', 'numberingSystem': 'latn'}, True)
    add('signed-zero', 'var r=new Intl.RelativeTimeFormat("en");return [r.format(0,"day"),r.format(-0,"days"),r.format(-1,"day"),r.format(1,"day")]',
        ['in 0 days', '0 days ago', '1 day ago', 'in 1 day'], True)
    add('original-plural-before-rounding', 'var r=new Intl.RelativeTimeFormat("en");return [r.format(1.0001,"year"),r.format(0.0001,"year"),r.format(1.9999,"year")]',
        ['in 1 years', 'in 0 years', 'in 2 years'], True)
    add('parts-independent', 'return new Intl.RelativeTimeFormat("en").formatToParts(-12345.625,"years")',
        [{'type': 'integer', 'value': '12', 'unit': 'year'}, {'type': 'group', 'value': ',', 'unit': 'year'},
         {'type': 'integer', 'value': '345', 'unit': 'year'}, {'type': 'decimal', 'value': '.', 'unit': 'year'},
         {'type': 'fraction', 'value': '625', 'unit': 'year'}, {'type': 'literal', 'value': ' years ago'}], True)
    add('auto-part-no-unit', 'var r=new Intl.RelativeTimeFormat("en",{numeric:"auto"});return [r.format(-0,"day"),r.formatToParts(-1,"day"),r.formatToParts(0,"second")]',
        ['today', [{'type': 'literal', 'value': 'yesterday'}], [{'type': 'literal', 'value': 'now'}]], True)
    add('narrow-still-space', 'return new Intl.RelativeTimeFormat("en",{style:"narrow"}).format(2,"seconds")', 'in 2 s', True)
    add('japanese-still-space', 'var r=new Intl.RelativeTimeFormat("ja");return [r.format(2,"day"),r.format(-2,"day")]', ['2 日後', '2 日前'], True)
    add('korean-still-space', 'var r=new Intl.RelativeTimeFormat("ko");return [r.format(2,"year"),r.format(-2,"year")]', ['2 년 후', '2 년 전'], True)
    add('auto-english-fallback-pin', 'return ["zh","ru","pt","ko","it"].map(l=>new Intl.RelativeTimeFormat(l,{numeric:"auto"}).format(-1,"day"))', ['yesterday'] * 5, True)
    add('german-auto-zero-pin', 'var r=new Intl.RelativeTimeFormat("de",{numeric:"auto"});return [r.format(0,"day"),r.format(-1,"day"),r.format(1,"quarter")]', ['in 0 Tagen', 'gestern', 'in 1 Quartal'], True)
    add('french-auto-apostrophe', 'return new Intl.RelativeTimeFormat("fr",{numeric:"auto"}).format(-1,"year")', 'l’année dernière', True)
    add('polish-auto-no-exceptions', 'var r=new Intl.RelativeTimeFormat("pl",{numeric:"auto"});return [-1,0,1,2,5,12,22,1.5].map(n=>r.format(n,"year"))',
        ['1 rok temu', 'za 0 lat', 'za 1 rok', 'za 2 lata', 'za 5 lat', 'za 12 lat', 'za 22 lata', 'za 1,5 roku'], True)
    add('polish-min2', 'var r=new Intl.RelativeTimeFormat("pl");return [r.format(1234,"day"),r.formatToParts(1234,"day")]',
        ['za 1234 dni', [{'type': 'literal', 'value': 'za '}, {'type': 'integer', 'value': '1234', 'unit': 'day'}, {'type': 'literal', 'value': ' dni'}]], True)
    add('numbering-parts-ascii-only-pin', 'var r=new Intl.RelativeTimeFormat("en",{numberingSystem:"arab"});return [r.format(2,"day"),r.formatToParts(2,"day")]',
        ['in ٢ days', [{'type': 'literal', 'value': 'in '}, {'type': 'literal', 'value': ' days'}]], True)
    add('extension-retain', 'return new Intl.RelativeTimeFormat("en-u-ca-gregory-nu-arab").resolvedOptions()',
        {'locale': 'en-u-nu-arab', 'style': 'long', 'numeric': 'always', 'numberingSystem': 'arab'}, True)
    add('extension-override', 'return new Intl.RelativeTimeFormat("en-u-nu-arab",{numberingSystem:"latn"}).resolvedOptions()',
        {'locale': 'en', 'style': 'long', 'numeric': 'always', 'numberingSystem': 'latn'}, True)
    add('extension-unknown-option-retain', 'return new Intl.RelativeTimeFormat("en-u-nu-arab",{numberingSystem:"unknown"}).resolvedOptions()',
        {'locale': 'en-u-nu-arab', 'style': 'long', 'numeric': 'always', 'numberingSystem': 'arab'}, True)
    add('option-order', 'var log=[];new Intl.RelativeTimeFormat("en",new Proxy({},{get(t,k){log.push(k)}}));return log',
        ['localeMatcher', 'numberingSystem', 'style', 'numeric'], True)
    add('number-unit-coercion-order', 'var log=[],r=new Intl.RelativeTimeFormat;var s=r.format({valueOf(){log.push("number");return 2}},{toString(){log.push("unit");return "days"}});return [s,log]',
        ['in 2 days', ['number', 'unit']], True)
    add('nonfinite-before-unit', 'var log=[];try{new Intl.RelativeTimeFormat().format(Infinity,{toString(){log.push("unit");throw new TypeError}})}catch(e){return [e.name,log]}', ['RangeError', []], True)
    add('brand-before-coercion', 'var log=[];try{Intl.RelativeTimeFormat.prototype.format.call({},{valueOf(){log.push("number");return 1}},{toString(){log.push("unit");return "day"}})}catch(e){return [e.name,log]}', ['TypeError', []], True)
    add('numberformat-private-root', 'var C=Intl.NumberFormat;try{Intl.NumberFormat=function(){throw new Error};return new Intl.RelativeTimeFormat("en").format(1234.5,"day")}finally{Intl.NumberFormat=C}', 'in 1,234.5 days', True)
    add('numberformat-no-bound-getter', 'var d=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,"format");try{Object.defineProperty(Intl.NumberFormat.prototype,"format",{get(){throw new Error}});return new Intl.RelativeTimeFormat("en").format(2,"day")}finally{Object.defineProperty(Intl.NumberFormat.prototype,"format",d)}', 'in 2 days', True)
    add('numberformat-real-inherited-options', 'var r=new Intl.RelativeTimeFormat("en");Object.defineProperty(Object.prototype,"minimumFractionDigits",{value:2,configurable:true});try{return r.format(1,"day")}finally{delete Object.prototype.minimumFractionDigits}', 'in 1.00 day', True)
    add('numbering-options-inherited-setter', 'var r=new Intl.RelativeTimeFormat("en"),log=[];Object.defineProperty(Object.prototype,"numberingSystem",{configurable:true,set(v){log.push(v)}});try{return [r.format(1,"day"),log]}finally{delete Object.prototype.numberingSystem}', ['in 1 day', ['latn']], True)
    add('parts-inherited-setter', 'var r=new Intl.RelativeTimeFormat("en"),log=[];Object.defineProperty(Object.prototype,"unit",{configurable:true,set(v){log.push(v)}});try{return [r.formatToParts(1,"day"),log]}finally{delete Object.prototype.unit}',
        [[{'type': 'literal', 'value': 'in '}, {'type': 'integer', 'value': '1'}, {'type': 'literal', 'value': ' day'}], ['day']], True)
    add('supported-receiver-ignored', 'return Intl.RelativeTimeFormat.supportedLocalesOf.call(null,"en")', ['en'], True)
    add('supported-undefined-ignores-options', 'return Intl.RelativeTimeFormat.supportedLocalesOf(undefined,{get localeMatcher(){throw new Error}})', [], True)
    add('cross-realm-default', 'var r=Reflect.construct(Intl.RelativeTimeFormat,["en"],__foreignTarget);return [Object.getPrototypeOf(r)===__foreignRelativeTimeFormat.prototype,r instanceof __foreignRelativeTimeFormat,r instanceof Intl.RelativeTimeFormat]', [True, True, False], True)
    add('cross-realm-brand', 'return Intl.RelativeTimeFormat.prototype.format.call(new __foreignRelativeTimeFormat("en"),2,"day")', 'in 2 days', True)
    add('subclass', 'class R extends Intl.RelativeTimeFormat{};var r=new R("en");return [r instanceof R,r instanceof Intl.RelativeTimeFormat,r.format(1,"day")]', [True, True, 'in 1 day'], True)
    add('descriptors', 'function d(o,k){var x=Object.getOwnPropertyDescriptor(o,k);return [x.writable,x.enumerable,x.configurable,typeof x.value,typeof x.get,typeof x.set]}var C=Intl.RelativeTimeFormat;return [C.name,C.length,Object.getOwnPropertyNames(C),Object.getOwnPropertyNames(C.prototype),Object.getOwnPropertySymbols(C.prototype).map(String),d(Intl,"RelativeTimeFormat"),d(C,"prototype"),d(C.prototype,"constructor"),d(C.prototype,Symbol.toStringTag),Object.prototype.toString.call(new C),["format","formatToParts","resolvedOptions"].map(k=>[d(C.prototype,k),C.prototype[k].name,C.prototype[k].length])]')
    add('resolved-own-fields', 'var o=new Intl.RelativeTimeFormat().resolvedOptions();return Object.keys(o).map(k=>[k,Object.getOwnPropertyDescriptor(o,k).writable,Object.getOwnPropertyDescriptor(o,k).enumerable,Object.getOwnPropertyDescriptor(o,k).configurable])',
        [[k, True, True, True] for k in ['locale', 'style', 'numeric', 'numberingSystem']], True)
    add('part-own-fields', 'return new Intl.RelativeTimeFormat("en").formatToParts(1,"day").map(p=>[Object.getPrototypeOf(p)===Object.prototype,Object.keys(p).map(k=>[k,Object.getOwnPropertyDescriptor(p,k).writable,Object.getOwnPropertyDescriptor(p,k).enumerable,Object.getOwnPropertyDescriptor(p,k).configurable])])')
    add('newtarget-order', 'var log=[];function T(){};var p=new Proxy(T,{get(t,k){log.push("target:"+String(k));return Reflect.get(t,k)}});var o=new Proxy({},{get(t,k){log.push("option:"+String(k))}});var r=Reflect.construct(Intl.RelativeTimeFormat,["en",o],p);return [log,Object.getPrototypeOf(r)===T.prototype]')
    add('locale-double-traversal', 'var log=[],list={get length(){log.push("length");return 1},get 0(){log.push("index");return {toString(){log.push("string");return "en"}}}};var r=new Intl.RelativeTimeFormat(list);return [r.resolvedOptions(),log]')
    add('locale-traversal-can-change', 'var n=0,list={length:1,get 0(){return ++n===1?"de":"en-u-nu-arab"}};return new Intl.RelativeTimeFormat(list).resolvedOptions()')
    error('requires-new', 'return Intl.RelativeTimeFormat()', 'TypeError')
    for method in ['format', 'formatToParts', 'resolvedOptions', 'supportedLocalesOf']:
        function = 'Intl.RelativeTimeFormat.'+method if method == 'supportedLocalesOf' else 'Intl.RelativeTimeFormat.prototype.'+method
        error('not-constructor-'+method, 'var f='+function+';return new f(1,"day")', 'TypeError')
        if method != 'supportedLocalesOf':
            for receiver in ['null', 'undefined', '{}', 'Intl.RelativeTimeFormat.prototype', 'Object.create(Intl.RelativeTimeFormat.prototype)', 'new Proxy(new Intl.RelativeTimeFormat,{})', 'new Intl.NumberFormat']:
                error('brand-'+method+'-'+receiver, 'return '+function+'.call('+receiver+',1,"day")', 'TypeError')
    for method in ['format', 'formatToParts']:
        for number, kind in [('undefined', 'RangeError'), ('NaN', 'RangeError'), ('Infinity', 'RangeError'), ('-Infinity', 'RangeError'), ('1n', 'TypeError'), ('Symbol()', 'TypeError')]:
            error(method+'-number-'+number, 'return new Intl.RelativeTimeFormat().'+method+'('+number+',"day")', kind)
        for unit in ['undefined', 'null', '""', '"DAY"', '"Day"', '"dayss"', '"millisecond"', '"day\\u0000"', '"dayxxxxxxxxxxxxs"', '"\\ud800"', 'Symbol()']:
            error(method+'-unit-'+unit, 'return new Intl.RelativeTimeFormat().'+method+'(1,'+unit+')', 'TypeError' if unit == 'Symbol()' else 'RangeError')
        for number in ['null', 'true', 'false', '"1.5"', '""', '[]', '[2]', '{valueOf(){return -2}}', '{[Symbol.toPrimitive](hint){return hint==="number"?3:9}}']:
            add(method+'-coercion-'+number, 'return new Intl.RelativeTimeFormat("en").'+method+'('+number+',"day")')
        add(method+'-missing', 'return new Intl.RelativeTimeFormat().'+method+'()')
        add(method+'-throwing-value', 'return new Intl.RelativeTimeFormat().'+method+'({valueOf(){throw new SyntaxError}}, {toString(){throw new TypeError}})')
        add(method+'-throwing-unit', 'return new Intl.RelativeTimeFormat().'+method+'(1, {toString(){throw new SyntaxError}})')
    for key, values in [
        ('localeMatcher', ['lookup', 'best fit', 'bad', 'lookup\0', None, 1]),
        ('numberingSystem', ['latn', 'arab', 'hanidec', 'mathsans', 'LATN', 'unknown', 'abc-def', 'ab', 'abcdefghi', '-abc', 'abc-', 'abc--def', 'latn\0', 'a_b', None, 123]),
        ('style', ['long', 'short', 'narrow', 'LONG', '', 'long\0', None, 1]),
        ('numeric', ['always', 'auto', 'AUTO', '', 'auto\0', None, 1])
    ]:
        for value in values:
            add('option-'+key+'-'+js(value), 'return new Intl.RelativeTimeFormat("en-u-nu-arab",'+js({key: value})+').resolvedOptions()')
        error('option-symbol-'+key, 'var o={};o['+js(key)+']=Symbol();return new Intl.RelativeTimeFormat("en",o)', 'TypeError')
        add('option-string-coercion-'+key, 'var log=[],o={};o['+js(key)+']={toString(){log.push("string");throw new SyntaxError}};try{new Intl.RelativeTimeFormat("en",o)}catch(e){return [e.name,log]}', ['SyntaxError', ['string']], True)
        add('option-get-throw-'+key, 'var log=[];try{new Intl.RelativeTimeFormat("en",new Proxy({},{get(t,k){log.push(k);if(k==='+js(key)+')throw new SyntaxError}}))}catch(e){return [e.name,log]}')
    for locale in [None, True, 4, {}, '', 'bad_tag', 'en-u-nu-unknown', 'en-u-nu-native', 'en-u-nu', 'en-u-nu-latn', 'en-u-nu-arab-ca-gregory', 'de-CH-u-nu-thai', 'xx-YY', ['xx', 'fr-CA'], ['en', 'bad_tag']]:
        add('locale-'+js(locale), 'return new Intl.RelativeTimeFormat('+js(locale)+').resolvedOptions()')
    add('locale-object', 'return new Intl.RelativeTimeFormat(new Intl.Locale("fr-u-nu-arab")).resolvedOptions()')
    for options in ['undefined', 'null', '1', 'true', '"foo"', 'Symbol()', '1n']:
        add('options-boxing-'+options, 'return new Intl.RelativeTimeFormat("en",'+options+').resolvedOptions()')
    for prototype in ['null', '7', 'undefined', '{}']:
        add('newtarget-prototype-'+prototype, 'function T(){};T.prototype='+prototype+';var r=Reflect.construct(Intl.RelativeTimeFormat,["en"],T);return [Object.getPrototypeOf(r)===Intl.RelativeTimeFormat.prototype,r.format(1,"day")]')
    for locales in ['undefined', 'null', '[]', '["EN-us","en-US","xx","de"]', '{length:2,0:"fr",1:"en"}', 'new Intl.Locale("fr")']:
        add('supported-'+locales, 'return Intl.RelativeTimeFormat.supportedLocalesOf('+locales+')')
    add('supported-order', 'var log=[],list=new Proxy({length:1,0:"en"},{get(t,k){log.push("list:"+String(k));return Reflect.get(t,k)},has(t,k){log.push("has:"+String(k));return Reflect.has(t,k)}});var options={get localeMatcher(){log.push("matcher");return "lookup"}};return [Intl.RelativeTimeFormat.supportedLocalesOf(list,options),log]')
    units = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']
    for locale, style, numeric in itertools.product(['en', 'de', 'fr', 'es', 'ja', 'zh', 'pl', 'ru', 'pt', 'ko', 'it', 'ar'], ['long', 'short', 'narrow'], ['always', 'auto']):
        options = js({'style': style, 'numeric': numeric})
        add('grammar-'+locale+'-'+style+'-'+numeric, 'var r=new Intl.RelativeTimeFormat('+js(locale)+','+options+');return '+js(units)+'.map(u=>[-2,-1,-0,0,1,2,5,12,22,1.5].map(n=>[r.format(n,u),r.formatToParts(n,u+"s")]))')
    for locale, system in itertools.product(['en', 'de', 'fr', 'pl', 'ar', 'hi'], ['latn', 'arab', 'arabext', 'hanidec', 'fullwide', 'mathsans', 'thai']):
        add('numbering-'+locale+'-'+system, 'var r=new Intl.RelativeTimeFormat('+js(locale)+',{numberingSystem:'+js(system)+'});return [r.resolvedOptions(),[0,1,999,1000,1234.5678,10000,1234567.89].map(n=>[r.format(n,"day"),r.formatToParts(-n,"day")])]')
    add('all-plurals', 'var r=new Intl.RelativeTimeFormat("en");return '+js(units)+'.map(u=>r.format(1,u+"s"))', ['in 1 '+u for u in units], True)
    add('unbound-method', 'var f=new Intl.RelativeTimeFormat().format;return f(1,"day")')
    add('gc-cycle', 'var r=new Intl.RelativeTimeFormat("en"),p=r.formatToParts(1,"day");r.parts=p;p.owner=r;return [r.format(1,"day"),p[1].value]', ['in 1 day', '1'], True)
    # C casts every Polish absolute value to int, which is undefined beyond INT_MAX.
    # Independently require the mathematical plural category, never an oracle crash.
    add('native-polish-large-plural', 'var r=new Intl.RelativeTimeFormat("pl");return [2147483648,2147483652,2147483712,2147483652.5,9007199254740991].map(n=>r.format(n,"year").split(" ").pop())',
        ['lat', 'lata', 'lat', 'roku', 'lat'], True, False)
    return result


FAULTS = [
    '(function(){return new Intl.RelativeTimeFormat()})',
    '(function(){return new Intl.RelativeTimeFormat("de-u-nu-arab",{style:"narrow",numeric:"auto",numberingSystem:"latn"})})',
    '(function(){return new Intl.RelativeTimeFormat(["xx","fr-CA-u-nu-arab"],{numberingSystem:"unknown"})})',
    '(function(){return new Intl.RelativeTimeFormat(new Intl.Locale("en-u-nu-mathsans"))})',
    '(function(){var r=new Intl.RelativeTimeFormat("en-u-nu-arab");return function(){return r.resolvedOptions()}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("en");return function(){return r.format(12345.625,"years")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("fr");return function(){return r.formatToParts(-12345.625,"years")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("pl");return function(){return r.formatToParts(1234,"days")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("pl",{style:"short"});return function(){return r.formatToParts(123456.5,"years")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("en",{numberingSystem:"mathsans"});return function(){return r.formatToParts(1234.5,"days")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("ja",{numeric:"auto"});return function(){return r.formatToParts(-1,"year")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("en",{numeric:"auto"});return function(){return r.format(0,"second")}})()',
    '(function(){var r=new Intl.RelativeTimeFormat("ko");return function(){return r.formatToParts(-2,"quarter")}})()',
    '(function(){return Intl.RelativeTimeFormat.supportedLocalesOf(["en","de","xx"],{localeMatcher:"lookup"})})',
    '(function(){var r=new Intl.RelativeTimeFormat;return function(){return r.format({valueOf(){return 1.5}},{toString(){return "days"}})}})()',
    '(function(){function T(){};T.prototype=null;return function(){return Reflect.construct(Intl.RelativeTimeFormat,["en"],T)}})()',
]
