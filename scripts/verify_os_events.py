#!/usr/bin/env python3
"""Verify the native libc event boundary against independent assertions and qjs.

--native and --oracle are separate actual qjs executables. --fixture is the native
src/js_os_events_fixture.silk executable, which injects every allocation ordinal
until non-injected success and checks JS/native descriptor/signal-mask teardown.
No build runs implicitly. C failures remain non-passing source defects, never
converted into expectations for the native implementation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time

from verify_bytecode import validate_pins

ROOT = Path(__file__).resolve().parents[1]
IMPORTS = "import * as os from 'os'; import * as std from 'std';\n"
CASES = [
    ("timer-jobs", """
let a=['sync']; Promise.resolve().then(()=>a.push('job'));
os.setTimeout(()=>{a.push('timer1');Promise.resolve().then(()=>a.push('job1'))},0);
os.setTimeout(()=>a.push('timer2'),0);
os.setTimeout(()=>print(JSON.stringify(a)),0);
""", 0, b'["sync","job","timer1","job1","timer2"]\n', None),
    ("timer-cancellation", """
let a=[], calls=[];
const id=os.setTimeout(()=>a.push('cancelled'),0);
os.clearTimeout({valueOf(){calls.push('clear');return id}});
os.clearTimeout(-1);os.clearTimeout(undefined);
os.setTimeout(()=>{a.push('negative');os.setTimeout(()=>{a.push('nested');print(JSON.stringify([a,calls]))},0)},-100);
""", 0, b'[["negative","nested"],["clear"]]\n', None),
    ("coercion-order", """
let a=[];function bad(f){try{f()}catch(e){a.push(e.name)}};
bad(()=>os.setTimeout(null,{valueOf(){a.push('wrong-delay');return 0}}));
bad(()=>os.setReadHandler({valueOf(){a.push('fd');return -1}},42));
bad(()=>os.signal({valueOf(){a.push('signal');return 64}},()=>{}));
bad(()=>os.sleepAsync({valueOf(){a.push('delay');throw TypeError('x')}}));
print(JSON.stringify(a));
""", 0, b'["TypeError","fd","TypeError","signal","RangeError","delay","TypeError"]\n', None),
    ("fd-read-before-write", """
let [r,w]=os.pipe(), a=[];let b=new Uint8Array([7]);os.write(w,b.buffer,0,1);
os.setReadHandler(r,()=>{a.push('read');os.read(r,b.buffer,0,1);os.setReadHandler(r,null)});
os.setWriteHandler(w,()=>{a.push('write');os.setWriteHandler(w,null);os.close(r);os.close(w);print(JSON.stringify(a))});
""", 0, b'["read","write"]\n', None),
    ("fd-eof", """
let [r,w]=os.pipe();os.close(w);let b=new ArrayBuffer(1);
os.setReadHandler(r,()=>{let n=os.read(r,b,0,1);os.setReadHandler(r,null);os.close(r);print(n)});
""", 0, b'0\n', None),
    ("fd-list-mutation", """
let [r,w]=os.pipe(),[r2,w2]=os.pipe(),b=new Uint8Array([1]);
os.write(w,b.buffer,0,1);os.write(w2,b.buffer,0,1);
os.setReadHandler(r,()=>{os.setReadHandler(r,null);os.setReadHandler(r2,null);for(let fd of [r,w,r2,w2])os.close(fd);print('first-only')});
os.setReadHandler(r2,()=>print('wrong-second'));
""", 0, b'first-only\n', None),
    ("invalid-fd-ready", """
os.setReadHandler(1000000000,()=>{os.setReadHandler(1000000000,null);print('POLLNVAL')});
""", 0, b'POLLNVAL\n', None),
    ("signal-before-timer", """
