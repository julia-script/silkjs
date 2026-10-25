"""Independent public contracts and source-pinned edge cases for real Intl JS."""
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
    add('collator-default', 'return Intl.Collator().resolvedOptions()', {'locale':'en-US','usage':'sort','sensitivity':'variant','ignorePunctuation':False,'collation':'default'}, True)
    add('segmenter-default', 'return new Intl.Segmenter().resolvedOptions()', {'locale':'en-US','granularity':'grapheme'}, True)
    add('compare-fresh-identity', 'var c=new Intl.Collator;return [c.compare===c.compare,c.compare.name,c.compare.length,Object.hasOwn(c,"compare")]', [False,'',2,False], True)
    add('compare-capture-survives', 'var f=(new Intl.Collator("en",{sensitivity:"base"})).compare;return [f("A","a"),f.call(null,"a","c"),f.call({},{toString(){return "d"}},"a")]', [0,-2,3], True)
    add('numeric-inert-pin', 'return new Intl.Collator("en",{numeric:true}).compare("2","10")', 1, True)
    add('sentence-whole-input-pin', r'return Array.from(new Intl.Segmenter("en",{granularity:"sentence"}).segment("Hi! Bye.\nNext?"))', [{'segment':'Hi! Bye.\nNext?','index':0,'input':'Hi! Bye.\nNext?'}], True)
    add('iterator-prototype-pin', 'var s=new Intl.Segmenter().segment("ab"),it=s[Symbol.iterator](),p=Object.getPrototypeOf(it);return [Object.getPrototypeOf(p)===Object.prototype,it[Symbol.iterator],it[Symbol.toStringTag],Object.prototype.toString.call(it),Object.prototype.toString.call(s),Object.getOwnPropertyNames(p),Object.getOwnPropertySymbols(p).length]', [True,None,None,'[object Object]','[object Object]',['next'],0], True)
    add('iterator-fresh-state', 'var s=new Intl.Segmenter().segment("ab"),a=s[Symbol.iterator](),b=s[Symbol.iterator]();return [a.next().value.index,a.next().value.index,b.next().value.index,a.next(),a.next(),b.next().value.index,b.next()]', [0,1,0,{'done':True},{'done':True},1,{'done':True}], True)
    add('iterator-survives-release', 'var it=(new Intl.Segmenter().segment("xy"))[Symbol.iterator]();return [it.next().value.segment,it.next().value.segment,it.next().done]', ['x','y',True], True)
    add('segments-survives-release', 'var s=(new Intl.Segmenter("en",{granularity:"word"})).segment("one two");return [s.containing(5),Array.from(s)]', [{'segment':'two','index':4,'input':'one two','isWordLike':True},[{'segment':'one','index':0,'input':'one two','isWordLike':True},{'segment':' ','index':3,'input':'one two','isWordLike':False},{'segment':'two','index':4,'input':'one two','isWordLike':True}]], True)
    add('collator-call-always-creates','var c=new Intl.Collator("fr");var d=Intl.Collator.call(c,"de");return [c!==d,c.resolvedOptions().locale,d.resolvedOptions().locale]',[True,'fr','de'],True)
    add('compare-getter-descriptor','var d=Object.getOwnPropertyDescriptor(Intl.Collator.prototype,"compare");return [d.enumerable,d.configurable,d.get.name,d.get.length,d.set]',[False,True,'get compare',0,None],True)
    add('segments-method-descriptors','var s=new Intl.Segmenter().segment("x"),p=Object.getPrototypeOf(s),q=Object.getPrototypeOf(s[Symbol.iterator]());return [[p,"containing"],[p,Symbol.iterator],[q,"next"]].map(x=>{var d=Object.getOwnPropertyDescriptor(x[0],x[1]);return [d.value.name,d.value.length,d.writable,d.enumerable,d.configurable]})',[['containing',1,True,False,True],['[Symbol.iterator]',0,True,False,True],['next',0,True,False,True]],True)
    for method in ['new Intl.Collator().compare','Intl.Collator.prototype.resolvedOptions','Intl.Collator.supportedLocalesOf','Intl.Segmenter.prototype.segment','Intl.Segmenter.prototype.resolvedOptions','Intl.Segmenter.supportedLocalesOf','new Intl.Segmenter().segment("").containing','new Intl.Segmenter().segment("")[Symbol.iterator]','new Intl.Segmenter().segment("")[Symbol.iterator]().next']:
        error('method-not-constructable-'+method,'var f='+method+';return new f()','TypeError')
    for cls in ['Collator','Segmenter']:
        ctor='new Intl.'+cls
        add(cls+'-cross-realm-default', 'var C=__foreign'+cls+';var c=Reflect.construct(Intl.'+cls+',[\"en\"],__foreignTarget);return [Object.getPrototypeOf(c)===C.prototype,c instanceof C,c instanceof Intl.'+cls+']', [True,True,False], True)
        add(cls+'-cross-realm-method', 'var c=new __foreign'+cls+'(\"en\");return Intl.'+cls+'.prototype.resolvedOptions.call(c)')
        for locale in [None,True,4,{},'','bad_tag','en-u-kn-true','de-u-co-phonebk','en-u-kf-upper','en-u-kn-false','th','xx-YY',['xx','fr-CA'],['xx','de-u-co-phonebk'],['fr','bad_tag']]:
            add(cls+'-locale-'+js(locale), 'return '+ctor+'('+js(locale)+').resolvedOptions()')
        for opt in [None,1,True,'foo',{}, {'localeMatcher':'lookup'},{'localeMatcher':'best fit'},{'localeMatcher':'invalid'}]:
            add(cls+'-options-'+js(opt),'return '+ctor+'("en",'+js(opt)+').resolvedOptions()')
        add(cls+'-locale-object', 'return '+ctor+'(new Intl.Locale("de-u-co-phonebk")).resolvedOptions()')
        add(cls+'-subclass', 'class Child extends Intl.'+cls+'{};var c=new Child("en");return [c instanceof Child,c instanceof Intl.'+cls+',c.resolvedOptions()]')
        add(cls+'-newtarget-get-order', 'var log=[];function T(){};var p=new Proxy(T,{get(t,k){log.push(String(k));return Reflect.get(t,k)}});var o=new Proxy({},{get(t,k){log.push(String(k))}});var c=Reflect.construct(Intl.'+cls+',["en",o],p);return [log,Object.getPrototypeOf(c)===T.prototype]')
        for prototype in ['null','7','undefined','{}']:
            add(cls+'-newtarget-proto-'+prototype,'function T(){};T.prototype='+prototype+';var c=Reflect.construct(Intl.'+cls+',["en"],T);return [Object.getPrototypeOf(c)===Intl.'+cls+'.prototype,c.resolvedOptions()]')
        for locales in ['undefined','null','[]','["en-US","xx","de-u-co-phonebk","en-US"]','{length:2,0:"fr",1:"en"}','["EN-us","en-US"]','new Intl.Locale("fr")']:
            add(cls+'-supported-'+locales, 'return Intl.'+cls+'.supportedLocalesOf('+locales+')')
        add(cls+'-supported-order', 'var log=[],list=new Proxy({length:1,0:"en"},{get(t,k){log.push("list:"+String(k));return Reflect.get(t,k)},has(t,k){log.push("has:"+String(k));return Reflect.has(t,k)}});var options={get localeMatcher(){log.push("matcher");return "lookup"}};return [Intl.'+cls+'.supportedLocalesOf(list,options),log]')
        add(cls+'-supported-undefined-ignores-options', 'return Intl.'+cls+'.supportedLocalesOf(undefined,{get localeMatcher(){throw 1}})', [], True)
        add(cls+'-descriptors', 'function d(o,k){var x=Object.getOwnPropertyDescriptor(o,k);return [x.writable,x.enumerable,x.configurable,typeof x.value,typeof x.get,typeof x.set]}var C=Intl.'+cls+';return [C.name,C.length,Object.getOwnPropertyNames(C),Object.getOwnPropertyNames(C.prototype),Object.getOwnPropertySymbols(C.prototype).map(String),d(Intl,"'+cls+'"),d(C,"prototype"),d(C.prototype,"constructor"),d(C.prototype,Symbol.toStringTag),Object.prototype.toString.call(new C),d(C,"supportedLocalesOf"),d(C.prototype,"resolvedOptions")]')
        error(cls+'-resolved-brand','return Intl.'+cls+'.prototype.resolvedOptions.call({})','TypeError')
        error(cls+'-proxy-brand','return new Proxy('+ctor+'(),{}).resolvedOptions()','TypeError')
        add(cls+'-coercion-log', 'var log=[],list={get length(){log.push("length");return 1},get 0(){log.push("index");return {toString(){log.push("locale:string");return "en"}}}},o=new Proxy({},{get(t,k){log.push("option:"+String(k))}});var c='+ctor+'(list,o);return [c.resolvedOptions(),log]')
        add(cls+'-resolved-own-fields', 'var o='+ctor+'("en").resolvedOptions();return Object.keys(o).map(k=>[k,Object.getOwnPropertyDescriptor(o,k).writable,Object.getOwnPropertyDescriptor(o,k).enumerable,Object.getOwnPropertyDescriptor(o,k).configurable])')
        add(cls+'-supported-receiver-ignored','return Intl.'+cls+'.supportedLocalesOf.call(null,"en")',['en'],True)
    error('segmenter-requires-new','return Intl.Segmenter()','TypeError')
    for receiver in ['null','undefined','{}','Intl.Collator.prototype','new Intl.Segmenter()','new Proxy(new Intl.Collator,{})']:
        error('compare-brand-'+receiver,'return Object.getOwnPropertyDescriptor(Intl.Collator.prototype,"compare").get.call('+receiver+')','TypeError')
    for receiver in ['null','undefined','{}','Intl.Segmenter.prototype','new Intl.Collator()']:
        error('segment-brand-'+receiver,'return Intl.Segmenter.prototype.segment.call('+receiver+',{toString(){throw new RangeError}})','TypeError')
        error('containing-brand-'+receiver,'return Object.getPrototypeOf(new Intl.Segmenter().segment("")).containing.call('+receiver+')','TypeError')
        error('iterator-brand-'+receiver,'return Object.getPrototypeOf(new Intl.Segmenter().segment(""))[Symbol.iterator].call('+receiver+')','TypeError')
        error('next-brand-'+receiver,'return Object.getPrototypeOf(new Intl.Segmenter().segment("")[Symbol.iterator]()).next.call('+receiver+')','TypeError')
    for key, values in [('usage',['sort','search','bad']),('sensitivity',['base','accent','case','variant','bad']),('caseFirst',['upper','lower','false','bad','upper\0']),('numeric',[False,True,None,0,1,'']),('ignorePunctuation',[False,True,None,'yes']),('collation',['default','phonebk','emoji','eor','foobar','SEARCH','search','a','abcdefghi','a-b','abc\0junk'])]:
        for value in values:
            add('collator-option-'+key+'-'+js(value),'return new Intl.Collator("de-u-co-phonebk-kn-kf-upper",'+js({key:value})+').resolvedOptions()')
    for locale, options in itertools.product(['en','de','de-u-co-phonebk','tr','az','th'],[{}, {'sensitivity':'base'}, {'sensitivity':'accent'}, {'sensitivity':'case'}, {'usage':'search'}, {'caseFirst':'upper'}, {'ignorePunctuation':True}]):
        pairs=[['a','c'],['A','a'],['ä','ae'],['ä','a'],['ß','ss'],['I','ı'],['é','e\u0301'],['a-b','ab'],['😀','😁'],['\ud800','\ud801']]
        add('collation-kernel-'+locale+'-'+js(options),'var c=new Intl.Collator('+js(locale)+','+js(options)+');return '+js(pairs)+'.map(p=>c.compare(p[0],p[1]))')
    add('compare-coercion-order', 'var log=[],f=new Intl.Collator().compare;var a={toString(){log.push("a");return "a"}},b={toString(){log.push("b");return "b"}};return [f(a,b),log]', [-1,['a','b']], True)
    error('compare-symbol','return new Intl.Collator().compare(Symbol(),"a")','TypeError')
    add('compare-default-args','var f=new Intl.Collator().compare;return [f(),f(undefined,undefined),f("undefined")]',[0,0,0],True)
    texts=['','a','ab','a\u0301b','\r\n','👨\u200d👩\u200d👧','🇦🇧🇨','\u1100\u1161\u11a8','\ud800x\udc00','a b!!c','foo-bar 12.5% $x','Hi! Bye.\nNext?','\u0e31\u0e47x']
    for granularity,text in itertools.product(['grapheme','word','sentence'],texts):
        portable=granularity!='word' or all(ord(ch)<=255 for ch in text)
        expected=None
        if not portable:
            # These fixtures contain only word characters. Iteration is one run;
            # containing alone splits the explicitly isolated surrogate fixture.
            length=len(text.encode('utf-16-le',errors='surrogatepass'))//2
            whole={'segment':text,'index':0,'input':text,'isWordLike':True}
            contained=[whole]*length
            if text=='\ud800x\udc00':
                contained=[{'segment':ch,'index':i,'input':text,'isWordLike':True} for i,ch in enumerate(text)]
            expected=[[whole],[None,*contained,None,None]]
        add('segments-'+granularity+'-'+js(text),'var input='+js(text)+',s=new Intl.Segmenter("en",{granularity:'+js(granularity)+'}).segment(input),a=[];for(var i=-1;i<=input.length+1;i++)a.push(s.containing(i));return [Array.from(s),a]', expected,not portable,portable)
    for index in ['undefined','null','NaN','Infinity','-Infinity','-0.8','1.9','"2"','4294967296','-2147483649','{valueOf(){return 1}}','1n','Symbol()']:
        add('containing-index-'+index,'return new Intl.Segmenter().segment("abc").containing('+index+')')
    for granularity in ['grapheme','word','sentence']:
        add('segment-data-descriptors-'+granularity,'var s=new Intl.Segmenter("en",{granularity:'+js(granularity)+'}).segment("ab cd").containing(0);return [Object.getPrototypeOf(s)===Object.prototype,Object.keys(s).map(k=>[k,Object.getOwnPropertyDescriptor(s,k).writable,Object.getOwnPropertyDescriptor(s,k).enumerable,Object.getOwnPropertyDescriptor(s,k).configurable])]')
    for input in ['undefined','null','123','true','{toString(){return "abc"}}','Symbol()']:
        add('segment-coercion-'+input,'return Array.from(new Intl.Segmenter().segment('+input+'))')
    add('segmenter-option-order','var log=[];new Intl.Segmenter("en",new Proxy({},{get(t,k){log.push(k)}}));return log',['localeMatcher','granularity'],True)
    add('localeCompare-root-not-global','var old=Intl.Collator;try{Intl.Collator=function(){throw 1};return "a".localeCompare("c")}finally{Intl.Collator=old}',-2,True)
    add('localeCompare-callback-observable','var d=Object.getOwnPropertyDescriptor(Intl.Collator.prototype,"compare"),log=[];try{Object.defineProperty(Intl.Collator.prototype,"compare",{get(){log.push("get");return function(a,b){log.push([this===undefined,typeof a,typeof b,a,b]);return 73}}});return [String.prototype.localeCompare.call({toString(){log.push("a");return "x"}},{toString(){log.push("b");return "y"}},"en",{get usage(){log.push("usage");return "sort"}}),log]}finally{Object.defineProperty(Intl.Collator.prototype,"compare",d)}')
    add('localeCompare-null-option-order','var log=[];try{String.prototype.localeCompare.call(null,"x","en",{get usage(){log.push("usage");throw new RangeError}})}catch(e){return [e.name,log]}',['RangeError',['usage']],True)
    add('localeCompare-compare-before-null','var d=Object.getOwnPropertyDescriptor(Intl.Collator.prototype,"compare"),log=[];try{Object.defineProperty(Intl.Collator.prototype,"compare",{get(){log.push("compare");return ()=>0}});try{String.prototype.localeCompare.call(null,"x")}catch(e){return [e.name,log]}}finally{Object.defineProperty(Intl.Collator.prototype,"compare",d)}',['TypeError',['compare']],True)
    add('other-locale-callback-preserved','return ["I".toLocaleLowerCase("tr"),"i".toLocaleUpperCase("tr")]',['ı','İ'],True)
    add('localeCompare-noncallable-coercion-order','var d=Object.getOwnPropertyDescriptor(Intl.Collator.prototype,\"compare\"),log=[];try{Object.defineProperty(Intl.Collator.prototype,\"compare\",{get(){log.push(\"compare\");return 4}});try{String.prototype.localeCompare.call({toString(){log.push(\"a\");return \"a\"}},{toString(){log.push(\"b\");return \"b\"}})}catch(e){return [e.name,log]}}finally{Object.defineProperty(Intl.Collator.prototype,\"compare\",d)}',['TypeError',['compare','a','b']],True)
    for key in ['collation','caseFirst']:
        add('collator-option-string-throw-'+key,'var log=[];var options={};options['+js(key)+']={toString(){log.push("string");throw new RangeError}};var c=new Intl.Collator("en",options);return [c.resolvedOptions(),log]')
    add('text-gc-cycle-owners','var c=new Intl.Collator;var f=c.compare;c.f=f;f.c=c;var s=new Intl.Segmenter;var segments=s.segment("abc");var iterator=segments[Symbol.iterator]();s.segments=segments;segments.iterator=iterator;iterator.owner=s;return [f("a","b"),iterator.next().value.segment]',[-1,'a'],True)
    for key in ['localeMatcher','usage','sensitivity','ignorePunctuation','collation','numeric','caseFirst']:
        add('collator-option-throw-'+key,'var log=[];try{new Intl.Collator("en",new Proxy({},{get(t,k){log.push(k);if(k==='+js(key)+')throw new RangeError}}))}catch(e){return [e.name,log]}')
    # Explicit native-only expectations: C's isalnum argument is outside its domain.
    add('native-word-unicode-independent','return Array.from(new Intl.Segmenter("en",{granularity:"word"}).segment("😀x y"))',[{'segment':'😀x','index':0,'input':'😀x y','isWordLike':True},{'segment':' ','index':3,'input':'😀x y','isWordLike':False},{'segment':'y','index':4,'input':'😀x y','isWordLike':True}],True,False)
    add('native-word-lone-surrogate-independent',r'var s=new Intl.Segmenter("en",{granularity:"word"}).segment("a\ud800b");return [Array.from(s),[0,1,2].map(i=>s.containing(i))]',[[{'segment':'a\ud800b','index':0,'input':'a\ud800b','isWordLike':True}],[{'segment':'a','index':0,'input':'a\ud800b','isWordLike':True},{'segment':'\ud800','index':1,'input':'a\ud800b','isWordLike':True},{'segment':'b','index':2,'input':'a\ud800b','isWordLike':True}]],True,False)
    return result


