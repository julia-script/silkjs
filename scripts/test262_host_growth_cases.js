// Pinned source snapshots SAB byte length before coercing broadcast's value.
// The native wrapper must retain physical capacity, not confuse it with that
// JavaScript snapshot when canonical atomic cells access an odd-length view.
(function () {
    var buffer = new SharedArrayBuffer(3, {maxByteLength: 16});
    var bytes = new Uint8Array(buffer);
    bytes[0] = 7;
    $262.agent.start(
        "$262.agent.receiveBroadcast(function(b,n){" +
        "if(b.byteLength!==3||n!==99)throw Error('broadcast source snapshot');" +
        "var a=new Uint8Array(b);if(Atomics.load(a,0)!==7)throw Error('odd shared view');" +
        "Atomics.store(a,2,9);$262.agent.report('growth-snapshot');});"
    );
    $262.agent.broadcast(buffer, {valueOf: function () { buffer.grow(16); return 99; }});
    var end = $262.agent.monotonicNow() + 10000;
    for (;;) {
        var report = $262.agent.getReport();
        if (report !== null) {
            if (report !== 'growth-snapshot' || buffer.byteLength !== 16 || Atomics.load(new Uint8Array(buffer), 2) !== 9)
                throw Error('growable shared alias');
            break;
        }
        if ($262.agent.monotonicNow() > end) throw Error('growth report timeout');
        $262.agent.sleep(1);
    }
    print('test262-host: growable-shared-coercion-snapshot PASS');
})();
