#!/usr/bin/env python3
"""Run the SilkJS performance suite and record or compare results.

Two kinds of measurement:

* macro: each bench/macro/*.js is run as a whole process several times; the runner
  records the minimum and median wall time and the peak RSS, and checks that stdout
  matches the C QuickJS output recorded in bench/macro/expected.json.
* micro: bench/microbench.js (QuickJS's own micro benchmark, vendored from the pinned
  upstream revision) reports nanoseconds per operation for about 70 small tests.

Examples:

  # Record a baseline (writes bench/results/<label>.json).
  python3 scripts/bench.py --label baseline

  # Compare the current build against a recorded result; exits 1 on a regression.
  python3 scripts/bench.py --compare bench/results/baseline.json

  # Only macro workloads, 3 runs each, plus the C QuickJS reference binary.
  python3 scripts/bench.py --skip-micro --runs 3 --reference ~/quickjs/qjs

The machine must be otherwise idle for numbers to be comparable, and comparisons are
only meaningful between results recorded on the same host.
"""
import argparse
import datetime
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / 'bench'
DEFAULT_BINARY = ROOT / 'build/llvm/x86_64-unknown-linux-gnu/release/silkjs'
MICRO_LINE = re.compile(r'^\s*(\S+)\s+(\d+)\s+([0-9.]+)')


def run_once(binary, script, args=(), timeout=1800):
    """Runs one process and returns (wall seconds, stdout, stderr, exit status)."""
    start = time.perf_counter()
    process = subprocess.Popen([str(binary), str(script), *args], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, cwd=BENCH)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        raise
    wall = time.perf_counter() - start
    return wall, stdout.decode(errors='replace'), stderr.decode(errors='replace'), process.returncode


def run_measured(binary, script, args=(), timeout=1800):
    """Runs one process and returns (wall seconds, peak RSS KiB, exit status, stdout) via wait4."""
    read_fd, write_fd = os.pipe()
    start = time.perf_counter()
    pid = os.fork()
    if pid == 0:
        os.chdir(BENCH)
        os.dup2(write_fd, 1)
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 2)
        os.close(read_fd)
        os.execv(str(binary), [str(binary), str(script), *args])
    os.close(write_fd)
    chunks = []
    with os.fdopen(read_fd, 'rb') as pipe:
        for chunk in iter(lambda: pipe.read(65536), b''):
            chunks.append(chunk)
    _, status, usage = os.wait4(pid, 0)
    wall = time.perf_counter() - start
    code = os.waitstatus_to_exitcode(status)
    return wall, usage.ru_maxrss, code, b''.join(chunks).decode(errors='replace')


def macro_suite(binary, runs, only, expected):
    results = {}
    for script in sorted((BENCH / 'macro').glob('*.js')):
        name = script.stem
        if only and name not in only:
            continue
        walls, rss, output = [], 0, None
        for _ in range(runs):
            wall, peak, code, stdout = run_measured(binary, script)
            if code != 0:
                raise SystemExit(f'{binary.name} {script.name}: exit status {code}')
            walls.append(wall)
            rss = max(rss, peak)
            output = stdout
        want = expected.get(name)
        ok = want is None or output == want
        results[name] = {'min_s': min(walls), 'median_s': statistics.median(walls),
                         'runs': runs, 'max_rss_kib': rss, 'output_ok': ok}
        flag = '' if ok else '  OUTPUT MISMATCH'
        print(f'  {name:<10} min {min(walls):8.3f}s  median {statistics.median(walls):8.3f}s  '
              f'rss {rss / 1024:7.1f} MiB{flag}', flush=True)
    return results


def micro_suite(binary, only):
    args = list(only) + ['-s', os.devnull] if only else ['-s', os.devnull]
    wall, stdout, stderr, code = run_once(binary, BENCH / 'microbench.js', args, timeout=7200)
    if code != 0:
        raise SystemExit(f'microbench failed ({code}): {stderr[-2000:]}')
    results = {}
    for line in stdout.splitlines():
        match = MICRO_LINE.match(line)
        if match and match.group(1) != 'TEST':
            results[match.group(1)] = float(match.group(3))
    print(f'  {len(results)} micro tests in {wall:.1f}s, total {sum(results.values()):.1f} ns', flush=True)
    return results


def git_revision():
    try:
        sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = subprocess.call(['git', 'diff', '--quiet', 'HEAD', '--', 'src'], cwd=ROOT) != 0
        return sha + ('-dirty' if dirty else '')
    except (OSError, subprocess.CalledProcessError):
        return 'unknown'


