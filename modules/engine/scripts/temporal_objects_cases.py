"""Public Temporal behavior through JavaScript; independent goldens never call native helpers."""
import json


def expression(body):
    return "JSON.stringify((function(){try{return " + body + "}catch(e){return ['error',e.name]}})(),function(k,v){return typeof v==='bigint'?String(v)+'n':v})"


SAMPLES = {
    'Instant': "new Temporal.Instant(1709210096123456789n)",
    'Duration': "new Temporal.Duration(1,2,3,4,5,6,7,8,9,10)",
    'PlainDate': "new Temporal.PlainDate(2024,2,29)",
    'PlainDateTime': "new Temporal.PlainDateTime(2024,2,29,12,34,56,123,456,789)",
    'PlainTime': "new Temporal.PlainTime(12,34,56,123,456,789)",
    'PlainYearMonth': "new Temporal.PlainYearMonth(2024,2)",
    'PlainMonthDay': "new Temporal.PlainMonthDay(2,29)",
    'ZonedDateTime': "new Temporal.ZonedDateTime(1709210096123456789n,'America/New_York')",
}
ARGS = {'Instant':'1709210096123456789n','Duration':'1,2,3,4,5,6,7,8,9,10','PlainDate':'2024,2,29','PlainDateTime':'2024,2,29,12,34,56,123,456,789','PlainTime':'12,34,56,123,456,789','PlainYearMonth':'2024,2','PlainMonthDay':'2,29','ZonedDateTime':"1709210096123456789n,'America/New_York'"}
STRINGS = {'Instant':'2024-02-29T12:34:56.123456789Z','Duration':'P1Y2M3W4DT5H6M7.00800901S','PlainDate':'2024-02-29','PlainDateTime':'2024-02-29T12:34:56.123456789','PlainTime':'12:34:56.123456789','PlainYearMonth':'2024-02','PlainMonthDay':'02-29','ZonedDateTime':'2024-02-29T12:34:56.123456789-05:00[America/New_York]'}
BAGS = {'Instant':None,'Duration':'{years:1,months:2,weeks:3,days:4,hours:5,minutes:6,seconds:7,milliseconds:8,microseconds:9,nanoseconds:10}','PlainDate':'{year:2024,month:2,day:29}','PlainDateTime':'{year:2024,month:2,day:29,hour:12,minute:34,second:56,millisecond:123,microsecond:456,nanosecond:789}','PlainTime':'{hour:12,minute:34,second:56,millisecond:123,microsecond:456,nanosecond:789}','PlainYearMonth':'{year:2024,month:2}','PlainMonthDay':'{month:2,day:29}','ZonedDateTime':"{year:2024,month:2,day:29,hour:12,minute:34,timeZone:'America/New_York'}"}


