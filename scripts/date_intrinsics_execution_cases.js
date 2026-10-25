/* Real production-Engine / pinned QuickJS consumers, not a host Date mirror.
   Cases 0..19 are timezone-independent with no installed locale callback.
   Each returns [1,1,1,1,orderLog] when correct; the individual cases also assert
   their order logs. Run 20 with TZ=UTC, 21 with TZ=Asia/Kathmandu, 22..24 with
   TZ=America/New_York in fresh processes (both VM and pinned source oracle).
   Case 25 returns actual clock milliseconds as low words plus high-word log,
   checked against independent OS samples surrounding each engine process.
   Case 26 requires {foreignConstructor,foreignDatePrototype}: a constructor
   from a second live realm whose .prototype is null and that realm's original
   Date.prototype. These explicit integration inputs are never mocked here. */
(function (operation, environment) {
    "use strict";
    const log = [];
    const yes = x => +!!x;
    const out = (a, b, c, d) => [yes(a), yes(b), yes(c), yes(d), log];
    const raises = (f, type) => { try { f(); return false; } catch (e) { return e instanceof type; } };
    const D = Date.prototype;
    if (operation === 0) {
        const p = Object.getOwnPropertyDescriptor(Date, "prototype");
        const m = Object.getOwnPropertyDescriptor(D, Symbol.toPrimitive);
        return out(Date.length === 7 && Date.UTC.length === 7 && Date.parse.length === 1,
            D.toGMTString === D.toUTCString && D.valueOf !== D.getTime,
            Object.getPrototypeOf(D) === Object.prototype && raises(() => D.getTime(), TypeError),
            !p.writable && !p.enumerable && !p.configurable && !m.writable && !m.enumerable && m.configurable);
    }
    if (operation === 1) {
        return out(Object.is(new Date(-0).getTime(), 0) && new Date(-1.9).getTime() === -1,
            new Date(8640000000000000).toISOString() === "+275760-09-13T00:00:00.000Z",
            new Date(-8640000000000000).toISOString() === "-271821-04-20T00:00:00.000Z",
            Number.isNaN(+new Date(8640000000000001)) && Number.isNaN(+new Date(Infinity)) && Number.isNaN(+new Date(undefined)));
    }
    if (operation === 2) {
        const original = new Date(42);
        Object.defineProperty(original, Symbol.toPrimitive, {get() { throw 99; }});
        const copy = new Date(original);
        const custom = {[Symbol.toPrimitive](hint) { log.push(hint === "default" ? 1 : 9); return "1970-01-01T00:00:00.007Z"; }};
        const parsed = new Date(custom);
        const ignored = {[Symbol.toPrimitive]() { throw 99; }};
        return out(copy.getTime() === 42 && copy !== original,
            parsed.getTime() === 7 && log.join() === "1",
            typeof Date(ignored, Symbol(), 1n) === "string",
            Number.isNaN(new Date(new Date(NaN)).getTime()) && raises(() => new Date(new Proxy(new Date(0), {})), TypeError));
    }
    if (operation === 3) {
        const arg = (n, value) => ({valueOf() { log.push(n); return value; }});
        const a = Date.UTC(arg(1, NaN), arg(2, 0), arg(3, 1), arg(4, 0), arg(5, 0), arg(6, 0), arg(7, 0), arg(9, 0));
        const b = new Date(arg(11, Infinity), arg(12, 0));
        return out(Number.isNaN(a) && Number.isNaN(b.getTime()) && log.join() === "1,2,3,4,5,6,7,11,12",
            Number.isNaN(Date.UTC()) && Number.isNaN(Date.UTC(undefined)),
            Date.UTC(99, 0) === 915148800000 && Date.UTC(99.9, 0) === 915148800000,
            Date.UTC(1970, -1, 32) === 0 && Date.UTC(2000, 1, 29) === 951782400000);
    }
    if (operation === 4) {
        const prototype = {};
        const target = new Proxy(function () {}, {get(t, k, r) { if (k === "prototype") { log.push(2); return prototype; } return Reflect.get(t, k, r); }});
        const d = Reflect.construct(Date, [{valueOf() { log.push(1); return 42; }}], target);
        let caught;
        try { Reflect.construct(Date, [{valueOf() { log.push(3); throw 7; }}], target); } catch (e) { caught = e; }
        const invalid = Reflect.construct(Date, [NaN], target);
        return out(Object.getPrototypeOf(d) === prototype && D.getTime.call(d) === 42,
            caught === 7 && log.join() === "1,2,3,2",
            Number.isNaN(D.getTime.call(invalid)),
            raises(() => new Date(1n), TypeError) && raises(() => Date.UTC(Symbol()), TypeError));
    }
    if (operation === 5) {
        let touched = false;
        const text = {toString() { log.push(1); return "1970-01-01T01:00:00+01:00"; }, valueOf() { touched = true; return 9; }};
        return out(Date.parse(text) === 0 && !touched && log.join() === "1",
            Date.parse("1970-01-01T00:00:00Z\0ignored") === 0 && Date.parse("1970-01-01" + " ".repeat(117) + "x") === 0,
            Date.parse("1970-01-01T00:00:00\u221201:00") === 3600000 && Number.isNaN(Date.parse("1970-01-01T00:00:00\u1234")),
            raises(() => Date.parse(Symbol()), TypeError) && Number.isNaN(Date.parse()));
    }
    if (operation === 6) {
        const over = "+275760-09-13T00:00:00.000-00:01";
        const under = "-271821-04-20T00:00:00.000+00:01";
        return out(Date.parse(over) === 8640000000060000 && Date.parse(under) === -8640000000060000,
            Number.isNaN(new Date(over).getTime()) && Number.isNaN(new Date(under).getTime()),
            Date.parse("2000-02-29T24:00:00Z") === 951868800000 && Number.isNaN(Date.parse("2000-02-29T24:00:00.001Z")),
            Date.parse("Thu, 01 Jan 1970 00:00:00 GMT") === 0 && Date.parse("2000-02-30T00:00:00Z") === 951868800000);
    }
    if (operation === 7) {
        const d = new Date("2000-02-29T23:58:57.456Z");
        return out(d.getUTCFullYear() === 2000 && d.getUTCMonth() === 1 && d.getUTCDate() === 29 && d.getUTCDay() === 2,
            d.getUTCHours() === 23 && d.getUTCMinutes() === 58 && d.getUTCSeconds() === 57 && d.getUTCMilliseconds() === 456,
            d.getTime() === 951868737456 && d.valueOf() === 951868737456,
            d.toUTCString() === "Tue, 29 Feb 2000 23:58:57 GMT" && d.toISOString() === "2000-02-29T23:58:57.456Z");
    }
    if (operation === 8) {
        const tests = [
            ["setUTCMilliseconds", [1500], "2000-02-29T23:58:58.500Z"],
            ["setUTCSeconds", [-1, 5], "2000-02-29T23:57:59.005Z"],
            ["setUTCMinutes", [60, 1, 2], "2000-03-01T00:00:01.002Z"],
            ["setUTCHours", [24, 1, 2, 3], "2000-03-01T00:01:02.003Z"],
            ["setUTCDate", [0], "2000-01-31T23:58:57.456Z"],
            ["setUTCMonth", [12, 1], "2001-01-01T23:58:57.456Z"],
            ["setUTCFullYear", [99, 0, 2], "0099-01-02T23:58:57.456Z"]
        ];
        let valid = true;
        for (const [method, args, expected] of tests) {
            const d = new Date("2000-02-29T23:58:57.456Z"), result = d[method](...args);
            valid = valid && d.toISOString() === expected && result === d.getTime();
        }
        const d = new Date(123);
        return out(valid, Object.is(d.setTime(-0), 0) && Object.is(d.getTime(), 0),
            d.setTime(-1.9) === -1, Number.isNaN(d.setTime(8640000000000001)) && Number.isNaN(d.getTime()));
    }
    if (operation === 9) {
        const invalid = new Date(NaN);
        const getters = ["getYear", "getFullYear", "getUTCFullYear", "getMonth", "getUTCMonth", "getDate", "getUTCDate", "getDay", "getUTCDay", "getHours", "getUTCHours", "getMinutes", "getUTCMinutes", "getSeconds", "getUTCSeconds", "getMilliseconds", "getUTCMilliseconds", "getTime", "valueOf", "getTimezoneOffset"];
        const setters = ["setMilliseconds", "setUTCMilliseconds", "setSeconds", "setUTCSeconds", "setMinutes", "setUTCMinutes", "setHours", "setUTCHours", "setDate", "setUTCDate", "setMonth", "setUTCMonth"];
        const d = new Date(NaN), result = d.setUTCFullYear(2000);
        return out(getters.every(k => Number.isNaN(invalid[k]())), setters.every(k => Number.isNaN(invalid[k](1))) && Number.isNaN(invalid.getTime()),
            result === 946684800000 && d.toISOString() === "2000-01-01T00:00:00.000Z",
            invalid.setTime(0) === 0 && invalid.getTime() === 0);
    }
    if (operation === 10) {
        const setters = ["setTime", "setYear", "setFullYear", "setUTCFullYear", "setMilliseconds", "setUTCMilliseconds", "setSeconds", "setUTCSeconds", "setMinutes", "setUTCMinutes", "setHours", "setUTCHours", "setDate", "setUTCDate", "setMonth", "setUTCMonth"];
        const omitted = setters.every(k => { const d = new Date(0); return Number.isNaN(d[k]()) && Number.isNaN(d.getTime()); });
        const a = new Date(123), b = new Date("2000-02-29T23:58:57.456Z"), c = new Date(0);
        a.setUTCSeconds(10); b.setUTCMonth(0); c.setUTCSeconds(1, 2, {valueOf() { throw 9; }});
        return out(omitted, a.getTime() === 10123, b.toISOString() === "2000-01-29T23:58:57.456Z", c.getTime() === 1002);
    }
    if (operation === 11) {
        const a = new Date(NaN), b = new Date(0), c = new Date(NaN), d = new Date(0);
        const ar = a.setUTCSeconds({valueOf() { log.push(1); a.setTime(0); return 1; }});
        const br = b.setUTCMinutes({valueOf() { log.push(2); b.setTime(946684800000); return 1; }});
        const cr = c.setUTCFullYear({valueOf() { log.push(3); c.setTime(123456789); return 2001; }});
        let caught; try { d.setTime({valueOf() { log.push(4); d.setTime(7); throw 42; }}); } catch (e) { caught = e; }
        return out(Number.isNaN(ar) && a.getTime() === 0, br === 60000 && b.getTime() === 60000,
            cr === 978307200000 && c.toISOString() === "2001-01-01T00:00:00.000Z",
            caught === 42 && d.getTime() === 7 && log.join() === "1,2,3,4");
    }
    if (operation === 12) {
        const d = new Date(2000, 0, 2, 3, 4, 5, 6);
        d.setYear({valueOf() { log.push(1); d.setTime(new Date(2010, 6, 8, 9, 10, 11, 12).getTime()); return 99; }});
        const invalid = new Date(NaN); invalid.setYear(5);
        const fractional = new Date(2000, 0, 1); fractional.setYear(99.9);
        return out(d.getFullYear() === 1999 && d.getMonth() === 6 && d.getDate() === 8,
            d.getHours() === 9 && d.getMinutes() === 10 && d.getSeconds() === 11 && d.getMilliseconds() === 12,
            invalid.getFullYear() === 1905 && invalid.getMonth() === 0 && invalid.getDate() === 1,
            fractional.getFullYear() === 1999 && fractional.getYear() === 99 && log.join() === "1");
    }
    if (operation === 13) {
        const bad = {valueOf() { log.push(9); throw 9; }};
        const proxy = new Proxy(new Date(0), {});
        return out(raises(() => D.setTime.call({}, bad), TypeError) && raises(() => D.setYear.call(null, bad), TypeError),
            raises(() => D.setUTCFullYear.call(proxy, bad), TypeError) && raises(() => D.setHours.call(D, bad), TypeError),
            raises(() => D.toISOString.call({}), TypeError) && raises(() => D.getTime.call(0), TypeError),
            log.length === 0 && raises(() => D.getTimezoneOffset.call(proxy), TypeError));
    }
    if (operation === 14) {
        const a = new Date(0), b = new Date(NaN), c = new Date(0);
        const arg = (n, value) => ({valueOf() { log.push(n); return value; }});
        const ar = a.setUTCHours(arg(1, Infinity), arg(2, 0), arg(3, 0), arg(4, 0));
        const br = b.setUTCSeconds(arg(5, 1), arg(6, 2));
        let caught; try { c.setUTCMinutes(arg(7, NaN), {valueOf() { log.push(8); c.setTime(42); throw 17; }}); } catch (e) { caught = e; }
        return out(Number.isNaN(ar) && Number.isNaN(a.getTime()), Number.isNaN(br) && Number.isNaN(b.getTime()),
            caught === 17 && c.getTime() === 42, log.join() === "1,2,3,4,5,6,7,8");
    }
    if (operation === 15) {
        const key = {valueOf() { throw 99; }};
        const object = {[Symbol.toPrimitive](hint) { log.push(hint === "number" ? 1 : 9); return "x"; },
            get toISOString() { log.push(2); return function () { log.push(3); return this === object && arguments.length === 0 ? 42 : 99; }; }};
        const absent = {valueOf() { return Infinity; }, get toISOString() { throw 99; }};
        const big = {valueOf() { return 1n; }, toISOString() { return "big"; }};
        return out(D.toJSON.call(object, key) === 42 && log.join() === "1,2,3", D.toJSON.call(absent) === null,
            D.toJSON.call(big) === "big", new Date(NaN).toJSON() === null && new Date(0).toJSON() === "1970-01-01T00:00:00.000Z");
    }
    if (operation === 16) {
        let caught;
        try { D.toJSON.call({[Symbol.toPrimitive]() { throw 42; }, get toISOString() { log.push(9); return 1; }}); } catch (e) { caught = e; }
        const noncallable = raises(() => D.toJSON.call({valueOf() { return 0; }, toISOString: 1}), TypeError);
        const descriptor = Object.getOwnPropertyDescriptor(Number.prototype, "toISOString");
        let boxed;
        try { Object.defineProperty(Number.prototype, "toISOString", {configurable: true, value() { return this instanceof Number && this.valueOf() === 7; }}); boxed = D.toJSON.call(7); }
        finally { if (descriptor) Object.defineProperty(Number.prototype, "toISOString", descriptor); else delete Number.prototype.toISOString; }
        return out(caught === 42 && log.length === 0, noncallable, boxed, raises(() => D.toJSON.call(null), TypeError) && raises(() => D.toJSON.call(undefined), TypeError));
    }
    if (operation === 17) {
        const primitive = D[Symbol.toPrimitive];
        const object = {get [Symbol.toPrimitive]() { throw 99; }, toString() { log.push(1); return "s"; }, valueOf() { log.push(2); return 7; }};
        const defaults = primitive.call(object, "default"), strings = primitive.call(object, "string");
        const numbers = primitive.call(object, "number"), integers = primitive.call(object, "integer");
        const hint = {toString() { log.push(9); return "number"; }};
        return out(defaults === "s" && strings === "s" && numbers === 7 && integers === 7,
            raises(() => primitive.call(object, hint), TypeError) && raises(() => primitive.call(object), TypeError),
            raises(() => primitive.call(1, "number"), TypeError), log.join() === "1,1,2,2");
    }
    if (operation === 18) {
        const d = new Date(NaN), ignored = new Proxy({}, {get() { throw 99; }});
        const formats = ["toString", "toUTCString", "toGMTString", "toDateString", "toTimeString", "toLocaleString", "toLocaleDateString", "toLocaleTimeString"];
        return out(formats.every(k => d[k](ignored, ignored) === "Invalid Date"), raises(() => d.toISOString(), RangeError),
            d.toJSON() === null, raises(() => D.toLocaleString.call({}, ignored), TypeError));
    }
    if (operation === 19) {
        const a = new Date("0000-01-01T00:00:00Z"), b = new Date("+010000-01-01T00:00:00Z"), c = new Date("-000001-01-01T00:00:00Z");
        const ordinary = {toString() { log.push(1); return {}; }, valueOf() { log.push(2); return 5; }};
        return out(a.toISOString() === "0000-01-01T00:00:00.000Z" && a.getUTCFullYear() === 0,
            b.toISOString() === "+010000-01-01T00:00:00.000Z" && c.toISOString() === "-000001-01-01T00:00:00.000Z",
            D[Symbol.toPrimitive].call(ordinary, "default") === 5 && log.join() === "1,2",
            raises(() => D[Symbol.toPrimitive].call({valueOf() { return {}; }, toString() { return {}; }}, "number"), TypeError));
    }
    if (operation === 20) {
        const d = new Date(0), ignored = new Proxy({}, {get() { throw 99; }});
        const tests = [["setMilliseconds", [1001], 1001], ["setSeconds", [1, 2], 1002], ["setMinutes", [1, 2, 3], 62003], ["setHours", [1, 2, 3, 4], 3723004], ["setDate", [2], 86400000], ["setMonth", [1, 1], 2678400000], ["setFullYear", [2000, 0, 1], 946684800000]];
        const setters = tests.every(([method, args, expected]) => { const value = new Date(0); return value[method](...args) === expected && value.getTime() === expected; });
        return out(d.getTimezoneOffset() === 0 && d.getFullYear() === 1970 && d.getYear() === 70 && d.getMonth() === 0 && d.getDate() === 1 && d.getDay() === 4,
            d.toString() === "Thu Jan 01 1970 00:00:00 GMT+0000" && d.toDateString() === "Thu Jan 01 1970" && d.toTimeString() === "00:00:00 GMT+0000",
            d.toLocaleString(ignored, ignored) === "01/01/1970, 12:00:00 AM" && d.toLocaleDateString() === "01/01/1970" && d.toLocaleTimeString() === "12:00:00 AM",
            setters && new Date(NaN).setFullYear(2000) === 946684800000);
    }
    if (operation === 21) {
        const d = new Date("2020-01-01T00:00:00Z"), local = new Date(2020, 0, 1, 0, 0, 0, 0);
        return out(d.getTimezoneOffset() === -345 && d.getHours() === 5 && d.getMinutes() === 45,
            d.toTimeString() === "05:45:00 GMT+0545" && d.getDate() === 1,
            local.toISOString() === "2019-12-31T18:15:00.000Z" && Date.parse("2020-01-01T00:00:00") === 1577816100000,
            Date.parse("2020-01-01") === 1577836800000 && new Date("2020-01-01T00:00:00-03:30").getTime() === 1577849400000);
    }
    if (operation === 22) {
        const before = new Date("2021-03-14T06:59:59.999Z"), after = new Date("2021-03-14T07:00:00.000Z");
        const skipped = new Date(2021, 2, 14, 2, 30);
        return out(before.getTimezoneOffset() === 300 && after.getTimezoneOffset() === 240,
            before.getHours() === 1 && before.getMinutes() === 59 && after.getHours() === 3 && after.getMinutes() === 0,
            skipped.toISOString() === "2021-03-14T07:30:00.000Z" && skipped.getHours() === 3,
            Date.parse("2021-03-14T02:30:00") === 1615707000000 && skipped.toTimeString() === "03:30:00 GMT-0400");
    }
    if (operation === 23) {
        const before = new Date("2021-11-07T05:59:59.999Z"), after = new Date("2021-11-07T06:00:00.000Z");
        const repeated = new Date(2021, 10, 7, 1, 30);
        return out(before.getTimezoneOffset() === 240 && after.getTimezoneOffset() === 300,
            before.getHours() === 1 && before.getMinutes() === 59 && after.getHours() === 1 && after.getMinutes() === 0,
            repeated.toISOString() === "2021-11-07T05:30:00.000Z" && repeated.toTimeString() === "01:30:00 GMT-0400",
            Date.parse("2021-11-07T01:30:00") === 1636263000000);
    }
    if (operation === 24) {
        const spring = new Date("2021-03-14T05:00:00Z"), autumn = new Date("2021-11-07T04:00:00Z");
        spring.setHours(2, 30); autumn.setHours(1, 30);
        const rescued = new Date(NaN); rescued.setFullYear(2000);
        const end = new Date("2020-12-31T23:59:59.999Z"); end.setMilliseconds(1000);
        return out(spring.toISOString() === "2021-03-14T07:30:00.000Z", autumn.toISOString() === "2021-11-07T05:30:00.000Z",
            rescued.toISOString() === "2000-01-01T05:00:00.000Z" && rescued.getHours() === 0,
            end.toISOString() === "2021-01-01T00:00:00.000Z" && end.getFullYear() === 2020 && end.getDate() === 31 && end.getHours() === 19);
    }
    if (operation === 25) {
        const now = Date.now(), constructed = new Date().getTime(), called = Date({valueOf() { throw 99; }});
        const parsed = Date.parse(called);
        log.push(Math.floor(now / 4294967296), Math.floor(constructed / 4294967296), Math.floor(parsed / 4294967296));
        return [now >>> 0, constructed >>> 0, parsed >>> 0,
            yes(Number.isInteger(now) && Number.isInteger(constructed) && Number.isInteger(parsed)
                && typeof called === "string" && called !== "Invalid Date"), log];
    }
    if (operation === 26) {
        const ctor = environment.foreignConstructor, proto = environment.foreignDatePrototype;
        const d = Reflect.construct(Date, [42], ctor);
        const custom = {}; function C() {} C.prototype = custom;
        const local = Reflect.construct(Date, [7], C);
        return out(Object.getPrototypeOf(d) === proto && D.getTime.call(d) === 42, Object.getPrototypeOf(d) !== D,
            Object.getPrototypeOf(local) === custom && D.getTime.call(local) === 7, new Date(d).getTime() === 42);
    }
    if (operation === 27) {
        // Finite MakeDate intermediates saturate the i64 timezone-query input
        // before TimeClip, so real platform adapters must accept both extrema.
        const high = new Date(1970, 0, 1e20), low = new Date(1970, 0, -1e20);
        const a = new Date(0), b = new Date(0);
        const ar = a.setDate(1e20), br = b.setHours(-1e20);
        return out(Number.isNaN(high.getTime()) && Number.isNaN(low.getTime()),
            Number.isNaN(ar) && Number.isNaN(a.getTime()), Number.isNaN(br) && Number.isNaN(b.getTime()),
            Number.isNaN(Date.UTC(1970, 0, 1e308)) && Number.isNaN(new Date(1970, 0, 1e308).getTime()));
    }
    throw new Error("unknown Date intrinsic semantic case");
})
