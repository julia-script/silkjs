// Source-defined ordinary ArrayBuffer broadcasts: do not detach/resize while
// C agents hold raw aliases. Run both native and pinned C run-test262 -N.
// Observed pinned 7d1c13c C result: assertions print PASS, then exit134 at
// quickjs.c:2513 (gc_obj_list) because run-test262.c:786 overwrites the retained
// broadcast_sab without releasing its previous owner. Native must exit0 and
// reclaim every owner; matching the C teardown abort would preserve the defect.
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
    var buffer = new ArrayBuffer(16);
    var cells = new Int32Array(buffer);
    cells[0] = 7;
    $262.agent.start(
        "var old;" +
        "$262.agent.receiveBroadcast(function(b,n){" +
        "if(!(b instanceof SharedArrayBuffer)||n!==1)throw Error('ordinary wrapper');" +
        "old=new Int32Array(b);if(old[0]!==7)throw Error('ordinary bytes');old[0]=13;" +
        "Promise.resolve().then(function(){" +
        "$262.agent.receiveBroadcast(function(next,n){var current=new Int32Array(next);" +
        "if(n!==2||old[0]!==21||current[0]!==21)throw Error('alias retained across broadcasts');" +
        "old[1]=55;if(current[1]!==55)throw Error('broadcast copied backing');" +
        "$262.agent.report('second');});$262.agent.report('first');});});"
    );
    $262.agent.broadcast(buffer, 1);
    check(report() === 'first' && cells[0] === 13, 'ordinary child write reaches original view');
    cells[0] = 21;
    $262.agent.broadcast(buffer, 2);
    check(report() === 'second' && cells[1] === 55, 'repeated ordinary backing identity');
    check(buffer instanceof ArrayBuffer && !(buffer instanceof SharedArrayBuffer) && buffer.byteLength === 16, 'parent class/length preserved');
    print('test262-host: repeated-ordinary-backing PASS');
})();
