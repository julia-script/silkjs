/* Production Engine/pinned QuickJS oracle cases. Invoke the resulting function
   with operations 0..19. Each returns [1,1,1,1,log] on success; logs are asserted
   independently inside each case. Operation 19 additionally accepts a live foreign
   realm's {Number, Boolean, Symbol, BigInt}. No host mirror or fake callbacks. */
(function (operation, foreign) {
    const log = [];
    const out = (a, b, c, d) => [+!!a, +!!b, +!!c, +!!d, log];
    const raises = (f, kind) => { try { f(); return false; } catch (e) { return e instanceof kind; } };
    if (operation === 0) {
        return out(Number() === 0 && Number(undefined) !== Number(undefined),
            Object.is(Number(-0), -0), Number(9007199254740993n) === 9007199254740992,
            Number({[Symbol.toPrimitive](hint) { log.push(hint === 'number' ? 1 : 0); return 42n; }}) === 42 && log.join() === '1');
    }
    if (operation === 1) {
        const marker = {}, target = new Proxy(function () {}, {get(t, k) { if (k === 'prototype') { log.push(2); return marker; } }});
        const object = Reflect.construct(Number, [{valueOf() { log.push(1); return -0; }}], target);
        return out(Object.getPrototypeOf(object) === marker, Object.is(Number.prototype.valueOf.call(object), -0),
            log.join() === '1,2', Number.prototype.valueOf() === 0);
    }
    if (operation === 2) {
        let touched = false;
        const radix = {valueOf() { touched = true; throw 8; }};
        return out(raises(() => Number.prototype.toString.call({}, radix), TypeError) && !touched,
            raises(() => Number.prototype.valueOf.call(new Proxy(new Number(3), {})), TypeError),
            raises(() => (3).toString(1.9), RangeError), (35).toString(36.9) === 'z');
    }
    if (operation === 3) {
        return out((0.1).toString(2) === '0.0001100110011001100110011001100110011001100110011001101',
            (-0).toString() === '0', (1e21).toString() === '1e+21',
            (Number.MIN_VALUE).toString(2) === '0.' + '0'.repeat(1073) + '1');
    }
    if (operation === 4) {
        return out((1.25).toFixed(1) === '1.3' && (-1.25).toFixed(1) === '-1.3',
            (-0).toFixed(2) === '0.00' && (-0.001).toFixed(2) === '-0.00',
            (1e21).toFixed(100) === '1e+21', (2.55).toFixed(1) === '2.5' && (1).toFixed(100).length === 102);
    }
    if (operation === 5) {
        return out((123).toExponential() === '1.23e+2' && (123).toExponential(0) === '1e+2',
            (9.99).toPrecision(2) === '10' && (0.0000001).toPrecision(2) === '1.0e-7',
            (Infinity).toExponential(101) === 'Infinity' && (NaN).toPrecision(0) === 'NaN',
            raises(() => (Infinity).toFixed(101), RangeError) && raises(() => (1).toPrecision(0), RangeError));
    }
    if (operation === 6) {
        let caught;
        try { (Infinity).toExponential({valueOf() { log.push(1); throw 77; }}); } catch (e) { caught = e; }
        return out(caught === 77 && log.join() === '1', (3).toPrecision(undefined) === '3',
            raises(() => (3).toFixed(1n), TypeError),
            (31).toLocaleString({toString() { throw 99; }}) === '31');
    }
    if (operation === 7) {
        const bad = {valueOf() { throw 42; }};
        return out(!Number.isNaN('NaN') && Number.isNaN(NaN),
            !Number.isFinite(bad) && !Number.isInteger(bad) && !Number.isSafeInteger(bad),
            Number.isInteger(9007199254740992) && !Number.isSafeInteger(9007199254740992),
            Number.isInteger(-0) && Number.isSafeInteger(9007199254740991) && !Number.isInteger(Infinity));
    }
    if (operation === 8) {
        const n = parseInt({toString() { log.push(1); return '\uFEFF -0x10junk'; }}, {valueOf() { log.push(2); return 0; }});
        return out(n === -16 && log.join() === '1,2', parseInt('11', 4294967298) === 3,
            parseInt('0b11') === 0 && parseInt('Infinity', 36) === 1461559270678,
            Object.is(parseInt('-0'), -0) && Number.isNaN(parseInt('0x')) && Number.isNaN(parseInt('7', 37)));
    }
    if (operation === 9) {
        return out(parseFloat('\u2003-.125e+2junk') === -12.5 && parseFloat('12e+') === 12,
            parseFloat('0x12') === 0 && parseFloat('Infinity!') === Infinity,
            Object.is(parseFloat('-0e9'), -0) && parseFloat('4\u00005') === 4,
            Number.isNaN(parseFloat('.e1')) && parseFloat('1_2') === 1);
    }
    if (operation === 10) {
        const d = Object.getOwnPropertyDescriptor(Number, 'MAX_VALUE');
        return out(Number.parseInt === parseInt && Number.parseFloat === parseFloat,
            isNaN('x') && !isNaN('') && isFinite(null) && !Number.isFinite(null),
            raises(() => isFinite(1n), TypeError) && raises(() => isNaN(Symbol()), TypeError),
            d.value === 1.7976931348623157e308 && !d.writable && !d.enumerable && !d.configurable && Number.EPSILON === 2 ** -52);
    }
    if (operation === 11) {
        const object = {valueOf() { throw 4; }, [Symbol.toPrimitive]() { throw 5; }};
        return out(Boolean(object) && new Boolean(false).valueOf() === false,
            !Boolean(0n) && Boolean(1n) && !Boolean(NaN) && !Boolean(''),
            Boolean.prototype.valueOf() === false && Boolean.prototype.toString() === 'false',
            raises(() => Boolean.prototype.toString.call(1), TypeError) && raises(() => Boolean.prototype.valueOf.call(new Proxy(new Boolean(), {})), TypeError));
    }
    if (operation === 12) {
        const a = Symbol(), b = Symbol(''), c = Symbol('x');
        return out(a.description === undefined && b.description === '',
            a.toString() === 'Symbol()' && b.toString() === 'Symbol()' && c.toString() === 'Symbol(x)',
            c !== Symbol('x') && Object(c).valueOf() === c && Object(c)[Symbol.toPrimitive]('ignored') === c,
            raises(() => new Symbol({toString() { log.push(1); return 'x'; }}), TypeError) && log.length === 0);
    }
    if (operation === 13) {
        const symbol = Symbol.for({toString() { log.push(1); return 'scalar-registry'; }});
        return out(symbol === Symbol.for('scalar-registry') && log.join() === '1', Symbol.keyFor(symbol) === 'scalar-registry',
            Symbol.keyFor(Symbol('scalar-registry')) === undefined && Symbol.for() === Symbol.for('undefined'),
            raises(() => Symbol.keyFor(Object(symbol)), TypeError) && raises(() => Symbol(Symbol()), TypeError));
    }
    if (operation === 14) {
        const get = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get;
        const primitive = Object.getOwnPropertyDescriptor(Symbol.prototype, Symbol.toPrimitive);
        const tag = Object.getOwnPropertyDescriptor(Symbol.prototype, Symbol.toStringTag);
        return out(get.call(Object(Symbol('d'))) === 'd' && raises(() => get.call(Symbol.prototype), TypeError),
            raises(() => Symbol.prototype.valueOf.call(new Proxy(Object(Symbol()), {})), TypeError),
            !primitive.writable && primitive.configurable && !primitive.enumerable && primitive.value.length === 1,
            tag.value === 'Symbol' && !tag.writable && tag.configurable && Symbol.asyncDispose !== Symbol.dispose);
    }
    if (operation === 15) {
        return out(BigInt(' \uFEFF0x10000000000000001 ') === 18446744073709551617n && BigInt('') === 0n,
            BigInt(true) === 1n && BigInt(-0) === 0n && BigInt({valueOf() { return 42; }}) === 42n,
            raises(() => BigInt(1.5), RangeError) && raises(() => BigInt(Infinity), RangeError),
            raises(() => BigInt('-0x1'), SyntaxError) && raises(() => new BigInt({valueOf() { log.push(1); return 0; }}), TypeError) && log.length === 0);
    }
    if (operation === 16) {
        return out((18446744073709551615n).toString(16) === 'ffffffffffffffff' && (-35n).toString(36) === '-z',
            (255n).toLocaleString(16) === 'ff', Object(7n).valueOf() === 7n,
            raises(() => BigInt.prototype.valueOf.call(BigInt.prototype), TypeError) && raises(() => BigInt.prototype.toString.call(3), TypeError)
            && raises(() => (1n).toString(37), RangeError) && raises(() => (1n).toString(2n), TypeError));
    }
    if (operation === 17) {
        return out(BigInt.asUintN(32, -1n) === 4294967295n && BigInt.asUintN(33, -1n) === 8589934591n,
            BigInt.asIntN(32, 2147483648n) === -2147483648n && BigInt.asIntN(65, 18446744073709551616n) === -18446744073709551616n,
            BigInt.asUintN(64, -18446744073709551617n) === 18446744073709551615n,
            BigInt.asIntN(9007199254740991, -7n) === -7n && BigInt.asUintN(9007199254740991, 7n) === 7n);
    }
    if (operation === 18) {
        const result = BigInt.asIntN({valueOf() { log.push(1); return 0; }}, {valueOf() { log.push(2); return 123n; }});
        return out(result === 0n && log.join() === '1,2', raises(() => BigInt.asUintN(0, 1), TypeError),
            raises(() => BigInt.asUintN(-1, {valueOf() { log.push(3); return 1n; }}), RangeError) && log.join() === '1,2',
            BigInt.asIntN(3.9, 7n) === -1n && raises(() => BigInt.asUintN(9007199254740991, -1n), RangeError));
    }
    if (operation === 19) {
        const N = foreign.Number, B = foreign.Boolean;
        return out(Number.prototype.valueOf.call(new N(7)) === 7 && B.prototype.valueOf.call(new Boolean(true)) === true,
            foreign.Symbol.for('shared-scalar-key') === Symbol.for('shared-scalar-key'),
            foreign.BigInt.prototype.valueOf.call(Object(123n)) === 123n,
            raises(() => Symbol.prototype.valueOf.call(foreign.Symbol.prototype), TypeError));
    }
    throw new RangeError('unknown scalar intrinsic case');
})