def cases():
    result = []
    def add(name, body):
        result.append((name, expression(body)))
    add('independent/epoch-negative', "(()=>{let i=new Temporal.Instant(-1n);return [i.epochNanoseconds,i.epochMilliseconds,i.toString(),new Date(-1).toTemporalInstant().epochNanoseconds]})()")
    add('independent/nanoseconds', "(()=>{let d=Temporal.Duration.from('PT0.000000001S');return [d.nanoseconds,d.sign,d.blank,d.toString(),d.negated().toString()]})()")
    add('independent/leap-date', "(()=>{let d=Temporal.PlainDate.from('2024-02-29');return [d.dayOfWeek,d.dayOfYear,d.daysInMonth,d.daysInYear,d.inLeapYear,d.add({years:1}).toString(),d.until('2024-03-01').toString()]})()")
    add('independent/time-wrap', "new Temporal.PlainTime(23,59,59,999,999,999).add({nanoseconds:1}).toString()")
    add('independent/datetime-carry', "Temporal.PlainDateTime.from('2024-02-29T23:59:59.999999999').add({nanoseconds:1}).toString()")
    add('independent/yearmonth', "new Temporal.PlainYearMonth(2024,2).add({months:12}).toString()")
    add('independent/monthday', "new Temporal.PlainMonthDay(2,29).toPlainDate({year:2024}).toString()")
    add('independent/dst-day', "(()=>{let z=Temporal.ZonedDateTime.from('2024-03-10T00:00-05:00[America/New_York]');return [z.hoursInDay,z.add({days:1}).toString(),z.add({hours:24}).toString()]})()")
    add('independent/instant-limits', "[-8640000000000000000000n,8640000000000000000000n].map(n=>new Temporal.Instant(n).toString())")
    add('independent/now-bracket', "(()=>{let a=BigInt(Date.now())*1000000n,n=Temporal.Now.instant().epochNanoseconds,b=BigInt(Date.now()+1)*1000000n;return n>=a&&n<b})()")
    add('independent/now-date', "(()=>{let a=new Date(Date.now()).toISOString().slice(0,10),v=Temporal.Now.plainDateISO('UTC').toString(),b=new Date(Date.now()).toISOString().slice(0,10);return a<=v&&v<=b})()")
    add('independent/now-datetime', "(()=>{let a=new Date(Date.now()).toISOString().slice(0,-1)+'000000',v=Temporal.Now.plainDateTimeISO('UTC').toString({fractionalSecondDigits:9}),b=new Date(Date.now()+1).toISOString().slice(0,-1)+'000000';return a<=v&&v<b})()")
    add('independent/now-time', "(()=>{let a=new Date(Date.now()).toISOString(),v=Temporal.Now.plainTimeISO('UTC').toString({fractionalSecondDigits:9}),b=new Date(Date.now()+1).toISOString();return a.slice(0,10)!==b.slice(0,10)||(a.slice(11,-1)+'000000'<=v&&v<b.slice(11,-1)+'000000')})()")
    add('independent/now-zoned', "(()=>{let a=BigInt(Date.now())*1000000n,v=Temporal.Now.zonedDateTimeISO('America/New_York'),b=BigInt(Date.now()+1)*1000000n;return [a<=v.epochNanoseconds&&v.epochNanoseconds<b,v.timeZoneId]})()")
    add('surface/namespace', "[Object.getOwnPropertyNames(Temporal),Object.prototype.toString.call(Temporal),Object.getOwnPropertyNames(Temporal.Now),Object.prototype.toString.call(Temporal.Now),Object.getOwnPropertyDescriptor(globalThis,'Temporal').enumerable]")
    for value in ['0','-1','1.5','NaN','Infinity','8640000000000000','8640000000000001',"'123'",'1n']:
        add('instant/fromEpochMilliseconds/'+value, 'Temporal.Instant.fromEpochMilliseconds('+value+').toString()')
    for value in ['0n','-1n','8640000000000000000000n','8640000000000000000001n',"'123'",'1','true','null','Symbol()']:
        add('instant/fromEpochNanoseconds/'+value, 'Temporal.Instant.fromEpochNanoseconds('+value+').toString()')
    for value in ['-1500n','-500n','500n','1500n']:
        for mode in ['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven']:
            add('instant/signed-tie/'+value+'/'+mode, 'new Temporal.Instant('+value+').round({smallestUnit:"microsecond",roundingMode:'+json.dumps(mode)+'}).epochNanoseconds')
    for cls, sample in SAMPLES.items():
        ctor = 'Temporal.' + cls
        args = ARGS[cls]
        add('surface/'+cls, "(()=>{let C="+ctor+",x="+sample+";return [C.name,C.length,Object.getOwnPropertyNames(C).map(k=>{let d=Object.getOwnPropertyDescriptor(C,k);return [k,d.enumerable,d.configurable,d.writable,typeof d.value,d.value&&d.value.length]}),Object.getOwnPropertyNames(C.prototype).map(k=>{let d=Object.getOwnPropertyDescriptor(C.prototype,k);return [k,d.enumerable,d.configurable,d.writable,typeof d.value,d.value&&d.value.length,!!d.get,!!d.set]}),Object.prototype.toString.call(x),Object.keys(x),x.toString(),x.toJSON()]})()")
        add('getters/'+cls, "(()=>{let C="+ctor+",x="+sample+";return Object.getOwnPropertyNames(C.prototype).filter(k=>Object.getOwnPropertyDescriptor(C.prototype,k).get).map(k=>[k,x[k]])})()")
        add('construction/no-new/'+cls, ctor+'('+args+')')
        add('construction/subclass/'+cls, "(()=>{class S extends "+ctor+"{};let x=new S("+args+");return [x instanceof S,x instanceof "+ctor+",x.toString(),Object.getPrototypeOf("+ctor+".from(x))==="+ctor+".prototype]})()")
        add('construction/prototype-order/'+cls, "(()=>{let log=[],T=new Proxy(function(){},{get(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}});let x=Reflect.construct("+ctor+",["+args+"],T);return [log,x.toString()]})()")
        add('realm/brand/'+cls, "(()=>{let C=__otherTemporal."+cls+",x=new C("+args+");return ["+ctor+".prototype.toString.call(x),Object.getPrototypeOf("+ctor+".from(x))==="+ctor+".prototype,Object.getPrototypeOf(C.from("+sample+"))===C.prototype]})()")
        add('reinstall/brand/'+cls, "(()=>{let C=__previousTemporal."+cls+",x=new C("+args+");return [C!=="+ctor+",C.prototype!=="+ctor+".prototype,"+ctor+".prototype.toString.call(x),Object.getPrototypeOf(C.from(x))==="+ctor+".prototype]})()")
        add('realm/newtarget/'+cls, "(()=>{let T=__otherTemporal."+cls+".constructor('return function T(){}')();T.prototype=null;let x=Reflect.construct("+ctor+",["+args+"],T);return Object.getPrototypeOf(x)===__otherTemporal."+cls+".prototype})()")
        for invalid in ['undefined','null','1','{}','Object.create('+ctor+'.prototype)','new Proxy('+sample+',{})']:
            add('brand/'+cls+'/'+invalid, "(()=>{let C="+ctor+",bad="+invalid+";return Object.getOwnPropertyNames(C.prototype).filter(k=>k!=='constructor').map(k=>{let d=Object.getOwnPropertyDescriptor(C.prototype,k);try{let r=d.get?d.get.call(bad):d.value.call(bad);return [k,'accepted',String(r)]}catch(e){return [k,e.name]}})})()")
        for value in [json.dumps(STRINGS[cls]),sample,"undefined","null","true","1","Symbol('x')","{}","''","'invalid'","'2024-02-29\\u0000tail'"]:
            add('from/'+cls+'/'+value, ctor+'.from('+value+').toString()')
        if BAGS[cls]:
            for opts in ['undefined','{}',"{overflow:'constrain'}","{overflow:'reject'}","{overflow:'invalid'}",'null','1']:
                add('bag/'+cls+'/'+opts, ctor+'.from('+BAGS[cls]+','+opts+').toString()')
            add('order/bag/'+cls, "(()=>{let log=[],bag=new Proxy("+BAGS[cls]+",{get(t,k,r){log.push(String(k));let v=Reflect.get(t,k,r);return typeof v==='number'?{valueOf(){log.push('number:'+String(k));return v}}:v}});let x="+ctor+".from(bag);return [x.toString(),log]})()")
        add('valueOf/'+cls, sample+'.valueOf()')
        for locale in ['en-US','de-DE','ar','ja-JP']:
            add('locale/'+cls+'/'+locale, sample+'.toLocaleString('+json.dumps(locale)+')')
        add('locale/options-order/'+cls, "(()=>{let log=[],o=new Proxy({},{get(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},defineProperty(t,k,d){log.push('define:'+String(k));return Reflect.defineProperty(t,k,d)}});let x="+sample+".toLocaleString('en-US',o);return [x,log,Object.keys(o)]})()")
    for cls in ['Instant','PlainDate','PlainDateTime','PlainTime','PlainYearMonth','ZonedDateTime']:
        sample = SAMPLES[cls]
        compare = json.dumps(STRINGS[cls])
        add('compare/'+cls, '[Temporal.'+cls+'.compare('+sample+','+compare+'),Temporal.'+cls+'.compare('+compare+','+sample+')]')
        add('equals/'+cls, '['+sample+'.equals('+compare+'),'+sample+'.equals('+sample+')]')
        for method in ['add','subtract']:
            for duration in ["'PT1.000000001S'","{hours:25,minutes:1}","{days:1}","{months:1}","{years:1}","{nanoseconds:-1}","{seconds:1,nanoseconds:-1}"]:
                add('arithmetic/'+cls+'/'+method+'/'+duration, sample+'.'+method+'('+duration+').toString()')
        for method in ['until','since']:
            for unit in ['year','month','week','day','hour','minute','second','millisecond','microsecond','nanosecond','auto','invalid']:
                add('difference/'+cls+'/'+method+'/'+unit, sample+'.'+method+'('+compare+',{largestUnit:'+json.dumps(unit)+'}).toString()')
    for cls in ['Instant','PlainDateTime','PlainTime','ZonedDateTime']:
        for mode in ['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven']:
            for unit in ['day','hour','minute','second','millisecond','microsecond','nanosecond']:
                add('round/'+cls+'/'+mode+'/'+unit, SAMPLES[cls]+'.round({smallestUnit:'+json.dumps(unit)+',roundingMode:'+json.dumps(mode)+'}).toString()')
        for opts in ["{smallestUnit:'minute',roundingIncrement:15}","{smallestUnit:'minute',roundingIncrement:7}","{smallestUnit:'second',roundingIncrement:0}","{smallestUnit:'hour',roundingIncrement:24}","{}","null","undefined"]:
            add('round-options/'+cls+'/'+opts,SAMPLES[cls]+'.round('+opts+').toString()')
        for precision in ['auto',0,1,3,6,9,-1,10,None]:
            add('format-precision/'+cls+'/'+str(precision),SAMPLES[cls]+'.toString({fractionalSecondDigits:'+json.dumps(precision)+'})')
    for cls in ['PlainDate','PlainDateTime','PlainYearMonth','PlainMonthDay','ZonedDateTime']:
        sample = SAMPLES[cls]
        fields = "{day:15}" if cls!='PlainYearMonth' else "{month:3}"
        add('with/'+cls,sample+'.with('+fields+').toString()')
        add('with-empty/'+cls,sample+'.with({}).toString()')
        add('with-brand/'+cls,sample+'.with('+sample+').toString()')
        add('with-calendar-property/'+cls,sample+".with({calendar:'iso8601',day:1}).toString()")
        add('with-monthcode-conflict/'+cls,sample+".with({month:3,monthCode:'M02'}).toString()")
        for name in ['auto','always','never','critical','invalid']:
            add('calendar-name/'+cls+'/'+name,sample+'.toString({calendarName:'+json.dumps(name)+'})')
    add('time/with',SAMPLES['PlainTime']+".with({hour:23,nanosecond:1}).toString()")
    add('duration/negated',SAMPLES['Duration']+'.negated().toString()')
    add('duration/abs',SAMPLES['Duration']+'.negated().abs().toString()')
    add('duration/with',SAMPLES['Duration']+'.with({years:2,nanoseconds:99}).toString()')
    for method in ['add','subtract']:
        for value in ["{hours:1}","{nanoseconds:1}","'PT25H'","{years:1}"]:
            add('duration/'+method+'/'+value,"Temporal.Duration.from('PT23H59M59.999999999S')."+method+'('+value+').toString()')
    for relative in ["undefined","'2024-02-29'","'2024-03-10T00:00-05:00[America/New_York]'","{year:2024,month:2,day:29}","Temporal.PlainDate.from('2024-02-29')","Temporal.ZonedDateTime.from('2024-11-03T00:00-04:00[America/New_York]')"]:
        for unit in ['year','month','week','day','hour','minute','second','millisecond','microsecond','nanosecond']:
            opts = '{unit:'+json.dumps(unit)+',relativeTo:'+relative+'}'
            add('duration/total/'+relative+'/'+unit,"Temporal.Duration.from('P1DT12H').total("+opts+')')
            opts = '{smallestUnit:'+json.dumps(unit)+',relativeTo:'+relative+'}'
            add('duration/round/'+relative+'/'+unit,"Temporal.Duration.from('P1DT12H').round("+opts+').toString()')
        add('duration/compare/'+relative,"Temporal.Duration.compare('P1D','PT24H',{relativeTo:"+relative+'})')
    # RelativeTo must validate its PlainDate even for time-only or zero durations.
    for year, month, day in [(-271821,4,18),(-271821,4,19),(-271821,4,20),(275760,9,12),(275760,9,13),(275760,9,14)]:
        text = ('-' if year < 0 else '+') + f'{abs(year):06d}-{month:02d}-{day:02d}'
        for relative in [json.dumps(text),json.dumps(text+'T23:59:59.999999999'),f'{{year:{year},month:{month},day:{day}}}']:
            add('duration/relative-limits/compare/'+relative,'Temporal.Duration.compare({minutes:5},{seconds:0},{relativeTo:'+relative+'})')
            add('duration/relative-limits/round/'+relative,"Temporal.Duration.from('PT0S').round({smallestUnit:'second',relativeTo:"+relative+'}).toString()')
            add('duration/relative-limits/total/'+relative,"Temporal.Duration.from('PT0S').total({unit:'second',relativeTo:"+relative+'})')
    for text in ['P0D','PT0S','-PT0.000000001S','PT9007199254740991S','PT9007199254740992S','PT1.5H','PT1.5M','P1.5D','P1Y2M3W4DT5H6M7.123456789S','P','PT','P1DT','P-1D','PT1.1234567890S','PT1S\x00x']:
        add('duration/string/'+repr(text),'Temporal.Duration.from('+json.dumps(text)+').toString()')
    for calendar in ['iso8601','gregory','japanese','buddhist','roc','persian','hebrew','chinese','dangi','coptic','ethiopic','ethioaa','indian','islamic','islamic-civil','islamic-tbla','islamic-umalqura']:
        for cls in ['PlainDate','PlainDateTime','PlainYearMonth','PlainMonthDay','ZonedDateTime']:
            text = STRINGS[cls]+'[u-ca='+calendar+']'
            add('calendar/'+cls+'/'+calendar,"(()=>{let x=Temporal."+cls+'.from('+json.dumps(text)+");return [x.toString(),x.calendarId,x.year,x.month,x.monthCode,x.day,x.era,x.eraYear,x.inLeapYear,x.daysInMonth,x.daysInYear,x.dayOfWeek,x.dayOfYear,x.weekOfYear,x.yearOfWeek]})()")
    for cls in ['PlainDate','PlainDateTime','ZonedDateTime']:
        for calendar in ['gregory','hebrew','japanese']:
            add('withCalendar/'+cls+'/'+calendar,SAMPLES[cls]+'.withCalendar('+json.dumps(calendar)+').toString()')
    add('date/toPlainDateTime',SAMPLES['PlainDate']+".toPlainDateTime('23:59:01.000000001').toString()")
    add('date/toPlainYearMonth',SAMPLES['PlainDate']+'.toPlainYearMonth().toString()')
    add('date/toPlainMonthDay',SAMPLES['PlainDate']+'.toPlainMonthDay().toString()')
    add('yearmonth/toPlainDate',SAMPLES['PlainYearMonth']+'.toPlainDate({day:29}).toString()')
    add('monthday/equals',SAMPLES['PlainMonthDay']+".equals('02-29')")
    for method in ['toPlainDate','toPlainTime']:
        add('datetime/'+method,SAMPLES['PlainDateTime']+'.'+method+'().toString()')
    add('datetime/withPlainTime',SAMPLES['PlainDateTime']+".withPlainTime('01:02:03').toString()")
    for zone in ['UTC','+05:30','-03:30','America/New_York','Europe/Paris','Asia/Kathmandu','Australia/Lord_Howe','Pacific/Apia']:
        add('instant/toZoned/'+zone,SAMPLES['Instant']+'.toZonedDateTimeISO('+json.dumps(zone)+').toString()')
        add('date/toZoned/'+zone,SAMPLES['PlainDate']+'.toZonedDateTime({timeZone:'+json.dumps(zone)+",plainTime:'12:34'}).toString()")
        add('datetime/toZoned/'+zone,SAMPLES['PlainDateTime']+'.toZonedDateTime('+json.dumps(zone)+').toString()')
        add('zoned/withTimeZone/'+zone,SAMPLES['ZonedDateTime']+'.withTimeZone('+json.dumps(zone)+').toString()')
        for method in ['plainDateISO','plainDateTimeISO','plainTimeISO','zonedDateTimeISO']:
            add('now/'+method+'/'+zone,"(()=>{let a=Date.now(),v=Temporal.Now."+method+'('+json.dumps(zone)+"),b=Date.now();return [typeof v.toString()==='string',Object.prototype.toString.call(v),b>=a]})()")
    for text in ['2024-03-10T02:30[America/New_York]','2024-11-03T01:30[America/New_York]','2011-12-30T12:00[Pacific/Apia]','2024-04-07T01:45[Australia/Lord_Howe]']:
        for disambiguation in ['compatible','earlier','later','reject']:
            add('zoned/ambiguity/'+text+'/'+disambiguation,'Temporal.ZonedDateTime.from('+json.dumps(text)+',{disambiguation:'+json.dumps(disambiguation)+'}).toString()')
    for offset in ['prefer','use','ignore','reject']:
        for sign in ['-04:00','-05:00','-06:00']:
            text='2024-11-03T01:30'+sign+'[America/New_York]'
            add('zoned/offset/'+offset+'/'+sign,'Temporal.ZonedDateTime.from('+json.dumps(text)+',{offset:'+json.dumps(offset)+'}).toString()')
    for method in ['startOfDay','toInstant','toPlainDateTime','toPlainDate','toPlainTime','withPlainTime']:
        add('zoned/'+method,SAMPLES['ZonedDateTime']+'.'+method+'().toString()')
    for direction in ["'next'","'previous'","{direction:'next'}","{direction:'previous'}","undefined","'invalid'"]:
        add('zoned/transition/'+direction,"(()=>{let v="+SAMPLES['ZonedDateTime']+'.getTimeZoneTransition('+direction+');return v===null?null:v.toString()})()')
    for opts in ["{offset:'never'}","{timeZoneName:'never'}","{timeZoneName:'critical',calendarName:'always'}","{smallestUnit:'minute',roundingMode:'ceil'}"]:
        add('zoned/format/'+opts,SAMPLES['ZonedDateTime']+'.toString('+opts+')')
    add('now/default-zone', "(()=>{let id=Temporal.Now.timeZoneId(),z=Temporal.Now.zonedDateTimeISO();return [typeof id==='string',id.length>0,z.timeZoneId===id]})()")
    add('now/default-zone-id', 'Temporal.Now.timeZoneId()')
    for value in ['new Date(0)','new Date(-1)','new Date(8640000000000000)','new Date(NaN)','{}','Object.create(Date.prototype)','new Proxy(new Date(0),{})']:
        add('date-adapter/'+value,'Date.prototype.toTemporalInstant.call('+value+').toString()')
    for cls in ['PlainDate','PlainDateTime','PlainYearMonth','PlainMonthDay','PlainTime','ZonedDateTime']:
        for options in ["{dateStyle:'full'}","{timeStyle:'long'}","{dateStyle:'short',timeStyle:'short'}","{calendar:'hebrew'}","{timeZone:'UTC'}"]:
            add('locale/styles/'+cls+'/'+options,SAMPLES[cls]+".toLocaleString('en-US',"+options+')')
    return result


