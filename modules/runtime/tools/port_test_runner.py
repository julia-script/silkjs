#!/usr/bin/env python3
"""Copies Node.js v24.22.1's test runner and watch mode sources to ext/node.

usage: port_test_runner.py NODE_SRC

NODE_SRC is a Node.js checkout (v24.22.1). Only binding lines change: primordials,
internalBinding(...) and the few module ids the runtime keeps elsewhere. Edit this
script and rerun it; never hand-edit the ported files.
"""
import sys
from pathlib import Path

if len(sys.argv) != 2:
    sys.exit(__doc__)
NODE = Path(sys.argv[1]) / 'lib'
EXT = Path(__file__).resolve().parent.parent / 'ext' / 'node'
HEADER = '// Adapted from Node.js v24.22.1 lib/{name} by tools/port_test_runner.py.\n'
COMMON = [
    ("} = primordials;", "} = require('internal/per_context/primordials');"),
    ("internalBinding('util')", "require('internal/util/binding')"),
    ("internalBinding('errors')", "require('internal/errors_binding')"),
    ("internalBinding('types')", "require('internal/util/types')"),
    ("internalBinding('profiler')", "require('internal/profiler_binding')"),
]


def port(name, target=None, extra=()):
    text = (NODE / name).read_text()
    for old, new in COMMON:
        text = text.replace(old, new)
    for old, new in extra:
        if old not in text:
            sys.exit(f'{name}: missing {old!r}')
        text = text.replace(old, new)
    if 'internalBinding(' in text or '= primordials' in text:
        sys.exit(f'{name}: unported binding left')
    out = EXT / (target or name)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(HEADER.format(name=name) + text)


# The runtime's previous test runner files that Node does not have.
for old in ['test_runner/support.js', 'test_runner/mock.js', 'test_runner/mock_timers.js',
            'test_runner/coverage_report.js', 'watch_mode/watch_mode.js']:
    path = EXT / 'internal' / old
    if path.exists():
        path.unlink()

for name in sorted(p.relative_to(NODE).as_posix() for p in (NODE / 'internal/test_runner').rglob('*.js')):
    port(name)
port('test.js')
port('test/reporters.js')
port('internal/main/test_runner.js')
port('internal/events/abort_listener.js')
port('internal/watch_mode/files_watcher.js')
port('internal/main/watch_mode.js')
