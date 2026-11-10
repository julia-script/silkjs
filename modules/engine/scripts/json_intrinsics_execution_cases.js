/* Production Engine cases 0..21. Each returns [1,1,1,1,log] on success.
   Independent expectations follow pinned quickjs.c:52103-52797, including the
   small-record/hashed-record duplicate-key source-context asymmetry. Evaluate
   this function in the actual VM (not a host mirror); run each case in a fresh
   realm. Parent should also compare outputs with the pinned QuickJS executable.
   No builds or execution were performed while preparing these cases. */
(function (operation) {
    const log = [];
    const out = (a, b, c, d) => [+!!a, +!!b, +!!c, +!!d, log];
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const raises = (f, C) => { try { f(); return false; } catch (e) { return e instanceof C; } };
    if (operation === 0) {
        const v = JSON.parse('{"__proto__":{"x":1},"a":[true,null,-0,1e400]}');
        return out(Object.getPrototypeOf(v) === Object.prototype && own(v, '__proto__'),
            v.__proto__.x === 1 && v.x === undefined, v.a[0] && v.a[1] === null,
            Object.is(v.a[2], -0) && v.a[3] === Infinity);
    }
    if (operation === 1) {
        const contexts = [];
        const value = JSON.parse(' {"a":1.20e+2,"b":"\\u0061","c":-0} ', function (k, v, c) {
            log.push(k); contexts.push(c);
            if (k === 'a') return c.source;
            if (k === 'b') return c.source;
            if (k === 'c') return c.source;
            return v;
        });
        return out(value.a === '1.20e+2' && value.b === '"\\u0061"' && value.c === '-0',
            log.join(',') === 'a,b,c,', !own(contexts[3], 'source'),
            contexts[0] !== contexts[1] && Object.getPrototypeOf(contexts[0]) === Object.prototype);
    }
    if (operation === 2) {
        let rootThis, rootContext;
        const v = JSON.parse('12345678901234567890', function (k, n, c) {
            rootThis = this; rootContext = c; return BigInt(c.source);
        });
        const d = Object.getOwnPropertyDescriptor(rootContext, 'source');
        return out(v === 12345678901234567890n, own(rootThis, '') && typeof rootThis[''] === 'number',
            d.value === '12345678901234567890' && d.enumerable && d.writable && d.configurable,
            raises(() => JSON.parse('1 2', () => { log.push(1); }), SyntaxError) && log.length === 0);
    }
    if (operation === 3) {
        const v = JSON.parse('{"a":1,"b":2,"c":3}', function (k, n, c) {
            log.push(k + ':' + own(c, 'source'));
            if (k === 'a') { this.b = 20; delete this.c; this.d = 4; }
            return n;
        });
        return out(v.b === 20 && !own(v, 'c') && v.d === 4,
            log.join(',') === 'a:true,b:false,c:false,:false',
            JSON.parse('null', () => undefined) === undefined,
            raises(() => JSON.parse('[1,]'), SyntaxError));
    }
    if (operation === 4) {
        const a = JSON.parse('[1,2,3]', function (k, v) {
            log.push(k); if (k === '0') { this.length = 1; return undefined; } return v;
        });
        return out(a.length === 1 && !own(a, '0'), log.join(',') === '0,1,2,',
            JSON.stringify(a) === '[null]', raises(() => JSON.parse('\ufeff1'), SyntaxError));
    }
    if (operation === 5) {
        let small, large;
        JSON.parse('{"x":1.0,"x":1}', (k, v, c) => { if (k === 'x') small = c.source; return v; });
        JSON.parse('{"x":1.0,"a":0,"b":0,"c":0,"d":0,"e":0,"f":0,"g":0,"x":1}',
            (k, v, c) => { if (k === 'x') large = c.source; return v; });
        let different;
        JSON.parse('{"x":2,"x":1}', (k, v, c) => { if (k === 'x') different = own(c, 'source'); return v; });
        return out(small === '1.0', large === '1', different === false,
            JSON.parse('1', {}) === 1);
    }
    if (operation === 6) {
        const v = JSON.parse('{"a":1,"b":2}', function (k, n) {
            if (k === 'a') Object.defineProperty(this, 'b', {value: 2, writable: false, configurable: false});
            if (k === 'b') return 9;
            return n;
        });
        let marker = {};
        let caught; try { JSON.parse({toString() { throw marker; }}, () => log.push(1)); } catch (e) { caught = e; }
        return out(v.b === 2, caught === marker && log.length === 0,
            raises(() => JSON.parse(Symbol()), TypeError), raises(() => JSON.parse('01'), SyntaxError));
    }
    if (operation === 7) {
        const o = {z: 1, 10: 10, 2: 2, a: undefined, b: function () {}, c: Symbol()};
        o[Symbol()] = 9;
        return out(JSON.stringify(o) === '{"2":2,"10":10,"z":1}',
            JSON.stringify([, undefined, function () {}, Symbol(), NaN, Infinity, -Infinity, -0]) === '[null,null,null,null,null,null,null,0]',
            JSON.stringify(undefined) === undefined && JSON.stringify(Symbol()) === undefined,
            JSON.stringify(function () {}) === undefined);
    }
    if (operation === 8) {
        const child = {toJSON(k) { log.push('toJSON:' + k); return 7; }};
        let rootHolder;
        const text = JSON.stringify({a: child}, function (k, v) {
            log.push('replacer:' + k); if (k === '') rootHolder = this;
            if (k === 'a') return v + 1; return v;
        });
        const returned = {toJSON() { throw 99; }, x: 2};
        return out(text === '{"a":8}', log.join(',') === 'replacer:,toJSON:a,replacer:a',
            own(rootHolder, '') && rootHolder[''].a === child,
            JSON.stringify(0, (k, v) => k === '' ? returned : v) === '{"x":2}');
    }
    if (operation === 9) {
        const obj = Object.create({inherited: 5});
        Object.defineProperty(obj, 'hidden', {value: 4}); obj.a = 1; obj.b = 2; obj['3'] = 3;
        const boxed = new String('a'); boxed.toString = () => { log.push('key'); return 'a'; };
        const text = JSON.stringify(obj, ['hidden', boxed, 'a', new Number(3), true, {}, 'inherited']);
        return out(text === '{"hidden":4,"a":1,"3":3,"inherited":5}', log.join(',') === 'key',
            JSON.stringify([3, 4], ['1']) === '[3,4]', JSON.stringify({a: 1}, []) === '{}');
    }
    if (operation === 10) {
        const replacer = [new Number(1)]; replacer[0].toString = () => { log.push('key'); return 'a'; };
        const space = new Number(2); space.valueOf = () => { log.push('space'); return 2; };
        const obj = {toJSON() { log.push('value'); return {a: 1}; }};
        const text = JSON.stringify(obj, replacer, space);
        return out(text === '{\n  "a": 1\n}', log.join(',') === 'key,space,value',
            JSON.stringify({a: [1]}, null, '..........extra') === '{\n.........."a": [\n....................1\n..........]\n}',
            JSON.stringify({}, null, 5) === '{}');
    }
    if (operation === 11) {
        const s = new String('x'); s.toString = () => { log.push('string'); return 'y'; };
        const n = new Number(1); n.valueOf = () => { log.push('number'); return 2; };
        const b = new Boolean(false); b.valueOf = () => { throw 99; };
        return out(JSON.stringify([s, n, b]) === '["y",2,false]', log.join(',') === 'string,number',
            JSON.stringify(Object(Symbol('s'))) === '{}', raises(() => JSON.stringify(Object(1n)), TypeError));
    }
    if (operation === 12) {
        const x = {}; x.self = x;
        const shared = {v: 1};
        return out(raises(() => JSON.stringify(x), TypeError),
            JSON.stringify([shared, shared]) === '[{"v":1},{"v":1}]',
            JSON.stringify(x, (k, v) => k === 'self' ? 2 : v) === '{"self":2}',
            JSON.stringify({toJSON() { return null; }}) === 'null');
    }
    if (operation === 13) {
        const text = JSON.stringify('\ud800X\udc00\ud83d\ude00\b\t\n\f\r\u0000"\\');
        return out(text === '"\\ud800X\\udc00\ud83d\ude00\\b\\t\\n\\f\\r\\u0000\\"\\\\"',
            JSON.stringify('\u2028\u2029') === '"\u2028\u2029"',
            JSON.stringify({'\ud800': 1}) === '{"\\ud800":1}',
            JSON.stringify({a: 1}, null, '123456789\ud800X') === '{\n123456789\ud800"a": 1\n}');
    }
    if (operation === 14) {
        const old = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
        let text, direct;
        try {
            Object.defineProperty(BigInt.prototype, 'toJSON', {configurable: true, value(k) { log.push(k); return String(this); }});
            text = JSON.stringify({a: 123n}); direct = JSON.stringify(9n);
        } finally { if (old) Object.defineProperty(BigInt.prototype, 'toJSON', old); else delete BigInt.prototype.toJSON; }
        return out(text === '{"a":"123"}' && direct === '"9"', log.join(',') === 'a,',
            raises(() => JSON.stringify(1n), TypeError), JSON.stringify(1n, (k, v) => Number(v)) === '1');
    }
    if (operation === 15) {
        const raw = JSON.rawJSON('9007199254740993');
        const d = Object.getOwnPropertyDescriptor(raw, 'rawJSON');
        return out(JSON.isRawJSON(raw) && Object.getPrototypeOf(raw) === null,
            Object.isFrozen(raw) && !Object.isExtensible(raw) && d.enumerable && !d.writable && !d.configurable,
            d.value === '9007199254740993' && JSON.stringify({n: raw}) === '{"n":9007199254740993}',
            JSON.stringify(JSON.rawJSON('"\\ud800"')) === '"\\ud800"');
    }
    if (operation === 16) {
        const bad = ['', ' 1', '1 ', '{}', '[]', 'true\n', '+1', '01', 'NaN', 'Infinity', 'undefined', '1 2', '"bad\n"'];
        let rejected = 0; for (const s of bad) if (raises(() => JSON.rawJSON(s), SyntaxError)) rejected++;
        let marker = {}; let caught; try { JSON.rawJSON({toString() { throw marker; }}); } catch (e) { caught = e; }
        return out(rejected === bad.length, caught === marker, raises(() => JSON.rawJSON(Symbol()), TypeError),
            JSON.rawJSON(-0).rawJSON === '0' && JSON.rawJSON(null).rawJSON === 'null');
    }
    if (operation === 17) {
        const raw = JSON.rawJSON('true'); const proxy = new Proxy(raw, {});
        const revoked = Proxy.revocable(raw, {}); revoked.revoke();
        return out(!JSON.isRawJSON(proxy) && !JSON.isRawJSON(revoked.proxy),
            !JSON.isRawJSON({rawJSON: '1'}) && !JSON.isRawJSON(null),
            JSON.stringify(proxy) === '{"rawJSON":"true"}',
            JSON.stringify({x: 1}, (k, v) => k === 'x' ? raw : v) === '{"x":true}');
    }
    if (operation === 18) {
        const o = {get a() { log.push('a'); delete this.b; this.c = 3; return 1; }, b: 2};
        const text = JSON.stringify(o);
        const p = new Proxy({a: 1}, {ownKeys() { log.push('keys'); return ['a']; },
            getOwnPropertyDescriptor(t, k) { log.push('desc:' + k); return Reflect.getOwnPropertyDescriptor(t, k); },
            get(t, k) { log.push('get:' + String(k)); return t[k]; }});
        const proxyText = JSON.stringify(p);
        return out(text === '{"a":1}', proxyText === '{"a":1}',
            log.join(',') === 'a,get:toJSON,keys,desc:a,get:a',
            JSON.stringify({a: 1}, function (k, v) { return k === 'a' ? JSON.parse('2') : v; }) === '{"a":2}');
    }
    if (operation === 19) {
        const revoked = Proxy.revocable([], {}); revoked.revoke();
        const space = new Number(2); space.valueOf = () => { log.push('space'); return 2; };
        const a = raises(() => JSON.stringify(undefined, revoked.proxy, space), TypeError);
        let marker = {}; let caught;
        try { JSON.stringify({get toJSON() { throw marker; }}, () => { log.push('replacer'); }); } catch (e) { caught = e; }
        return out(a && log.length === 0, caught === marker,
            raises(() => JSON.stringify(revoked.proxy), TypeError),
            JSON.stringify(undefined, null, space) === undefined && log.join(',') === 'space');
    }
    if (operation === 20) {
        let inherited = false;
        const a = [1, 2];
        const text = JSON.stringify(a, function (k, v) {
            if (k === '0') { a.length = 1; Object.defineProperty(Array.prototype, '1', {value: 9, configurable: true}); inherited = true; }
            return v;
        });
        if (inherited) delete Array.prototype[1];
        return out(text === '[1,9]', a.length === 1,
            JSON.stringify({a: 1}, ['a'], NaN) === '{"a":1}',
            JSON.stringify({a: 1}, null, Infinity) === '{\n          "a": 1\n}');
    }
    if (operation === 21) {
        let saved;
        JSON.parse('{"a":0,"b":{"c":1}}', function (k, v, c) {
            if (k === 'a') { saved = this.b; this.b = {c: 1}; }
            if (k === 'c') log.push(own(c, 'source'));
            return v;
        });
        let source;
        JSON.parse('[1.0,2]', function (k, v, c) { if (k === '0') this[1] = 2; if (k === '1') source = c.source; return v; });
        return out(log.length === 1 && log[0] === false, saved.c === 1, source === '2',
            JSON.stringify(JSON.rawJSON('1e400')) === '1e400');
    }
    throw new RangeError('unknown JSON execution case');
})
