#!/usr/bin/env python3
"""Interleaved A/B timing of two SilkJS binaries on the macro workloads.

Recorded baselines drift on shared cloud hosts by 10-20%, which is larger than most
changes. This runs the two binaries alternately, so both see the same host load, and
compares their minimum wall times. With --instructions it instead counts executed
instructions under callgrind once per binary, which is deterministic and immune to host
noise (but ignores cache and branch effects, and runs ~50x slower).

  python3 scripts/ab.py OLD_BINARY NEW_BINARY [--runs 9] [--only arrays,strings] [--instructions]

Exits 1 when any workload is slower than --threshold (default 5%).
"""
import argparse
import re
import subprocess
import tempfile
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MACRO = ROOT / 'bench' / 'macro'


def run(binary, script):
    start = time.perf_counter()
    subprocess.run([binary, str(script)], stdout=subprocess.DEVNULL, check=True)
    return time.perf_counter() - start


def instructions(binary, script):
    with tempfile.TemporaryDirectory() as scratch:
        done = subprocess.run(['valgrind', '--tool=callgrind', f'--callgrind-out-file={scratch}/out',
                               binary, str(script)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=True)
    return int(re.search(r'Collected : (\d+)', done.stderr).group(1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('old')
    parser.add_argument('new')
    parser.add_argument('--runs', type=int, default=9)
    parser.add_argument('--only', help='comma-separated workload names')
    parser.add_argument('--threshold', type=float, default=0.05)
    parser.add_argument('--instructions', action='store_true', help='compare callgrind instruction counts')
    args = parser.parse_args()
    names = sorted(path.stem for path in MACRO.glob('*.js'))
    if args.only:
        names = [name for name in names if name in args.only.split(',')]
    slower = []
    ratios = []
    for name in names:
        script = MACRO / f'{name}.js'
        if args.instructions:
            old, new = instructions(args.old, script), instructions(args.new, script)
            shown = f'old {old / 1e6:9.1f}M  new {new / 1e6:9.1f}M instructions'
        else:
            times = {args.old: [], args.new: []}
            for _ in range(args.runs):
                for binary in (args.old, args.new):
                    times[binary].append(run(binary, script))
            old, new = min(times[args.old]), min(times[args.new])
            shown = f'old {old:7.3f}s  new {new:7.3f}s'
        ratio = new / old
        ratios.append(ratio)
        mark = '  SLOWER' if ratio > 1 + args.threshold else ''
        print(f'  {name:10} {shown}  ratio {ratio:.3f}{mark}')
        if mark:
            slower.append(name)
    geomean = 1.0
    for ratio in ratios:
        geomean *= ratio
    print(f'  geometric mean ratio {geomean ** (1 / len(ratios)):.3f}')
    if slower:
        print(f'{len(slower)} slower: {", ".join(slower)}')
        sys.exit(1)


if __name__ == '__main__':
    main()
