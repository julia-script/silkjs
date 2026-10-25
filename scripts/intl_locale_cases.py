"""Inputs only; expected outcomes are always obtained from the pinned C engine."""
import json
import re

FIELDS = ['language', 'script', 'region', 'baseName', 'variants', 'calendar', 'collation',
          'hourCycle', 'numberingSystem', 'caseFirst', 'numeric', 'firstDayOfWeek']
METHODS = ['getCalendars', 'getTimeZones', 'getTextInfo', 'getWeekInfo', 'getCollations',
           'getHourCycles', 'getNumberingSystems', 'maximize', 'minimize', 'toString']
SNAPSHOT = '''function snap(tag, options) {
  var l = new Intl.Locale(tag, options), r = [];
  var fields = FIELDS;
  for (var i=0;i<fields.length;i++) r.push(l[fields[i]]);
  r.push(l.toString(), l.maximize().toString(), l.minimize().toString(),
         l.getCalendars(), l.getTimeZones(), l.getTextInfo(), l.getWeekInfo(),
         l.getCollations(), l.getHourCycles(), l.getNumberingSystems());
  return r;
}'''.replace('FIELDS', json.dumps(FIELDS))


def cases(reference):
    result = []
    def add(name, body):
        result.append((name, '(function(){' + SNAPSHOT + '\ntry {return JSON.stringify({value:(function(){' + body + '\n})()});}catch(e){return JSON.stringify({error:e.name});}})()'))
    tags = ['en', 'en-US', 'fr-FR', 'und', 'und-Zzzz-ZZ', 'de-DE', 'ar', 'he', 'fa-AF',
            'th-TH', 'zh-Hant-TW', 'sr-Latn', 'az', 'lt', 'tr', 'zz-ZZ', 'zxx',
            'en-u-ca-islamicc-co-phonebk-fw-mon-hc-h12-kf-upper-kn-nu-arab',
            'en-u-kn-false', 'en-u-ca-true-co-true-fw-true-hc-true-kf-true-kn-true-nu-true',
            'en-u-attr-ca-buddhist-x-private', 'en-a-hello-u-ca-buddhist',
            'sl-rozaj-biske-1994', 'de-1901', 'en-0-abc', 'en-x-u-ca-buddhist',
            'en-u-rg-thzzzz', 'en-u-sd-usca', 'en-u-rg-419zzzz', 'en-u-rg-xxzzzz',
            'sh', 'cnr', 'mo', 'ji', 'in', 'sgn-GR', 'de-DD', 'hy-arevmda']
    tags += ['en-Qaaa', 'qaa', 'und-QQ', 'en-u-ca-buddhist-ca-gregory',
             'en-u-foobar-abc-ca-gregory', 'en-u-rg-thzzzz-sd-usca',
             'en-u-sd-gbsct', 'en-u-rg-invalid-sd-gbsct', 'en-u-fw-sun',
             'en-a-hello-x-world', 'en-t-fr-latn-fr-u-kn']
    tags += ['en-u-'+'-'.join(chr(97+i)+'a-abc' for i in range(n)) for n in [15,16,17]]
    tags += ['en-x-'+'-'.join(['abcdefgh']*n) for n in [27,28,55,56,57,64]]
    tags += ['en-'+'-'.join('abc'+str(i).zfill(2) for i in range(n)) for n in [15,16,17]]
    for tag in tags:
        add('locale:'+tag, 'return snap('+json.dumps(tag)+');')
    options = {'language':['EN','fr','abcd','','abcde','a','a1'],
               'script':['latn','ARAB','abc','abcdx','1234'],
               'region':['us','419','zz','1234','u1'],
               'variants':['rozaj-biske','BISKE-rozaj','1901','abcd','foo','rozaj-ROZAJ','rozaj--biske',''],
               'calendar':['gregory','islamicc','ethiopic-amete-alem','gregorian','TRUE','bad!'],
               'collation':['phonebk','TRUE','foo-bar','ab'],
               'firstDayOfWeek':['0','1','2','3','4','5','6','7','8','MON','true','foo-bar'],
               'hourCycle':['h11','h12','h23','h24','H12','true'],
               'caseFirst':['upper','lower','false','Upper','true'],
               'numeric':[True,False,0,1,'', 'false',None],
               'numberingSystem':['latn','arab','native','TRUE','foo-bar','ab']}
    for prop, values in options.items():
        for value in values:
            add('option:'+prop+':'+repr(value), 'return snap("en-US-u-ca-buddhist-hc-h23",'+json.dumps({prop:value})+');')
    invalids = ['undefined','null','true','1','1n','Symbol("x")','[]','{}','""','"abcd"','"en_Us"','"en\\0US"','"en-u-ca"','"en-u"']
    for value in invalids:
        add('constructor-input:'+value, 'return snap('+value+');')
        add('canonical-input:'+value, 'return Intl.getCanonicalLocales('+value+');')
    for options_value in ['null','false','0','"x"','Symbol()','1n']:
        add('options-object:'+options_value, 'return snap("en",'+options_value+');')
    add('constructor-requires-new', 'return Intl.Locale("en");')
    add('subclass', 'class L extends Intl.Locale {} var x=new L("en-US"); return [x instanceof L,x instanceof Intl.Locale,Object.getPrototypeOf(x)===L.prototype,x.maximize() instanceof L,x.maximize() instanceof Intl.Locale];')
    add('newTarget-prototype-order', 'var log=[]; function N(){}; var p=new Proxy(N,{get:function(t,k){log.push(String(k)); return Reflect.get(t,k);}}); var opts=new Proxy({},{get:function(t,k){log.push(k);return undefined;}}); Reflect.construct(Intl.Locale,["en",opts],p); return log;')
    add('newTarget-nonobject-prototype', 'function N(){} N.prototype=7; var x=Reflect.construct(Intl.Locale,["en"],N); return Object.getPrototypeOf(x)===Intl.Locale.prototype;')
    add('option-read-order', 'var log=[]; snap({toString:function(){log.push("tag");return "en";}},new Proxy({},{get:function(t,k){log.push(k);return undefined;}})); return log;')
    for prop in options:
        add('option-throw:'+prop, 'var log=[];try{snap("en",new Proxy({},{get:function(t,k){log.push(k);if(k==='+json.dumps(prop)+')throw Error("poison");return undefined;}}));}catch(e){log.push(e.name);}return log;')
    add('locale-object-bypasses-string', 'var l=new Intl.Locale("fr");l.toString=function(){throw Error("poison");};return [new Intl.Locale(l).toString(),Intl.getCanonicalLocales(l),Intl.getCanonicalLocales([l])];')
    add('proxy-locale-not-branded', 'return new Intl.Locale(new Proxy(new Intl.Locale("en"),{})).toString();')
    add('poisoned-tag-invalid-options-order', 'var log=[];try{new Intl.Locale({toString:function(){log.push("tag");return "INVALID_";}},null);}catch(e){log.push(e.name);}return log;')
    add('symbol-toPrimitive-tag', 'var log=[];var t={};t[Symbol.toPrimitive]=function(h){log.push(h);return "fr";};return [new Intl.Locale(t).toString(),log];')
    add('boxed-string-locale-list', 'return Intl.getCanonicalLocales(new String("en"));')
    add('revoked-locale-proxy', 'var p=Proxy.revocable(new Intl.Locale("en"),{});p.revoke();return Intl.getCanonicalLocales(p.proxy);')
    add('intrinsic-constructor-root', 'var original=Intl.Locale;var prior=original.prototype.constructor;try{original.prototype.constructor=function(){throw Error("poison");};var l=new original("en");Intl.Locale=function(){throw Error("replaced");};return [l.maximize().toString(),l.minimize().toString()];}finally{Intl.Locale=original;original.prototype.constructor=prior;}')
    add('canonical-side-effects', 'var log=[];var x=new Proxy({length:3,0:"EN-us",2:{toString:function(){log.push("string");return "fr";}}},{get:function(t,k){log.push("get:"+String(k));return Reflect.get(t,k);},has:function(t,k){log.push("has:"+String(k));return Reflect.has(t,k);}});var r=Intl.getCanonicalLocales(x);return [r,log];')
    for length in ['-1','0','1.9','NaN','Infinity','4294967296','"2"','1n','{valueOf:function(){throw Error("poison");}}']:
        # Huge lengths deliberately throw at first has trap; never iterate billions.
        add('length:'+length, 'var log=[];var p=new Proxy({length:'+length+',0:"en",1:"fr"},{has:function(t,k){log.push(k);if(log.length===3)throw RangeError("stop");return Reflect.has(t,k);}});try{log.push(Intl.getCanonicalLocales(p));}catch(e){log.push(e.name);}return log;')
    add('canonical-all-elements-before-first', 'return "I".toLocaleLowerCase(["tr",{toString:function(){throw Error("later");}}]);')
    for key in ['calendar','collation','currency','numberingSystem','timeZone','unit','invalid','Calendar','calendar\0']:
        add('supported-values:'+key, 'return Intl.supportedValuesOf('+json.dumps(key)+');')
    for lang in ['tr','az','lt','en','trv','azb','ltg']:
        add('string-language:'+lang, 'return ["Iİiı".toLocaleLowerCase('+json.dumps(lang)+'),"iı".toLocaleUpperCase('+json.dumps(lang)+')];')
    add('namespace-descriptors', 'return Object.getOwnPropertyNames(Intl).filter(function(k){return k==="Locale"||k==="getCanonicalLocales"||k==="supportedValuesOf";}).map(function(k){var d=Object.getOwnPropertyDescriptor(Intl,k);return [k,d.writable,d.enumerable,d.configurable,d.value.name,d.value.length];});')
    add('prototype-descriptors', 'return Reflect.ownKeys(Intl.Locale.prototype).map(function(k){var d=Object.getOwnPropertyDescriptor(Intl.Locale.prototype,k);return [String(k),d.writable,d.enumerable,d.configurable,d.value&&typeof d.value==="function"?d.value.name:d.value,d.get&&d.get.name,d.get&&d.get.length,d.set];});')
    add('constructor-descriptors', 'return [Object.getOwnPropertyDescriptor(Intl.Locale,"prototype"),Object.getPrototypeOf(Intl.Locale)===Function.prototype,Object.getPrototypeOf(Intl.Locale.prototype)===Object.prototype,Object.prototype.toString.call(new Intl.Locale("en"))];')
    for member in FIELDS + METHODS:
        call = 'Object.getOwnPropertyDescriptor(Intl.Locale.prototype,'+json.dumps(member)+').get.call(x)' if member in FIELDS else 'Intl.Locale.prototype['+json.dumps(member)+'].call(x)'
        add('brands:'+member, 'return [undefined,null,1,"en",{},Intl.Locale.prototype,new Proxy(new Intl.Locale("en"),{})].map(function(x){try{return '+call+';}catch(e){return e.name;}});')
    add('supported-locales-order', 'var log=[];var locales=new Proxy({length:1,0:"en"},{get:function(t,k){log.push("locale:"+String(k));return Reflect.get(t,k);},has:function(t,k){log.push("has:"+String(k));return Reflect.has(t,k);}});var options=new Proxy({},{get:function(t,k){log.push("option:"+String(k));return undefined;}});return [__supportedLocalesOf(locales,options),log];')
    for value in ['undefined','null','["EN-us","en-US","zxx","zxx-US","fr"]','[1]']:
        add('supported-locales:'+value, 'return __supportedLocalesOf('+value+',{localeMatcher:"lookup"});')
    add('supported-locales-empty-ignores-options', 'return __supportedLocalesOf(undefined,{get localeMatcher(){throw Error("poison");}});')
    add('supported-locales-boxing', 'return __supportedLocalesOf(["en"],true);')
    # Exercise every logical table key using independent pinned-C data declarations.
    source = (reference/'intl/locale-data.c').read_text()
    pools = {}
    for table in ['likely_subtags_tab','cal_pref_tab','time_data_tab','week_data_tab','script_dir_tab']:
        body = source.split(table+'[] = {',1)[1].split('\n};',1)[0]
        if table == 'likely_subtags_tab':
            keys = re.findall(r'^\s*"([^"\\]+)\\000',body,re.M)
            tags = keys
        else:
            keys = re.findall(r'\{ "([^"]+)"',body)
            if table == 'script_dir_tab': tags = ['und-'+key for key in keys]
            else: tags = [key if '-' in key else 'und-'+key for key in keys]
        pools[table] = tags
    zone_source=(reference/'temporal/tzdata_generated.c').read_text()
    body=zone_source.split('ti_tz_region_tab[] = {',1)[1].split('\n};',1)[0]
    pools['zones']=['und-'+key for key in re.findall(r'\{ "([^"]+)"',body)]
    for table, tags in pools.items():
        if not tags: raise ValueError('No table inputs discovered: '+table)
        for start in range(0,len(tags),32):
            batch=tags[start:start+32]
            add('data:'+table+':'+str(start), 'return '+json.dumps(batch)+'.map(function(t){try{return [t,snap(t)];}catch(e){return [t,e.name];}});')
    return result

