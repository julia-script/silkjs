"""Observable pinned NumberFormat contracts; expected strings never use native helpers."""
import json


def expression(body):
    return 'JSON.stringify((function(){try{return '+body+'}catch(e){return {error:e.name,message:e.message}}})())'


def cases():
    result=[]
    def add(name, body): result.append((name, expression(body)))
    add('independent/default', "new Intl.NumberFormat('en-US').format(12345.6789)")
    add('independent/exact-bigint', "new Intl.NumberFormat('en-US').format(9007199254740993n)")
    add('independent/exact-string', "new Intl.NumberFormat('en-US',{useGrouping:false,maximumFractionDigits:20}).format('9007199254740993.125')")
    add('independent/parts', "new Intl.NumberFormat('en-US').formatToParts(-1234.5)")
    add('surface/descriptors', "[Intl.NumberFormat.length,Intl.NumberFormat.name,Object.getOwnPropertyNames(Intl.NumberFormat.prototype).map(k=>{let d=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,k);return [k,d.enumerable,d.configurable,d.writable,typeof d.value,d.value&&d.value.length,!!d.get,!!d.set]}),Object.prototype.toString.call(new Intl.NumberFormat)]")
    add('surface/call-new-subclass', "(()=>{class N extends Intl.NumberFormat{};let n=new N('de');return [Intl.NumberFormat('en').format(12),n instanceof N,n instanceof Intl.NumberFormat,n.format(1234.5),Object.getPrototypeOf(Reflect.construct(Intl.NumberFormat,[],function(){}))===Intl.NumberFormat.prototype]})()")
    add('surface/cross-realm-default', "(()=>{function T(){};T.prototype=1;let n=Reflect.construct(__otherNumberFormat,[],T);return [Object.getPrototypeOf(n)===Intl.NumberFormat.prototype,n.format(1),__otherNumberFormat.prototype.isPrototypeOf(new __otherNumberFormat)]})()")
    add('surface/foreign-newtarget-default', "(()=>{let T=__otherNumberFormat.constructor('return function T(){}')();T.prototype=null;let n=Reflect.construct(Intl.NumberFormat,['de'],T);return [Object.getPrototypeOf(n)===__otherNumberFormat.prototype,n.format(1234.5)]})()")
    add('surface/foreign-call', "(()=>{let n=Object.create(__otherNumberFormat.prototype),r=__otherNumberFormat.call(n,'de');return [r===n,n.format(1234.5),Object.getOwnPropertySymbols(n).length]})()")
    add('surface/bound-cache', "(()=>{let n=new Intl.NumberFormat;let f=n.format;return [f===n.format,f.name,f.length,f.call({},1234),Object.keys(n),Object.getOwnPropertyDescriptor(n,'__boundFormat__').enumerable]})()")
    add('surface/bound-cache-replacement', "(()=>{let n=new Intl.NumberFormat;n.__boundFormat__=function(){return 42};let a=n.format();n.__boundFormat__=1;return [a,n.format(12),typeof n.__boundFormat__]})()")
    add('surface/legacy', "(()=>{let n=Object.create(Intl.NumberFormat.prototype),r=Intl.NumberFormat.call(n,'de');let s=Object.getOwnPropertySymbols(n)[0];return [r===n,n.format(1234.5),n.formatToParts(1),n.resolvedOptions(),n.formatRange(1,2),String(s),Object.getOwnPropertyDescriptor(n,s).writable]})()")
    add('surface/branded-rechain', "(()=>{let n=new Intl.NumberFormat('en');Intl.NumberFormat.call(n,'de');return [n.format(1234.5),Object.getOwnPropertySymbols(n).length]})()")
    add('surface/cache-accessor-order', "(()=>{let n=new Intl.NumberFormat,log=[],stored;Object.defineProperty(n,'__boundFormat__',{get(){log.push('get');return 1},set(v){log.push('set');stored=v}});let f=n.format;return [log,f===stored,f(1234.5)]})()")
    add('surface/cache-getter-throws', "(()=>{let n=new Intl.NumberFormat,log=[];Object.defineProperty(n,'__boundFormat__',{get(){log.push('get');throw Error('cache')},set(v){log.push('set')}});let f=n.format;return [log,typeof f,f(1)]})()")
    add('surface/cache-setter-throws', "(()=>{let n=new Intl.NumberFormat,log=[];Object.defineProperty(n,'__boundFormat__',{get(){log.push('get')},set(v){log.push('set');throw Error('cache')}});let f=n.format;return [log,typeof f,f(1)]})()")
    add('surface/cache-nonextensible', "(()=>{let n=Object.preventExtensions(new Intl.NumberFormat),f=n.format;return [typeof f,f(1),n.format===f]})()")
    add('surface/legacy-reinitialize', "(()=>{let n=Object.create(Intl.NumberFormat.prototype);Intl.NumberFormat.call(n,'en');let r=Intl.NumberFormat.call(n,'de');return [n===r,n.format(1234.5),Object.getOwnPropertySymbols(n).length]})()")
    for method in ['format','formatToParts','formatRange','formatRangeToParts','resolvedOptions']:
        get="Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get" if method=='format' else 'Intl.NumberFormat.prototype.'+method
        for value in ['undefined','null','1','{}','Object.create(Intl.NumberFormat.prototype)','new Proxy(new Intl.NumberFormat,{})']:
            add('brand/'+method+'/'+value, '('+get+').call('+value+',1,2)')
    values=['undefined','null','false','true','0','-0','1','-1','1.25','-1.25','1234.56789','1e21','1e-7','NaN','Infinity','-Infinity','9007199254740993123456789n',"'9007199254740993123456789.123456789'","''","'  '","'-'","'.'","'1e'","'1e+'","'0x10'","'Infinity '","'+Infinity'","'1\\u00002'","'\\u00a01'",'Symbol()']
    for value in values: add('values/'+value, "(()=>{let n=new Intl.NumberFormat('en-US');return [n.format("+value+'),n.formatToParts('+value+')]})()')
    locales=['en-US','de-DE','fr-FR','ar','fa','hi-IN','bn','zh-CN','ja','ru','sv','pl','es','pt-BR','en-u-nu-arab','en-u-nu-hanidec','en-u-nu-fullwide','en-u-nu-mathsans','xx-ZZ']
    for locale in locales:
        for style in [{},{'style':'percent'},{'style':'currency','currency':'USD'},{'style':'currency','currency':'JPY','currencyDisplay':'name'},{'style':'unit','unit':'meter-per-second','unitDisplay':'long'}]:
            opts=json.dumps(style)
            add('locale/'+locale+'/'+opts,"(()=>{let n=new Intl.NumberFormat("+json.dumps(locale)+','+opts+");return [n.resolvedOptions(),[-12345.625,0,1,2,Infinity,NaN].map(x=>[n.format(x),n.formatToParts(x)])]})()")
    for mode in ['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven']:
        for increment in [1,2,5,10,20,25,50,100,200,250,500,1000,2000,2500,5000]:
            opts={'minimumFractionDigits':2,'maximumFractionDigits':2,'roundingMode':mode,'roundingIncrement':increment}
            add('rounding/'+mode+'/'+str(increment),"(()=>{let n=new Intl.NumberFormat('en',"+json.dumps(opts)+");return ['-1234.125','-12.345','-1.235','1.235','12.345','1234.125','0','-0'].map(x=>[n.format(x),n.formatToParts(x)])})()")
        for priority in ['auto','morePrecision','lessPrecision']:
            opts={'minimumSignificantDigits':3,'maximumSignificantDigits':4,'minimumFractionDigits':1,'maximumFractionDigits':2,'roundingMode':mode,'roundingPriority':priority}
            add('precision/'+mode+'/'+priority,"(()=>{let n=new Intl.NumberFormat('en',"+json.dumps(opts)+");return ['999.95','9.9995','0.12345','1234567890123456789012345','1.234567890123456789012345','-1.25'].map(x=>n.format(x))})()")
    for notation in ['standard','scientific','engineering','compact']:
        for compact in ['short','long']:
            for sign in ['auto','never','always','exceptZero','negative']:
                opts={'notation':notation,'compactDisplay':compact,'signDisplay':sign}
                add('notation/'+notation+'/'+compact+'/'+sign,"(()=>{let n=new Intl.NumberFormat('en',"+json.dumps(opts)+");return [-1234567,-1,-0,0,1,999,1000,999999,1e21,0.000123,NaN,Infinity].map(x=>[n.format(x),n.formatToParts(x)])})()")
    for grouping in [True,False,'auto','min2','always','true','false']:
        for loc in ['en','hi','es']:
            add('group/'+loc+'/'+str(grouping),"(()=>{let n=new Intl.NumberFormat('"+loc+"',{useGrouping:"+json.dumps(grouping)+"});return [n.resolvedOptions(),[999,1000,10000,1000000].map(x=>[n.format(x),n.formatToParts(x)])]})()")
    for currency in ['USD','EUR','JPY','KWD','CLF','XXX','abc']:
        for display in ['code','symbol','narrowSymbol','name']:
            for sign in ['standard','accounting']:
                add('currency/'+currency+'/'+display+'/'+sign,"(()=>{let n=new Intl.NumberFormat('en',{style:'currency',currency:'"+currency+"',currencyDisplay:'"+display+"',currencySign:'"+sign+"'});return [n.resolvedOptions(),[-1,0,1,2].map(x=>[n.format(x),n.formatToParts(x)])]})()")
    units=['acre','bit','byte','celsius','centimeter','day','degree','fahrenheit','fluid-ounce','foot','gallon','gigabit','gigabyte','gram','hectare','hour','inch','kilobit','kilobyte','kilogram','kilometer','liter','megabit','megabyte','meter','microsecond','mile','mile-scandinavian','milliliter','millimeter','millisecond','minute','month','nanosecond','ounce','percent','petabyte','pound','second','stone','terabit','terabyte','week','yard','year','meter-per-second','kilometer-per-hour','byte-per-second']
    for unit in units:
        for display in ['short','narrow','long']:
            add('unit/'+unit+'/'+display,"(()=>{let n=new Intl.NumberFormat('en',{style:'unit',unit:'"+unit+"',unitDisplay:'"+display+"'});return [0,1,2].map(x=>[n.format(x),n.formatToParts(x)])})()")
    invalid={'style':['bad',None], 'currency':['US','US12','U$D','USD\u0000'],'unit':['','Meter','meter-per-second-per-hour','bogus'],'numberingSystem':['','ab','abcdefghi','latn-','latn\u0000bad'],'notation':['bad'],'compactDisplay':['bad'],'currencyDisplay':['bad'],'currencySign':['bad'],'unitDisplay':['bad'],'signDisplay':['bad'],'roundingMode':['bad'],'roundingPriority':['bad'],'trailingZeroDisplay':['bad'],'useGrouping':['bad'],'minimumIntegerDigits':[0,22,None],'minimumFractionDigits':[-1,101],'maximumFractionDigits':[-1,101],'minimumSignificantDigits':[0,22],'maximumSignificantDigits':[0,22],'roundingIncrement':[0,3,5001]}
    for key, vals in invalid.items():
        for v in vals: add('invalid/'+key+'/'+str(v),'new Intl.NumberFormat("en",'+json.dumps({key:v})+').resolvedOptions()')
    for options in [None,1,True,'x',{'minimumFractionDigits':3,'maximumFractionDigits':2},{'minimumSignificantDigits':4,'maximumSignificantDigits':3},{'roundingIncrement':5},{'roundingIncrement':5,'maximumSignificantDigits':3},{'roundingIncrement':5,'roundingPriority':'morePrecision'},{'style':'currency'},{'style':'unit'},{'minimumFractionDigits':2,'trailingZeroDisplay':'stripIfInteger'}]:
        add('options/'+json.dumps(options),'(()=>{let n=new Intl.NumberFormat("en",'+json.dumps(options)+');return [n.resolvedOptions(),n.format(1)]})()')
    order=['localeMatcher','numberingSystem','style','currency','currencyDisplay','currencySign','unit','unitDisplay','notation','minimumIntegerDigits','minimumFractionDigits','maximumFractionDigits','minimumSignificantDigits','maximumSignificantDigits','roundingIncrement','roundingMode','roundingPriority','trailingZeroDisplay','compactDisplay','useGrouping','signDisplay']
    for stop in [None]+order:
        add('order/'+str(stop),"(()=>{let log=[];let o=new Proxy({},{get(t,k){log.push(k);"+("if(k==="+json.dumps(stop)+")throw new Error('stop');" if stop else '')+"return undefined}});try{new Intl.NumberFormat('en',o)}catch(e){log.push(e.name)}return log})()")
    add('order/coercion',"(()=>{let log=[];let n=new Intl.NumberFormat;let v={[Symbol.toPrimitive](h){log.push(h);return '9007199254740993'}};return [n.format(v),n.formatToParts(v),n.formatRange(v,v),log]})()")
    add('supported/order',"(()=>{let log=[];let a={get length(){log.push('length');return 1},get 0(){log.push('0');return 'de'}};let o={get localeMatcher(){log.push('matcher');return 'lookup'}};return [Intl.NumberFormat.supportedLocalesOf(a,o),log]})()")
    for locales_value in ['undefined','null',"['en-US','de','zz','en-US']","new Intl.Locale('fr')","{length:2,0:'de',1:'ar'}"]:
        add('supported/'+locales_value,'Intl.NumberFormat.supportedLocalesOf('+locales_value+')')
    for opts in [{},{'style':'percent'},{'style':'currency','currency':'USD'},{'style':'currency','currency':'EUR','currencyDisplay':'name'},{'style':'unit','unit':'meter'},{'notation':'compact'},{'signDisplay':'always'}]:
        for loc in ['en','de','fr','ar','ja']:
            add('range/'+loc+'/'+json.dumps(opts),"(()=>{let n=new Intl.NumberFormat('"+loc+"',"+json.dumps(opts)+");return [[1,2],[1,1],[1.001,1.002],[-2,-1],[-1,1],[Infinity,Infinity],[2,1]].map(([a,b])=>[n.formatRange(a,b),n.formatRangeToParts(a,b)])})()")
    for pair in ['','1','undefined,2','1,undefined','NaN,2',"'bad',2",'Symbol(),1']:
        add('range/invalid/'+pair,'new Intl.NumberFormat().formatRange('+pair+')')
    add('locale/adapters',"[1234567.5.toLocaleString('de'),(900719925474099312345n).toLocaleString('en'),Number.prototype.toLocaleString.call(new Number(-0),'en'),BigInt.prototype.toLocaleString.call(Object(123n),'en')]")
    add('numbering/all-systems', "Intl.supportedValuesOf('numberingSystem').map(numberingSystem=>{let n=new Intl.NumberFormat('en',{numberingSystem});return [numberingSystem,n.resolvedOptions().numberingSystem,n.format(-1234567890.125),n.formatToParts(12345.6)]})")
    add('currency/all-digits', "Intl.supportedValuesOf('currency').map(currency=>{let n=new Intl.NumberFormat('en',{style:'currency',currency});return [currency,n.resolvedOptions().minimumFractionDigits,n.format(1.234567)]})")
    for option in [{'minimumIntegerDigits':21}, {'minimumFractionDigits':100,'maximumFractionDigits':100}, {'minimumSignificantDigits':21,'maximumSignificantDigits':21}, {'maximumFractionDigits':0,'roundingMode':'halfEven'}, {'roundingPriority':'lessPrecision'}, {'roundingPriority':'morePrecision'}, {'notation':'engineering','minimumIntegerDigits':5}, {'notation':'scientific','minimumFractionDigits':5}]:
        add('boundary/'+json.dumps(option), "(()=>{let n=new Intl.NumberFormat('en',"+json.dumps(option)+");return [n.resolvedOptions(),['0','-0','1','1.234567890123456789012345','999999999999999999999.9999','0.00000000000000000000000012345'].map(x=>[n.format(x),n.formatToParts(x)])]})()")
    add('rounding/overflow-modulus', "['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven'].map(roundingMode=>[roundingMode,new Intl.NumberFormat('en',{maximumFractionDigits:0,roundingMode}).format('1.234567890123456789012345'),new Intl.NumberFormat('en',{maximumFractionDigits:0,roundingMode}).format('0.0000000000000000000000001')])")
    for method in ['formatRange','formatRangeToParts']:
        add('range/repeated-coercion/'+method, "(()=>{let log=[],i=0;let a={valueOf(){log.push('a');return ++i}},b={valueOf(){log.push('b');return ++i}};let n=new Intl.NumberFormat;return [n."+method+"(a,b),log]})()")
    add('constructor/option-before-prototype', "(()=>{let log=[];let target=new Proxy(function(){},{get(t,k){log.push(k);return Reflect.get(t,k)}});let opts=new Proxy({},{get(t,k){log.push(k)}});Reflect.construct(Intl.NumberFormat,['en',opts],target);return log})()")
    add('constructor/ignored-hasinstance', "(()=>{let ctor=Intl.NumberFormat,log=[];Object.defineProperty(ctor,Symbol.hasInstance,{configurable:true,value(){log.push('hasInstance');return false}});try{let n=Object.create(ctor.prototype);return [ctor.call(n)===n,n.format(1),log]}finally{delete ctor[Symbol.hasInstance]}})()")
    for loc,units_for_locale in [('en',['percent','kilometer-per-hour','day','hour','minute','second','week','month','year']),('en-GB',['hour','minute','second']),('de',['kilometer-per-hour','hour','minute','second']),('ja',['kilometer-per-hour','hour','minute','second']),('ko',['kilometer-per-hour']),('zh',['kilometer-per-hour','hour','minute','second']),('zh-Hant',['hour','minute','second'])]:
        add('unit-patterns/'+loc, json.dumps(units_for_locale)+".map(unit=>['short','narrow','long'].map(unitDisplay=>{let n=new Intl.NumberFormat('"+loc+"',{style:'unit',unit,unitDisplay});return [0,1,2,-1].map(x=>[n.format(x),n.formatToParts(x)])}))")
    for loc in locales+['ko','zh-Hant','it','nl','tr','id','th','vi','uk','cs','da','fi','nb','he','ur','ta','te','ml']:
        add('compact-patterns/'+loc, "['short','long'].map(compactDisplay=>{let n=new Intl.NumberFormat("+json.dumps(loc)+",{notation:'compact',compactDisplay});return [1,1000,10000,100000,1000000,1000000000,1000000000000,1000000000000000,-1234567].map(x=>[n.format(x),n.formatToParts(x)])})")
    return result