let a=[];os.signal(os.SIGUSR1,()=>{a.push('signal');os.signal(os.SIGUSR1,null)});
os.setTimeout(()=>{a.push('timer');print(JSON.stringify(a))},0);os.kill(os.getpid(),os.SIGUSR1);
""", 0, b'["signal","timer"]\n', None),
    ("signal-reregister-pending", """
os.signal(os.SIGUSR1,()=>print('wrong-old'));
os.kill(os.getpid(),os.SIGUSR1);os.signal(os.SIGUSR1,null);
os.signal(os.SIGUSR1,()=>print('readded'));
os.setTimeout(()=>os.signal(os.SIGUSR1,null),0);
""", 0, b'readded\n', None),
    ("signals-not-keepalive", "os.signal(os.SIGUSR1,()=>print('wrong'));print('exit');", 0, b'exit\n', None),
    ("signal-ignore", "os.signal(os.SIGUSR1,undefined);os.kill(os.getpid(),os.SIGUSR1);print('ignored');os.signal(os.SIGUSR1,null);", 0, b'ignored\n', None),
    ("sleep-await", """
let before=os.now();let value=await os.sleepAsync(20);
if(value!==undefined||os.now()-before<18)throw Error('clock/resolve contract');print('slept');
""", 0, b'slept\n', None),
    ("await-rejected", "await Promise.reject('await-owned-rejection');", 1, b'', b'await-owned-rejection'),
    ("handled-rejection", """
let a=[];let p=Promise.reject('handled');Promise.resolve().then(()=>p.catch(v=>a.push(v)));
os.setTimeout(()=>print(JSON.stringify(a)),0);
""", 0, b'["handled"]\n', None),
    ("unhandled-before-poll", """
Promise.reject('unhandled-event');print('sync');os.setTimeout(()=>print('wrong-timer'),0);
""", 1, b'sync\n', b'Possibly unhandled promise rejection: '),
    ("unhandled-job", "Promise.resolve().then(()=>{throw 'job-rejection'});", 1, b'', b'Possibly unhandled promise rejection: '),
    ("callback-errors-continue", """
os.setTimeout(()=>{throw 'callback-failure'},0);os.setTimeout(()=>print('continued'),0);
""", 0, b'continued\n', b'callback-failure'),
    ("timer-id-shape", """
let a=os.setTimeout(()=>{},10000),b=os.setTimeout(()=>{},10000);os.clearTimeout(a);os.clearTimeout(b);
print(Number.isInteger(a)&&a>0&&b===a+1);
""", 0, b'true\n', None),
]


def run(executable, path, *, timeout=30):
    return subprocess.run([str(executable), str(path)], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, cwd=path.parent)


def check(result, case, owner):
    name, _, status, output, error = case
    if result.returncode != status or result.stdout != output:
        raise AssertionError((owner, name, result.returncode, result.stdout, result.stderr,
                              'expected', status, output))
    if error is None:
        if result.stderr:
            raise AssertionError((owner, name, 'unexpected stderr', result.stderr))
    elif error not in result.stderr:
        raise AssertionError((owner, name, 'missing diagnostic', error, result.stderr))


def externally_signal(executable, path, signo, expected):
    process = subprocess.Popen([str(executable), str(path)], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, cwd=path.parent)
    prefix = b''
    try:
        deadline = time.monotonic() + 15
        while b'READY\n' not in prefix:
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError(('signal fixture did not become ready', prefix))
            readable, _, _ = select.select([process.stdout], [], [], left)
            if readable:
                data = os.read(process.stdout.fileno(), 4096)
                if not data:
                    raise AssertionError(('early signal fixture exit', prefix, process.communicate()))
                prefix += data
        os.kill(process.pid, signo)
        output, error = process.communicate(timeout=20)
        observed = prefix + output
        if process.returncode != 0 or observed != expected or error:
            raise AssertionError(('signal delivery', process.returncode, observed, error, expected))
        return observed
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--reference', type=Path, default=Path('/private/tmp/silkjs-quickjs-reference-20261023'))
    parser.add_argument('--source-defects', type=Path, required=True)
    args = parser.parse_args()
    validate_pins(args.reference.resolve())
    native, oracle, fixture = (path.resolve() for path in (args.native, args.oracle, args.fixture))
    defects, transcript = [], bytearray()
    with tempfile.TemporaryDirectory(prefix='silkjs-os-events-') as directory:
        work = Path(directory).resolve()
        for case in CASES:
            path = work / (case[0] + '.mjs')
            path.write_text(IMPORTS + case[1])
            source = run(oracle, path)
            try:
                check(source, case, 'C')
            except AssertionError as error:
                defects.append({'case': case[0], 'failure': repr(error)})
            actual = run(native, path)
            check(actual, case, 'native')
            # Non-error output has an independent literal expectation and C parity.
            if source.returncode == case[2] and source.stdout == case[3]:
                if actual.stdout != source.stdout:
                    raise AssertionError((case[0], 'C/native stdout mismatch'))
            transcript.extend(actual.stdout)
        external = work / 'external-signal.mjs'
        external.write_text(IMPORTS + """
