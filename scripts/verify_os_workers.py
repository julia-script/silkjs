#!/usr/bin/env python3
"""Exercise real detached Worker threads, clone transport and lifetime/fault ledgers.

The pinned QuickJS executable and C embedding fixture are independent oracle
programs, never production linkage. Native fixtures check post-root FILE and
SharedArrayBuffer progress, retained queues and eventual resource reclamation.
Builds are opt-in. A timeout, native failure or oracle failure is a failure;
no crash/timeout is normalized into a successful comparison.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time

from verify_bytecode import validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = Path('/private/tmp/silkjs-quickjs-reference-20261023')


def invoke(argv, *, cwd=ROOT, timeout=90, env=None, stdin=None):
    result = subprocess.run([str(item) for item in argv], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, stdin=stdin)
    if result.returncode:
        raise AssertionError((argv, result.returncode, result.stdout, result.stderr))
    return result


def build(args, source, output, env):
    invoke([args.compiler, 'build', source, '-o', output, '--stdlib', args.stdlib,
            '--optimization', 'speed', '--debug', 'false'], timeout=1800, env=env)


def process_exit(executable, arguments, *, cwd, env, stdin=None):
    # Source exits the qjs process without joining Workers. File-backed capture
    # observes process exit independently of forked exec/popen descendants that
    # inherit stdio. The harness reaps its process group only after that verdict.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        process = subprocess.Popen([str(executable), *map(str, arguments)],
                                   cwd=cwd, env=env, stdin=stdin,
                                   stdout=output, stderr=error,
                                   start_new_session=True)
        try:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired as failure:
                output.seek(0); error.seek(0)
                raise AssertionError(('detached process-exit timeout', executable,
                                      arguments, output.read(), error.read())) from failure
            output.seek(0); error.seek(0)
            result = subprocess.CompletedProcess(process.args, process.returncode,
                                                 output.read(), error.read())
            assert result.returncode == 0, (result.args, result.returncode,
                                            result.stdout, result.stderr)
            return result
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def signal_during_sleep(executable, module, cwd, env):
    # Block the sender/main thread so process-directed SIGURG can only interrupt
    # a Worker that incorrectly unblocks it. Source Workers keep it blocked.
    # Repeated delivery spans the real 200ms sleep.
    def block_main():
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGURG})
    process = subprocess.Popen([str(executable), str(module), 'sleep-signal'],
                               cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, preexec_fn=block_main)
    try:
        ready, _, _ = select.select([process.stdout], [], [], 15)
        prefix = os.read(process.stdout.fileno(), 4096) if ready else b''
        if prefix != b'READY\n':
            if process.poll() is None:
                process.kill()
            output, error = process.communicate()
            raise AssertionError(('Worker signal sleep not ready', executable,
                                  process.returncode, prefix + output, error))
        for _ in range(5):
            time.sleep(0.01)
            os.kill(process.pid, signal.SIGURG)
        output, error = process.communicate(timeout=15)
        assert process.returncode == 0 and output == b'sleep-signal:ok\n' and error == b'', (
            executable, process.returncode, output, error)
    except subprocess.TimeoutExpired as failure:
        process.kill()
        output, error = process.communicate()
        raise AssertionError(('Worker signal sleep timeout', executable,
                              failure.timeout, output, error)) from failure
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def suite(native, oracle, env):
    # A different working directory proves Worker module filenames resolve from
    # the caller's module, not the process cwd. Whitespace/non-ASCII paths exercise
    # native bootstrap ownership rather than a shell command string.
    count = 0
    with tempfile.TemporaryDirectory(prefix='silk-workers-') as directory:
        work = Path(directory).resolve()
        modules = work / 'module space-π'
        modules.mkdir()
        for name in ['libc_worker_main.mjs', 'libc_worker_child.mjs', 'libc_worker_shutdown.mjs']:
            shutil.copyfile(ROOT / 'tests/fixtures' / name, modules / name)
        for mode in ['descriptors', 'clone', 'signals', 'queue', 'shared', 'nested', 'environment', 'experimental']:
            options = ['--experimental'] if mode == 'experimental' else []
            arguments = [*options, modules / 'libc_worker_main.mjs', mode]
            reference = invoke([oracle, *arguments], cwd=work, env=env)
            actual = invoke([native, *arguments], cwd=work, env=env)
            expected = (mode + ':ok\n').encode()
            assert reference.stdout == expected, ('oracle', mode, reference.stdout, reference.stderr)
            assert actual.stdout == expected, ('native', mode, actual.stdout, actual.stderr)
            assert actual.stderr == reference.stderr == b'', (mode, actual.stderr, reference.stderr)
            count += 1
        for executable in [oracle, native]:
            signal_during_sleep(executable, modules / 'libc_worker_main.mjs', work, env)
        count += 1
        fifo = work / 'shutdown.fifo'
        os.mkfifo(fifo)
        for command in ['block', 'spin', 'timer', 'sleep', 'read', 'write',
                        'getline', 'fifo', 'exec', 'pclose']:
            arguments = [modules / 'libc_worker_shutdown.mjs', command, fifo]
            reference = process_exit(oracle, arguments, cwd=work, env=env)
            actual = process_exit(native, arguments, cwd=work, env=env)
            expected = ('shutdown:' + command + ':ok\n').encode()
            assert actual.stdout == reference.stdout == expected, (command, actual, reference)
            assert actual.stderr == reference.stderr == b'', (command, actual.stderr, reference.stderr)
            count += 1
        # Both runtimes share libc stdin's FILE lock. Keep the writer open but
        # silent: EOF would make this a vacuous shutdown proof.
        read_fd, write_fd = os.pipe()
        try:
            arguments = [modules / 'libc_worker_shutdown.mjs', 'stdio-lock']
            reference = process_exit(oracle, arguments, cwd=work, env=env, stdin=read_fd)
            actual = process_exit(native, arguments, cwd=work, env=env, stdin=read_fd)
            assert actual.stdout == reference.stdout == b'shutdown:stdio-lock:ok\n', (actual, reference)
            assert actual.stderr == reference.stderr == b'', (actual, reference)
            count += 1
        finally:
            os.close(read_fd)
            os.close(write_fd)
    upstream = REFERENCE / 'tests/test_worker.js'
    reference = invoke([oracle, upstream], cwd=REFERENCE, timeout=120, env=env)
    actual = invoke([native, upstream], cwd=REFERENCE, timeout=120, env=env)
    assert (actual.stdout, actual.stderr) == (reference.stdout, reference.stderr), (actual, reference)
    return count + 1


def main():
    global REFERENCE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, default=ROOT / 'build/native-frontends/qjs')
    parser.add_argument('--reference', type=Path, default=REFERENCE)
    parser.add_argument('--oracle', type=Path)
    parser.add_argument('--fixture', type=Path, default=ROOT / 'build/os-workers/faults')
    parser.add_argument('--oracle-fixture', type=Path, default=ROOT / 'build/os-workers/oracle-detached')
    parser.add_argument('--sab-fixture', type=Path, default=ROOT / 'build/accept-detached-sab')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--compiler', type=Path, default=toolchain.compiler_path())
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    args = parser.parse_args()
    REFERENCE = args.reference.resolve()
    if args.oracle is None:
        args.oracle = REFERENCE / 'qjs'
    validate_pins(REFERENCE.resolve())
    env = dict(toolchain.host_environment(), SILK_VERIFY_MIR='1')
    native, oracle, fixture = args.native.resolve(), args.oracle.resolve(), args.fixture.resolve()
    oracle_fixture = args.oracle_fixture.resolve()
    sab_fixture = args.sab_fixture.resolve()
    if args.build:
        native.parent.mkdir(parents=True, exist_ok=True)
        fixture.parent.mkdir(parents=True, exist_ok=True)
        build(args, ROOT / 'src/main.silk', native, env)
        build(args, ROOT / 'src/js_os_workers_fixture.silk', fixture, env)
        sab_fixture.parent.mkdir(parents=True, exist_ok=True)
        build(args, ROOT / 'src/js_libc_detached_sab_fixture.silk', sab_fixture, env)
        oracle_fixture.parent.mkdir(parents=True, exist_ok=True)
        cflags = ['-isysroot', env['SDKROOT']] if sys.platform == 'darwin' else []
        invoke([env['SILK_CLANG'], '-std=c11', '-O2', *cflags, '-I', REFERENCE,
                ROOT / 'tests/fixtures/libc_worker_detached_oracle.c',
                REFERENCE / 'libquickjs.a', '-lm', '-ldl', '-lpthread',
                '-o', oracle_fixture], timeout=1800, env=env)
    for executable in [native, oracle, fixture, oracle_fixture, sab_fixture]:
        if not executable.is_file():
            raise FileNotFoundError(f'Build prerequisite missing: {executable}')
    count = suite(native, oracle, env)
    source_embedding = invoke([oracle_fixture], timeout=30, env=env)
    assert source_embedding.stdout == b'detached-root-free:ok\n' and source_embedding.stderr == b'', source_embedding
    sab_lifetime = invoke([sab_fixture], timeout=30, env=env)
    assert sab_lifetime.stdout == b'detached SAB lifetime OK: root freed, original owners dropped, real notify, eventual zero ledgers\n' and sab_lifetime.stderr == b'', sab_lifetime
    fault = invoke([fixture], timeout=1800, env=env)
    sys.stderr.buffer.write(fault.stderr)
    assert len(fault.stdout) == 12, ('fault record size', fault.stdout, fault.stderr)
    cases, attempts, injected = struct.unpack('<III', fault.stdout)
    assert cases == 20 and injected > 0 and attempts == cases + injected, (cases, attempts, injected)
    print(f'Worker process scenarios: {count}; pinned detached embedding and native SAB lifetime: passed; fault cases: {cases}; attempts: {attempts}; injected: {injected}; all ledgers zero')


if __name__ == '__main__':
    main()
