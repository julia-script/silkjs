#!/usr/bin/env python3
"""Exercise the actual REPL terminal, kernel SIGINT and raw-mode restoration."""
import errno
import fcntl
import os
import pathlib
import pty
import re
import select
import subprocess
import sys
import termios
import time

executable = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'build/silkjsruntime').resolve())
master, slave = pty.openpty()
environment = dict(os.environ, NODE_REPL_HISTORY='', TERM='xterm', NO_COLOR='1')
environment.pop('FORCE_COLOR', None)
environment.pop('NODE_NO_READLINE', None)
process = subprocess.Popen([executable, '-i'], stdin=slave, stdout=slave, stderr=slave,
                           env=environment, start_new_session=True,
                           preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
os.close(slave)
ansi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
transcript = bytearray()


def read_until(predicate, eof=False):
    received = bytearray()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                if eof:
                    return ansi.sub(b'', bytes(received))
                break
            raise
        if not chunk:
            if eof:
                return ansi.sub(b'', bytes(received))
            break
        transcript.extend(chunk)
        received.extend(chunk)
        cleaned = ansi.sub(b'', bytes(received))
        if predicate(cleaned):
            return cleaned
    raise AssertionError('REPL did not reach expected state: ' + repr(ansi.sub(b'', bytes(transcript))))


def prompt():
    return read_until(lambda data: data.endswith(b'> '))


try:
    prompt()
    assert not termios.tcgetattr(master)[3] & termios.ISIG, 'idle REPL should use raw input'
    os.write(master, b"process.stdout.write('loop'+'-ready\\n');while(true){}\n")
    read_until(lambda data: b'loop-ready\r\n' in data or b'loop-ready\n' in data)
    assert termios.tcgetattr(master)[3] & termios.ISIG, 'evaluation must enable kernel SIGINT delivery'
    os.write(master, b'\x03')
    prompt()
    assert not termios.tcgetattr(master)[3] & termios.ISIG, 'interrupted REPL must restore raw input'
    os.write(master, b"console.log('reco'+'vered',6*7,_error.code)\n")
    recovered = prompt()
    assert b'recovered 42 ERR_SCRIPT_EXECUTION_INTERRUPTED' in recovered, repr(recovered)
    os.write(master, b'.exit\n')
    read_until(lambda data: False, eof=True)
    assert process.wait(timeout=15) == 0
    print('REPL terminal SIGINT, context reuse and raw-mode restoration smoke passed')
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
