#!/usr/bin/env python3
"""Regenerate startup.order, the link-time function order of the silkjs CLI.

Runs the CLI on an empty script under callgrind and lists every function it
executes, hottest first. The [native].function-order entry in silk.toml makes
the release link place these functions first, so creating and tearing down a
runtime touches a few contiguous code pages instead of windows spread across
the whole text segment.

Usage: python3 scripts/function_order.py [BINARY]
"""
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEADER = """# Functions the CLI runs to create a runtime and realm and tear them down,
# grouped so startup touches few code pages. Regenerate with
# python3 scripts/function_order.py after a release build.
"""


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'build', 'silkjs')
    binary = os.path.abspath(binary)
    with tempfile.TemporaryDirectory() as scratch:
        script = os.path.join(scratch, 'empty.js')
        profile = os.path.join(scratch, 'callgrind.out')
        open(script, 'w').close()
        subprocess.run(['valgrind', '--tool=callgrind', '--callgrind-out-file=' + profile, binary, script],
                       check=True, capture_output=True)
        report = subprocess.run(['callgrind_annotate', '--threshold=100', profile],
                                check=True, capture_output=True, text=True).stdout
    names = []
    for line in report.splitlines():
        if not line.rstrip().endswith('[' + binary + ']'):
            continue
        match = re.search(r'\?\?\?:([A-Za-z_0-9.]+)', line)
        if match and match.group(1) not in names:
            names.append(match.group(1))
    with open(os.path.join(ROOT, 'startup.order'), 'w') as out:
        out.write(HEADER)
        out.write(''.join(name + '\n' for name in names))
    print('wrote %d functions to startup.order' % len(names))


if __name__ == '__main__':
    main()