def geomean(values):
    values = [v for v in values if v > 0]
    if not values:
        return 1.0
    product = 1.0
    for value in values:
        product *= value
    return product ** (1 / len(values))


def compare(current, baseline, threshold):
    """Prints current/baseline ratios (>1 is slower) and returns the regressed names."""
    regressions = []
    print(f'\nComparison against {baseline.get("label")} ({baseline.get("revision", "?")[:12]}); '
          f'ratio > 1 is slower, threshold {threshold:.0%}')
    for kind, key in (('macro', 'min_s'), ('micro', None)):
        old, new = baseline.get(kind, {}), current.get(kind, {})
        ratios = {}
        for name in sorted(set(old) & set(new)):
            o = old[name][key] if key else old[name]
            n = new[name][key] if key else new[name]
            if o > 0:
                ratios[name] = n / o
        if not ratios:
            continue
        print(f'  {kind}: geometric mean ratio {geomean(ratios.values()):.3f}')
        for name, ratio in sorted(ratios.items(), key=lambda item: -item[1]):
            marker = ''
            if ratio > 1 + threshold:
                marker = '  REGRESSION'
                regressions.append(f'{kind}:{name}')
            elif ratio < 1 - threshold:
                marker = '  faster'
            if kind == 'macro' or marker:
                print(f'    {name:<24} {ratio:6.3f}{marker}')
    return regressions


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--binary', type=Path, default=DEFAULT_BINARY, help='SilkJS qjs binary')
    parser.add_argument('--reference', type=Path, help='also measure this C QuickJS qjs binary')
    parser.add_argument('--runs', type=int, default=5, help='runs per macro workload (default 5)')
    parser.add_argument('--label', help='write bench/results/<label>.json')
    parser.add_argument('--output', type=Path, help='write results JSON to this path')
    parser.add_argument('--compare', type=Path, help='compare against a recorded results JSON')
    parser.add_argument('--threshold', type=float, default=0.10, help="regression threshold (default 0.10; the cloud hosts are noisy)")
    parser.add_argument('--skip-micro', action='store_true', help='skip the micro benchmark (about 15 min)')
    parser.add_argument('--skip-macro', action='store_true')
    parser.add_argument('--only', nargs='*', default=[], help='macro names / micro test prefixes to run')
    args = parser.parse_args()

    binary = args.binary.expanduser().resolve()
    if not binary.is_file():
        raise SystemExit(f'missing binary {binary}; build with `silk build --release`')
    expected = json.loads((BENCH / 'macro/expected.json').read_text())
    result = {
        'label': args.label or 'unlabelled',
        'revision': git_revision(),
        'date': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'host': {'machine': platform.machine(), 'system': platform.system(), 'release': platform.release(),
                 'cpus': os.cpu_count(), 'python': platform.python_version()},
        'binary': str(binary.relative_to(ROOT)) if binary.is_relative_to(ROOT) else str(binary),
    }
    failed = False
    targets = [('silkjs', binary)] + ([('reference', args.reference.expanduser().resolve())] if args.reference else [])
    for role, path in targets:
        print(f'{role}: {path}', flush=True)
        entry = result if role == 'silkjs' else result.setdefault('reference', {})
        if not args.skip_macro:
            entry['macro'] = macro_suite(path, args.runs, args.only, expected)
            failed |= not all(r['output_ok'] for r in entry['macro'].values())
        if not args.skip_micro:
            entry['micro'] = micro_suite(path, args.only)
    if 'reference' in result:
        ref = result['reference']
        if 'macro' in ref and 'macro' in result:
            ratios = [result['macro'][k]['min_s'] / ref['macro'][k]['min_s'] for k in result['macro'] if k in ref['macro']]
            print(f'\nSilkJS / C QuickJS macro geometric mean: {geomean(ratios):.2f}x')
        if 'micro' in ref and 'micro' in result:
            ratios = [result['micro'][k] / ref['micro'][k] for k in result['micro'] if ref['micro'].get(k)]
            print(f'SilkJS / C QuickJS micro geometric mean: {geomean(ratios):.2f}x')

    destination = args.output or (BENCH / 'results' / f'{args.label}.json' if args.label else None)
    if destination:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
        print(f'\nWrote {destination}')
    if args.compare:
        regressions = compare(result, json.loads(args.compare.read_text()), args.threshold)
        if regressions:
            print(f'\n{len(regressions)} regression(s): {", ".join(regressions)}')
            failed = True
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
