#!/usr/bin/env python3
"""Writes tools/startup-order.txt: the functions a start of the runtime runs.

Usage: python3 tools/startup_order.py path/to/silkjsruntime

Runs the given release executable under valgrind's callgrind on an empty script and on
one console.log, and lists every function either run entered, in the order callgrind
first names them. tools/build.py hands the list to the linker, which places these
functions together (see startup_order there). Function names are hashes of what a
function is, not of where it lands, so the list stays right across builds; a name that
no longer exists is ignored by the linker. Run this again when startup changes shape.
"""

import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = re.compile(r'^c?fn=\(\d+\) (silk_[0-9a-f]{32})$')
SCRIPTS = ['', 'console.log("hello");\n']


def entered(executable, script, directory, seen, order):
    source = directory / 'main.js'
    source.write_text(script)
    profile = directory / 'callgrind.out'
    subprocess.run(
        ['valgrind', '--tool=callgrind', f'--callgrind-out-file={profile}', str(executable), str(source)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for line in profile.read_text().splitlines():
        match = NAME.match(line)
        if match and match.group(1) not in seen:
            seen.add(match.group(1))
            order.append(match.group(1))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    executable = pathlib.Path(sys.argv[1]).resolve()
    seen, order = set(), []
    with tempfile.TemporaryDirectory() as directory:
        for script in SCRIPTS:
            entered(executable, script, pathlib.Path(directory), seen, order)
    (ROOT / 'tools/startup-order.txt').write_text('\n'.join(order) + '\n')
    print(f'{len(order)} functions')


if __name__ == '__main__':
    main()
