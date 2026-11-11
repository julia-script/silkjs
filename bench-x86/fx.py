# fx.py ROUNDS BIN... : user and wall seconds per binary on fx-typescript.js, interleaved
import subprocess,resource,sys,time
rounds=int(sys.argv[1]); bins=sys.argv[2:]
ut={b:[] for b in bins}; wt={b:[] for b in bins}
for r in range(rounds):
    for b in bins:
        r0=resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime; t0=time.time()
        p=subprocess.run([b,'fx-typescript.js'],capture_output=True,text=True)
        if p.returncode: print('FAIL',b,p.stderr[-300:])
        ut[b].append(resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime-r0); wt[b].append(time.time()-t0)
    print('round',r,' '.join('%.2f'%wt[b][-1] for b in bins),flush=True)
ref=min(wt[bins[0]])
for b in bins:
    w=sorted(wt[b]); print('%-22s wall min %.3f med %.3f  user min %.3f  wall/v8 %.3f  v8/wall %.3f'%(b.split('/')[-1],w[0],w[len(w)//2],min(ut[b]),w[0]/ref,ref/w[0]))
