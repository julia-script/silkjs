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
python3 scripts/bench.py --label baseline                 # record bench/results/baseline.json
python3 scripts/bench.py --compare bench/results/baseline.json   # exit 1 on >10% regression
python3 scripts/bench.py --skip-micro --runs 3            # quick macro-only check
python3 scripts/bench.py --only fib loops                 # selected macro workloads
python3 scripts/bench.py --reference path/to/c/qjs        # also measure C QuickJS
```

Results are only comparable on the same host with the machine otherwise idle. Compare `min_s`
for macro workloads; medians on shared cloud hosts vary by 10-30%.

`results/baseline.json` was recorded on 2026-10-26 on a 4-CPU Linux x86_64 cloud container,
Silk 0.1.0-dev.17, with C QuickJS 7d1c13c5 as the reference: SilkJS was 21x slower than C
QuickJS on the macro geometric mean and 28x on the micro geometric mean.