let guard=os.setTimeout(()=>{throw Error('signal timeout')},5000);
os.signal(os.SIGUSR1,()=>{os.clearTimeout(guard);os.signal(os.SIGUSR1,null);print('handled')});
console.log('READY');
""")
        interrupt = work / 'eval-interrupt.mjs'
        interrupt.write_text(IMPORTS + """
os.signal(os.SIGINT,()=>print('wrong-late-interrupt'));
console.log('READY');try{std.evalScript('while(true){}')}catch(e){print(e.name)}
print(std.evalScript('40+2'));os.signal(os.SIGINT,null);
""")
        for owner, executable in [('C', oracle), ('native', native)]:
            for path, signo, expected in [
                (external, signal.SIGUSR1, b'READY\nhandled\n'),
                (interrupt, signal.SIGINT, b'READY\nInternalError\n42\n'),
            ]:
                try:
                    transcript.extend(externally_signal(executable, path, signo, expected))
                except (AssertionError, subprocess.TimeoutExpired) as error:
                    if owner == 'native':
                        raise
                    defects.append({'case': path.name, 'failure': repr(error)})
        default_signal = work / 'signal-default.mjs'
        default_signal.write_text(IMPORTS + "os.signal(os.SIGUSR1,null);console.log('READY');os.setTimeout(()=>{},10000);")
        for executable in (oracle, native):
            process = subprocess.Popen([str(executable), str(default_signal)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                ready, _, _ = select.select([process.stdout], [], [], 15)
                if not ready or os.read(process.stdout.fileno(), 4096) != b'READY\n':
                    raise AssertionError('default signal fixture not ready')
                os.kill(process.pid, signal.SIGUSR1)
                output, error = process.communicate(timeout=15)
                if process.returncode != -signal.SIGUSR1:
                    raise AssertionError(('SIG_DFL changed', executable, process.returncode, output, error))
            finally:
                if process.poll() is None:
                    process.kill(); process.communicate()
    faults = subprocess.run([str(fixture)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
    sys.stderr.buffer.write(faults.stderr)
    if faults.returncode or len(faults.stdout) != 12:
        raise AssertionError(('allocation fixture', faults.returncode, faults.stdout, faults.stderr))
    operations, attempts, injected = struct.unpack('<3I', faults.stdout)
    if operations != 9 or attempts != injected + operations or not injected:
        raise AssertionError(('sweep stopped without independent clean success', operations, attempts, injected))
    args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    if defects:
        raise SystemExit(f'{len(defects)} pinned-C failures remain non-passing: {args.source_defects}')
    print(f'PASS {len(CASES)+3} event behaviors; {attempts} native allocation ordinals; '
          f'{injected} injected; zero heap/FD ledgers and restored signal masks; '
          f'SHA256={hashlib.sha256(transcript).hexdigest()}')


if __name__ == '__main__':
    main()
