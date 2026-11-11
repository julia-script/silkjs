set -x
cd /tmp
gcc -O2 -shared -fPIC -o sampler.so $GITHUB_WORKSPACE/bench-x86/sampler.c -lrt
sed 's/var N=4/var N=10/' fx-typescript.js > fx10.js
for b in /tmp/bin/silkjs-*dbg*; do
  [ -f "$b" ] || continue
  LD_PRELOAD=./sampler.so SAMPLES_OUT=/tmp/art/$(basename $b).samples $b fx10.js > /dev/null
  wc -l /tmp/art/$(basename $b).samples
done
sudo apt-get install -y -qq linux-tools-common linux-tools-$(uname -r) >/dev/null 2>&1 || true
perf stat -e cycles,instructions,branches,branch-misses,cache-misses,L1-dcache-load-misses,L1-icache-load-misses,dTLB-load-misses,iTLB-load-misses /tmp/bin/silkjs-main fx-typescript.js 2>&1 | tail -25 || true
perf stat -e cycles,instructions,branches,branch-misses,cache-misses,L1-dcache-load-misses,L1-icache-load-misses,dTLB-load-misses,iTLB-load-misses /tmp/bin/v8-jitless-st fx-typescript.js 2>&1 | tail -25 || true
