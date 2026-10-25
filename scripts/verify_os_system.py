#!/usr/bin/env python3
"""Actual CLI/OS/PTY and allocation-failure acceptance for native quickjs-libc os.

Builds are opt-in. The pinned C qjs is a separate behavioral oracle, never a
production library. WNOHANG's C uninitialized status is checked independently
on native only. The native fault executable reports twelve clean-success sweeps
and enforces zero leaked engine allocations, native FDs, and child processes.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
PINNED = Path('/private/tmp/silkjs-quickjs-reference-20261023')
SDK = '/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk'


def run(argv, *, cwd, expected=0, timeout=90, env=None):
    result = subprocess.run([str(arg) for arg in argv], cwd=cwd, env=env,
                            capture_output=True, timeout=timeout)
    assert result.returncode == expected, (argv, result.returncode, result.stdout, result.stderr)
    return result


def script(binary, source, directory):
    path = directory / 'case.mjs'
    path.write_text(source)
    return run([binary, path], cwd=directory)


def constants(binary, directory):
    wanted = {}
    for name in ('O_RDONLY O_WRONLY O_RDWR O_APPEND O_CREAT O_EXCL O_TRUNC WNOHANG').split():
        wanted[name] = getattr(os, name)
    for name in ('S_IFMT S_IFIFO S_IFCHR S_IFDIR S_IFBLK S_IFREG S_IFSOCK S_IFLNK S_ISGID S_ISUID').split():
        wanted[name] = 0xf000 if name == 'S_IFMT' else getattr(stat, name)
    for name in ('SIGINT SIGABRT SIGFPE SIGILL SIGSEGV SIGTERM SIGQUIT SIGPIPE SIGALRM SIGUSR1 SIGUSR2 SIGCHLD SIGCONT SIGSTOP SIGTSTP SIGTTIN SIGTTOU').split():
        wanted[name] = int(getattr(signal, name))
    source = "import * as os from 'os'; print(JSON.stringify(Object.fromEntries(" + json.dumps(list(wanted)) + ".map(k=>[k,os[k]]))));"
    result = script(binary, source, directory)
    assert json.loads(result.stdout) == wanted, (result.stdout, wanted)
    errors = script(binary, "import * as os from 'os';print(JSON.stringify([os.close(-1),os.stat('absent')[1],os.readlink('absent')[1],os.readdir('absent')[1]]));", directory)
    assert json.loads(errors.stdout) == [-errno.EBADF, errno.ENOENT, errno.ENOENT, errno.ENOENT], errors.stdout


def executable_search(binary, directory):
    executable = directory / 'os-path-child'
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "$PATH"\n')
    executable.chmod(0o755)
    case = directory / 'search.mjs'
    case.write_text("import * as os from 'os'; const status=os.exec(['os-path-child'],{env:{PATH:'/not-used-for-search'}}); print(status);")
    environment = dict(os.environ, PATH=str(directory))
    observed = run([binary, case], cwd=directory, env=environment)
    assert observed.stdout == b'/not-used-for-search\n0\n', observed.stdout
    # Pinned my_execvpe appends '/' even to an empty PATH segment, unlike POSIX
    # execvp's current-directory convention. Preserve that defined source quirk.
    environment['PATH'] = ':'
    observed = run([binary, case], cwd=directory, env=environment)
    assert observed.stdout == b'127\n', observed.stdout


def native_undefined_behavior_contract(binary, directory):
    source = """import * as os from 'os';
const pid=os.exec(['/bin/sleep','30'],{block:false});
try { const status=os.waitpid(pid,os.WNOHANG); if(status[0]!==0||status[1]!==0) throw Error(JSON.stringify(status)); }
finally { os.kill(pid,os.SIGTERM); os.waitpid(pid,0); }
print('native WNOHANG initialized status OK');
"""
    result = script(binary, source, directory)
    assert result.stdout == b'native WNOHANG initialized status OK\n', result.stdout


def terminal(binary, directory):
    path = directory / 'terminal.mjs'
    path.write_text("""import * as os from 'os';
