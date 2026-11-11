set -x
cd /tmp
sed 's/var N=4/var N=1/' fx-typescript.js > fx1.js
curl -sL --retry 5 -o /tmp/llvm.tar.xz https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.8/LLVM-22.1.8-Linux-X64.tar.xz
mkdir -p /tmp/bolt
tar -xf /tmp/llvm.tar.xz -C /tmp/bolt --strip-components=1 --wildcards '*/bin/llvm-bolt*' '*/bin/merge-fdata*' '*/lib/libbolt_rt*' || true
rm -f /tmp/llvm.tar.xz
ls -la /tmp/bolt/bin /tmp/bolt/lib || true
B=/tmp/bolt/bin
SRC=/tmp/bin/silkjs-maindbg
$B/llvm-bolt $SRC -instrument -o /tmp/silkjs-instr --instrumentation-file=/tmp/prof.fdata 2>&1 | tail -30
/tmp/silkjs-instr fx1.js > /dev/null
ls -la /tmp/prof.fdata
$B/llvm-bolt $SRC -o /tmp/bin/silkjs-bolt -data=/tmp/prof.fdata -reorder-blocks=ext-tsp -reorder-functions=cdsort -split-functions -split-all-cold -dyno-stats 2>&1 | tail -60
cp /tmp/bin/silkjs-bolt /tmp/art/ || true
cp /tmp/prof.fdata /tmp/art/ || true
if [ -x /tmp/bin/silkjs-bolt ]; then
  /tmp/bin/silkjs-bolt fx1.js > /dev/null && echo bolt-runs
  python3 $GITHUB_WORKSPACE/bench-x86/fx.py 5 /tmp/bin/v8-jitless /tmp/bin/silkjs-main /tmp/bin/silkjs-maindbg /tmp/bin/silkjs-bolt
fi
sudo apt-get install -y -qq valgrind >/dev/null 2>&1 || true
CG="valgrind --tool=cachegrind --cache-sim=yes --I1=32768,8,64 --D1=32768,8,64 --LL=1048576,16,64"
for b in silkjs-maindbg silkjs-bolt; do
  [ -x /tmp/bin/$b ] || continue
  $CG --cachegrind-out-file=/tmp/art/cg.$b.out /tmp/bin/$b fx1.js 2>&1 | tail -22
done
$CG --cachegrind-out-file=/tmp/art/cg.v8.out node --jitless --single-threaded /tmp/noderun.js fx1.js 2>&1 | tail -22
xz -T0 /tmp/art/cg.*.out || true