INDEPENDENT = {
    'independent/epoch-negative': ['-1n', -1, '1969-12-31T23:59:59.999999999Z', '-1000000n'],
    'independent/nanoseconds': [1, 1, False, 'PT0.000000001S', '-PT0.000000001S'],
    'independent/leap-date': [4, 60, 29, 366, True, '2025-02-28', 'P1D'],
    'independent/time-wrap': '00:00:00',
    'independent/datetime-carry': '2024-03-01T00:00:00',
    'independent/yearmonth': '2025-02',
    'independent/monthday': '2024-02-29',
    'independent/dst-day': [23, '2024-03-11T00:00:00-04:00[America/New_York]', '2024-03-11T01:00:00-04:00[America/New_York]'],
    'independent/instant-limits': ['-271821-04-20T00:00:00Z', '+275760-09-13T00:00:00Z'],
    'independent/now-bracket': True,
    'independent/now-date': True,
    'independent/now-datetime': True,
    'independent/now-time': True,
    'independent/now-zoned': [True, 'America/New_York'],
    'now/default-zone': [True, True, True],
}


def native_boundaries():
    return [
        ('boundary/instant-positive-2p64-ns', expression("(()=>{let d=new Temporal.Instant(0n).until(new Temporal.Instant(18446744073709551616n),{largestUnit:'nanosecond'});return d.nanoseconds===18446744073709551616&&d.microseconds===0})()"), True),
        ('boundary/instant-negative-2p64-ns', expression("(()=>{let d=new Temporal.Instant(0n).since(new Temporal.Instant(18446744073709551616n),{largestUnit:'nanosecond'});return d.nanoseconds===-18446744073709551616&&d.microseconds===0})()"), True),
        ('boundary/instant-positive-2p63-us', expression("(()=>{let d=new Temporal.Instant(-4611686018427387904000n).until(new Temporal.Instant(4611686018427387904000n),{largestUnit:'microsecond'});return d.microseconds===9223372036854775808&&d.nanoseconds===0})()"), True),
        ('boundary/monthday-month13-constrain', expression("new Temporal.PlainMonthDay(1,31).with({month:13}).toString()"), '12-31'),
        ('boundary/monthday-month13-reject', expression("new Temporal.PlainMonthDay(1,1).with({month:13},{overflow:'reject'}).toString()"), ['error', 'RangeError']),
        ('boundary/yearmonth-huge-day', expression("new Temporal.PlainYearMonth(2000,2).toPlainDate({day:2147483648}).toString()"), '2000-02-29'),
        ('boundary/yearmonth-huge-positive-day', expression("new Temporal.PlainYearMonth(2000,2).toPlainDate({day:1e100}).toString()"), '2000-02-29'),
        ('boundary/yearmonth-huge-negative-day', expression("new Temporal.PlainYearMonth(2000,2).toPlainDate({day:-1e100}).toString()"), '2000-02-01'),
        ('boundary/yearmonth-huge-day-reject', expression("new Temporal.PlainYearMonth(2000,2).toPlainDate({day:2147483648},{overflow:'reject'}).toString()"), ['error', 'RangeError']),
    ]


