/* Evaluate with the production Engine. Cases 0..18 return four independent
   boolean observations and an order log, matching async_execution_consumers.
   Case 19 additionally takes constructors transferred from a second live realm. */
(function (operation, foreign) {
    const log = [];
    const yes = x => +!!x;
    const out = (a, b, c, d) => [yes(a), yes(b), yes(c), yes(d), log];
    const raises = (f, kind) => { try { f(); return false; } catch (e) { return e instanceof kind; } };
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const data = (o, k, v) => {
        const d = Object.getOwnPropertyDescriptor(o, k);
        return !!d && d.value === v && d.writable && !d.enumerable && d.configurable;
    };
    if (operation === 0) {
        const f = Function('a', 'b', 'return a+b');
        return out(f(12, 30) === 42, f.name === 'anonymous' && f.length === 2,
            Function.prototype() === undefined, Object.getPrototypeOf(f) === Function.prototype);
    }
    if (operation === 1) {
        function text(n, s) { return {toString() { log.push(n); return s; }}; }
        const f = Function(text(1, 'a'), text(2, 'b'), text(3, 'return a*b'));
        let local = 55;
        const g = Function('return typeof local');
        return out(f(6, 7) === 42, log.join(',') === '1,2,3', g() === 'undefined',
            f.toString() === 'function anonymous(a,b\n) {\nreturn a*b\n}');
    }
    if (operation === 2) {
        let touched = false;
        const a = {toString() { throw 42; }}, b = {toString() { touched = true; return ''; }};
        let caught; try { Function(a, b); } catch (e) { caught = e; }
        return out(caught === 42, !touched, raises(() => Function(Symbol()), TypeError),
            raises(() => Function('a', 'return )'), SyntaxError));
    }
    if (operation === 3) {
        function C() {}
        const prototype = {};
        const target = new Proxy(C, {get(t, k, r) { if (k === 'prototype') { log.push(2); return prototype; } return Reflect.get(t, k, r); }});
        const f = Reflect.construct(Function, [{toString() { log.push(1); return 'return 9'; }}], target);
        return out(f() === 9, Object.getPrototypeOf(f) === prototype, log.join(',') === '1,2', f.name === 'anonymous');
    }
    if (operation === 4) {
        const target = new Proxy(function () {}, {get() { log.push(9); throw 99; }});
        return out(raises(() => Reflect.construct(Function, ['return )'], target), SyntaxError),
            log.length === 0, raises(() => Function.prototype.toString.call({}), TypeError),
            Function.prototype.toString.call(Function).indexOf('[native code]') >= 0);
    }
    if (operation === 5) {
        const G = (function* () {}).constructor;
        const A = (async function () {}).constructor;
        const AG = (async function* () {}).constructor;
        const g = G('x', 'yield x; return 8'), a = A('return 7'), ag = AG('yield 9');
        return out(g(4).next().value === 4 && Object.getPrototypeOf(g) === G.prototype,
            Object.getPrototypeOf(a) === A.prototype && a() instanceof Promise,
            Object.getPrototypeOf(ag) === AG.prototype && ag().next() instanceof Promise,
            g.toString().startsWith('function* anonymous(') && a.toString().startsWith('async function anonymous('));
    }
    if (operation === 6) {
        function f(a, b) { return this.x + a + b; }
        const receiver = {x: 3};
        const args = {get length() { log.push(1); return 2; }, get 0() { log.push(2); return 4; }, get 1() { log.push(3); return 5; }};
        return out(f.call(receiver, 4, 5) === 12, f.apply(receiver, args) === 12,
            log.join(',') === '1,2,3', raises(() => f.apply(receiver, 5), TypeError));
    }
    if (operation === 7) {
        function C(a, b) { this.sum = a + b; }
        const B = C.bind({sum: 0}, 10), object = new B(32);
        return out(object.sum === 42 && object instanceof C && object instanceof B,
            B.name === 'bound C' && B.length === 1 && !own(B, 'prototype'),
            Function.prototype[Symbol.hasInstance].call(C, object),
            !Function.prototype[Symbol.hasInstance].call({}, object));
    }
    if (operation === 8) {
        const f = Function('return 1');
        const file = Object.getOwnPropertyDescriptor(Function.prototype, 'fileName').get;
        const line = Object.getOwnPropertyDescriptor(Function.prototype, 'lineNumber').get;
        const column = Object.getOwnPropertyDescriptor(Function.prototype, 'columnNumber').get;
        return out(file.call(f) === '<input>', line.call(f) === 1 && column.call(f) === 2,
            file.call(Function) === undefined && line.call({}) === undefined && column.call(null) === undefined,
            f.fileName === '<input>' && f.lineNumber === 1 && f.columnNumber === 2);
    }
    if (operation === 9) {
        const get = Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get;
        const set = Object.getOwnPropertyDescriptor(Function.prototype, 'arguments').set;
        const sloppy = Function('return 1'), strict = Function('"use strict"; return 1');
        return out(get.call(sloppy) === undefined, raises(() => get.call(strict), TypeError),
            raises(() => get.call(() => 0), TypeError), raises(() => set.call(sloppy, 1), TypeError));
    }
    if (operation === 10) {
        const cause = {}, e = Error('bad', {cause});
        return out(e instanceof Error && Error.isError(e), e.toString() === 'Error: bad',
            data(e, 'message', 'bad') && data(e, 'cause', cause), typeof e.stack === 'string' && !own(Error(), 'message'));
    }
    if (operation === 11) {
        const kinds = [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, InternalError];
        let valid = true;
        for (const C of kinds) {
            const e = C('x');
            valid = valid && e instanceof C && e instanceof Error && Error.isError(e) && e.toString() === C.name + ': x';
        }
        return out(valid, !Error.isError(Object.create(Error.prototype)), !Error.isError(new Proxy(new Error(), {})),
            !Error.isError(null) && !Error.isError({}));
    }
    if (operation === 12) {
        const options = new Proxy({}, {has(t, k) { log.push(2); return true; }, get(t, k) { log.push(3); return 9; }});
        const e = Error({toString() { log.push(1); return 'm'; }}, options);
        return out(log.join(',') === '1,2,3', e.cause === 9, data(e, 'message', 'm'),
            data(e, 'cause', 9));
    }
    if (operation === 13) {
        const marker = {}, target = new Proxy(function () {}, {get(t, k) { if (k === 'prototype') { log.push(1); return marker; } }});
        const e = Reflect.construct(TypeError, [{toString() { log.push(2); return 'm'; }}], target);
        return out(Object.getPrototypeOf(e) === marker, Error.isError(e), log.join(',') === '1,2', data(e, 'message', 'm'));
    }
    if (operation === 14) {
        const input = {get [Symbol.iterator]() { log.push(4); return function () { log.push(5); let n = 0; return {
            get next() { log.push(6); return function () { log.push(7); return n++ ? {done: true} : {value: 42, done: false}; }; }
        }; }; }};
        const e = AggregateError(input, {toString() { log.push(1); return 'many'; }},
            new Proxy({}, {has() { log.push(2); return true; }, get() { log.push(3); return 8; }}));
        return out(e instanceof AggregateError && Error.isError(e), e.errors.length === 1 && e.errors[0] === 42,
            e.message === 'many' && e.cause === 8, log.join(',') === '1,2,3,4,5,6,7,7');
    }
    if (operation === 15) {
        let caught, closes = 0;
        const input = {[Symbol.iterator]() { return {next() { throw 42; }, return() { closes++; throw 99; }}; }};
        try { AggregateError(input); } catch (e) { caught = e; }
        let nextGetterCaught;
        const getterFails = {[Symbol.iterator]() { return {get next() { throw 43; }, return() { closes++; return {}; }}; }};
        try { AggregateError(getterFails); } catch (e) { nextGetterCaught = e; }
        return out(caught === 42, closes === 1, nextGetterCaught === 43, raises(() => AggregateError(null), TypeError));
    }
    if (operation === 16) {
        const first = {}, second = {}, e = SuppressedError(first, second, 'both', {cause: 17});
        const d = Object.getOwnPropertyDescriptor(e, 'error');
        return out(e instanceof SuppressedError && Error.isError(e), data(e, 'error', first) && data(e, 'suppressed', second),
            data(e, 'cause', 17) && data(e, 'message', 'both'), e.toString() === 'SuppressedError: both' && SuppressedError.length === 3);
    }
    if (operation === 17) {
        const receiver = {get name() { log.push(1); return {toString() { log.push(2); return 'N'; }}; },
            get message() { log.push(3); return {toString() { log.push(4); return 'M'; }}; }};
        const str = Error.prototype.toString.call(receiver);
        return out(str === 'N: M' && log.join(',') === '1,2,3,4',
            Error.prototype.toString.call({name: '', message: 'm'}) === 'm',
            Error.prototype.toString.call({name: 'n', message: ''}) === 'n',
            Error.prototype.toString.call({}) === 'Error');
    }
    if (operation === 18) {
        let touched = false;
        const receiver = {name: Symbol(), get message() { touched = true; return 'm'; }};
        const revoked = Proxy.revocable(new Error(), {}); revoked.revoke();
        return out(raises(() => Error.prototype.toString.call(receiver), TypeError), !touched,
            raises(() => Error.prototype.toString.call(null), TypeError), !Error.isError(revoked.proxy));
    }
    if (operation === 19) {
        // foreign is populated by transferring constructors from a second actual
        // Engine context; no prototype emulation or alternate evaluator qualifies.
        const target = new Proxy(foreign.Function.bind(null), {get(t, k, r) { return k === 'prototype' ? 0 : Reflect.get(t, k, r); }});
        const f = Reflect.construct(Function, ['return 42'], target);
        const errorTarget = new Proxy(foreign.TypeError.bind(null), {get(t, k, r) { return k === 'prototype' ? null : Reflect.get(t, k, r); }});
        const e = Reflect.construct(TypeError, ['x'], errorTarget);
        return out(f() === 42, Object.getPrototypeOf(f) === foreign.Function.prototype,
            Object.getPrototypeOf(e) === foreign.TypeError.prototype, Error.isError(e) && foreign.Error.isError(e));
    }
    throw new RangeError('unknown Function/Error execution scenario');
})
