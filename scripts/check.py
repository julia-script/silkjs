#!/usr/bin/env python3
"""Correctness gate for SilkJS changes.

Runs, in order:
  1. the native regression suite: silk test src/tests.silk
  2. QuickJS's own tests/*.js (vendored in tests/upstream/ from the pinned upstream
     revision) under the release qjs binary
  3. SilkJS's own regression scripts, tests/silkjs/*.js (behavior QuickJS gets wrong)
  4. the benchmark workloads once each, checking output against C QuickJS
     (scripts/bench.py --skip-micro --runs 1)

  python3 scripts/check.py                 # everything
  python3 scripts/check.py --skip-native   # only the JS-level checks (needs a release build)

test_bjson.js is not vendored: it needs upstream's bjson.so C plugin.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / 'build/llvm/x86_64-unknown-linux-gnu/release/silkjs'
# (script, extra qjs arguments); upstream's Makefile `test` target uses the same flags.
UPSTREAM = [
    ('test_closure.js', []), ('test_language.js', []), ('test_builtin.js', ['--std']),
    ('test_loop.js', []), ('test_bigint.js', []), ('test_cyclic_import.js', []),
    ('test_std.js', []), ('test_worker.js', []),
]


def step(name, command, cwd=ROOT):
    start = time.perf_counter()
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    elapsed = time.perf_counter() - start
    status = 'PASS' if result.returncode == 0 else 'FAIL'
    print(f'{status}  {name}  ({elapsed:.1f}s)', flush=True)
    if result.returncode != 0:
        print((result.stdout + result.stderr)[-4000:])
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--binary', type=Path, default=BINARY)
    parser.add_argument('--skip-native', action='store_true', help='skip silk test src/tests.silk')
    parser.add_argument('--skip-bench', action='store_true', help='skip the benchmark output check')
    args = parser.parse_args()
    ok = True
    if not args.skip_native:
        ok &= step('native regression suite', ['silk', 'test', 'src/tests.silk', '-o', 'build/core-tests',
                                               '--optimization', 'speed', '--debug', 'false'])
    binary = args.binary.expanduser().resolve()
    if not binary.is_file():
        raise SystemExit(f'missing {binary}; build with `silk build --release`')
    for script, flags in UPSTREAM:
        ok &= step(f'upstream {script}', [str(binary), *flags, script], cwd=ROOT / 'tests/upstream')
    for script in sorted((ROOT / 'tests/silkjs').glob('*.js')):
        ok &= step(f'silkjs {script.name}', [str(binary), script.name], cwd=ROOT / 'tests/silkjs')
    if not args.skip_bench:
        ok &= step('benchmark outputs', [sys.executable, 'scripts/bench.py', '--binary', str(binary),
                                         '--skip-micro', '--runs', '1'])
    print('\nall checks passed' if ok else '\nCHECKS FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