FAULTS = [
    '(function(){return new Intl.Locale("en-US");})',
    '(function(){return new Intl.Locale("en-US-u-ca-buddhist",{language:"fr",script:"Latn",region:"CA",variants:"rozaj-biske",calendar:"islamicc",collation:"phonebk",firstDayOfWeek:7,hourCycle:"h12",caseFirst:"upper",numeric:true,numberingSystem:"arab"});})',
    '(function(){return Intl.getCanonicalLocales(["en","fr","zh-Hant-TW","EN"]);})',
    '(function(){return Intl.supportedValuesOf("currency");})',
    '(function(){return new Intl.Locale("en-u-rg-thzzzz").getCalendars();})',
    '(function(){return new Intl.Locale("en").getTextInfo();})',
    '(function(){return new Intl.Locale("en-US").getTimeZones();})',
    '(function(){return new Intl.Locale("en-US").getWeekInfo();})',
    '(function(){return new Intl.Locale("de").getCollations();})',
    '(function(){return new Intl.Locale("en").getHourCycles();})',
    '(function(){return new Intl.Locale("en").getNumberingSystems();})',
    '(function(){return new Intl.Locale("sr-u-ca-gregory").maximize();})',
    '(function(){return new Intl.Locale("sr-Cyrl-RS-u-kn").minimize();})',
    '(function(){return __supportedLocalesOf(["en","fr","zxx"]);})',
]

