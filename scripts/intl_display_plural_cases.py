"""Real-JS DisplayNames/PluralRules contracts, including pinned-source quirks."""
import itertools
import json


def js(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def wrapped(body):
    return 'JSON.stringify((function(){try{return ["ok",(function(){'+body+'})()]}catch(e){return ["error",e.name]}})())'


def cases():
    result = []
    def add(name, body, expected=None, independent=False, portable=True):
        result.append((name, wrapped(body), ['ok', expected] if independent else None, portable))
    def error(name, body, kind):
        result.append((name, wrapped(body), ['error', kind], True))

    add('display-default', 'return new Intl.DisplayNames(undefined,{type:"language"}).resolvedOptions()', {'locale':'en-US','style':'long','type':'language','fallback':'code','languageDisplay':'dialect'}, True)
    add('plural-default', 'return new Intl.PluralRules().resolvedOptions()', {'locale':'en-US','type':'cardinal','notation':'standard','minimumIntegerDigits':1,'minimumFractionDigits':0,'maximumFractionDigits':3,'pluralCategories':['one','other'],'roundingIncrement':1,'roundingMode':'halfEven','roundingPriority':'auto','trailingZeroDisplay':'auto'}, True)
    display_order = ['localeMatcher','style','type','fallback','languageDisplay']
    plural_order = ['localeMatcher','type','notation','compactDisplay','minimumIntegerDigits','minimumFractionDigits','maximumFractionDigits','minimumSignificantDigits','maximumSignificantDigits','roundingIncrement','roundingMode','roundingPriority','trailingZeroDisplay']
    for cls, options, order, methods in [('DisplayNames','{type:"language"}',display_order,[('of',1),('resolvedOptions',0)]), ('PluralRules','{}',plural_order,[('select',1),('selectRange',2),('resolvedOptions',0)])]:
        ctor = 'new Intl.'+cls+'("en",'+options+')'
        error(cls+'-new-required','return Intl.'+cls+'("en",'+options+')','TypeError')
        add(cls+'-option-order','var log=[];new Intl.'+cls+'("en",new Proxy('+options+',{get(t,k){log.push(k);return t[k]}}));return log',order,True)
        target_order = ['prototype']+order if cls == 'DisplayNames' else order+['prototype']
        add(cls+'-target-order','var log=[];function T(){};var t=new Proxy(T,{get(t,k){log.push(String(k));return Reflect.get(t,k)}});Reflect.construct(Intl.'+cls+',["en",new Proxy('+options+',{get(t,k){log.push(k);return t[k]}})],t);return log',target_order,True)
        add(cls+'-subclass','class C extends Intl.'+cls+'{};var v=new C("en",'+options+');return [v instanceof C,v instanceof Intl.'+cls+',v.resolvedOptions().locale]',[True,True,'en'],True)
        add(cls+'-cross-realm','var v=new __foreign'+cls+'("en",'+options+');return Intl.'+cls+'.prototype.resolvedOptions.call(v)')
        add(cls+'-foreign-target','var v=Reflect.construct(Intl.'+cls+',["en",'+options+'],__foreignTarget);return Object.getPrototypeOf(v)===__foreign'+cls+'.prototype',True,True)
        add(cls+'-tag','return Object.prototype.toString.call('+ctor+')','[object Intl.'+cls+']',True)
        add(cls+'-descriptors','var C=Intl.'+cls+';return [C.name,C.length,Object.getOwnPropertyNames(C),Object.getOwnPropertyNames(C.prototype),Object.getOwnPropertySymbols(C.prototype).map(String),Object.getOwnPropertyDescriptor(C.prototype,Symbol.toStringTag)]')
        add(cls+'-resolved-fields','var r='+ctor+'.resolvedOptions();return Object.keys(r).map(k=>{var d=Object.getOwnPropertyDescriptor(r,k);return [k,d.writable,d.enumerable,d.configurable]})')
        for method, arity in methods:
            add(cls+'-descriptor-'+method,'var d=Object.getOwnPropertyDescriptor(Intl.'+cls+'.prototype,'+js(method)+');return [d.value.name,d.value.length,d.writable,d.enumerable,d.configurable]',[method,arity,True,False,True],True)
            error(cls+'-method-constructor-'+method,'var f=Intl.'+cls+'.prototype.'+method+';return new f()','TypeError')
            for receiver in ['null','undefined','{}','Intl.'+cls+'.prototype','new Proxy('+ctor+',{})']:
                error(cls+'-brand-'+method+'-'+receiver,'return Intl.'+cls+'.prototype.'+method+'.call('+receiver+',{toString(){throw new RangeError},valueOf(){throw new RangeError}},1)','TypeError')
        for locale in ['undefined','null','[]','["fr","en"]','["fr","bad_tag"]','"en-u-nu-arab"','"fr-CA"','"zz"','new Intl.Locale("en")']:
            add(cls+'-locale-'+locale,'return new Intl.'+cls+'('+locale+','+options+').resolvedOptions()')
            add(cls+'-supported-'+locale,'return Intl.'+cls+'.supportedLocalesOf('+locale+')')
        add(cls+'-supported-no-options','return Intl.'+cls+'.supportedLocalesOf(undefined,{get localeMatcher(){throw 1}})',[],True)
        for key in order:
            add(cls+'-getter-throw-'+key,'var log=[];try{new Intl.'+cls+'("en",new Proxy('+options+',{get(t,k){log.push(k);if(k==='+js(key)+')throw new RangeError;return t[k]}}))}catch(e){return [e.name,log]}',['RangeError',order[:order.index(key)+1]],True)

    error('display-type-required','return new Intl.DisplayNames','TypeError')
    for value in ['null','1','true','"x"']:
        error('display-options-'+value,'return new Intl.DisplayNames("en",'+value+')','TypeError')
        add('plural-options-'+value,'return new Intl.PluralRules("en",'+value+').resolvedOptions()')
    for key, values in [('localeMatcher',['lookup','best fit','bad']),('style',['narrow','short','long','bad']),('type',['language','region','script','currency','calendar','dateTimeField','bad','language\0']),('fallback',['none','code','bad']),('languageDisplay',['dialect','standard','bad'])]:
        for value in values:
            options={'type':'language',key:value}
            add('display-option-'+key+'-'+js(value),'return new Intl.DisplayNames("en",'+js(options)+').resolvedOptions()')
    known = [('language','en','English'),('region','US','United States'),('script','Latn','Latin'),('currency','USD','US Dollar')]
    for kind, code, expected in known:
        add('display-known-'+kind,'return new Intl.DisplayNames("en",{type:'+js(kind)+'}).of('+js(code)+')',expected,True)
    samples={'language':['en','fr','zh-Hans-CN','zh-Hant-TW','en-US','EN','zz','en-u-nu-latn','en-x-private','bad_tag','en\0x'], 'region':['US','GB','001','us','ZZ','A','USA','12','US\0tail'], 'script':['Latn','Cyrl','bad','', 'latn','\ud800'], 'currency':['USD','EUR','ZZZ','usd','US','USDD','U1D'], 'calendar':['gregory','ethioaa','buddhist','abc','ab','abcdefghi','abc-def','abc-'], 'dateTimeField':['era','year','quarter','weekOfYear','timeZoneName','bad']}
    for locale, style, (kind,codes) in itertools.product(['en','fr','de'],['long','short','narrow'],samples.items()):
        # fallback:none isolates data lookup from code fallback behavior.
        add('display-data-'+locale+'-'+style+'-'+kind,'var d=new Intl.DisplayNames('+js(locale)+',{type:'+js(kind)+',style:'+js(style)+',fallback:"none"});return '+js(codes)+'.map(x=>{try{return d.of(x)}catch(e){return e.name}})')
    for kind,code in [('script','not-a-script'),('region','ZZ'),('currency','ZZZ'),('calendar','abc'),('language','zz')]:
        add('display-safe-fallback-'+kind,'return new Intl.DisplayNames("de",{type:'+js(kind)+'}).of('+js(code)+')',code,True)
    add('display-fallback-nul','return new Intl.DisplayNames("de",{type:"script"}).of("abc\\0tail")','abc',True)
    add('display-temporary-language-fallback','return new Intl.DisplayNames("en",{type:"language"}).of({toString(){return "q".repeat(3)}})','qqq',True,False)
    add('display-temporary-currency-fallback','return new Intl.DisplayNames("en",{type:"currency"}).of({toString(){return "Q".repeat(3)}})','QQQ',True,False)
    error('display-symbol','return new Intl.DisplayNames("en",{type:"script"}).of(Symbol())','TypeError')
    add('display-code-coercion','var log=[];var d=new Intl.DisplayNames("en",{type:"language"});return [d.of({toString(){log.push("string");return "en"}}),log]',['English',['string']],True)

    for locale in ['en','en-US','ar','fa','fr','fr-CA','gv','ko','ko-KR','ja','ja-JP','zh','zh-Hant','sl','ru','ru-RU']:
        for kind in ['cardinal','ordinal']:
            add('plural-categories-'+locale+'-'+kind,'return new Intl.PluralRules('+js(locale)+',{type:'+js(kind)+'}).resolvedOptions().pluralCategories')
            add('plural-selection-'+locale+'-'+kind,'var p=new Intl.PluralRules('+js(locale)+',{type:'+js(kind)+'});return [0,1,-1,2,3,4,5,10,11,12,14,21,22,24,100,101,1000,1000000,1.9,2.5,NaN,Infinity,-Infinity].map(x=>p.select(x))')
    add('plural-ordinal-inert','var p=new Intl.PluralRules("en",{type:"ordinal"});return [1,2,3,21].map(x=>p.select(x))',['one','other','other','other'],True)
    add('plural-french-powers','var p=new Intl.PluralRules("fr");return [0,1.9,2,10,100,1000,10000,10001].map(x=>p.select(x))',['one','one','other','many','many','many','many','other'],True)
    add('plural-russian-fractions','var p=new Intl.PluralRules("ru");return [1.9,2.9,11.9,21.9,22.9].map(x=>p.select(x))',['one','few','many','one','few'],True)
    add('plural-russian-safe-large','var p=new Intl.PluralRules("ru");return [2147483648,10000000001,1e20].map(x=>p.select(x))',['many','one','many'],True,False)
    add('plural-minimum-alone-ignored','return Object.hasOwn(new Intl.PluralRules("en",{minimumSignificantDigits:4}).resolvedOptions(),"minimumSignificantDigits")',False,True)
    add('plural-digit-options-inert','var p=new Intl.PluralRules("en",{maximumFractionDigits:0,roundingMode:"ceil"});return [p.select(1.1),p.select(1)]',['other','one'],True)
    for key,values in [('type',['cardinal','ordinal','bad']),('notation',['standard','scientific','engineering','compact','bad']),('compactDisplay',['short','long','bad']),('minimumIntegerDigits',[0,1,21,22,1.5]),('minimumFractionDigits',[-1,0,100,101]),('maximumFractionDigits',[0,3,100,101]),('minimumSignificantDigits',[0,1,21,22]),('maximumSignificantDigits',[0,1,21,22]),('roundingIncrement',[0,1,3,4999,5000,5001]),('roundingMode',['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven','bad']),('roundingPriority',['auto','morePrecision','lessPrecision','bad']),('trailingZeroDisplay',['auto','stripIfInteger','bad'])]:
        for value in values:
            add('plural-option-'+key+'-'+js(value),'return new Intl.PluralRules("en",'+js({key:value})+').resolvedOptions()')
    for options in [{'minimumFractionDigits':10,'maximumFractionDigits':1},{'minimumSignificantDigits':20,'maximumSignificantDigits':2},{'notation':'compact','compactDisplay':'long','roundingIncrement':3}]:
        add('plural-unvalidated-combinations-'+js(options),'return new Intl.PluralRules("fr",'+js(options)+').resolvedOptions()')
    for value in ['undefined','null','true','"1"','"bad"','NaN','Infinity','1n','Symbol()','{valueOf(){return 1}}']:
        add('plural-coercion-'+value,'return new Intl.PluralRules().select('+value+')')
    for a,b in [('undefined','1'),('1','undefined'),('NaN','1'),('1','NaN'),('Infinity','-Infinity'),('2','1'),('1','1'),('1n','2'),('Symbol()','1')]:
        add('plural-range-'+a+'-'+b,'return new Intl.PluralRules().selectRange('+a+','+b+')')
    add('plural-range-coercion-order','var log=[],p=new Intl.PluralRules;try{p.selectRange({valueOf(){log.push("start");return NaN}},{valueOf(){log.push("end");return 1}})}catch(e){return [e.name,log]}',['RangeError',['start','end']],True)
    add('plural-range-undefined-before-coercion','var log=[];try{new Intl.PluralRules().selectRange({valueOf(){log.push("start");return 1}},undefined)}catch(e){return [e.name,log]}',['TypeError',[]],True)
    return result


FAULTS = [
    '(function(){return new Intl.DisplayNames("en",{type:"language"})})',
    '(function(){return new Intl.DisplayNames(["fr-CA","en"],{type:"region",style:"short",fallback:"none",languageDisplay:"standard"})})',
    '(function(){var d=new Intl.DisplayNames("fr",{type:"language"});return function(){return d.of("en")}})()',
    '(function(){var d=new Intl.DisplayNames("de",{type:"script"});return function(){return d.of("unknown")}})()',
    '(function(){var d=new Intl.DisplayNames("en",{type:"language"});return function(){return d.resolvedOptions()}})()',
    '(function(){return new Intl.PluralRules})',
    '(function(){return new Intl.PluralRules(["fr","en"],{notation:"compact",compactDisplay:"long",minimumSignificantDigits:2,maximumSignificantDigits:5,roundingMode:"ceil",roundingPriority:"morePrecision",trailingZeroDisplay:"stripIfInteger"})})',
    '(function(){var p=new Intl.PluralRules("ar");return function(){return p.resolvedOptions()}})()',
    '(function(){var p=new Intl.PluralRules("en",{minimumSignificantDigits:2,maximumSignificantDigits:3});return function(){return p.resolvedOptions()}})()',
    '(function(){var p=new Intl.PluralRules("fr");return function(){return p.select(1000)}})()',
    '(function(){var p=new Intl.PluralRules;return function(){return p.selectRange(1,2)}})()',
    '(function(){return Intl.DisplayNames.supportedLocalesOf(["en","fr"],{localeMatcher:"lookup"})})',
    '(function(){return Intl.PluralRules.supportedLocalesOf(["en","fr"],{localeMatcher:"lookup"})})',
]

# Separate source-oracle probes, not passing native assertions. Literal ASCII
# arguments keep their CString storage rooted; temporary coercion results do not.
# The integration owner records actual sanitizer output for these probes.
# The plural cast requires UBSan float-cast-overflow (ASan alone cannot detect it).
DEFECTS = [
    ('display-fallback-use-after-free', 'new Intl.DisplayNames("en",{type:"language"}).of({toString(){return "q".repeat(3)}})'),
    ('display-currency-fallback-use-after-free', 'new Intl.DisplayNames("en",{type:"currency"}).of({toString(){return "Q".repeat(3)}})'),
    ('plural-russian-float-cast-overflow', 'new Intl.PluralRules("ru").select(2147483648)'),
]
