"""Actual Engine DateTimeFormat contracts, including branded Temporal inputs."""
import json


def expression(body):
    return 'JSON.stringify((function(){try{return '+body+'}catch(e){return {error:e.name,message:e.message}}})())'


def cases():
    result = []
    def add(name, body): result.append((name, expression(body)))
    add('independent/epoch', "new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(0)")
    add('independent/fresh-bound', "(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});return [f.format===f.format,f.format.length,f.format.call(null,0)]})()")
    add('independent/parts', "new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).formatToParts(0)")
    add('independent/offset', "new Intl.DateTimeFormat('en-US',{timeZone:'-00'}).resolvedOptions().timeZone")
    add('independent/timeclip', "new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(8640000000000001)")
    add('independent/plain-upper-boundary', "new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(new Temporal.PlainDate(275760,9,13))")
    add('independent/date-adapters', "[new Date(0).toLocaleString('en-US',{timeZone:'UTC',year:'numeric',month:'numeric',day:'numeric'}),new Date(0).toLocaleDateString('en-US',{timeZone:'UTC'}),new Date(0).toLocaleTimeString('en-US',{timeZone:'UTC',hourCycle:'h23',hour:'2-digit',minute:'2-digit'})]")
    add('independent/equal-range', "(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});return [f.formatRange(0,0),f.formatRangeToParts(0,0)]})()")
    add('defaults/timezone', "(()=>{let f=new Intl.DateTimeFormat('en-US');return [f.resolvedOptions().timeZone,f.format(0)]})()")
    add('surface/descriptors', "[Intl.DateTimeFormat.name,Intl.DateTimeFormat.length,Object.getOwnPropertyNames(Intl.DateTimeFormat.prototype).map(k=>{let d=Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,k);return [k,d.enumerable,d.configurable,d.writable,typeof d.value,d.value&&d.value.length,!!d.get,!!d.set]}),Object.prototype.toString.call(new Intl.DateTimeFormat)]")
    add('surface/subclass', "(()=>{class D extends Intl.DateTimeFormat{};let d=new D('de',{timeZone:'UTC'});return [d instanceof D,d instanceof Intl.DateTimeFormat,d.format(0),Intl.DateTimeFormat('en',{timeZone:'UTC'}).format(0)]})()")
    add('surface/legacy', "(()=>{let f=Object.create(Intl.DateTimeFormat.prototype),r=Intl.DateTimeFormat.call(f,'en-US',{timeZone:'UTC'}),s=Object.getOwnPropertySymbols(f)[0];return [r===f,f.format(0),f.formatToParts(0),f.resolvedOptions(),f.formatRange(0,86400000),String(s),Object.getOwnPropertyDescriptor(f,s).writable]})()")
    add('surface/rechain-branded', "(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});Intl.DateTimeFormat.call(f,'de',{timeZone:'UTC'});return [f.format(0),Object.getOwnPropertySymbols(f).length]})()")
    add('surface/nonextensible-getter', "(()=>{let f=Object.preventExtensions(new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}));return [f.format(0),f.format===f.format,Object.keys(f)]})()")
    add('surface/cross-realm-default', "(()=>{let T=__otherDateTimeFormat.constructor('return function T(){}')();T.prototype=null;let f=Reflect.construct(Intl.DateTimeFormat,['en',{timeZone:'UTC'}],T);return [Object.getPrototypeOf(f)===__otherDateTimeFormat.prototype,f.format(0)]})()")
    add('surface/foreign-call', "(()=>{let f=Object.create(__otherDateTimeFormat.prototype),r=__otherDateTimeFormat.call(f,'en',{timeZone:'UTC'});return [f===r,f.format(0),Object.getOwnPropertySymbols(f).length]})()")
    for method in ['format','formatToParts','formatRange','formatRangeToParts','resolvedOptions']:
        get = "Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format').get" if method == 'format' else 'Intl.DateTimeFormat.prototype.'+method
        for value in ['undefined','null','1','{}','Object.create(Intl.DateTimeFormat.prototype)','new Proxy(new Intl.DateTimeFormat,{})']:
            add('brand/'+method+'/'+value, '('+get+').call('+value+',0,86400000)')
    locales = ['en-US','en-GB','de-DE','fr-FR','ar','fa','hi-IN','bn','zh-CN','ja','ru','sv','pl','es','pt-BR','xx-ZZ']
    for loc in locales:
        for ds in ['full','long','medium','short']:
            for ts in [None,'full','long','medium','short']:
                opts = {'timeZone':'UTC','dateStyle':ds}
                if ts: opts['timeStyle'] = ts
                add('style/'+loc+'/'+ds+'/'+str(ts), "(()=>{let f=new Intl.DateTimeFormat("+json.dumps(loc)+','+json.dumps(opts)+");return [f.resolvedOptions(),f.format(1709210096789),f.formatToParts(1709210096789)]})()")
    components = {'weekday':['narrow','short','long'],'era':['narrow','short','long'],'year':['2-digit','numeric'],'month':['2-digit','numeric','narrow','short','long'],'day':['2-digit','numeric'],'dayPeriod':['narrow','short','long'],'hour':['2-digit','numeric'],'minute':['2-digit','numeric'],'second':['2-digit','numeric'],'fractionalSecondDigits':[1,2,3],'timeZoneName':['short','long','shortOffset','longOffset','shortGeneric','longGeneric']}
    for key, values in components.items():
        for value in values:
            for loc in ['en-US','de','ja','ar']:
                opts = {'timeZone':'UTC',key:value}
                add('component/'+loc+'/'+key+'/'+str(value), "(()=>{let f=new Intl.DateTimeFormat("+json.dumps(loc)+','+json.dumps(opts)+");return [f.resolvedOptions(),[-62167219200000,-1,0,1709210096789].map(x=>[f.format(x),f.formatToParts(x)])]})()")
    for hc in ['h11','h12','h23','h24']:
        for h12 in [None,False,True]:
            opts={'timeZone':'UTC','hourCycle':hc,'hour':'numeric','minute':'2-digit','second':'2-digit'}
            if h12 is not None: opts['hour12']=h12
            add('hourcycle/'+hc+'/'+str(h12), "(()=>{let f=new Intl.DateTimeFormat('en-US',"+json.dumps(opts)+");return [f.resolvedOptions(),[0,43200000,86399000].map(x=>[f.format(x),f.formatToParts(x)])]})()")
    zones=['UTC','utc','GMT','gmt','+00','-00','+0530','-08:30','+23:59','Etc/UTC','Etc/GMT+3','Europe/Vienna','Europe/Paris','America/New_York','Asia/Tokyo','Asia/Kolkata','Australia/Sydney','Invalid/Zone']
    for zone in zones:
        for name in ['short','long','shortOffset','longOffset','shortGeneric','longGeneric']:
            opts={'timeZone':zone,'timeZoneName':name,'year':'numeric','month':'numeric','day':'numeric','hour':'numeric','minute':'numeric'}
            add('zone/'+zone+'/'+name, "(()=>{let f=new Intl.DateTimeFormat('en',"+json.dumps(opts)+");return [f.resolvedOptions(),[0,1711846800000,1729990800000].map(x=>[f.format(x),f.formatToParts(x)])]})()")
    for calendar in ['buddhist','chinese','coptic','dangi','ethioaa','ethiopic','gregory','hebrew','indian','islamic-civil','islamic-tbla','islamic-umalqura','iso8601','japanese','persian','roc']:
        for width in ['numeric','short','long','narrow']:
            opts={'timeZone':'UTC','calendar':calendar,'era':'long','year':'numeric','month':width,'day':'numeric'}
            add('calendar/'+calendar+'/'+width,"(()=>{let f=new Intl.DateTimeFormat('en',"+json.dumps(opts)+");return [f.resolvedOptions(),[0,1556668800000,1709251200000].map(x=>[f.format(x),f.formatToParts(x)])]})()")
    add('numbering/all', "Intl.supportedValuesOf('numberingSystem').map(numberingSystem=>{let f=new Intl.DateTimeFormat('en',{numberingSystem,timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'numeric',second:'numeric',fractionalSecondDigits:3});return [numberingSystem,f.resolvedOptions(),f.format(1709210096789),f.formatToParts(1709210096789)]})")
    for loc in ['en-u-ca-japanese-nu-arab-hc-h23','de-u-hc-h12','ar-u-nu-latn','en-u-ca-unknown','en-u-nu-foobar','en-u-hc-h99']:
        add('extensions/'+loc,"(()=>{let f=new Intl.DateTimeFormat('"+loc+"',{timeZone:'UTC',hour:'numeric'});return [f.resolvedOptions(),f.format(0)]})()")
    for key, vals in dict(components,calendar=['','ab','abcdefghi','abc-','bogus'],numberingSystem=['','ab','abcdefghi','latn-','bogus'],timeZone=['','X','+24','+00:60','+1','+010203','A!B/C'],hourCycle=['bad'],localeMatcher=['bad'],formatMatcher=['bad'],dateStyle=['bad'],timeStyle=['bad'],fractionalSecondDigits=[0,4,-1,1.5]).items():
        for v in vals:
            if key in components and key!='fractionalSecondDigits': v='invalid-'+str(v)
            add('invalid/'+key+'/'+str(v),'new Intl.DateTimeFormat("en",'+json.dumps({key:v})+').resolvedOptions()')
    for value in ['null','true','false','-0','-1','0.9','-0.9','NaN','Infinity','-Infinity','8640000000000000','-8640000000000000','8640000000000001','1n','Symbol()','"0"','""','new Date(0)','new Date(NaN)']:
        add('input/'+value,"(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});return [f.format("+value+'),f.formatToParts('+value+')]})()')
    for loc in ['en-US','de','fr','ja','ar']:
        for opts in [{'year':'numeric','month':'short','day':'numeric'},{'dateStyle':'full'},{'hour':'numeric','minute':'numeric'},{'dateStyle':'medium','timeStyle':'short'}]:
            opts=dict(opts,timeZone='UTC')
            for a,b in [(0,0),(0,86400000),(0,2678400000),(0,31536000000),(0,3600000),(60000,120000),(86400000,0)]:
                add('range/'+loc+'/'+json.dumps(opts)+'/'+str(a)+'/'+str(b),"(()=>{let f=new Intl.DateTimeFormat("+json.dumps(loc)+','+json.dumps(opts)+');return [f.formatRange('+str(a)+','+str(b)+'),f.formatRangeToParts('+str(a)+','+str(b)+')]})()')
    for args in ['', '0','undefined,0','0,undefined','NaN,0','0,NaN','Symbol(),0','0,Symbol()','8640000000000001,0']:
        for method in ['formatRange','formatRangeToParts']: add('range-invalid/'+method+'/'+args,'new Intl.DateTimeFormat("en",{timeZone:"UTC"}).'+method+'('+args+')')
    order=['localeMatcher','calendar','numberingSystem','hour12','hourCycle','timeZone','weekday','era','year','month','day','dayPeriod','hour','minute','second','fractionalSecondDigits','timeZoneName','formatMatcher','dateStyle','timeStyle']
    for stop in [None]+order:
        add('order/options/'+str(stop),"(()=>{let log=[];let o=new Proxy({},{get(t,k){log.push(k);"+("if(k==="+json.dumps(stop)+")throw Error('stop');" if stop else '')+"return undefined}});try{new Intl.DateTimeFormat('en',o)}catch(e){log.push(e.name)}return log})()")
    for method in ['format','formatToParts','formatRange','formatRangeToParts']:
        add('order/coerce/'+method,"(()=>{let log=[],a={[Symbol.toPrimitive](h){log.push('a:'+h);return 0}},b={[Symbol.toPrimitive](h){log.push('b:'+h);return 86400000}};let f=new Intl.DateTimeFormat('en',{timeZone:'UTC'});let result=f."+method+"(a,b);return [result,log]})()")
    for value in ['undefined','null',"['en-US','de','zz','en-US']","new Intl.Locale('fr')","{length:2,0:'de',1:'ar'}"]:
        add('supported/'+value,'Intl.DateTimeFormat.supportedLocalesOf('+value+')')
    for method in ['toLocaleString','toLocaleDateString','toLocaleTimeString']:
        for opts in [{},{'dateStyle':'full'},{'timeStyle':'full'},{'hour':'numeric','year':'numeric'}]:
            opts=dict(opts,timeZone='UTC')
            add('date-adapter/'+method+'/'+json.dumps(opts),'new Date(0).'+method+'("en-US",'+json.dumps(opts)+')')
        add('date-invalid/'+method,'new Date(NaN).'+method+'("en-US",new Proxy({},{get(){throw Error("must not read")}}))')
        add('date-order/'+method,"(()=>{let log=[],o=new Proxy({timeZone:'UTC'},{get(t,k){log.push(k);return t[k]}});let result=new Date(0)."+method+"('en-US',o);return [result,log]})()")
        add('date-null-options/'+method,"new Date(0)."+method+"('en-US',null)")
        add('date-frozen-options/'+method,"(()=>{let o=Object.freeze({timeZone:'UTC'});return new Date(0)."+method+"('en-US',o)})()")
        add('date-mutation/'+method,"(()=>{let o={timeZone:'UTC'};let result=new Date(0)."+method+"('en-US',o);return [result,o]})()")
        add('date-coercion/'+method,"(()=>{let d=new Date(0);Object.defineProperty(d,Symbol.toPrimitive,{value:()=>86400000});return d."+method+"('en-US',{timeZone:'UTC'})})()")
        add('date-brand/'+method,"Date.prototype."+method+".call(new Proxy(new Date(0),{}),'en-US',{timeZone:'UTC'})")
    types={'Instant':"new Temporal.Instant(1709251200123456789n)",'PlainDate':"new Temporal.PlainDate(2024,3,1)",'PlainDateTime':"new Temporal.PlainDateTime(2024,3,1,12,34,56,789,123,456)",'PlainTime':"new Temporal.PlainTime(12,34,56,789,123,456)",'PlainYearMonth':"new Temporal.PlainYearMonth(2024,3)",'PlainMonthDay':"new Temporal.PlainMonthDay(3,1)",'ZonedDateTime':"new Temporal.ZonedDateTime(1709251200123456789n,'UTC')",'Duration':"new Temporal.Duration(1)"}
    for typ, value in types.items():
        for opts in [{},{'dateStyle':'full'},{'timeStyle':'full'},{'dateStyle':'long','timeStyle':'long'},{'year':'numeric'},{'month':'long'},{'day':'numeric'},{'hour':'numeric'},{'era':'long'},{'timeZoneName':'long'},{'fractionalSecondDigits':3}]:
            opts=dict(opts,timeZone='America/New_York')
            for method in ['format','formatToParts','formatRange','formatRangeToParts']:
                args=value
                if method.startswith('formatRange'): args+=','+value
                add('temporal/'+typ+'/'+method+'/'+json.dumps(opts),"(()=>{let f=new Intl.DateTimeFormat('en-US',"+json.dumps(opts)+');let result=f.'+method+'('+args+');return [result,f.resolvedOptions()]})()')
    for a,va in types.items():
        for b,vb in types.items():
            if a!=b: add('temporal-mixed/'+a+'/'+b,"new Intl.DateTimeFormat('en',{timeZone:'UTC'}).formatRange("+va+','+vb+')')
    for typ in ['PlainDate','PlainDateTime','PlainYearMonth','PlainMonthDay']:
        ctor={'PlainDate':'2024,3,1','PlainDateTime':'2024,3,1,12,0,0,0,0,0','PlainYearMonth':'2024,3','PlainMonthDay':'3,1'}[typ]
        for cal in ['iso8601','gregory','japanese','hebrew']:
            value='new Temporal.'+typ+'('+ctor+','+json.dumps(cal)+')'
            for fmt in ['gregory','iso8601','japanese','hebrew']:
                add('temporal-calendar/'+typ+'/'+cal+'/'+fmt,"(()=>{let f=new Intl.DateTimeFormat('en',{calendar:'"+fmt+"',timeZone:'UTC'});return [f.format("+value+'),f.formatRange('+value+','+value+')]})()')
    for value in ["new Temporal.PlainDate(275760,9,13)","new Temporal.PlainDate(-271821,4,19)","new Temporal.Instant(8640000000000000000000n)","new Temporal.Instant(-8640000000000000000000n)"]:
        add('temporal-boundary/'+value,"(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});return [f.format("+value+"),f.formatToParts("+value+"),f.formatRange("+value+","+value+")]})()")
    add('timeclip/independent-yearmonth', "new Intl.DateTimeFormat('en',{calendar:'iso8601'}).format(new Temporal.PlainYearMonth(-271821,4))")
    for calendar in ['iso8601', 'gregory']:
        for zone in ['UTC', 'America/New_York', '+23:59']:
            for method in ['format', 'formatToParts', 'formatRange', 'formatRangeToParts']:
                args = 'a,b' if method.startswith('formatRange') else 'a'
                add('timeclip/plain/'+calendar+'/'+zone+'/'+method,
                    "(()=>{let c="+json.dumps(calendar)+",f=new Intl.DateTimeFormat('en',{calendar:c,timeZone:"+json.dumps(zone)+"});"
                    "let pairs=[[new Temporal.PlainDate(-271821,4,19,c),new Temporal.PlainDate(275760,9,13,c)],"
                    "[new Temporal.PlainDateTime(-271821,4,19,0,0,0,0,0,1,c),new Temporal.PlainDateTime(275760,9,13,23,59,59,999,999,999,c)],"
                    "[new Temporal.PlainYearMonth(-271821,4,c),new Temporal.PlainYearMonth(275760,9,c)],"
                    "[new Temporal.PlainYearMonth(-271821,4,c,30),new Temporal.PlainYearMonth(275760,9,c,30)]];"
                    "return pairs.map(([a,b])=>[f."+method+"("+args+"),f."+method+"(b,b)])})()")
    for method in ['format', 'formatToParts', 'formatRange', 'formatRangeToParts']:
        args = 'x,x' if method.startswith('formatRange') else 'x'
        add('timeclip/numeric-invalid/'+method,
            "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC'});return "
            "[8640000000000001,-8640000000000001,NaN,Infinity,-Infinity,new Date(NaN),new Date(8640000000000001)]"
            ".map(x=>{try{return f."+method+"("+args+")}catch(e){return e.name}})})()")
        add('timeclip/numeric-valid/'+method,
            "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC'});return "
            "[8640000000000000,-8640000000000000,0.9,-0.9,new Date(8640000000000000),new Date(-8640000000000000)]"
            ".map(x=>f."+method+"("+args+"))})()")
    add('temporal/foreign-brand', "(()=>{let x=new __otherTemporal.PlainDate(2024,3,1);return new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(x)})()")
    add('independent/clock', "(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',year:'numeric'});return f.format()===f.format(Date.now())&&f.formatToParts().some(p=>p.type==='year'&&p.value===String(new Date().getUTCFullYear()))})()")
    return result


