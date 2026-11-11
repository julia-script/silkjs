set -x
cd /tmp
sed 's/var N=4/var N=1/' fx-typescript.js > fx1.js
sudo apt-get install -y -qq valgrind >/dev/null 2>&1 || true
valgrind --tool=callgrind --dump-instr=yes --cache-sim=yes --I1=32768,8,64 --D1=32768,8,64 --LL=1048576,16,64 --callgrind-out-file=/tmp/art/clg.maindbg.out /tmp/bin/silkjs-maindbg fx1.js 2>&1 | tail -20
xz -T0 /tmp/art/clg.maindbg.out || true
