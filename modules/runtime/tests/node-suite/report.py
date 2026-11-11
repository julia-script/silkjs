import json,collections,re,sys
n=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
def mod(f):
    t=f[5:].split('-'); t0=t[0].split('.')[0]
    m={'stream2':'stream','stream3':'stream','readable':'stream','webstream':'webstreams','child':'child_process','runner':'test_runner','whatwg':'whatwg('+t[1]+')' if len(t)>1 else 'whatwg','diagnostics':'diagnostics_channel','diagnostic':'diagnostics_channel','async':'async_hooks/als','als':'async_hooks/als','event':'events','events':'events','eventtarget':'events','perf':'perf_hooks','performance':'perf_hooks','performanceobserver':'perf_hooks','require':'module','esm':'module','compile':'module(compile-cache)','trace':'trace_events','fastutf8stream':'fs','filehandle':'fs','file':'fs','heap':'v8/heap','heapsnapshot':'v8/heap','webcrypto':'crypto(webcrypto)','stdin':'stdio','stdout':'stdio','stdio':'stdio','tty':'tty','ttywrap':'tty','pipe':'net','tcp':'net','socket':'net','listen':'net','promise':'promises/rejections','promises':'promises/rejections','unhandled':'promises/rejections','next':'process','tick':'process','microtask':'process','signal':'process','cwd':'process','abortsignal':'abort','abortcontroller':'abort','domexception':'web','blob':'web','fetch':'web','eventsource':'web','websocket':'web','webstorage':'web','structuredClone':'web','urlpattern':'url','error':'errors','errors':'errors','exception':'errors','uncaught':'errors'}
    return m.get(t0,t0)
eligible={f for f,x in n.items() if x['code']==0 and not x['skip']}
stat=collections.defaultdict(lambda: collections.Counter())
fails=collections.defaultdict(list)
for f in eligible:
    x=r.get(f); m=mod(f)
    internal=any(fl.startswith('--expose-internals') or fl.startswith('--expose_internals') for fl in x['flags'])
    k='pass' if x['code']==0 and not x['skip'] else ('skip' if x['skip'] else 'fail')
    stat[m][k]+=1
    if internal: stat[m]['int_'+k]+=1
    if k!='pass': fails[m].append(f)
rows=sorted(stat.items(), key=lambda kv:-(kv[1]['fail']+kv[1]['skip']))
tot=collections.Counter()
for m,c in rows: tot.update(c)
print('eligible',len(eligible),'pass',tot['pass'],'fail',tot['fail'],'skip',tot['skip'],'internal-flag fails',tot['int_fail'])
for m,c in rows:
    t=c['pass']+c['fail']+c['skip']
    print(f"{m:28s} {c['pass']:4d}/{t:<4d} fail {c['fail']:4d} skip {c['skip']:3d} (internals {c['int_fail']+c['int_skip']})")
json.dump(fails,open(sys.argv[3],'w'),indent=1)