INDEPENDENT = {
    'independent/default':'12,345.679',
    'independent/exact-bigint':'9,007,199,254,740,993',
    'independent/exact-string':'9007199254740993.125',
    'independent/parts':[{'type':'minusSign','value':'-'},{'type':'integer','value':'1'},{'type':'group','value':','},{'type':'integer','value':'234'},{'type':'decimal','value':'.'},{'type':'fraction','value':'5'}],
}
FAULTS = [
    "(()=>new Intl.NumberFormat('en-u-nu-arab',{style:'currency',currency:'USD',minimumFractionDigits:2}))",
    "(()=>new Intl.NumberFormat('de',{notation:'compact',compactDisplay:'long'}))",
    "(()=>{let n=Object.create(Intl.NumberFormat.prototype);return ()=>Intl.NumberFormat.call(n,'en')})()",
    "(()=>{let n=new Intl.NumberFormat;return ()=>n.format})()",
    "(()=>{let n=new Intl.NumberFormat;return ()=>n.format('9007199254740993.125')})()",
    "(()=>{let n=new Intl.NumberFormat('ar',{style:'currency',currency:'EUR'});return ()=>n.formatToParts(-1234567.25)})()",
    "(()=>{let n=new Intl.NumberFormat('en',{style:'unit',unit:'meter-per-second',unitDisplay:'long'});return ()=>n.formatToParts(1.25)})()",
    "(()=>{let n=new Intl.NumberFormat('en',{notation:'scientific'});return ()=>n.formatToParts(12345)})()",
    "(()=>{let n=new Intl.NumberFormat('en',{notation:'compact'});return ()=>n.formatToParts(12345)})()",
    "(()=>{let n=new Intl.NumberFormat('en',{roundingPriority:'morePrecision',maximumSignificantDigits:3});return ()=>n.formatToParts('123456.12345')})()",
    "(()=>{let n=new Intl.NumberFormat('de',{style:'currency',currency:'EUR'});return ()=>n.formatRange(1,2)})()",
    "(()=>{let n=new Intl.NumberFormat;return ()=>n.formatRangeToParts(1,2)})()",
    "(()=>{let n=new Intl.NumberFormat;return ()=>n.resolvedOptions()})()",
    "(()=>Intl.NumberFormat.supportedLocalesOf(['en','de','zz']))",
    "(()=>1234.5.toLocaleString('fr'))",
    "(()=>(9007199254740993n).toLocaleString('ar'))",
    "(()=>{let n=new Intl.NumberFormat('en',{maximumFractionDigits:0,roundingMode:'ceil'});return ()=>n.formatToParts('0.0001')})()",
    "(()=>{let n=new Intl.NumberFormat('en');let v='1'+'0'.repeat(100);return ()=>n.formatToParts(v)})()",
]


def native_boundaries():
    """Independent exact results only: pinned C has no defined output here."""
    result=[]
    for digits, positive, negative in [(0,'1','-1'),(2,'0.01','-0.01'),(6,'0.000001','-0.000001')]:
        tiny='0.'+'0'*(digits+3)+'1'
        for mode in ['ceil','floor','expand']:
            expected=[positive,'-0']
            if mode=='floor': expected=['0',negative]
            if mode=='expand': expected=[positive,negative]
            body="(()=>{let n=new Intl.NumberFormat('en',{useGrouping:false,maximumFractionDigits:"+str(digits)+",roundingMode:'"+mode+"'});return [n.format('"+tiny+"'),n.format('-"+tiny+"')]})()"
            result.append(('native-undefined/tiny/'+str(digits)+'/'+mode,expression(body),expected))
    result.append(('native-undefined/long-grouped',expression("new Intl.NumberFormat('en').format('1'+'0'.repeat(100))"),'10'+',000'*33))
    return result