print(JSON.stringify([os.isatty(0),os.ttyGetWinSize(0)]));
os.ttySetRaw(0);print('RAW READY');
const b=new ArrayBuffer(1);if(os.read(0,b,0,1)!==1||new Uint8Array(b)[0]!==81)throw Error('raw input');
print('RAW DONE');
""")
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 25, 72, 0, 0))
    process = subprocess.Popen([str(binary), str(path)], cwd=directory,
                               stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    output = bytearray()

    def until(marker):
        deadline = time.monotonic() + 20
        while marker not in output:
            assert time.monotonic() < deadline, (marker, bytes(output), process.poll())
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                assert data, (marker, bytes(output), process.poll())
                output.extend(data)
    try:
        until(b'RAW READY')
        assert b'[true,[72,25]]' in output, output
        raw = termios.tcgetattr(slave)
        assert not raw[3] & (termios.ECHO | termios.ECHONL | termios.ICANON | termios.IEXTEN), raw
        assert raw[3] & termios.ISIG == original[3] & termios.ISIG, raw
        assert raw[1] & termios.OPOST, raw
        assert raw[6][termios.VMIN] == 1 and raw[6][termios.VTIME] == 0, raw
        os.write(master, b'Q')
        until(b'RAW DONE')
        assert process.wait(timeout=20) == 0, output
        restored = termios.tcgetattr(slave)
        if sys.platform == 'darwin':
            # Darwin sets this transient input-replay status when ICANON returns,
            # including a Python-only tcsetattr roundtrip. All configuration,
            # control characters, and speeds must still restore exactly.
            restored[3] &= ~termios.PENDIN
            original[3] &= ~termios.PENDIN
        assert restored == original, (restored, original)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def terminal_domain(fault, directory):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([str(fault)], cwd=directory, stdin=slave,
                               stdout=slave, stderr=slave, start_new_session=True)
    try:
        assert process.wait(timeout=90) == 0, process.returncode
        readable, _, _ = select.select([master], [], [], 5)
        assert readable, 'missing terminal-domain fixture result'
        assert b'TERMINAL DOMAIN OK' in os.read(master, 65536)
        latest = termios.tcgetattr(slave)
        assert original[3] & termios.ICANON, original
        assert not latest[3] & (termios.ICANON | termios.ECHO), latest
        assert latest[3] & termios.ISIG == original[3] & termios.ISIG, latest
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        termios.tcsetattr(slave, termios.TCSANOW, original)
        os.close(master)
        os.close(slave)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True, help='native qjs executable')
    parser.add_argument('--oracle', type=Path, default=PINNED / 'qjs')
    parser.add_argument('--fault', type=Path, default=ROOT / 'build/os-system/os-fault')
    parser.add_argument('--build-fault', action='store_true')
    parser.add_argument('--compiler', type=Path, default=ROOT / 'build/toolchain-main-dd2e99ab/silk-fixed5')
    parser.add_argument('--stdlib', type=Path, default=ROOT / 'build/toolchain-main-dd2e99ab/stdlib')
    parser.add_argument('--cc', default='/opt/homebrew/opt/llvm/bin/clang' if sys.platform == 'darwin' else 'cc')
    args = parser.parse_args()
    native = args.native.resolve(strict=True)
    oracle = args.oracle.resolve(strict=True)
    assert native != oracle, 'native and reference executable must be separate'
    environment = dict(os.environ)
    if sys.platform == 'darwin':
        environment['SDKROOT'] = SDK
        environment['SILK_CLANG'] = args.cc
    environment['SILK_VERIFY_MIR'] = '1'
    fault = args.fault.resolve()
    if args.build_fault:
        fault.parent.mkdir(parents=True, exist_ok=True)
        command = [args.compiler, 'build', ROOT / 'src/js_os_fixture.silk', '-o', fault,
                   '--stdlib', args.stdlib, '--optimization', 'speed', '--debug', 'false']
        run(command, cwd=ROOT, timeout=1800, env=environment)
    fault.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='silk-os-system-') as temporary:
        root = Path(temporary).resolve()
        abi = root / 'abi'
        command = [args.cc, '-std=c11', '-D_DEFAULT_SOURCE', ROOT / 'tests/fixtures/os_abi.c', '-o', abi]
        if sys.platform == 'darwin':
            command += ['-isysroot', SDK]
        run(command, cwd=root)
        assert run([abi], cwd=root).stdout == b'os host ABI OK\n'
        outputs = []
        for label, binary in [('native', native), ('reference', oracle)]:
            directory = root / label
            directory.mkdir()
            result = run([binary, ROOT / 'tests/fixtures/os_system.mjs'], cwd=directory)
            assert result.stdout == b'os synchronous behavior OK\n', (label, result.stdout, result.stderr)
            outputs.append(result.stdout)
            constants(binary, directory)
            executable_search(binary, directory)
            terminal(binary, directory)
        assert outputs[0] == outputs[1]
        native_undefined_behavior_contract(native, root / 'native')
        fault_directory = root / 'fault'
        fault_directory.mkdir()
        result = run([fault], cwd=fault_directory, timeout=1800)
        assert len(result.stdout) == 12, (result.stdout, result.stderr)
        operations, attempts, injected = struct.unpack('<III', result.stdout)
        assert operations == 12 and injected > 0 and attempts == injected + operations, (operations, attempts, injected)
        assert list(fault_directory.iterdir()) == [], list(fault_directory.iterdir())
        terminal_domain(fault, fault_directory)
    print(f'OS behavior/constants/PTY/ABI: native + pinned C; fault operations={operations}, attempts={attempts}, injected={injected}; all ledgers balanced')


if __name__ == '__main__':
    main()
