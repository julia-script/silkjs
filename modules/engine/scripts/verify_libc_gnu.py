#!/usr/bin/env python3
"""Run actual GNU libc/Worker acceptance using separately built native/C binaries.

This does not substitute CLI checks for allocation fault sweeps: the report
explicitly distinguishes GNU runtime coverage from the separate fault fixtures.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer

import verify_std as std
import verify_os_system as system
import verify_os_events as events
import verify_os_workers as workers

ROOT = Path(__file__).resolve().parents[1]
SAB_OK = b'detached SAB lifetime OK: root freed, original owners dropped, real notify, eventual zero ledgers\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('native', 'oracle', 'upstream', 'sab-fixture', 'oracle-fixture', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux':
        raise SystemExit('This acceptance must execute on a real Linux runtime')
    native, oracle = args.native.resolve(strict=True), args.oracle.resolve(strict=True)
    assert native != oracle
    workers.REFERENCE = args.upstream.resolve(strict=True)
    workers.validate_pins(workers.REFERENCE)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, LC_ALL='C', TZ='UTC')
    server = ThreadingHTTPServer(('127.0.0.1', 0), std.Response)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env['SILK_STD_URL'] = f'http://127.0.0.1:{server.server_port}'
    report = {'platform': platform.platform(), 'libc': platform.libc_ver(),
              'nativeSha256': hashlib.sha256(native.read_bytes()).hexdigest(),
              'oracleSha256': hashlib.sha256(oracle.read_bytes()).hexdigest(),
              'faultSweepsExecutedByThisDriver': False, 'sourceFailures': []}
    try:
        observations = []
        matrix, formats = std.format_matrix()
        format_file = output / 'format.mjs'
        format_file.write_text(matrix)
        formatting = []
        for label, binary in [('native', native), ('oracle', oracle)]:
            work = output / label
            work.mkdir(exist_ok=True)
            child_env = dict(env, SILK_STD_DIR=str(work))
            observations.append(std.execute([binary, '-m', ROOT / 'scripts/std_cases.js'],
                                            child_env, 90, output, label + '-std'))
            formatting.append(std.execute([binary, '-m', format_file], env, 90, output, label + '-format'))
            std.worker_stdio(binary, env, 90, output, label)
            std.stdio_autoflush(binary, env, 30, output, label)
            actual = system.run([binary, ROOT / 'tests/fixtures/os_system.mjs'], cwd=work, env=env)
            assert actual.stdout == b'os synchronous behavior OK\n', actual
            system.constants(binary, work)
            system.executable_search(binary, work)
            system.terminal(binary, work)
        assert observations[0] == observations[1]
        report['stdContracts'] = json.loads(observations[0])['checks']
        assert report['stdContracts'] == 99
        assert formatting[0] == formatting[1]
        report['printfCases'] = formats
        system.native_undefined_behavior_contract(native, output / 'native')
        report['nativeWnohangDefinedStatus'] = 'passed; source uninitialized-status UB is not a differential oracle'
        abi = output / 'os-abi'
        system.run(['cc', '-std=c11', '-D_DEFAULT_SOURCE', ROOT / 'tests/fixtures/os_abi.c', '-o', abi], cwd=ROOT)
        assert system.run([abi], cwd=ROOT).stdout == b'os host ABI OK\n'
        event_count = 0
        with tempfile.TemporaryDirectory(prefix='silk-gnu-events-') as directory:
            work = Path(directory)
            for case in events.CASES:
                path = work / (case[0] + '.mjs')
                path.write_text(events.IMPORTS + case[1])
                reference = events.run(oracle, path)
                try:
                    events.check(reference, case, 'C')
                except AssertionError as error:
                    report['sourceFailures'].append({'case': case[0], 'failure': repr(error)})
                actual = events.run(native, path)
                events.check(actual, case, 'native')
                if reference.returncode == case[2] and reference.stdout == case[3]:
                    assert actual.stdout == reference.stdout
                event_count += 1
            external = work / 'external-signal.mjs'
            external.write_text(events.IMPORTS + "let guard=os.setTimeout(()=>{throw Error('timeout')},5000);os.signal(os.SIGUSR1,()=>{os.clearTimeout(guard);os.signal(os.SIGUSR1,null);print('handled')});console.log('READY');")
            interrupt = work / 'eval-interrupt.mjs'
            interrupt.write_text(events.IMPORTS + "os.signal(os.SIGINT,()=>print('wrong-late-interrupt'));console.log('READY');try{std.evalScript('while(true){}')}catch(e){print(e.name)}print(std.evalScript('40+2'));os.signal(os.SIGINT,null);")
            for label, binary in [('native', native), ('oracle', oracle)]:
                for path, signo, expected in [(external, signal.SIGUSR1, b'READY\nhandled\n'),
                                              (interrupt, signal.SIGINT, b'READY\nInternalError\n42\n')]:
                    try:
                        events.externally_signal(binary, path, signo, expected)
                    except (AssertionError, subprocess.TimeoutExpired) as error:
                        if label == 'native':
                            raise
                        report['sourceFailures'].append({'case': path.name, 'failure': repr(error)})
        report['eventCases'] = event_count
        report['externalSignalCases'] = 2
        report['workerCliCases'] = workers.suite(native, oracle, env)
        for label, binary, expected in [('detached-sab', args.sab_fixture, SAB_OK),
                                        ('detached-c-embedding', args.oracle_fixture, b'detached-root-free:ok\n')]:
            result = subprocess.run([str(binary.resolve(strict=True))], cwd=ROOT,
                                    capture_output=True, timeout=30, env=env)
            (output / (label + '.stdout')).write_bytes(result.stdout)
            (output / (label + '.stderr')).write_bytes(result.stderr)
            assert result.returncode == 0 and result.stdout == expected and not result.stderr, result
            report[label] = 'passed'
        report['passed'] = not report['sourceFailures']
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['passed']:
        raise SystemExit('Pinned C failures remain non-passing: ' + str(output / 'report.json'))
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
