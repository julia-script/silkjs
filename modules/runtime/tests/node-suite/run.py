#!/usr/bin/env python3
"""Run Node's test/parallel (or other dirs) against a binary. usage: run.py BIN OUT.json [dir] [jobs] [filter-regex]"""
import json, os, re, subprocess, sys, time, shutil
from concurrent.futures import ThreadPoolExecutor
BIN, OUT = sys.argv[1], sys.argv[2]
DIR = sys.argv[3] if len(sys.argv) > 3 else 'parallel'
JOBS = int(sys.argv[4]) if len(sys.argv) > 4 else 4
FILT = re.compile(sys.argv[5]) if len(sys.argv) > 5 else None
PRE = os.environ.get('PRE','').split()
ROOT = os.path.expanduser(os.environ.get('NODE_SRC', '~/setup/node-src'))
TD = os.path.join(ROOT, 'test', DIR)
files = sorted(f for f in os.listdir(TD) if f.startswith('test-') and (f.endswith('.js') or f.endswith('.mjs') or f.endswith('.cjs')))
if FILT: files = [f for f in files if FILT.search(f)]
FLAGS = re.compile(r'^//\s+Flags:(.*)$', re.M)
import threading
slots = list(range(JOBS)); lock = threading.Lock()
def run(f):
    with lock: sid = slots.pop()
    try:
        src = open(os.path.join(TD, f), encoding='utf-8', errors='replace').read()
        flags = []
        for m in FLAGS.finditer(src): flags += m.group(1).split()
        env = dict(os.environ); env.pop('NODE_OPTIONS', None)
        env['TEST_THREAD_ID'] = str(sid); env['NODE_TEST_DIR'] = os.path.expanduser(os.environ.get('NODE_TEST_DIR', '~/nodetest/tmp'))
        os.makedirs(env['NODE_TEST_DIR'], exist_ok=True)
        t = time.time()
        import signal
        p = subprocess.Popen([BIN, *PRE, *flags, os.path.join('test', DIR, f)], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            so, se = p.communicate(timeout=60); code = p.returncode
        except subprocess.TimeoutExpired:
            code = 'timeout'
            try: os.killpg(p.pid, signal.SIGKILL)
            except Exception: pass
            try: so, se = p.communicate(timeout=5)
            except Exception: so, se = b'', b''
        try: os.killpg(p.pid, signal.SIGKILL)
        except Exception: pass
        out = (so[-1500:] + b'\n--stderr--\n' + se[-3000:]).decode('utf-8', 'replace')
        skipped = code == 0 and '1..0 # Skipped' in out
        return f, {'code': code, 'skip': skipped, 'flags': flags, 'ms': int((time.time()-t)*1000), 'out': out if code != 0 or skipped else ''}
    finally:
        with lock: slots.append(sid)
res = {}
J = OUT + 'l'
if os.path.exists(J):
    for line in open(J):
        try: f, r = json.loads(line); res[f] = r
        except Exception: pass
todo = [f for f in files if f not in res]
jl = open(J, 'a')
with ThreadPoolExecutor(JOBS) as ex:
    for i, (f, r) in enumerate(ex.map(run, todo)):
        res[f] = r; jl.write(json.dumps([f, r]) + '\n'); jl.flush()
        if i % 200 == 0: print(i, len(todo), flush=True)
json.dump(res, open(OUT, 'w'), indent=0)
ok = sum(1 for r in res.values() if r['code'] == 0 and not r['skip'])
print('pass', ok, 'skip', sum(r['skip'] for r in res.values()), 'total', len(res))
