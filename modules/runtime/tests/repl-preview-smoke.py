#!/usr/bin/env python3
"""Drive real terminal previews; run with a runtime executable, without test doubles."""
import errno
import fcntl
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

executable = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'build/silkjsruntime').resolve())
ansi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')


def exercise(use_global):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    environment = dict(os.environ, NODE_REPL_HISTORY='', TERM='xterm', NO_COLOR='1')
    environment.pop('FORCE_COLOR', None)
    environment.pop('NODE_NO_READLINE', None)
    source = "const r=require('repl').start({preview:true,useColors:false,breakEvalOnSigint:true,useGlobal:%s});" % ('true' if use_global else 'false')
    source += "r.context.closePreviewSmoke=()=>r.close();"
    process = subprocess.Popen([executable, '-e', source], stdin=slave, stdout=slave, stderr=slave,
                               env=environment, start_new_session=True,
                               preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
    os.close(slave)
    transcript = bytearray()

    def receive(predicate, timeout=15, eof=False):
        received = bytearray()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                if eof:
                    return bytes(received)
                break
            if not chunk:
                if eof:
                    return bytes(received)
                break
            transcript.extend(chunk)
            received.extend(chunk)
            if predicate(ansi.sub(b'', bytes(received))):
                return bytes(received)
        raise AssertionError('Terminal did not reach expected state: ' + repr(bytes(transcript)))

    def prompt():
        return receive(lambda data: data.endswith(b'> '))

    def send(text):
        os.write(master, text)

    def execute(text):
        send(text.encode() + b'\r')
        return ansi.sub(b'', prompt())

    def preview(text, expected):
        send(text.encode())
        return receive(lambda data: ('// ' + expected).encode() in data)

    def cancel():
        send(b'\x03')
        output = prompt()
        assert b'\x1b[2K' in output, repr(output)

    def rejected(text):
        send(text.encode())
        # A following keystroke must still be processed after the native 333ms
        # deadline. Pause long enough to let the preview request actually run.
        time.sleep(0.6)
        send(b'\x03')
        output = prompt()
        assert b'// ' not in ansi.sub(b'', output), repr(output)

    try:
        prompt()
        execute("var counter=0;var guarded={get value(){counter++;return 7}};var proxied=new Proxy({value:9},{get(t,k){counter++;return t[k]},ownKeys(t){counter++;return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){counter++;return Reflect.getOwnPropertyDescriptor(t,k)}});var custom={ [require('util').inspect.custom](){counter++;return 'unsafe-inspect'} }")
        preview('6*7', '42')
        send(b'\x1b[D')
        receive(lambda data: b'// 42' in data)
        send(b'\x1b[C')
        receive(lambda data: b'// 42' in data)
        send(b'\r')
        entered = ansi.sub(b'', prompt())
        assert re.search(rb'(?:\r?\n)42\r?\n', entered), repr(entered)
        send(b'\x1b[A')
        receive(lambda data: b'// 42' in data)
        cancel()
        preview('({answer:6*7})', '{ answer: 42 }')
        cancel()
        preview('guarded', '{ value: [Getter] }')
        cancel()
        preview('custom', '{')
        cancel()
        preview('proxied', 'Proxy')
        cancel()
        send(b'.editor\r')
        receive(lambda data: b'// Entering editor mode' in data)
        send(b'40+2')
        time.sleep(0.1)
        send(b'\x04')
        edited = ansi.sub(b'', prompt())
        assert b'// 42' not in edited, repr(edited)
        assert re.search(rb'(?:\r?\n)42\r?\n', edited), repr(edited)
        rejected('counter++')
        rejected('guarded.value')
        rejected('proxied.value')
        rejected('while(true){}')
        counts = execute("console.log('effects'+'-check',counter)")
        assert b'effects-check 0' in counts, repr(counts)
        # Enter is intentional execution, unlike speculative preview.
        rejected('counter++')
        execute('counter++')
        counts = execute("console.log('entered'+'-check',counter)")
        assert b'entered-check 1' in counts, repr(counts)
        preview('20+22', '42')
        send(b'\x15')  # Ctrl+U removes the expression and its retained preview.
        cleared = receive(lambda data: data.endswith(b'> '))
        assert b'\x1b[2K' in cleared, repr(cleared)
        preview('40+2', '42')
        # Resizing refreshes the current result without re-running it.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 32, 0, 0))
        receive(lambda data: b'// 42' in data)
        cancel()
        error = execute("throw new Error('domain'+'-check')")
        assert b'Uncaught Error: domain-check' in error, repr(error)
        execute("setTimeout(()=>{throw new Error('async'+'-domain')},1000)")
        preview('30+12', '42')
        asynchronous = receive(lambda data: b'Uncaught Error: async-domain' in data)
        assert b'\x1b[2K' in asynchronous, repr(asynchronous)
        # Let the domain handler redraw before cancelling the preserved input.
        time.sleep(0.1)
        cancel()
        preview('21*2', '42')
        cancel()
        assert not termios.tcgetattr(master)[3] & termios.ISIG
        send(b"process.stdout.write('loop'+'-ready\\n');while(true){}\r")
        receive(lambda data: b'loop-ready\r\n' in data or b'loop-ready\n' in data)
        assert termios.tcgetattr(master)[3] & termios.ISIG
        send(b'\x03')
        prompt()
        assert not termios.tcgetattr(master)[3] & termios.ISIG
        recovery = execute("console.log('reco'+'vered',6*7,_error.code)")
        assert b'recovered 42 ERR_SCRIPT_EXECUTION_INTERRUPTED' in recovery, repr(recovery)
        # A timer intentionally entered by the user closes the REPL while the
        # next expression's preview is still visible and owns a retained value.
        execute('setTimeout(closePreviewSmoke,1000)')
        preview('7*6', '42')
        closed = receive(lambda data: False, eof=True)
        assert b'\x1b[2K' in closed, repr(closed)
        assert process.wait(timeout=15) == 0
        print('REPL preview, guards, navigation, domain and SIGINT passed; useGlobal=' + str(use_global))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


exercise(False)
exercise(True)
