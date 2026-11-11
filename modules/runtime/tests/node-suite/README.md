# Node's own test suite against silkjsruntime

These scripts run the upstream Node test tree (`test/parallel`, `test/es-module`, ...) against a
runtime binary and compare with a reference Node, test by test. The denominator is the set of tests
that pass under the reference Node on the same machine, so environment failures (no IPv6, no
network, sandbox limits) do not count as gaps.

Setup (once): fetch only `test/` of the Node release that is the compatibility reference.

```sh
mkdir -p ~/setup/node-src && cd ~/setup/node-src && git init -q
git remote add origin https://github.com/nodejs/node
git config core.sparseCheckout true && printf 'test/\n' > .git/info/sparse-checkout
git fetch -q --depth 1 origin tag v24.22.1 && git checkout -q FETCH_HEAD
```

Run (`NODE_SRC` defaults to `~/setup/node-src`; unset `NODE_OPTIONS` first):

```sh
python3 run.py /opt/node24/bin/node node-parallel.json parallel 4      # reference, once
PRE="-r $PWD/shim.js" python3 run.py ../../build/silkjsruntime rt-parallel.json parallel 4 [regex]
python3 report.py node-parallel.json rt-parallel.json fails.json        # per-module table
python3 sig.py node-parallel.json rt-parallel.json 80                   # failures grouped by first error
```

`run.py` resumes from `OUT.jsonl`; delete it for a fresh run. Pass a regex as the fifth argument to
run a subset (for example `'^test-fs-'`). Each test gets the `// Flags:` its header lists, its own
process group and a 60 s timeout.

`shim.js` papers over the runtime gaps that stop `test/common` from loading at all
(`process.config`, `process.versions` entries, enumerable web globals). Each line is a gap to fix in
the runtime; delete the line once the runtime has it.
