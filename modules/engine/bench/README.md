# Benchmarks

`scripts/bench.py` measures the release `qjs` binary so refactors can be checked for
performance regressions.

- `macro/*.js` are small whole programs (calls, loops, objects, closures, arrays, strings,
  JSON, RegExp, Map/Set, parsing, startup). Each runs as its own process several times; the
  runner records min/median wall time and peak RSS and checks stdout against
  `macro/expected.json`, which was produced by C QuickJS at the pinned upstream revision.
- `microbench.js` is QuickJS's `tests/microbench.js`, vendored unchanged from the pinned
  upstream revision (MIT, see its header). It reports ns per operation for ~70 tests.

```sh
silk build --release
silk task bench --label baseline                 # record bench/results/baseline.json
silk task bench --compare bench/results/baseline.json   # exit 1 on >10% regression
silk task bench --skip-micro --runs 3            # quick macro-only check
silk task bench fib loops                        # selected macro workloads
silk task bench --reference path/to/c/qjs        # also measure C QuickJS
```

`silk task bench` runs `scripts/bench.py`, which can also be run directly for its other options.

Results are only comparable on the same host with the machine otherwise idle. Compare `min_s`
for macro workloads; medians on shared cloud hosts vary by 10-30%.

On a noisy host, compare two builds directly instead of against a recorded baseline:

```sh
python3 scripts/ab.py old/silkjs new/silkjs                  # interleaved wall-clock runs
python3 scripts/ab.py old/silkjs new/silkjs --instructions   # callgrind instruction counts
```

`--instructions` is deterministic, so it settles whether a wall-clock "regression" is real.

`results/baseline-edb6cee.json` was recorded on 2026-10-26 on a 4-CPU Linux x86_64 cloud
container, Silk 0.1.0-dev.17, with C QuickJS 7d1c13c5 as the reference: SilkJS was 21x slower
than C QuickJS on the macro geometric mean and 28x on the micro geometric mean.
`results/baseline.json` was re-recorded from main 8f70631, after the first performance pass
(about 3x faster than edb6cee on the macro geometric mean).

## V8 benchmark suite

`v8/` holds the eight V8 benchmarks that the QuickJS site reports (richards, deltablue,
crypto, raytrace, earley-boyer, regexp, splay, navier-stokes), copied unchanged with
`base.js` from github.com/chromium/octane at 570ad1c (BSD, see `v8/LICENSE`).

```sh
python3 scripts/v8bench.py path/to/silkjs path/to/c/qjs                  # suite scores, higher is better
python3 scripts/v8bench.py --instructions old/silkjs new/silkjs          # fixed iterations under callgrind
python3 scripts/v8bench.py --instructions a b --only richards deltablue
```

Scores are wall-clock based and noisy on shared hosts. A score gap that the instruction
counts do not show usually comes from memory traffic, such as larger objects or more GC
cycles.

## WebAssembly builds

`wasm/` builds silkjs (64-bit WebAssembly through the Silk LLVM backend) and QuickJS (wasi-sdk)
as WASI commands for wasmtime, as comparison columns for the tables above. See
[`wasm/README.md`](wasm/README.md).

## Profile-guided build

`scripts/pgo_build.py` builds the release CLI twice: once instrumented, which it runs on the
V8 suite and `macro/`, and once with Clang optimizing by the profile from those runs. Clang
then lays the hot interpreter paths out together and moves cold ones out of line, which
roughly halves instruction-cache misses on large programs.

```sh
SILK_CLANG=/path/to/clang silk task pgo      # writes build/pgo/silkjs
```

On 2026-11-07 (Silk dev.55, 4-CPU Linux x86_64) it ran Octane PdfJS 12% faster than the plain
release build, Typescript 2%, zlib and Mandreel 18%, EarleyBoyer 16%, with 47-51% fewer I1
misses on PdfJS and Typescript; neither is a training input. Compare engines against the
profile-guided binary when measuring against other engines' release builds; compare two
plain release builds when A/B testing a change, since a new profile adds its own noise.
