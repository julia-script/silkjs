"""Actual-Engine auxiliary Intl contracts, source parity, and allocation operations."""
import json
from intl_text_bridge_cases import wrapped, js
from intl_list_cases import cases as list_cases, FAULTS as LIST_FAULTS
from intl_display_plural_cases import cases as display_plural_cases, FAULTS as DISPLAY_PLURAL_FAULTS
from intl_relative_cases import cases as relative_cases, FAULTS as RELATIVE_FAULTS


def duration_cases():
    rows=[]
    def add(name,body,expected=None,independent=False,portable=True):
        rows.append(('duration-'+name,wrapped(body),['ok',expected] if independent else None,portable))
    def error(name,body,kind='RangeError'):
        rows.append(('duration-'+name,wrapped(body),['error',kind],True))
    add('empty','return [new Intl.DurationFormat().format({seconds:0}),new Intl.DurationFormat().formatToParts({seconds:0})]',['',[]],True)
    add('digital','return new Intl.DurationFormat("en",{style:"digital"}).format({hours:1,minutes:2,seconds:3})','1:02:03',True)
    add('digital-negative','return new Intl.DurationFormat("en",{style:"digital"}).format({minutes:-2,seconds:-3})','-0:02:03',True)
    add('digital-fraction','return new Intl.DurationFormat("en",{style:"digital",fractionalDigits:3}).format({seconds:1,milliseconds:234,microseconds:567})','0:00:01.234',True)
    add('digital-parts','return new Intl.DurationFormat("en",{style:"digital"}).formatToParts({hours:1,minutes:2,seconds:3})',[{'type':'integer','value':'1','unit':'hour'},{'type':'literal','value':':'},{'type':'integer','value':'02','unit':'minute'},{'type':'literal','value':':'},{'type':'integer','value':'03','unit':'second'}],True)
    add('branded','var f=new Intl.DurationFormat("en",{style:"digital"});return [f.format(new Temporal.Duration(0,0,0,0,1,2,3)),f.format("PT1H2M3S"),f.format({hours:1,minutes:2,seconds:3})]',['1:02:03']*3,True)
    add('foreign-branded','return new Intl.DurationFormat("en",{style:"digital"}).format(new __foreignDuration(0,0,0,0,1,2,3))','1:02:03',True)
    add('brand-before-conversion','var log=[];try{Intl.DurationFormat.prototype.format.call({},new Proxy({},{get(t,k){log.push(String(k));throw 1}}))}catch(e){return [e.name,log]}',['TypeError',[]],True)
    add('getter-order','var log=[],o={};for(let k of ["years","months","weeks","days","hours","minutes","seconds","milliseconds","microseconds","nanoseconds"])Object.defineProperty(o,k,{get(){log.push(k);return 0}});new Intl.DurationFormat().format(o);return log',['days','hours','microseconds','milliseconds','minutes','months','nanoseconds','seconds','weeks','years'],True)
    add('constructor-order','var log=[],C=new Proxy(function(){},{get(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}});Reflect.construct(Intl.DurationFormat,[["en"],new Proxy({},{get(t,k){log.push(String(k));return undefined}})],C);return log',['prototype','localeMatcher','numberingSystem','style',*sum(([u,u+'Display'] for u in ['years','months','weeks','days','hours','minutes','seconds','milliseconds','microseconds','nanoseconds']),[]),'fractionalDigits'],True)
    for temporal in ['new Temporal.Instant(0n)','new Temporal.PlainDate(2024,1,2)','new Temporal.PlainDateTime(2024,1,2,3,4,5)','new Temporal.PlainTime(3,4,5)','new Temporal.PlainYearMonth(2024,1)','new Temporal.PlainMonthDay(1,2)','new Temporal.ZonedDateTime(0n,"UTC")']:
        add('temporal-input-'+temporal,'return new Intl.DurationFormat().format('+temporal+')')
    for value in ['{seconds:2**53-1}','{milliseconds:2**62}','{microseconds:2**72}','{nanoseconds:2**82}','"PT9007199254740991S"','"PT0.000000001S"','"-PT0.000000001S"']:
        add('wide-digital-'+value,'var f=new Intl.DurationFormat("en",{style:"digital"});return [f.format('+value+'),f.formatToParts('+value+')]')
    add('getter-throws-order','var log=[],d={get days(){log.push("days");return 1},get hours(){log.push("hours");throw new SyntaxError()},get seconds(){log.push("seconds");return 2}};try{new Intl.DurationFormat().format(d)}catch(e){return [e.name,log]}',['SyntaxError',['days','hours']],True)
    add('setter-side-effects','var log=[];Object.defineProperty(Object.prototype,"numberingSystem",{set(v){log.push(v)},configurable:true});try{return [new Intl.DurationFormat("en",{style:"digital"}).format({seconds:1}),log]}finally{delete Object.prototype.numberingSystem}')
    for locale in ['en','en-GB','es','de','fr','ar','fa','bn','ja','en-u-nu-arab','fr-u-nu-foobar']:
        for style in ['long','short','narrow','digital']:
            add('matrix-'+locale+'-'+style,'var f=new Intl.DurationFormat('+js(locale)+',{style:'+js(style)+'});var d={years:1,months:2,weeks:3,days:4,hours:5,minutes:6,seconds:7,milliseconds:8,microseconds:9,nanoseconds:10};return [f.resolvedOptions(),f.format(d),f.formatToParts(d)]')
    for unit in ['years','months','weeks','days','hours','minutes','seconds','milliseconds','microseconds','nanoseconds']:
        for value in [0,1,2,-1,1234]:
            for style in ['long','short','narrow']:
                add('unit-'+unit+'-'+str(value)+'-'+style,'var f=new Intl.DurationFormat("en",{style:'+js(style)+'}),d='+js({unit:value})+';return [f.format(d),f.formatToParts(d)]')
        for style in ['long','short','narrow','numeric','2-digit']:
            add('option-'+unit+'-'+style,'return new Intl.DurationFormat("en",'+js({unit:style})+').resolvedOptions()')
        for display in ['auto','always','bad',None]:
            add('display-'+unit+'-'+str(display),'return new Intl.DurationFormat("en",'+js({unit+'Display':display})+').resolvedOptions()')
    for digits in range(10):
        add('fraction-'+str(digits),'var f=new Intl.DurationFormat("en",{style:"digital",fractionalDigits:'+str(digits)+'});return [f.format("-PT1.234567891S"),f.formatToParts("PT0.000000001S")]')
    for value in ['undefined','null','true','false','1','NaN','Infinity','1n','Symbol()']:
        for method in ['format','formatToParts']:
            error('input-'+method+'-'+value,'return new Intl.DurationFormat().'+method+'('+value+')','TypeError')
    for value in ['{}','{seconds:1.5}','{hours:1,seconds:-1}','{years:4294967296}','{days:104249991375}','{seconds:9007199254740992}','{nanoseconds:9007199254740992000000000}','"P"','"PT1.1H1S"','new String("PT1S")','new Proxy(new Temporal.Duration(0,0,0,0,0,0,1),{})']:
        add('invalid-'+value,'return new Intl.DurationFormat().format('+value+')')
    for ns in ['latn','arab','deva','foobar','12','abc-def','LATN',None]:
        add('numbering-'+str(ns),'var f=new Intl.DurationFormat("en-u-nu-arab",'+js({'numberingSystem':ns})+');return [f.resolvedOptions(),f.format({seconds:1234})]')
    for method in ['format','formatToParts','resolvedOptions']:
        error('wrong-brand-'+method,'return Intl.DurationFormat.prototype.'+method+'.call({},{seconds:1})','TypeError')
        add('foreign-'+method,'return Intl.DurationFormat.prototype.'+method+'.call(new __foreignDurationFormat("en"),{seconds:1})')
        add('descriptor-'+method,'var d=Object.getOwnPropertyDescriptor(Intl.DurationFormat.prototype,'+js(method)+');return [d.value.name,d.value.length,d.writable,d.enumerable,d.configurable]')
    error('call-no-new','return Intl.DurationFormat()','TypeError')
    add('subclass','class D extends Intl.DurationFormat{};var d=new D;return [d instanceof D,d instanceof Intl.DurationFormat,d.format({seconds:0})]',[True,True,''],True)
    add('foreign-prototype','var d=Reflect.construct(Intl.DurationFormat,[],__foreignTarget);return [Object.getPrototypeOf(d)===__foreignDurationFormat.prototype,d instanceof Intl.DurationFormat]',[True,False],True)
    add('supported','return Intl.DurationFormat.supportedLocalesOf(["EN-us","fr","en-US","zz"])',['en-US','fr','zz'],True)
    # Actual Intl methods are dynamically observed, not private native shortcuts.
    add('nf-interception','var p=Intl.NumberFormat.prototype,d=Object.getOwnPropertyDescriptor(p,"format"),calls=[];Object.defineProperty(p,"format",{get(){calls.push("get");return function(x){calls.push(typeof x);return "X"}},configurable:true});try{return [new Intl.DurationFormat().format({seconds:1}),calls]}finally{Object.defineProperty(p,"format",d)}',['X',['get','number']],True)
    add('lf-interception','var p=Intl.ListFormat.prototype,f=p.format;p.format=function(x){return "seen:"+x.length};try{return new Intl.DurationFormat().format({hours:1,minutes:2})}finally{p.format=f}','seen:2',True)
    add('fraction-overflow-independent','var p=Intl.NumberFormat.prototype,d=Object.getOwnPropertyDescriptor(p,"format"),f=p.formatToParts;Object.defineProperty(p,"format",{get(){return x=>String(x)},configurable:true});p.formatToParts=function(){return []};try{return new Intl.DurationFormat("en",{microseconds:"short",nanoseconds:"numeric"}).format({microseconds:2**72})}finally{Object.defineProperty(p,"format",d);p.formatToParts=f}','4722366482869645213696.000',True,False)
    return rows


def cases():
    return list_cases()+display_plural_cases()+relative_cases()+duration_cases()


DURATION_FAULTS=[
    '(function(){return new Intl.DurationFormat("en-u-nu-arab",{style:"digital",fractionalDigits:6})})',
    '(function(){var f=new Intl.DurationFormat("en",{style:"digital"});return function(){return f.format({hours:1,minutes:2,seconds:3,milliseconds:4})}})()',
    '(function(){var f=new Intl.DurationFormat("en",{style:"long"});return function(){return f.formatToParts("P1Y2M3DT4H5M6.007008009S")}})()',
    '(function(){var f=new Intl.DurationFormat;return function(){return f.resolvedOptions()}})()',
    '(function(){var d=new Temporal.Duration(0,0,0,0,1,2,3),f=new Intl.DurationFormat;return function(){return f.format(d)}})()',
    '(function(){return Intl.DurationFormat.supportedLocalesOf(["fr","en-u-nu-arab"])})',
]
FAULTS=LIST_FAULTS+DISPLAY_PLURAL_FAULTS+RELATIVE_FAULTS+DURATION_FAULTS