FAULTS = [
    '(function(){return new Intl.Collator()})',
    '(function(){return Intl.Collator("de-u-co-phonebk-kn-kf-upper",{usage:"search",sensitivity:"base",collation:"emoji",numeric:false,caseFirst:"lower"})})',
    '(function(){return new Intl.Collator(["de","fr"],{collation:"unsupported"})})',
    '(function(){var c=new Intl.Collator("de-u-co-phonebk-kn-kf-upper");return function(){return c.resolvedOptions()}})()',
    '(function(){var c=new Intl.Collator;return function(){return c.compare}})()',
    '(function(){var f=new Intl.Collator("de",{usage:"search"}).compare;return function(){return f("Äffin","aeffin")}})()',
    '(function(){return "a".localeCompare("b","de-u-co-phonebk",{sensitivity:"base"})})',
    '(function(){return new Intl.Segmenter()})',
    '(function(){return new Intl.Segmenter(["xx","fr-CA"],{granularity:"word"})})',
    '(function(){var s=new Intl.Segmenter;return function(){return s.resolvedOptions()}})()',
    '(function(){var s=new Intl.Segmenter;return function(){return s.segment("áb")}})()',
    '(function(){var s=new Intl.Segmenter().segment("áb");return function(){return s[Symbol.iterator]()}})()',
    '(function(){var s=new Intl.Segmenter().segment("áb");return function(){return s.containing(0)}})()',
    '(function(){var s=new Intl.Segmenter("en",{granularity:"word"}).segment("one two");return function(){return s.containing(5)}})()',
    '(function(){var i=new Intl.Segmenter().segment("áb")[Symbol.iterator]();return function(){return i.next()}})()',
    '(function(){var i=new Intl.Segmenter("en",{granularity:"word"}).segment("one two")[Symbol.iterator]();return function(){return i.next()}})()',
    '(function(){var i=new Intl.Segmenter().segment("")[Symbol.iterator]();return function(){return i.next()}})()',
    '(function(){return Intl.Collator.supportedLocalesOf(["en","de"],{localeMatcher:"lookup"})})',
    '(function(){return Intl.Segmenter.supportedLocalesOf(["en","de"],{localeMatcher:"lookup"})})',
]
