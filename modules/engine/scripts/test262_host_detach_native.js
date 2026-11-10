// Native-only lifetime guarantee. Pinned C aliases freed storage after detach;
// running it there is a source UAF, NOT a useful differential oracle.
(function () {
    function check(value, message) { if (!value) throw Error(message); }
    function report() {
        var end = $262.agent.monotonicNow() + 10000;
        for (;;) {
            var value = $262.agent.getReport();
            if (value !== null) return value;
            if ($262.agent.monotonicNow() > end) throw Error('report timeout');
            $262.agent.sleep(1);
        }
    }
    var ordinary = new ArrayBuffer(16);
    var view = new Int32Array(ordinary);
    view[0] = 91;
    var control = new SharedArrayBuffer(8);
    var gate = new Int32Array(control);
    $262.agent.start(
        "var held;" +
        "$262.agent.receiveBroadcast(function(b){held=new Int32Array(b);" +
        "Promise.resolve().then(function(){" +
        "$262.agent.receiveBroadcast(function(g){var gate=new Int32Array(g);" +
        "$262.agent.report('waiting');while(Atomics.load(gate,0)===0)Atomics.wait(gate,0,0);" +
        "if(held[0]!==91)throw Error('detached owner freed child backing');" +
        "held[1]=44;$262.agent.report('survived');});$262.agent.report('held');});});"
    );
    $262.agent.broadcast(ordinary, 0);
    check(report() === 'held', 'ordinary lease readiness');
    $262.agent.broadcast(control, 0);
    check(report() === 'waiting', 'child parked on independent shared gate');
    $262.detachArrayBuffer(ordinary);
    check(ordinary.byteLength === 0 && view.length === 0, 'ordinary detach still refreshes original views');
    $262.gc();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    check(report() === 'survived', 'child owns backing independently of detached object');
    print('test262-host: native-detach-owner-lifetime PASS');
})();