def utilities():
    result = []
    def add(name, kind, expression):
        result.append((name, kind, 'var __log=[];var __utilityInput='+expression+';__utilityInput;'))
    for value in ['undefined','null','0','1.999','2','2.75','6','6.01','NaN','Infinity','-Infinity','"3"','1n','Symbol()','{valueOf:function(){__log.push("valueOf");return 3.9;}}','{valueOf:function(){__log.push("valueOf");throw Error("poison");}}']:
        add('number-option:'+value,0,'({get value(){__log.push("get");return '+value+';}})')
    for value in ['undefined','"lookup"','"best fit"','"LOOKUP"','"lookup\\0"','null','1','1n','Symbol()','{toString:function(){__log.push("toString");return "lookup";}}']:
        add('string-option:'+value,1,'({get value(){__log.push("get");return '+value+';}})')
    for kind in [2,3]:
        for property in ['none','weekday','year','month','day','dateStyle','hour','minute','second','timeStyle']:
            add('has-fields:'+str(kind)+':'+property,kind,'new Proxy({},{get:function(t,k){__log.push(k);return k==='+json.dumps(property)+'?null:undefined;}})')
        add('has-fields-poison:'+str(kind),kind,'new Proxy({},{get:function(t,k){__log.push(k);throw Error("poison");}})')
        add('has-fields-null:'+str(kind),kind,'null')
    for value in ['undefined','null','true','0','"x"','{}','new Proxy({},{get:function(){throw Error("not-read");}})']:
        add('options-object-helper:'+value,4,value)
    for kind in [5,6]:
        for value in ['undefined','[]','["en-US-u-ca-buddhist","fr"]','new Intl.Locale("de-u-kn")','["en",{toString:function(){__log.push("later");throw Error("poison");}}]','null']:
            add('locale-extract-first:'+str(kind)+':'+value,kind,value)
    return result
