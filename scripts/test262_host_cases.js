// Run through native run_test262 -N and pinned C run-test262 -N.
// No replacement helpers: every observation reaches the installed native $262.
(function () {
    function check(value, message) { if (!value) throw new Error(message); }
    function throwsType(action, message) {
        try { action(); } catch (error) { check(error instanceof TypeError, message + ': wrong error'); return; }
        throw new Error(message + ': did not throw');
    }
    check($262.global === globalThis, 'main global identity');
    var realm = $262.createRealm();
    check(realm !== $262 && realm.global !== globalThis, 'distinct realm/global');
    check(realm.global.$262 === realm, 'realm helper identity');
    check(realm.evalScript('globalThis') === realm.global, 'evalScript native function realm');
    check(realm.evalScript('Object') !== Object, 'realm intrinsic isolation');
    var foreign = realm.evalScript('({answer: 41})');
    check(Object.getPrototypeOf(foreign) === realm.global.Object.prototype, 'foreign result prototype');
    check(realm.evalScript({toString: function () { return 'globalThis.answer = 42; answer'; }}) === 42, 'source ToString');
    check(!Object.prototype.hasOwnProperty.call(globalThis, 'answer'), 'eval does not leak globals');
    var detachedEval = realm.evalScript;
    check(detachedEval.call($262, 'globalThis') === realm.global, 'function realm not receiver');
    var html = realm.IsHTMLDDA;
    check(typeof html === 'undefined' && !html && html == null && html == undefined, 'HTMLDDA coercions');
    check(html !== null && html !== undefined && html() === null, 'HTMLDDA callable identity');
    check(typeof $262.IsHTMLDDA === 'undefined' && $262.IsHTMLDDA !== html, 'per-realm HTMLDDA');
    $262.gc();
    check(foreign.answer === 41 && realm.evalScript('answer') === 42, 'foreign roots survive GC');
    var buffer = new ArrayBuffer(16);
    var array = new Uint8Array(buffer, 4, 4);
    var view = new DataView(buffer, 2, 6);
    check($262.detachArrayBuffer(buffer, 'ignored') === undefined, 'detach return');
    check(buffer.byteLength === 0 && array.length === 0 && array.byteLength === 0 && array[0] === undefined, 'detached typed view');
    throwsType(function () { return view.byteLength; }, 'detached DataView length');
    throwsType(function () { view.getInt8(0); }, 'detached DataView access');
    $262.detachArrayBuffer(buffer);
    $262.detachArrayBuffer(17);
    var shared = new SharedArrayBuffer(16);
    $262.detachArrayBuffer(shared);
    check(shared.byteLength === 16, 'shared detach is source no-op');
    check($262.codePointRange(65, 68) === 'ABC', 'code point range end exclusive');
    check($262.codePointRange(0xffff, 0x10002) === '\uffff\ud800\udc00\ud800\udc01', 'code point surrogate boundary');
    check($262.codePointRange(0x10ffff, 0xffffffff) === '\udbff\udfff', 'code point upper clamp');
    check($262.codePointRange(100, 99) === '', 'reversed range');
    var coercions = '';
    check($262.codePointRange({valueOf: function () { coercions += 'a'; return 65; }}, {valueOf: function () { coercions += 'b'; return 66; }}) === 'A' && coercions === 'ab', 'range coercion order');
    var names = ['start', 'getReport', 'broadcast', 'report', 'leaving', 'receiveBroadcast', 'sleep', 'monotonicNow'];
    var lengths = [1, 0, 2, 1, 0, 1, 1, 0];
    for (var i = 0; i < names.length; i++) {
        var descriptor = Object.getOwnPropertyDescriptor($262.agent, names[i]);
        check(typeof descriptor.value === 'function' && descriptor.value.length === lengths[i], 'agent method/arity ' + names[i]);
        check(descriptor.writable && descriptor.configurable && !descriptor.enumerable, 'agent descriptor ' + names[i]);
    }
    throwsType(function () { $262.agent.leaving(); }, 'main leaving guard');
    throwsType(function () { $262.agent.receiveBroadcast(function () {}); }, 'main receive guard');
    throwsType(function () { $262.agent.broadcast({}); }, 'broadcast buffer guard');
    // Comments in C say report/getReport are agent/main-only, but their bodies
    // intentionally impose neither restriction.
    check($262.agent.getReport() === null, 'empty report queue');
    $262.agent.report({toString: function () { return 'main-report\0discard'; }});
    check($262.agent.getReport() === 'main-report' && $262.agent.getReport() === null, 'owned report ToString/strdup/FIFO');
    var before = $262.agent.monotonicNow();
    $262.agent.sleep({valueOf: function () { return 5; }});
    check($262.agent.monotonicNow() >= before + 4, 'monotonic sleep');
    globalThis.parentOnly = 123;
    function nextReport() {
        var deadline = $262.agent.monotonicNow() + 10000;
        while (true) {
            var report = $262.agent.getReport();
            if (report !== null) return report;
            if ($262.agent.monotonicNow() >= deadline) throw new Error('agent report timeout');
            $262.agent.sleep(1);
        }
    }
    function child(id) {
        return "var agentId=" + id + ";" +
            "if(typeof parentOnly!=='undefined')throw Error('shared JS heap');" +
            "for(var name of ['start','getReport','broadcast','report','leaving','receiveBroadcast','sleep','monotonicNow'])if(typeof $262.agent[name]!=='function')throw Error('missing child API');" +
            "for(var operation of [()=> $262.agent.start(''),()=> $262.agent.broadcast(new SharedArrayBuffer(4)),()=> $262.agent.receiveBroadcast(1)]){var caught=false;try{operation()}catch(e){caught=e instanceof TypeError}if(!caught)throw Error('child context guard')}" +
            "Promise.resolve().then(function(){" +
            "$262.agent.receiveBroadcast(function(sab,value){" +
            "if(!(sab instanceof SharedArrayBuffer)||value!==1)throw Error('broadcast wrapping/coercion');" +
            "var cells=new Int32Array(sab);" +
            "Atomics.add(cells,0,1);Atomics.store(cells,agentId,agentId*11);Atomics.notify(cells,0);" +
            "$262.agent.leaving();$262.agent.report('done:'+agentId);" +
            "});$262.agent.report('ready:'+agentId);});";
    }
    $262.agent.start({toString: function () { return child(1); }});
    $262.agent.start(child(2));
    var ready = [nextReport(), nextReport()].sort();
    check(ready.join(',') === 'ready:1,ready:2', 'agents execute actual jobs');
    var cells = new Int32Array(shared);
    $262.agent.broadcast(shared, {valueOf: function () { return 4294967297; }});
    var end = $262.agent.monotonicNow() + 10000;
    while (Atomics.load(cells, 0) !== 2) {
        var observed = Atomics.load(cells, 0);
        if (observed === 2) break;
        check($262.agent.monotonicNow() < end, 'shared Atomics rendezvous timeout');
        Atomics.wait(cells, 0, observed, 100);
    }
    var reports = [nextReport(), nextReport()].sort();
    check(reports.join(',') === 'done:1,done:2', 'concurrent reports and leaving source semantics');
    check(cells[1] === 11 && cells[2] === 22, 'real shared native backing');
    check($262.agent.getReport() === null, 'report owners consumed exactly once');
    print('test262-host: realms htmlDDA detach coercions threads shared-atomics reports PASS');
})();
