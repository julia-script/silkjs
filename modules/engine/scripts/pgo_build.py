#!/usr/bin/env python3
"""Build the release silkjs CLI with profile-guided optimization.

Builds an instrumented release CLI, runs it on the repository's own workloads (the V8 suite
in bench/v8 at a few iterations each, and bench/macro), merges the profile and builds the
release CLI again with Clang optimizing by that profile. Both builds use the same source and
flags, so the profile describes exactly the code the final binary is built from.

Clang then knows which code is hot: it lays hot blocks out together and moves cold paths out
of line. Most of the gap to V8's interpreter on large programs is instruction-cache misses,
and the profile roughly halves them (Octane PdfJS and Typescript, which are not training
inputs, run with 47-51% fewer I1 misses).

    SILK_CLANG=/path/to/clang python3 scripts/pgo_build.py            # -> build/pgo/silkjs
    python3 scripts/pgo_build.py --output /tmp/silkjs --keep          # keep build/pgo/work

SILK_CLANG names the Clang to build with (as for `silk build`), and llvm-profdata must sit
beside it. Takes about two release builds plus a few seconds of training.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import v8bench  # noqa: E402

RELEASE = os.path.join(ROOT, "build", "llvm", "x86_64-unknown-linux-gnu", "release", "silkjs")


def wrapper(path, clang, flags):
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\nexec '%s' %s \"$@\"\n" % (clang, " ".join("'%s'" % x for x in flags)))
    os.chmod(path, 0o755)


def build(clang_wrapper, copy_to):
    env = dict(os.environ, SILK_CLANG=clang_wrapper)
    subprocess.run(["silk", "build", "--release", "--progress", "never"], cwd=ROOT, env=env, check=True)
    shutil.copy2(RELEASE, copy_to)


def train(binary, work, profiles):
    """Runs every training workload under `binary` and fails if any of them fails."""
    scripts = os.path.join(work, "training")
    os.makedirs(scripts)
    for name in v8bench.BENCHMARKS:
        iterations = max(1, v8bench.FIXED[name] // 2)
        v8bench.script(scripts, [name], v8bench.FIXED_RUNNER % iterations, name)
    for path in glob.glob(os.path.join(ROOT, "bench", "macro", "*.js")):
        shutil.copy2(path, scripts)
    for path in sorted(glob.glob(os.path.join(scripts, "*.js"))):
        name = os.path.splitext(os.path.basename(path))[0]
        env = dict(os.environ, LLVM_PROFILE_FILE=os.path.join(profiles, name + "-%p.profraw"))
        run = subprocess.run([binary, path], cwd=scripts, env=env, capture_output=True, text=True)
        if run.returncode != 0:
            sys.exit("training run %s failed:\n%s%s" % (name, run.stdout, run.stderr[-2000:]))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default=os.path.join(ROOT, "build", "pgo", "silkjs"))
    parser.add_argument("--keep", action="store_true", help="keep build/pgo/work (profiles, instrumented CLI)")
    args = parser.parse_args()
    clang = os.environ.get("SILK_CLANG") or shutil.which("clang")
    if not clang:
        sys.exit("pgo_build: set SILK_CLANG to the Clang silk builds with")
    clang = os.path.abspath(clang)
    profdata = os.path.join(os.path.dirname(clang), "llvm-profdata")
    if not os.access(profdata, os.X_OK):
        sys.exit("pgo_build: no llvm-profdata beside " + clang)

    work = os.path.join(ROOT, "build", "pgo", "work")
    shutil.rmtree(work, ignore_errors=True)
    profiles = os.path.join(work, "profiles")
    os.makedirs(profiles)
    merged = os.path.join(work, "silkjs.profdata")
    generate, use = os.path.join(work, "clang-generate"), os.path.join(work, "clang-use")
    quiet = ["-Wno-unused-command-line-argument"]
    wrapper(generate, clang, ["-fprofile-generate"] + quiet)
    wrapper(use, clang, ["-fprofile-use=" + merged, "-Wno-profile-instr-unprofiled",
                         "-Wno-profile-instr-out-of-date", "-Wno-backend-plugin"] + quiet)

    instrumented = os.path.join(work, "silkjs-instrumented")
    build(generate, instrumented)
    train(instrumented, work, profiles)
    subprocess.run([profdata, "merge", "-o", merged] + glob.glob(os.path.join(profiles, "*.profraw")), check=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    build(use, args.output)
    if not args.keep:
        shutil.rmtree(work)
    print("profile-guided silkjs: " + args.output)


if __name__ == "__main__":
    main()