FAULTS = [
    '(function(){return '+sample+'})' for sample in SAMPLES.values()
] + [
    '(function(){return Temporal.'+cls+'.from('+json.dumps(text)+')})' for cls,text in STRINGS.items()
] + [
    '(function(){return '+sample+".toLocaleString('en-US'"+(",{calendar:'iso8601'}" if cls in ['PlainYearMonth','PlainMonthDay'] else '')+")})" for cls,sample in SAMPLES.items()
] + [
    "(function(){return Temporal.Duration.from({hours:1,microseconds:999,nanoseconds:999}).round({smallestUnit:'millisecond'})})",
    "(function(){return Temporal.Duration.from('P1M').total({unit:'days',relativeTo:'2024-02-01'})})",
    "(function(){return Temporal.Duration.compare('P1D','PT24H',{relativeTo:'2024-03-10T00:00-05:00[America/New_York]'})})",
    "(function(){return Temporal.PlainDate.from({year:5784,monthCode:'M05L',day:20,calendar:'hebrew'}).add({months:1})})",
    "(function(){return Temporal.PlainDateTime.from('2024-02-29T23:59:59.999999999').round('minute')})",
    "(function(){return Temporal.ZonedDateTime.from('2024-11-03T01:30[America/New_York]',{disambiguation:'later'}).add({days:1})})",
    "(function(){return Temporal.ZonedDateTime.from('2024-03-10T00:00[America/New_York]').until('2024-03-11T00:00[America/New_York]',{largestUnit:'day'})})",
    "(function(){return Temporal.ZonedDateTime.from('2024-01-01T00:00[America/New_York]').getTimeZoneTransition('next')})",
    "(function(){return Temporal.Now.instant()})",
    "(function(){return Temporal.Now.zonedDateTimeISO()})",
    "(function(){return new Date(-1).toTemporalInstant()})",
    "(function(){class D extends Temporal.PlainDate{};return new D(2024,2,29)})",
]
