#!/usr/bin/env python3
"""Run the V8 benchmark suite (bench/v8) under one or more engines.

Default mode runs each benchmark the way the suite's own runner does and prints its
score (higher is better). `--instructions` runs a fixed number of iterations of each
benchmark under callgrind and prints instruction counts (lower is better), which is
deterministic and so usable on a noisy host.

    python3 scripts/v8bench.py build/.../release/silkjs ../quickjs/qjs
    python3 scripts/v8bench.py --instructions old/silkjs new/silkjs --only richards splay
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V8 = os.path.join(ROOT, "bench", "v8")
BENCHMARKS = ["richards", "deltablue", "crypto", "raytrace", "earley-boyer", "regexp", "splay", "navier-stokes"]
# Iterations per benchmark for --instructions; each takes 0.1-0.8 s natively.
FIXED = {"richards": 20, "deltablue": 20, "crypto": 4, "raytrace": 8, "earley-boyer": 2, "regexp": 2,
         "splay": 4, "navier-stokes": 2}

PRINT = "var __print = (typeof print === 'function') ? print : console.log.bind(console);\n"
SCORE_RUNNER = PRINT + """BenchmarkSuite.RunSuites({
  NotifyResult: function(name, result) { __print(name + ': ' + result); },
  NotifyError: function(name, error) { __print(name + ': ERROR ' + error); },
  NotifyScore: function(score) { __print('Score: ' + score); }
});
"""
FIXED_RUNNER = PRINT + """for (var s = 0; s < BenchmarkSuite.suites.length; s++) {
  var suite = BenchmarkSuite.suites[s];
  for (var i = 0; i < suite.benchmarks.length; i++) {
    var b = suite.benchmarks[i];
    BenchmarkSuite.ResetRNG(); b.Setup();
    for (var k = 0; k < %d; k++) b.run();
    b.TearDown();
  }
  __print(suite.name + ' done');
}
"""


def read(name):
    with open(os.path.join(V8, name + ".js"), encoding="utf-8") as f:
        return f.read()


def script(directory, names, runner, tag):
    path = os.path.join(directory, tag + ".js")
    with open(path, "w", encoding="utf-8") as f:
        f.write(read("base"))
        for name in names:
            f.write(read(name))
        f.write(runner)
    return path


def scores(engine, path):
    out = subprocess.run([engine, path], capture_output=True, text=True, check=False).stdout
    return dict((m.group(1), m.group(2)) for m in re.finditer(r"^(\w+): (\S+)$", out, re.M))


def instructions(engine, path):
    run = subprocess.run(["valgrind", "--tool=callgrind", "--callgrind-out-file=/dev/null", engine, path],
                         capture_output=True, text=True, check=False)
    found = re.search(r"Collected : (\d+)", run.stderr)
    if run.returncode != 0 or not found or "done" not in run.stdout:
        sys.exit(f"{engine} failed on {path}:\n{run.stdout}{run.stderr[-2000:]}")
    return int(found.group(1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("engines", nargs="+")
    parser.add_argument("--instructions", action="store_true", help="fixed iterations under callgrind")
    parser.add_argument("--only", nargs="+", choices=BENCHMARKS, default=BENCHMARKS)
    args = parser.parse_args()
    engines = [os.path.abspath(e) for e in args.engines]
    names = [os.path.basename(e) if args.engines.count(e) == 1 else e for e in args.engines]
    with tempfile.TemporaryDirectory() as directory:
        if args.instructions:
            print("%-14s" % "benchmark" + "".join("%16s" % n[-16:] for n in names))
            for bench in args.only:
                path = script(directory, [bench], FIXED_RUNNER % FIXED[bench], bench)
                counts = [instructions(e, path) for e in engines]
                ratios = "".join("  %.3fx" % (c / counts[0]) for c in counts[1:])
                print("%-14s" % bench + "".join("%16d" % c for c in counts) + ratios)
            return
        path = script(directory, args.only, SCORE_RUNNER, "suite")
        results = [scores(e, path) for e in engines]
        keys = [k for k in results[0]]
        print("%-14s" % "benchmark" + "".join("%16s" % n[-16:] for n in names))
        for key in keys:
            print("%-14s" % key + "".join("%16s" % r.get(key, "-") for r in results))


if __name__ == "__main__":
    main()
