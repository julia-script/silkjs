/* Production Engine / pinned QuickJS execution cases, operations 0..18.
   Use the existing js_async_execution_consumers case/fault contract with this
   source, never a host mirror. Every clean case returns [1,1,1,1,log]. Compare
   all 40 observations against pinned quickjs.c (commit 7d1c13c5), and require
   independent zero-byte/block ledgers. Sweep allocation cutoffs separately for
   each runtime, including abrupt list extraction, key conversion and proxy calls.
   Expected logs: 0:[1,2,3,4], 1:[1,2,3], 2:[1,2], 3:[1,2,1,2],
   4:[1,2,3,4], 5:[1,1,1], 6:[1,2], 7:[], 8:[1,2,3,4,5,6,7],
   9:[1,2], 10:[], 11:[1], 12:[1,2], 13:[1,2], 14:[], 15:[],
   16:[1,2,3,4], 17:[1,2,3,4], 18:[1,2].
   Source-specific: construct validates explicit newTarget before list extraction,
   but validates target only after extraction (52820-52834); unlike current
   ECMAScript prose, a nonconstructor target can therefore run list getters. */
(function (operation) {
    const log = [];
    const out = (a, b, c, d) => [+!!a, +!!b, +!!c, +!!d, log];
    const raises = (f, kind) => { try { f(); return false; } catch (e) { return e instanceof kind; } };
    const catches = f => { try { f(); } catch (e) { return e; } };
    if (operation === 0) {
        const receiver = {x: 30};
        const args = {get length() { log.push(1); return 2; },
            get 0() { log.push(2); return 5; }, get 1() { log.push(3); return 7; }};
        const result = Reflect.apply(function (a, b) { 'use strict'; log.push(4); return this.x + a + b; }, receiver, args);
        let touched = false;
        const bad = {get length() { touched = true; throw 99; }};
        return out(result === 42, raises(() => Reflect.apply({}, null, bad), TypeError) && !touched,
            raises(() => Reflect.apply(function () {}, null, null), TypeError),
            Reflect.apply(function () { 'use strict'; return this; }, undefined, []) === undefined);
    }
    if (operation === 1) {
        const marker = {};
        const args = {get length() { log.push(1); return {valueOf() { log.push(2); return 2; }}; },
            get 0() { log.push(3); throw marker; }, get 1() { throw 99; },
            [Symbol.iterator]() { throw 98; }};
        const error = catches(() => Reflect.apply(() => { throw 97; }, null, args));
        return out(error === marker, log.join() === '1,2,3',
            Reflect.apply((a, b) => a === undefined && b === 8, null, {length: 2, 1: 8}),
            Reflect.apply(() => 42, null, {length: -1}) === 42);
    }
    if (operation === 2) {
        function C(value) { log.push(2); this.value = value; this.target = new.target; }
        const args = {get length() { log.push(1); return 1; }, 0: 42};
        const value = Reflect.construct(C, args);
        let touched = false;
        const bad = {get length() { touched = true; throw 99; }};
        return out(value.value === 42 && value.target === C && value instanceof C,
            raises(() => Reflect.construct(C, bad, undefined), TypeError) && !touched,
            raises(() => Reflect.construct(C, bad, () => {}), TypeError) && !touched,
            raises(() => Reflect.construct(C, null), TypeError));
    }
    if (operation === 3) {
        const args = {get length() { log.push(1); return 1; }, get 0() { log.push(2); return 42; }};
        const first = raises(() => Reflect.construct({}, args), TypeError);
        const second = raises(() => Reflect.construct({}, args, function () {}), TypeError);
        const marker = {};
        const caught = catches(() => Reflect.construct({}, {get length() { throw marker; }}));
        return out(first, second, log.join() === '1,2,1,2', caught === marker);
    }
    if (operation === 4) {
        const prototype = {};
        function N() {}
        const newTarget = new Proxy(N, {get(t, k, r) {
            if (k === 'prototype') { log.push(3); return prototype; }
            return Reflect.get(t, k, r);
        }});
        function C(value) { log.push(4); this.value = value; this.target = new.target; }
        const args = {get length() { log.push(1); return 1; }, get 0() { log.push(2); return 42; }};
        const value = Reflect.construct(C, args, newTarget);
        return out(value.value === 42, value.target === newTarget,
            Object.getPrototypeOf(value) === prototype, log.join() === '1,2,3,4');
    }
    if (operation === 5) {
        const target = {get x() { 'use strict'; log.push(1); return this; }};
        const receiver = {};
        return out(Reflect.get(target, 'x') === target, Reflect.get(target, 'x', receiver) === receiver,
            Reflect.get(target, 'x', undefined) === undefined,
            Reflect.get(Object.create({x: 42}), 'x') === 42 && Reflect.get(target, 'missing') === undefined);
    }
    if (operation === 6) {
        const target = {x: 1}, receiver = {};
        const success = Reflect.set(target, 'x', 42, receiver);
        const setter = {set x(v) { 'use strict'; log.push(this === undefined ? 1 : 9); log.push(v); }};
        const setterSuccess = Reflect.set(setter, 'x', 2, undefined);
        const frozen = Object.freeze({x: 1});
        return out(success && receiver.x === 42 && target.x === 1,
            setterSuccess && log.join() === '1,2', !Reflect.set(target, 'x', 9, undefined),
            !Reflect.set(frozen, 'x', 2) && !Reflect.set({get x() { return 1; }}, 'x', 2));
    }
    if (operation === 7) {
        const key = {[Symbol.toPrimitive]() { log.push(9); throw 99; }};
        const methods = ['defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'has', 'set'];
        const first = methods.every(name => raises(() => Reflect[name](1, key, {}), TypeError));
        const second = ['getPrototypeOf', 'isExtensible', 'ownKeys', 'preventExtensions'].every(name =>
            raises(() => Reflect[name](1), TypeError));
        return out(first, second, raises(() => Reflect.setPrototypeOf(1, null), TypeError), log.length === 0);
    }
    if (operation === 8) {
        const target = {};
        const key = {[Symbol.toPrimitive](hint) { log.push(hint === 'string' ? 1 : 9); return 'x'; }};
        const desc = {get enumerable() { log.push(2); return true; }, get configurable() { log.push(3); return true; },
            get value() { log.push(4); return 42; }, get writable() { log.push(5); return true; }};
        const defined = Reflect.defineProperty(target, key, desc);
        const fixed = Object.freeze({x: 1});
        const rejected = Reflect.defineProperty(fixed, {toString() { log.push(6); return 'x'; }},
            {get value() { log.push(7); return 2; }});
        return out(defined && target.x === 42, !rejected && fixed.x === 1,
            raises(() => Reflect.defineProperty({}, 'x', 1), TypeError),
            raises(() => Reflect.defineProperty({}, 'x', {get() {}, value: 1}), TypeError));
    }
    if (operation === 9) {
        const getter = function () { throw 99; };
        const target = Object.create({inherited: 1});
        Object.defineProperty(target, 'x', {get: getter, configurable: true});
        const proxy = new Proxy(target, {getOwnPropertyDescriptor(t, k) { log.push(2); return Object.getOwnPropertyDescriptor(t, k); }});
        const desc = Reflect.getOwnPropertyDescriptor(proxy, {toString() { log.push(1); return 'x'; }});
        return out(desc.get === getter && desc.set === undefined,
            desc.configurable && !desc.enumerable && !('value' in desc),
            Reflect.getOwnPropertyDescriptor(target, 'inherited') === undefined,
            log.join() === '1,2');
    }
    if (operation === 10) {
        const symbol = Symbol('key'), target = {z: 1, 10: 2, 2: 3};
        Object.defineProperty(target, 'hidden', {get() { throw 99; }});
        target[symbol] = 4;
        const keys = Reflect.ownKeys(target);
        return out(keys.length === 5 && keys.slice(0, 4).join() === '2,10,z,hidden',
            keys[4] === symbol, Reflect.ownKeys([7]).join() === '0,length',
            Reflect.ownKeys(Object.create({inherited: 1})).length === 0);
    }
    if (operation === 11) {
        const symbol = Symbol(), target = {a: 1};
        const proxy = new Proxy(target, {ownKeys() { log.push(1); return [symbol, 'b', 'a']; },
            getOwnPropertyDescriptor() { throw 99; }});
        const keys = Reflect.ownKeys(proxy);
        const duplicate = new Proxy({}, {ownKeys() { return ['x', 'x']; }});
        const missing = new Proxy(Object.freeze({x: 1}), {ownKeys() { return []; }});
        return out(keys.length === 3 && keys[0] === symbol && keys[1] === 'b' && keys[2] === 'a',
            raises(() => Reflect.ownKeys(duplicate), TypeError), raises(() => Reflect.ownKeys(missing), TypeError),
            raises(() => Reflect.ownKeys(new Proxy({}, {ownKeys() { return [1]; }})), TypeError));
    }
    if (operation === 12) {
        const target = Object.create({get x() { throw 99; }});
        const proxy = new Proxy(target, {has(t, k) { log.push(2); return k === 'x'; }});
        const found = Reflect.has(proxy, {[Symbol.toPrimitive]() { log.push(1); return 'x'; }});
        const liar = new Proxy(Object.freeze({x: 1}), {has() { return false; }});
        return out(found, Reflect.has(target, 'x') && !Reflect.has(target, 'y'),
            raises(() => Reflect.has(liar, 'x'), TypeError), log.join() === '1,2');
    }
    if (operation === 13) {
        const target = {x: 1};
        const proxy = new Proxy(target, {deleteProperty(t, k) { log.push(2); return false; }});
        const failed = Reflect.deleteProperty(proxy, {toString() { log.push(1); return 'x'; }});
        const fixed = Object.freeze({x: 1});
        const marker = {};
        return out(!failed && target.x === 1, !Reflect.deleteProperty(fixed, 'x') && Reflect.deleteProperty(fixed, 'absent'),
            Reflect.deleteProperty(target, 'x') && !('x' in target),
            catches(() => Reflect.deleteProperty(target, {toString() { throw marker; }})) === marker);
    }
    if (operation === 14) {
        const target = {}, prototype = {};
        const set = Reflect.setPrototypeOf(target, prototype);
        const cycle = Reflect.setPrototypeOf(prototype, target);
        Object.preventExtensions(target);
        const refused = new Proxy({}, {setPrototypeOf() { return false; }});
        return out(set && Reflect.getPrototypeOf(target) === prototype,
            !cycle && Reflect.getPrototypeOf(prototype) === Object.prototype,
            Reflect.setPrototypeOf(target, prototype) && !Reflect.setPrototypeOf(target, null) && !Reflect.setPrototypeOf(refused, null),
            raises(() => Reflect.setPrototypeOf({}, 1), TypeError));
    }
    if (operation === 15) {
        const target = {};
        const before = Reflect.isExtensible(target), prevented = Reflect.preventExtensions(target);
        const refusal = new Proxy({}, {preventExtensions() { return false; }});
        const lie = new Proxy({}, {preventExtensions() { return true; }});
        const lieExtensible = new Proxy({}, {isExtensible() { return false; }});
        return out(before && prevented && !Reflect.isExtensible(target) && Reflect.preventExtensions(target),
            !Reflect.preventExtensions(refusal), raises(() => Reflect.preventExtensions(lie), TypeError),
            raises(() => Reflect.isExtensible(lieExtensible), TypeError));
    }
    if (operation === 16) {
        const receiver = {}, target = {};
        const proxy = new Proxy(target, {
            get(t, k, r) { log.push(2); return r; },
            set(t, k, v, r) { log.push(r === receiver && v === 42 ? 4 : 9); return false; }
        });
        const got = Reflect.get(proxy, {toString() { log.push(1); return 'x'; }}, receiver);
        const set = Reflect.set(proxy, {toString() { log.push(3); return 'x'; }}, 42, receiver);
        const frozen = Object.freeze({x: 1});
        return out(got === receiver && !set, log.join() === '1,2,3,4',
            raises(() => Reflect.get(new Proxy(frozen, {get() { return 2; }}), 'x'), TypeError),
            raises(() => Reflect.set(new Proxy(frozen, {set() { return true; }}), 'x', 2), TypeError));
    }
    if (operation === 17) {
        let owner = {value: 42};
        const args = {length: 2, get 0() { log.push(1); return owner; },
            get 1() { log.push(2); owner = null; return 7; }};
        const result = Reflect.apply((a, b) => ({a, b}), null, args);
        const marker = {};
        const failed = {length: 2, get 0() { log.push(3); return {temporary: true}; },
            get 1() { log.push(4); throw marker; }};
        const error = catches(() => Reflect.construct(function () { throw 99; }, failed));
        return out(result.a.value === 42 && result.b === 7, owner === null,
            error === marker, log.join() === '1,2,3,4');
    }
    if (operation === 18) {
        function C(a, b) { this.sum = a + b; this.target = new.target; }
        const B = C.bind(null, 10);
        const bound = Reflect.construct(B, [32]);
        const result = {};
        const proxy = new Proxy(C, {construct(t, args, n) {
            log.push(args[0]); log.push(n === proxy ? 2 : 9); return result;
        }});
        const constructed = Reflect.construct(proxy, [1]);
        const revoked = Proxy.revocable(C, {}); revoked.revoke();
        const marker = {};
        return out(bound.sum === 42 && bound.target === C && bound instanceof C,
            constructed === result, raises(() => Reflect.construct(revoked.proxy, []), TypeError),
            catches(() => Reflect.construct(revoked.proxy, {get length() { throw marker; }})) === marker);
    }
    throw new RangeError('unknown Reflect execution scenario');
})
