"""Real-JS ListFormat contracts, including pinned-C quirks and iterator closing."""
import json


# listformat.c:164 releases each rejected value, then :181 releases it again.
# Heap-backed values are native-only contracts; isolated C probes stay visible.
HEAP_NONSTRINGS = [
    'Symbol()', 'new String("a")', '{}', 'new Number(1)', 'new Boolean(false)',
    'function(){}', '[]', 'new Proxy({},{})', '123456789012345678901234567890n',
]

def js(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def wrapped(body):
    return 'JSON.stringify((function(){try{return ["ok",(function(){'+body+'})()]}catch(e){return ["error",e.name]}})())'


def cases():
    result = []

    def add(name, body, expected=None, independent=False, portable=True):
        result.append(('list-'+name, wrapped(body), ['ok', expected] if independent else None, portable))

    def error(name, body, kind='TypeError', portable=True):
        result.append(('list-'+name, wrapped(body), ['error', kind], portable))

    add('defaults', 'return new Intl.ListFormat().resolvedOptions()',
        {'locale': 'en-US', 'type': 'conjunction', 'style': 'long'}, True)
    error('requires-new', 'return Intl.ListFormat()')
    error('call-rejects-before-options', 'return Intl.ListFormat.call({},"en",{get type(){throw new RangeError}})')
    add('option-order', 'var log=[];new Intl.ListFormat("en",new Proxy({},{get(t,k){log.push(k)}}));return log',
        ['localeMatcher', 'type', 'style'], True)
    add('no-options-with-one-argument', 'var log=[];var d=Object.getOwnPropertyDescriptor(Object.prototype,"style");try{Object.defineProperty(Object.prototype,"style",{get(){log.push("style");throw 1},configurable:true});var a=new Intl.ListFormat("en"),b=new Intl.ListFormat("en",undefined);return [a.resolvedOptions(),b.resolvedOptions(),log]}finally{if(d)Object.defineProperty(Object.prototype,"style",d);else delete Object.prototype.style}',
        [{'locale': 'en', 'type': 'conjunction', 'style': 'long'}, {'locale': 'en', 'type': 'conjunction', 'style': 'long'}, []], True)
    add('option-coercion-order', 'var log=[];var o={};for(var k of ["localeMatcher","type","style"]){Object.defineProperty(o,k,{get:function(k){return function(){log.push("get:"+k);return {toString(){log.push("str:"+k);return {localeMatcher:"lookup",type:"unit",style:"short"}[k]}}}}(k)})}var f=new Intl.ListFormat("es-MX-u-nu-latn",o);return [f.resolvedOptions(),log]',
        [{'locale': 'es-MX', 'type': 'unit', 'style': 'short'}, ['get:localeMatcher', 'str:localeMatcher', 'get:type', 'str:type', 'get:style', 'str:style']], True)
    for key in ['localeMatcher', 'type', 'style']:
        add('option-getter-throws-'+key, 'var log=[];try{new Intl.ListFormat("en",new Proxy({},{get(t,k){log.push(k);if(k==='+js(key)+')throw new RangeError}}))}catch(e){return [e.name,log]}',
            ['RangeError', ['localeMatcher', 'type', 'style'][:['localeMatcher', 'type', 'style'].index(key)+1]], True)
        error('option-string-throws-'+key, 'var o={};o['+js(key)+']={toString(){throw new SyntaxError}};return new Intl.ListFormat("en",o)', 'SyntaxError')
        for value in [None, False, 1, '', 'invalid', 'LONG', 'long\0', 'conjunction\0']:
            error('invalid-option-'+key+'-'+js(value), 'return new Intl.ListFormat("en",'+js({key: value})+')', 'RangeError')
        error('symbol-option-'+key, 'var o={};o['+js(key)+']=Symbol();return new Intl.ListFormat("en",o)')
    for options in ['null', 'true', '0', '"long"', 'Symbol()', '1n']:
        error('primitive-options-'+options, 'return new Intl.ListFormat("en",'+options+')')
    add('inherited-options', 'return new Intl.ListFormat("en",Object.create({type:"disjunction",style:"short"})).resolvedOptions()',
        {'locale': 'en', 'type': 'disjunction', 'style': 'short'}, True)
    add('function-options', 'function o(){};o.type="unit";return new Intl.ListFormat("en",o).resolvedOptions()',
        {'locale': 'en', 'type': 'unit', 'style': 'long'}, True)

    # Explicit golden texts, not values obtained from Intl or native format helpers.
    patterns = {
        'and': ['', 'A', 'A and B', 'A, B, and C', 'A, B, C, and D'],
        'british': ['', 'A', 'A and B', 'A, B and C', 'A, B, C and D'],
        'amp': ['', 'A', 'A & B', 'A, B, & C', 'A, B, C, & D'],
        'or': ['', 'A', 'A or B', 'A, B, or C', 'A, B, C, or D'],
        'comma': ['', 'A', 'A, B', 'A, B, C', 'A, B, C, D'],
        'space': ['', 'A', 'A B', 'A B C', 'A B C D'],
        'spanish': ['', 'A', 'A y B', 'A, B y C', 'A, B, C y D'],
        'spanish-short': ['', 'A', 'A y B', 'A, B, C', 'A, B, C, D'],
    }
    configurations = [
        ('en-US', 'conjunction', 'long', 'and'),
        ('en-US', 'conjunction', 'short', 'amp'),
        ('en-US', 'conjunction', 'narrow', 'space'),
        ('en-US', 'disjunction', 'long', 'or'),
        ('en-US', 'disjunction', 'short', 'or'),
        ('en-US', 'disjunction', 'narrow', 'space'),
        ('en-US', 'unit', 'long', 'comma'),
        ('en-US', 'unit', 'short', 'comma'),
        ('en-US', 'unit', 'narrow', 'space'),
        ('en-GB', 'conjunction', 'long', 'british'),
        ('en-GB', 'conjunction', 'short', 'amp'),
        ('en-GB', 'disjunction', 'long', 'or'),
        ('es', 'conjunction', 'long', 'spanish'),
        ('es', 'conjunction', 'short', 'spanish-short'),
        ('es', 'conjunction', 'narrow', 'space'),
        ('es-MX', 'disjunction', 'long', 'spanish'),
        ('es-MX', 'disjunction', 'short', 'spanish-short'),
        ('es-MX', 'disjunction', 'narrow', 'space'),
        ('es-419', 'unit', 'long', 'spanish'),
        ('es-419', 'unit', 'short', 'spanish-short'),
        ('es-419', 'unit', 'narrow', 'space'),
        ('en-GB-x-private', 'conjunction', 'long', 'british'),
        ('fr', 'conjunction', 'long', 'and'),
        ('ja', 'disjunction', 'long', 'or'),
        ('xx', 'unit', 'long', 'comma'),
    ]
    for locale, kind, style, golden in configurations:
        ctor = 'new Intl.ListFormat('+js(locale)+','+js({'type': kind, 'style': style})+')'
        add('separators-'+locale+'-'+kind+'-'+style,
            'var f='+ctor+';return [[],["A"],["A","B"],["A","B","C"],["A","B","C","D"]].map(a=>f.format(a))',
            patterns[golden], True)
        add('parts-'+locale+'-'+kind+'-'+style,
            'var f='+ctor+';return [[],["A"],["A","B"],["A","B","C"],["A","B","C","D"]].map(a=>f.formatToParts(a))')
    add('parts-goldens', 'var f=new Intl.ListFormat("en");return [f.formatToParts(),f.formatToParts(["a"]),f.formatToParts(["a","b"]),f.formatToParts(["a","b","c"])]',
        [[], [{'type':'element','value':'a'}], [{'type':'element','value':'a'},{'type':'literal','value':' and '},{'type':'element','value':'b'}], [{'type':'element','value':'a'},{'type':'literal','value':', '},{'type':'element','value':'b'},{'type':'literal','value':', and '},{'type':'element','value':'c'}]], True)
    add('empty-elements', 'var f=new Intl.ListFormat;return [f.format(["","",""]),f.formatToParts(["","",""])]',
        [', , and ', [{'type':'element','value':''},{'type':'literal','value':', '},{'type':'element','value':''},{'type':'literal','value':', and '},{'type':'element','value':''}]], True)
    add('parts-fresh-objects', 'var f=new Intl.ListFormat,a=f.formatToParts(["x","x"]),b=f.formatToParts(["x","x"]);return [a!==b,a[0]!==a[2],a[0]!==b[0],Object.getPrototypeOf(a)===Array.prototype,a.every(p=>Object.getPrototypeOf(p)===Object.prototype)]',
        [True,True,True,True,True], True)
    for text in ['', 'é', '中文', '😀', 'a\u0301', '\ud800', '\udc00', '\ud800x\udc00', 'a\0z', '\0only', '😀\0x', '\ud800\0\udc00']:
        prefix = text.split('\0', 1)[0]
        add('utf16-'+js(text), 'var f=new Intl.ListFormat;return [f.format(['+js(text)+']),f.format(['+js(text)+',"z"]),f.formatToParts(['+js(text)+'])]',
            [prefix,prefix+' and z',[{'type':'element','value':prefix}]], True)
    add('surrogates-do-not-cross-elements', r'var f=new Intl.ListFormat("en",{style:"narrow"});return [f.format(["\ud800","\udc00"]),f.formatToParts(["\ud800","\udc00"])]',
        ['\ud800 \udc00',[{'type':'element','value':'\ud800'},{'type':'literal','value':' '},{'type':'element','value':'\udc00'}]], True)
    add('rope-prefix-nul', r'var a="😀".repeat(128),b="é".repeat(128),s=a+"\u0000"+b;var f=new Intl.ListFormat;return [f.format([s,"end"]),f.formatToParts([s])[0].value]',
        ['😀'*128+' and end','😀'*128], True)

    for method in ['format', 'formatToParts']:
        call = 'new Intl.ListFormat().'+method
        add(method+'-omitted', 'return '+call+'()', '' if method == 'format' else [], True)
        add(method+'-undefined', 'return '+call+'(undefined)', '' if method == 'format' else [], True)
        for source in ['null','1','true','1n','Symbol()','{}','{length:1,0:"a"}','{[Symbol.iterator]:null}','{[Symbol.iterator]:1}']:
            error(method+'-not-iterable-'+source, 'return '+call+'('+source+')')
        for source in ['[1]','[undefined]','[null]','new Array(1)','["a",false]']:
            error(method+'-nonstring-'+source, 'return '+call+'('+source+')')
        for value in HEAP_NONSTRINGS:
            source = '['+value+']'
            error(method+'-nonstring-'+source, 'return '+call+'('+source+')', portable=False)
        add(method+'-string-iterator', 'return '+call+'("A😀B")',
            'A, 😀, and B' if method == 'format' else [{'type':'element','value':'A'},{'type':'literal','value':', '},{'type':'element','value':'😀'},{'type':'literal','value':', and '},{'type':'element','value':'B'}], True)
        add(method+'-generator', 'function* g(){yield "a";yield "b"}return '+call+'(g())',
            'a and b' if method == 'format' else [{'type':'element','value':'a'},{'type':'literal','value':' and '},{'type':'element','value':'b'}], True)
        add(method+'-set-iterator', 'return '+call+'(new Set(["a","b","a"]))',
            'a and b' if method == 'format' else [{'type':'element','value':'a'},{'type':'literal','value':' and '},{'type':'element','value':'b'}], True)
        add(method+'-cached-next-order', 'var log=[],i=0,it={get next(){log.push("next:get");return function(){log.push("next:call");if(i++===0){Object.defineProperty(it,"next",{value(){throw 1}});return {get done(){log.push("done");return false},get value(){log.push("value");return "x"}}}return {get done(){log.push("done:true");return true},get value(){throw 2}}}},return(){log.push("return");return {}}};var input={get [Symbol.iterator](){log.push("iterator:get");return function(){log.push(this===input?"iterator:this":"bad");return it}}};var out='+call+'(input);return [out,log]',
            ['x' if method == 'format' else [{'type':'element','value':'x'}], ['iterator:get','iterator:this','next:get','next:call','done','value','next:call','done:true']], True)
        add(method+'-next-getter-no-close', 'var log=[],it={get next(){log.push("next");throw new RangeError},return(){log.push("return")}};try{'+call+'({[Symbol.iterator](){return it}})}catch(e){return [e.name,log]}',
            ['RangeError',['next']], True)
        error(method+'-iterator-nonobject', 'return '+call+'({[Symbol.iterator](){return 1}})')
        error(method+'-iterator-getter-throws', 'return '+call+'({get [Symbol.iterator](){throw new RangeError}})', 'RangeError')
        error(method+'-iterator-call-throws', 'return '+call+'({[Symbol.iterator](){throw new SyntaxError}})', 'SyntaxError')
        for step, expected in [
            ('throw new RangeError', 'RangeError'),
            ('return 1', 'TypeError'),
            ('return {get done(){throw new SyntaxError}}', 'SyntaxError'),
            ('return {done:false,get value(){throw new EvalError}}', 'EvalError'),
            ('return {done:false,value:42}', 'TypeError'),
        ]:
            for closing in ['return {}','return 1','throw new URIError']:
                add(method+'-close-'+step+'-'+closing, 'var log=[],it={next(){log.push("next");'+step+'},get return(){log.push("return:get");return function(){log.push(this===it?"return:this":"bad");'+closing+'}}};try{'+call+'({[Symbol.iterator](){return it}})}catch(e){return [e.name,log]}',
                    [expected,['next','return:get','return:this']], True)
        for closing in ['get return(){log.push("return:get");throw new URIError}', 'get return(){log.push("return:get");return null}', 'get return(){log.push("return:get");return 17}']:
            add(method+'-close-return-access-'+closing, 'var log=[],it={next(){throw new RangeError},'+closing+'};try{'+call+'({[Symbol.iterator](){return it}})}catch(e){return [e.name,log]}',
                ['RangeError',['return:get']], True)
        add(method+'-noncallable-next-closes', 'var log=[],it={next:1,return(){log.push("return");return {}}};try{'+call+'({[Symbol.iterator](){return it}})}catch(e){return [e.name,log]}',
            ['TypeError',['return']], True)
        add(method+'-nonstring-no-coercion', 'var log=[],x={toString(){log.push("string");return "x"}},it={next(){return {done:false,value:x}},return(){log.push("return");return {}}};try{'+call+'({[Symbol.iterator](){return it}})}catch(e){return [e.name,log]}',
            ['TypeError',['return']], True, False)
        add(method+'-generator-finally-on-error', 'var log=[];function* g(){try{yield "a";yield 1;log.push("after")}finally{log.push("finally")}}try{'+call+'(g())}catch(e){return [e.name,log]}',
            ['TypeError',['finally']], True)
        for receiver in ['null','undefined','{}','Intl.ListFormat.prototype','new Intl.Collator','new Proxy(new Intl.ListFormat,{})']:
            error(method+'-brand-before-iterator-'+receiver, 'return Intl.ListFormat.prototype.'+method+'.call('+receiver+',{get [Symbol.iterator](){throw new RangeError}})')
        add(method+'-extra-arguments-ignored', 'return '+call+'(["a"],{toString(){throw 1}})',
            'a' if method == 'format' else [{'type':'element','value':'a'}], True)

    add('parts-property-setters', 'var log=[],dt=Object.getOwnPropertyDescriptor(Object.prototype,"type"),dv=Object.getOwnPropertyDescriptor(Object.prototype,"value");try{Object.defineProperty(Object.prototype,"type",{set(v){log.push("type:"+v)},configurable:true});Object.defineProperty(Object.prototype,"value",{set(v){log.push("value:"+v)},configurable:true});var out=new Intl.ListFormat().formatToParts(["a","b"]);return [out.map(p=>Object.keys(p)),log]}finally{if(dt)Object.defineProperty(Object.prototype,"type",dt);else delete Object.prototype.type;if(dv)Object.defineProperty(Object.prototype,"value",dv);else delete Object.prototype.value}',
        [[[],[],[]],['type:element','value:a','type:literal','value: and ','type:element','value:b']], True)
    add('parts-setter-error-is-ignored-pin', 'var log=[],d=Object.getOwnPropertyDescriptor(Object.prototype,"type");try{Object.defineProperty(Object.prototype,"type",{set(v){log.push(v);throw new RangeError},configurable:true});var out=new Intl.ListFormat().formatToParts(["a"]);return [out,log]}finally{if(d)Object.defineProperty(Object.prototype,"type",d);else delete Object.prototype.type}',
        [[{'value':'a'}],['element']], True)
    add('parts-setter-after-complete-iteration', 'var log=[],d=Object.getOwnPropertyDescriptor(Object.prototype,"type");function* g(){log.push("first");yield "a";log.push("second");yield "b";log.push("done")}try{Object.defineProperty(Object.prototype,"type",{set(v){log.push(v)},configurable:true});new Intl.ListFormat().formatToParts(g());return log}finally{if(d)Object.defineProperty(Object.prototype,"type",d);else delete Object.prototype.type}',
        ['first','second','done','element','literal','element'], True)
    add('parts-descriptors', 'return new Intl.ListFormat().formatToParts(["x","y"]).map(p=>Object.keys(p).map(k=>{var d=Object.getOwnPropertyDescriptor(p,k);return [k,d.writable,d.enumerable,d.configurable]}))',
        [[['type',True,True,True],['value',True,True,True]]]*3, True)
    add('resolved-descriptors', 'var r=new Intl.ListFormat().resolvedOptions();return [Object.getPrototypeOf(r)===Object.prototype,Object.keys(r).map(k=>{var d=Object.getOwnPropertyDescriptor(r,k);return [k,d.writable,d.enumerable,d.configurable]})]',
        [True,[['locale',True,True,True],['type',True,True,True],['style',True,True,True]]], True)
    add('resolved-fresh', 'var f=new Intl.ListFormat,a=f.resolvedOptions();a.type="unit";return [a!==f.resolvedOptions(),f.resolvedOptions().type,f.format(["a","b"])]',
        [True,'conjunction','a and b'], True)
    error('resolved-brand', 'return Intl.ListFormat.prototype.resolvedOptions.call({})')
    add('public-descriptors', 'function d(o,k){var x=Object.getOwnPropertyDescriptor(o,k);return [x.writable,x.enumerable,x.configurable,typeof x.value]}var C=Intl.ListFormat;return [C.name,C.length,Object.getOwnPropertyNames(C.prototype),Object.getOwnPropertySymbols(C.prototype).map(String),d(Intl,"ListFormat"),d(C,"prototype"),d(C.prototype,"constructor"),d(C.prototype,Symbol.toStringTag),Object.prototype.toString.call(new C),["format","formatToParts","resolvedOptions"].map(k=>[C.prototype[k].name,C.prototype[k].length,d(C.prototype,k)])]',
        ['ListFormat',0,['format','formatToParts','resolvedOptions','constructor'],['Symbol(Symbol.toStringTag)'],[True,False,True,'function'],[False,False,False,'object'],[True,False,True,'function'],[False,False,True,'string'],'[object Intl.ListFormat]',[['format',1,[True,False,True,'function']],['formatToParts',1,[True,False,True,'function']],['resolvedOptions',0,[True,False,True,'function']]]], True)
    for method in ['Intl.ListFormat.prototype.format','Intl.ListFormat.prototype.formatToParts','Intl.ListFormat.prototype.resolvedOptions','Intl.ListFormat.supportedLocalesOf']:
        error('method-not-constructable-'+method, 'var f='+method+';return new f()')
    add('subclass', 'class Child extends Intl.ListFormat{};var f=new Child("en-GB");return [f instanceof Child,f instanceof Intl.ListFormat,f.format(["a","b","c"])]',
        [True,True,'a, b and c'], True)
    add('newtarget-order', 'var log=[];function T(){};var target=new Proxy(T,{get(t,k){log.push("target:"+String(k));return Reflect.get(t,k)}});var o=new Proxy({},{get(t,k){log.push("option:"+String(k))}});var f=Reflect.construct(Intl.ListFormat,["en",o],target);return [log,Object.getPrototypeOf(f)===T.prototype,Intl.ListFormat.prototype.format.call(f,["a","b"])]',
        [['option:localeMatcher','option:type','option:style','target:prototype'],True,'a and b'], True)
    error('newtarget-prototype-throws-after-options', 'function T(){};var p=new Proxy(T,{get(){throw new URIError}});return Reflect.construct(Intl.ListFormat,["en"],p)', 'URIError')
    for prototype in ['null', 'undefined', '7', '{}']:
        add('newtarget-prototype-'+prototype, 'function T(){};T.prototype='+prototype+';var f=Reflect.construct(Intl.ListFormat,["en"],T);return [Object.getPrototypeOf(f)===Intl.ListFormat.prototype,Intl.ListFormat.prototype.format.call(f,["a","b"])]',
            [prototype != '{}','a and b'], True)
    add('cross-realm-default', 'var f=Reflect.construct(Intl.ListFormat,["en"],__foreignTarget);return [Object.getPrototypeOf(f)===__foreignListFormat.prototype,f instanceof __foreignListFormat,f instanceof Intl.ListFormat]', [True,True,False], True)
    add('cross-realm-brand', 'var f=new __foreignListFormat("es");return [Intl.ListFormat.prototype.format.call(f,["a","b"]),Intl.ListFormat.prototype.resolvedOptions.call(f)]',
        ['a y b',{'locale':'es','type':'conjunction','style':'long'}], True)
    add('global-constructor-replaced', 'var C=Intl.ListFormat;try{Intl.ListFormat=function(){throw 1};var f=new C("en");return [f.format(["a","b"]),Object.getPrototypeOf(f)===C.prototype]}finally{Intl.ListFormat=C}',
        ['a and b',True], True)
    for locale in [None, True, 4, {}, '', 'bad_tag', 'EN-gb', 'es-MX-u-nu-latn', 'en-GB-x-private', 'xx-YY', ['xx','es'], ['fr','bad_tag']]:
        add('locale-'+js(locale), 'return new Intl.ListFormat('+js(locale)+').resolvedOptions()')
    add('locale-object', 'return new Intl.ListFormat(new Intl.Locale("es-MX-u-nu-latn")).resolvedOptions()',
        {'locale':'es-MX','type':'conjunction','style':'long'}, True)
    add('locale-before-options', 'var log=[];var locales={get length(){log.push("length");return 1},get 0(){log.push("locale");return {toString(){log.push("string");return "en"}}}};new Intl.ListFormat(locales,new Proxy({},{get(t,k){log.push(k)}}));return log',
        ['length','locale','string','localeMatcher','type','style'], True)
    for locales in ['undefined','null','[]','["en-US","xx","es","en-US"]','{length:2,0:"fr",1:"en"}','["EN-us","en-US"]','new Intl.Locale("es")']:
        add('supported-'+locales, 'return Intl.ListFormat.supportedLocalesOf('+locales+')')
    add('supported-undefined-skips-options', 'return Intl.ListFormat.supportedLocalesOf(undefined,{get localeMatcher(){throw 1}})', [], True)
    add('supported-options-before-list', 'var log=[],list=new Proxy({length:1,0:"en"},{get(t,k){log.push("get:"+String(k));return Reflect.get(t,k)},has(t,k){log.push("has:"+String(k));return Reflect.has(t,k)}});return [Intl.ListFormat.supportedLocalesOf(list,{get localeMatcher(){log.push("matcher");return "lookup"}}),log]',
        [['en'],['matcher','get:length','has:0','get:0']], True)
    add('supported-receiver-ignored', 'return Intl.ListFormat.supportedLocalesOf.call(null,"en")', ['en'], True)
    error('supported-invalid-matcher', 'return Intl.ListFormat.supportedLocalesOf("en",{localeMatcher:"invalid"})', 'RangeError')
    add('cycle-lifetime', 'var f=new Intl.ListFormat;f.self=f;var parts=f.formatToParts(["a","b"]);parts.owner=f;f.parts=parts;return f.format([parts[0].value,parts[2].value])', 'a and b', True)
    return result


FAULTS = [
    '(function(){return new Intl.ListFormat()})',
    '(function(){return new Intl.ListFormat(["es-MX-u-nu-latn","en"],{localeMatcher:"lookup",type:"disjunction",style:"short"})})',
    '(function(){function T(){};T.prototype=null;return Reflect.construct(Intl.ListFormat,["en-GB",{type:"unit",style:"narrow"}],T)})',
    '(function(){var f=new Intl.ListFormat;return function(){return f.resolvedOptions()}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.format()}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.format(["one"])}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.format(["one","two"])}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.format(["one","two","three","four"])}})()',
    '(function(){var f=new Intl.ListFormat;return function(){function* g(){try{yield "one";yield "two";yield "three"}finally{}}return f.format(g())}})()',
    '(function(){var f=new Intl.ListFormat;return function(){var i=0,it={next(){return i++<3?{done:false,value:"x"}:{done:true}},return(){return {}}};return f.format({[Symbol.iterator](){return it}})}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.formatToParts()}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.formatToParts(["one"])}})()',
    '(function(){var f=new Intl.ListFormat;return function(){return f.formatToParts(["one","two"])}})()',
    '(function(){var f=new Intl.ListFormat("es",{style:"short"});return function(){return f.formatToParts(["one","two","three","four"])}})()',
    '(function(){var f=new Intl.ListFormat;return function(){function* g(){yield "one";yield "two";yield "three"}return f.formatToParts(g())}})()',
    r'(function(){var f=new Intl.ListFormat,s="😀".repeat(128)+"\u0000"+"é".repeat(128);return function(){return [f.format([s,"\ud800","\udc00"]),f.formatToParts([s,"\ud800","\udc00"])]}})()',
    '(function(){return Intl.ListFormat.supportedLocalesOf(["en","es-MX","en"],{localeMatcher:"lookup"})})',
]


# Run each expression in a separate C process: the reported boxed-string probe
# segfaults, and the same double-release path applies to every heap value here.
# These probes never replace the independent native TypeError/close assertions.
DEFECTS = [
    ('list-'+method+'-nonstring-double-release-'+str(index),
     'new Intl.ListFormat().'+method+'(['+value+'])')
    for method in ['format', 'formatToParts']
    for index, value in enumerate(HEAP_NONSTRINGS)
]
DEFECTS += [
    ('list-'+method+'-nonstring-no-coercion-double-release',
     '(function(){var x={toString(){throw new Error("must not coerce")}},it={next(){return {done:false,value:x}},return(){return {}}};return new Intl.ListFormat().'+method+'({[Symbol.iterator](){return it}})})()')
    for method in ['format', 'formatToParts']
]
