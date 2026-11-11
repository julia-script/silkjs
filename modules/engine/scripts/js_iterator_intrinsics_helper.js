/* Evaluate this function and invoke cases 0..6 in the production VM and pinned
   quickjs.c oracle. Each case returns true; assertions use literal outcomes. */
(function (operation) {
    "use strict";
    const P = Iterator.prototype;
    const assert = (x) => { if (!x) throw new Error("iterator helper contract"); };
    const thrown = (f) => { try { f(); } catch (e) { return e; } throw new Error("expected throw"); };
    if (operation === 0) {
        for (const [name, value, error] of [["chunks", "2", TypeError], ["windows", 1.5, TypeError],
            ["chunks", 0, RangeError], ["windows", Infinity, TypeError], ["drop", NaN, RangeError],
            ["take", -1, RangeError], ["take", 9007199254740992, RangeError]]) {
            let closed = 0, read = 0;
            const source = {get next() { read++; }, return() { closed++; throw "secondary"; }};
            assert(thrown(() => P[name].call(source, value)) instanceof error);
            assert(closed === 1 && read === 0);
        }
        let coercions = 0;
        assert(thrown(() => P.chunks.call({return() { return {}; }}, {valueOf() { coercions++; return 2; }})) instanceof TypeError);
        assert(coercions === 0);
    } else if (operation === 1) {
        let gets = 0, calls = 0, mapped = 0;
        const source = {get next() { gets++; return () => ({value: ++calls, done: calls > 2}); }};
        const helper = P.map.call(source, (v, i) => { mapped++; return v + i * 10; });
        assert(gets === 1 && calls === 0 && mapped === 0);
        assert(helper.next().value === 1 && helper.next().value === 12 && helper.next().done);
        assert(calls === 3 && mapped === 2 && helper.next().done && calls === 3);
    } else if (operation === 2) {
        let closed = 0;
        const source = {next() { return {value: 1}; }, return() { closed++; throw "close"; }};
        const h = P.map.call(source, () => { throw "mapper"; });
        assert(thrown(() => h.next()) === "mapper" && closed === 1 && h.next().done);
        const direct = P.filter.call({next() { throw "next"; }, return() { closed++; return {}; }}, () => true);
        assert(thrown(() => direct.next()) === "next" && closed === 1 && direct.next().done);
        const empty = P.take.call(source, 0);
        assert(thrown(() => empty.next()) === "close" && closed === 2 && empty.next().done);
    } else if (operation === 3) {
        const chunks = [1,2,3,4,5].values().chunks(2);
        const a = chunks.next().value, b = chunks.next().value, c = chunks.next();
        assert(a.join() === "1,2" && b.join() === "3,4" && c.value.join() === "5" && !c.done && chunks.next().done);
        const windows = [1,2,3].values().windows(2, "allow-partial");
        const w = windows.next().value; w[0] = 99;
        assert(windows.next().value.join() === "2,3" && windows.next().done);
        const partial = [1,2].values().windows(3, "allow-partial");
        assert(partial.next().value.join() === "1,2" && partial.next().done);
        assert([1,2].values().windows(3).next().done);
        assert([1].values().windows(2, "allow-partial\0ignored").next().value[0] === 1);
    } else if (operation === 4) {
        let h, reentries = 0, closed = 0;
        h = P.map.call({next() { return {value: 4}; }, return() { closed++; assert(thrown(() => h.next()) instanceof TypeError); return {}; }}, v => {
            assert(thrown(() => h.next()) instanceof TypeError);
            assert(thrown(() => h.return()) instanceof TypeError); reentries++; return v;
        });
        assert(h.next().value === 4 && reentries === 1);
        assert(h.return().done && closed === 1 && h.next().done);
    } else if (operation === 5) {
        const log = [];
        const inner = {next() { return {value: 7}; }, return() { log.push("inner"); throw "inner-close"; }};
        const outer = {next() { return {value: 1}; }, return() { log.push("outer"); throw "outer-close"; }};
        const h = P.flatMap.call(outer, () => inner);
        assert(h.next().value === 7);
        assert(thrown(() => h.return()) === "inner-close" && log.join() === "inner,outer" && h.next().done);
        let closed = 0;
        const bad = P.flatMap.call({next() { return {value: 1}; }, return() { closed++; return {}; }}, () => "abc");
        assert(thrown(() => bad.next()) instanceof TypeError && closed === 1);
    } else if (operation === 6) {
        const indexes = [];
        const h = [10,20,30,40].values().drop(1.9).filter((v, i) => { indexes.push(i); return v !== 30; }).take(2);
        assert(h.next().value === 20 && h.next().value === 40 && h.next().done && indexes.join() === "0,1,2");
        assert([1].values().take(Infinity).next().value === 1);
        let closes = 0;
        const flat = P.flatMap.call([1,2].values(), v => ({next() { return {done: true}; }, return() { closes++; return {}; }}));
        assert(flat.next().done && closes === 2);
    } else { throw new Error("unknown case"); }
    return true;
})