INDEPENDENT = {
    'independent/epoch':'1/1/1970',
    'independent/fresh-bound':[False,1,'1/1/1970'],
    'independent/parts':[{'type':'month','value':'1'},{'type':'literal','value':'/'},{'type':'day','value':'1'},{'type':'literal','value':'/'},{'type':'year','value':'1970'}],
    'independent/offset':'+00:00',
    'independent/timeclip':{'error':'RangeError','message':'Invalid time value'},
    'independent/clock':True,
    'independent/plain-upper-boundary':'9/13/275760',
    'independent/date-adapters':['1/1/1970','1/1/1970','00:00'],
    'independent/equal-range':['1/1/1970',[{'type':'month','value':'1','source':'shared'},{'type':'literal','value':'/','source':'shared'},{'type':'day','value':'1','source':'shared'},{'type':'literal','value':'/','source':'shared'},{'type':'year','value':'1970','source':'shared'}]],
    'timeclip/independent-yearmonth':'4/-271821',
    **{'timeclip/numeric-invalid/'+method:['RangeError']*7
       for method in ['format','formatToParts','formatRange','formatRangeToParts']},
}

# Separate native expectations for inputs which exercise unsafe C memory bounds.
# Filled only with evidenced source-undefined cases, never to waive mismatches.
def native_boundaries():
    return []

