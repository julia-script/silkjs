#!/usr/bin/env python3
"""Build src/embed_smoke.silk, a host that embeds the runtime, and check what it prints.

The host evaluates its own module (no script in its arguments), turns the loop with a
bounded wait while the runtime is kept alive with nothing referenced, and the module
ends the runtime with process.exit: the host's turn reports the status, and 'exit'
listeners ran. Run after tools/build.py, which prepares the native archives and
src/runtime/embedded.silk: python3 tests/embed-smoke.py [--skip-build]
"""
import os
from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build/embed-smoke'
EXECUTABLE = BUILD / 'embed-smoke'
EXPECTED = [
    'fs function',
    'tick 1',
    'tick 2',
    'tick 3',
    'exit 3',
    'host: finished with 3',
]


def build():
    version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
    BUILD.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, 'SILKJS_CLANG_BUILD': str(BUILD)}
    subprocess.run(['silk', '+' + version, 'build', 'src/embed_smoke.silk', '-o', str(EXECUTABLE),
                    '--debug', 'true', '--clang', str(ROOT / 'tools/clang.py')],
                   cwd=ROOT, env=environment, check=True)


def main():
    if '--skip-build' not in sys.argv[1:]:
        build()
    result = subprocess.run([str(EXECUTABLE)], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    lines = result.stdout.splitlines()
    if result.returncode != 3 or lines != EXPECTED:
        print(f'embed smoke failed: status {result.returncode}')
        print('stdout:\n' + result.stdout)
        print('stderr:\n' + result.stderr)
        print('expected:\n' + '\n'.join(EXPECTED))
        sys.exit(1)
    print('embed smoke passed')


if __name__ == '__main__':
    main()
