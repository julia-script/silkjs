import json,re,collections,sys
n=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
el=[f for f,x in n.items() if x['code']==0 and not x['skip']]
def sig(x):
    if x['code']=='timeout': return 'TIMEOUT'
    e=x['out'].split('--stderr--')[-1]
    lines=[l.strip() for l in e.splitlines() if l.strip()]
    for l in lines:
        m=re.search(r'((?:[A-Z][A-Za-z]*Error|AssertionError)[^\n]{0,140})',l)
        if m:
            s=m.group(1); s=re.sub(r'/\S+','<path>',s); s=re.sub(r'\d+','N',s); return s[:130]
    return ('EXIT %s: '%x['code'])+(lines[-1][:100] if lines else '')
c=collections.Counter(); ex={}
for f in el:
    x=r[f]
    if x['code']==0 and not x['skip']: continue
    s=sig(x); c[s]+=1; ex.setdefault(s,[]).append(f)
for s,k in c.most_common(int(sys.argv[3]) if len(sys.argv)>3 else 80): print(k, s, '|', ' '.join(ex[s][:3]))
