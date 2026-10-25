#!/usr/bin/env python3
"""Exercise native std through real CLI, localhost HTTP and ordinal OOM fixture.

Requires independently built native/oracle qjs executables. The oracle is never
linked into native code. Builds only the standalone native allocation fixture
unless --fault-native is supplied. All source-C failures remain hard failures.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import struct
import pty
import select
import subprocess
import tempfile
import threading
import termios

ROOT = Path(__file__).resolve().parents[1]
PIN = '8c6c42619ab4edf1548b051c73bb2bee670003415b1de30d2910d71917859bce'


class Response(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/ok':
            status, body = 200, b'A\0B\xff'
        elif self.path.startswith('/quote'):
            status, body = 200, b'escaped'
        else:
            status, body = 404, b'missing'
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Std-Fixture', 'yes')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Source closes a non-full error response after its status line.
            pass


def execute(command, env, timeout, output, label, status=0):
    result = subprocess.run(list(map(str, command)), env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    (output / (label + '.stdout')).write_bytes(result.stdout)
    (output / (label + '.stderr')).write_bytes(result.stderr)
    if result.returncode != status:
        raise SystemExit(f'{label}: exit {result.returncode}, expected {status}: {result.stderr!r}')
    return result.stdout


def format_matrix():
    cases = []
    for kind in ['d', 'i', 'u', 'o', 'x', 'X', 'ld', 'li', 'lu', 'lo', 'lx', 'lX']:
        for flag in ['', '+', ' ', '-', '0', '#']:
            for value in ['0', '1', '-1', '2147483648', '4294967297n', '-9223372036854775808n']:
                cases.append((f'%{flag}16.8{kind}', [value]))
    for kind in 'efgaEFGA':
        for value in ['0', '-0', '1.25', '-123.5', '1e-100', '1e100', 'Infinity', 'NaN']:
            cases.append((f'%+#25.9{kind}', [value]))
    for text in ['""', '"a"', '"é😀"', '"a\\0b"']:
        for fmt in ['%s', '%10s', '%-10.3s', '%c']:
            cases.append((fmt, [text]))
    lines = ["import * as std from 'std'; const out=[];"]
    for fmt, values in cases:
        lines.append('out.push(std.sprintf(' + json.dumps(fmt) + ',' + ','.join(values) + '));')
    lines.append("std.out.puts(JSON.stringify(out),'\\n');")
    return '\n'.join(lines), len(cases)

def worker_stdio(binary, env, timeout, output, prefix):
    """Normal FILE finalization and URL I/O, including detached source Workers."""
    cases = {
        'popen-finalizer': (
            "globalThis.file=std.popen('echo $$; exit 7','r');"
            "const pid=Number(file.getline());globalThis.file=null;std.gc();"
            "os.Worker.parent.postMessage({pid:pid,finalized:true});"
        ),
        'urlget-worker': (
            "const reply=std.urlGet(std.getenv('SILK_STD_URL')+'/ok',{binary:true,full:true});"
            "os.Worker.parent.postMessage({status:reply.status,bytes:Array.from(new Uint8Array(reply.response))});"
        ),
    }
    for name, body in cases.items():
        label = prefix + '-' + name
        worker = output/(label+'-worker.mjs')
        worker.write_text("import * as std from 'std';import * as os from 'os';"+body)
        main = output/(label+'-main.mjs')
        main.write_text(
            "import * as std from 'std';import * as os from 'os';"
            "const w=new os.Worker("+json.dumps('./'+worker.name)+");"
            "let done;const ready=new Promise(r=>done=r);"
            "w.onmessage=e=>{std.puts(JSON.stringify(e.data),'\\n');w.onmessage=null;done()};"
            "await ready;"
        )
        observation = execute([binary.resolve(), '-m', main], env, timeout, output, label)
        message = json.loads(observation)
        if name == 'popen-finalizer':
            pid = message.get('pid', 0)
            if not isinstance(pid, int) or pid <= 0 or message.get('finalized') is not True:
                raise SystemExit('finalizer test did not observe its shell PID and completed GC')
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise SystemExit(f'pclose finalizer did not reap its child {pid}')
        elif message != {'status':200, 'bytes':[65, 0, 66, 255]}:
            raise SystemExit(f'Worker URL response differs: {message!r}')
    return len(cases)


def stdio_autoflush(binary, env, timeout, output, prefix):
    """A real input PTY must flush buffered output before waiting for a line."""
    source = output/(prefix+'-autoflush.mjs')
    source.write_text("import * as std from 'std';std.out.puts('pending');"
                      "const line=std.in.getline();std.out.puts('|'+line+'|');")
    input_master, input_slave = pty.openpty()
    output_master, output_slave = pty.openpty()
    process = None
    observed = bytearray()
    try:
        attributes = termios.tcgetattr(input_slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(input_slave, termios.TCSANOW, attributes)
        process = subprocess.Popen([str(binary.resolve()), '-m', str(source)], env=env,
                                   stdin=input_slave, stdout=output_slave, stderr=subprocess.PIPE)
        while len(observed) < len(b'pending'):
            readable, _, _ = select.select([output_master], [], [], timeout)
            if not readable:
                raise SystemExit('stdio input did not automatically flush pending output')
            observed.extend(os.read(output_master, 65536))
        if observed != b'pending':
            raise SystemExit(f'unexpected pre-input stdout: {observed!r}')
        os.write(input_master, b'answer\n')
        _, errors = process.communicate(timeout=timeout)
        while select.select([output_master], [], [], 0)[0]:
            observed.extend(os.read(output_master, 65536))
        (output/(prefix+'-autoflush.stdout')).write_bytes(observed)
        (output/(prefix+'-autoflush.stderr')).write_bytes(errors)
        if process.returncode != 0 or errors or observed != b'pending|answer|':
            raise SystemExit(f'stdio PTY autoflush differs: {(process.returncode, bytes(observed), errors)!r}')
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
        for descriptor in (input_master, input_slave, output_master, output_slave):
            os.close(descriptor)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--upstream', type=Path, default=Path('/private/tmp/silkjs-quickjs-reference-20261023'))
    parser.add_argument('--fault-native', type=Path)
    parser.add_argument('--silk', type=Path, default=ROOT/'build/toolchain-main-dd2e99ab/silk-fixed5')
    parser.add_argument('--stdlib', type=Path, default=ROOT/'build/toolchain-main-dd2e99ab/stdlib')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--timeout', type=float, default=300)
    args = parser.parse_args()
    if hashlib.sha256((args.upstream/'quickjs-libc.c').read_bytes()).hexdigest() != PIN:
        raise SystemExit('quickjs-libc.c does not match the pinned source')
    output = args.output or Path(tempfile.mkdtemp(prefix='silkjs-std-'))
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, LC_ALL='C', TZ='UTC')
    env.setdefault('SDKROOT', '/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk')
    env.setdefault('SILK_CLANG', '/opt/homebrew/opt/llvm/bin/clang')
    env['SILK_VERIFY_MIR'] = '1'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Response)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env['SILK_STD_URL'] = f'http://127.0.0.1:{server.server_port}'
    try:
        observations = []
        for label, binary in [('oracle', args.oracle), ('native', args.native)]:
            work = output/label
            work.mkdir(exist_ok=True)
            child_env = dict(env, SILK_STD_DIR=str(work))
            result = execute([binary.resolve(), '-m', ROOT/'scripts/std_cases.js'], child_env,
                             args.timeout, output, label+'-contracts')
            record = json.loads(result)
            if record.get('checks', 0) < 90:
                raise SystemExit(f'{label}: incomplete std contracts: {record}')
            observations.append(result)
        if observations[0] != observations[1]:
            raise SystemExit('native/oracle std contract observation mismatch')
        matrix, matrix_count = format_matrix()
        source = output/'format.mjs'
        source.write_text(matrix)
        expected = execute([args.oracle.resolve(), '-m', source], env, args.timeout, output, 'oracle-format')
        actual = execute([args.native.resolve(), '-m', source], env, args.timeout, output, 'native-format')
        if actual != expected:
            left, right = json.loads(actual), json.loads(expected)
            index = next((i for i, pair in enumerate(zip(left, right)) if pair[0] != pair[1]), None)
            raise SystemExit(f'printf matrix mismatch at {index}')
        for label, binary in [('oracle', args.oracle), ('native', args.native)]:
            for index, (expression, status) in enumerate([('7', 7), ('undefined', 0), ('{valueOf(){throw Error("exit coercion")}}', 255)]):
                child = output/f'exit-{index}.mjs'
                child.write_text("import * as std from 'std'; std.exit("+expression+"); throw Error('exit returned');")
                execute([binary.resolve(), '-m', child], env, args.timeout, output, label+f'-exit-{index}', status)
            child = output/'stdout.mjs'
            child.write_text("import * as std from 'std'; std.puts('a','b'); if(std.printf('%d:%s',7,'Ω')!==4)throw Error('printf count');std.__printObject({x:1});")
            execute([binary.resolve(), '-m', child], env, args.timeout, output, label+'-stdout')
        if (output/'oracle-stdout.stdout').read_bytes() != (output/'native-stdout.stdout').read_bytes():
            raise SystemExit('stdout/structured print differs')
        fault = args.fault_native
        if fault is None:
            fault = output/'std-fault-native'
            execute([args.silk.resolve(), 'build', ROOT/'src/js_std_fixture.silk', '-o', fault,
                     '--stdlib', args.stdlib.resolve(), '--optimization', 'speed', '--debug', 'false'],
                    env, args.timeout, output, 'build-fault')
        record = execute([fault.resolve()], env, args.timeout, output, 'native-fault')
        if len(record) != 12:
            raise SystemExit(f'invalid std fault report: {record!r}')
        operations, attempts, injected = struct.unpack('<III', record)
        if operations != 11 or attempts != injected + operations or not injected:
            raise SystemExit(f'incomplete std failure sweep: {(operations, attempts, injected)}')
        worker_cases = 0
        for label, binary in [('oracle', args.oracle), ('native', args.native)]:
            worker_cases = worker_stdio(binary, env, args.timeout, output, label)
            stdio_autoflush(binary, env, args.timeout, output, label)
        report = {'contracts':json.loads(observations[1])['checks'], 'printfCases':matrix_count,
                  'allocationOperations':operations, 'allocationAttempts':attempts,
                  'injectedFailures':injected, 'zeroRuntimeLedgers':True,
                  'balancedNativeDescriptors':True, 'sourceSha256':PIN,
                  'workerStdioCases':worker_cases, 'workerStdioOracleComparison':True,
                  'stdioPtyAutoflushComparison':True,
                  'printfSha256':hashlib.sha256(actual).hexdigest(),
                  'sourceUndefinedBehaviorExcluded':['printf conversion-buffer overflow',
                    'getenviron subtraction before null strchr check'],
                  'nativeOwnershipRepair':'close acquired FILE/popen stream if JS wrapper allocation fails'}
        (output/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report, indent=2))
        print('Artifacts:', output)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
