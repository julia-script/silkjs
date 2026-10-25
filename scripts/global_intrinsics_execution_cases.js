/* Production Engine/pinned QuickJS cases: invoke with operations 0..7.
   Every operation returns [1,1,1,1]. Expected literals are independent UTF-8 /
   UTF-16 goldens, not results computed by the codec under test. Allocation-fault
   integration should also cover a long ASCII prefix followed by a lone surrogate
   (encode) or malformed percent sequence (decode): URIError replaces sticky OOM. */
(function (operation) {
    const out = (a, b, c, d) => [+!!a, +!!b, +!!c, +!!d];
    const raises = (fn, kind) => { try { fn(); return false; } catch (e) { return e instanceof kind; } };
    if (operation === 0) {
        return out(decodeURI('%3b%2f%3f%3a%40%26%3d%2b%24%2c%23') === '%3b%2f%3f%3a%40%26%3d%2b%24%2c%23',
            decodeURIComponent('%3b%2f%3f%3a%40%26%3d%2b%24%2c%23') === ';/?:@&=+$,#',
            decodeURI('%25%41%00%20') === '%A\0 ', decodeURIComponent('a+b') === 'a+b');
    }
    if (operation === 1) {
        return out(encodeURI(";/?:@&=+$,#-_.!~*'()") === ";/?:@&=+$,#-_.!~*'()",
            encodeURIComponent(';/?:@&=+$,#') === '%3B%2F%3F%3A%40%26%3D%2B%24%2C%23',
            encodeURI(' %[]\\') === '%20%25%5B%5D%5C', encodeURIComponent("-_.!~*'()") === "-_.!~*'()");
    }
    if (operation === 2) {
        return out(encodeURIComponent('\x7f\x80\u07ff\u0800\uffff\ud800\udc00\udbff\udfff') === '%7F%C2%80%DF%BF%E0%A0%80%EF%BF%BF%F0%90%80%80%F4%8F%BF%BF',
            decodeURIComponent('%7f%c2%80%df%bf%e0%a0%80%ef%bf%bf%f0%90%80%80%f4%8f%bf%bf') === '\x7f\x80\u07ff\u0800\uffff\ud800\udc00\udbff\udfff',
            decodeURI('\ud800x\udfff') === '\ud800x\udfff', decodeURIComponent('%EF%BB%BF') === '\ufeff');
    }
    if (operation === 3) {
        const malformed = ['%', '%0', '%GG', '%80', '%BF', '%C0%80', '%C1%BF', '%E0%80%80', '%ED%A0%80', '%ED%BF%BF', '%F0%80%80%80', '%F4%90%80%80', '%F5%80%80%80', '%F8%80%80%80', '%FF', '%C2', '%C2x', '%C2%41', '%E1%80', '%F1%80%80'];
        return out(malformed.every(s => raises(() => decodeURI(s), URIError)),
            malformed.every(s => raises(() => decodeURIComponent(s), URIError)),
            raises(() => encodeURI('\udc00'), URIError) && raises(() => encodeURIComponent('\ud800'), URIError),
            raises(() => encodeURI('\ud800a'), URIError) && raises(() => encodeURIComponent('\ud800\ud800'), URIError));
    }
    if (operation === 4) {
        return out(escape('@*_+-./ AZaz09') === '@*_+-./%20AZaz09',
            escape("!~'()\0\xff\u0100\ud83d\ude00") === '%21%7E%27%28%29%00%FF%u0100%uD83D%uDE00',
            unescape('%uD800%udfff%00%FF') === '\ud800\udfff\0\xff',
            unescape('%u0041%41%u00e9') === 'AA\xe9');
    }
    if (operation === 5) {
        return out(unescape('%u123%U0041%uGGGG%G0%0%') === '%u123%U0041%uGGGG%G0%0%',
            unescape('%C3%A9') === '\xc3\xa9', unescape('%25u0041') === '%u0041',
            unescape('%u0041F%41F') === 'AFAF');
    }
    if (operation === 6) {
        let log = [], caught;
        const source = {[Symbol.toPrimitive](hint) { log.push(hint); return '\xe9'; }};
        const encoded = encodeURI(source);
        try { decodeURI({toString() { throw 77; }}); } catch (e) { caught = e; }
        return out(encoded === '%C3%A9' && log.join() === 'string', caught === 77,
            [decodeURI, decodeURIComponent, encodeURI, encodeURIComponent, escape, unescape].every(f => f() === 'undefined' && f(null) === 'null'),
            [decodeURI, decodeURIComponent, encodeURI, encodeURIComponent, escape, unescape].every(f => raises(() => f(Symbol()), TypeError)));
    }
    if (operation === 7) {
        const funcs = ['decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape'];
        return out(funcs.every(n => { const d = Object.getOwnPropertyDescriptor(globalThis, n); return d.writable && d.configurable && !d.enumerable && d.value.length === 1; }),
            ['Infinity', 'NaN', 'undefined'].every(n => { const d = Object.getOwnPropertyDescriptor(globalThis, n); return !d.writable && !d.configurable && !d.enumerable; }),
            parseInt === Number.parseInt && parseFloat === Number.parseFloat,
            encodeURI.call(null, 'a b') === 'a%20b' && decodeURI.call(42, '%41') === 'A');
    }
    throw new RangeError('unknown global intrinsic case');
})