FAULTS = [
    "()=>new Intl.DateTimeFormat('en-u-ca-japanese-nu-arab-hc-h23',{timeZone:'Europe/Vienna',dateStyle:'full',timeStyle:'long'})",
    "(()=>{let f=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'});return ()=>f.format})()",
    "(()=>{let f=new Intl.DateTimeFormat('ar',{timeZone:'Europe/Vienna',dateStyle:'full',timeStyle:'full'});return ()=>f.format(1709251200123)})()",
    "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'full',timeStyle:'full'});return ()=>f.formatToParts(1709251200123)})()",
    "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'long'});return ()=>f.formatRange(0,86400000)})()",
    "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'long'});return ()=>f.formatRangeToParts(0,86400000)})()",
    "(()=>{let f=new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'full',timeStyle:'full'});return ()=>f.resolvedOptions()})()",
    "()=>Intl.DateTimeFormat.supportedLocalesOf(['en-US','de','fr','ar'])",
    "(()=>{let d=new Date(0);return ()=>d.toLocaleString('en',{timeZone:'UTC'})})()",
    "(()=>{let d=new Date(0);return ()=>d.toLocaleDateString('en',{timeZone:'UTC'})})()",
    "(()=>{let d=new Date(0);return ()=>d.toLocaleTimeString('en',{timeZone:'UTC'})})()",
    "(()=>{let d=new Temporal.PlainDateTime(2024,3,1,12,34,56),f=new Intl.DateTimeFormat('en',{timeZone:'UTC'});return ()=>f.formatToParts(d)})()",
    "(()=>{let a=new Temporal.PlainDate(2024,3,1),b=new Temporal.PlainDate(2024,3,2),f=new Intl.DateTimeFormat('en',{timeZone:'UTC'});return ()=>f.formatRangeToParts(a,b)})()",
]
