(function (scenario) {
    const log = [];
    let a, b, c, d;
    switch (scenario) {
    case 0: {
        function* make(x, y) { log.push(arguments.length, x); yield y; return 33; }
        const g = make(11, 22, 44);
        log.push(100);
        a = g.next(99); b = g.next(55); c = g.next(); d = g.return(66);
        break;
    }
    case 1: {
        function* make() { log.push(99); yield 1; }
        const g = make();
        a = g.return(7); b = g.next();
        try { g.throw(9); } catch (e) { c = e; }
        d = make().return(8);
        break;
    }
    case 2: {
        function* make() {
            try { return yield 11; }
            catch (e) { yield e; }
            finally { log.push(8); yield 77; }
        }
        const g = make();
        a = g.next(); b = g.throw(22); c = g.return(33); d = g.next();
        break;
    }
    case 3: {
        let g;
        function* make() {
            try { g.next(); } catch (e) { log.push(e instanceof TypeError ? 1 : 99); }
            yield 5;
        }
        g = make(); a = g.next(); b = g.next();
        break;
    }
    case 4: {
        const iterator = {
            [Symbol.iterator]() { log.push(1); return this; },
            next(v) { log.push(v === undefined ? 0 : v); return {value: 11, done: false}; },
            return(v) { log.push(2, v); return {value: v, done: false}; },
            throw(v) { log.push(3, v); return {value: v, done: false}; }
        };
        const g = (function* () { return yield* iterator; })();
        a = g.next(); b = g.throw(22); c = g.return(33); d = g.next(44);
        break;
    }
    case 5: {
        let read;
        const g = (function* () { let n = 10; read = () => ++n; yield 1; n += 10; return n; })();
        a = g.next(); b = read(); c = g.next(); d = read();
        break;
    }
    case 6: {
        function* make(x = (() => { log.push(1); throw 55; })()) { log.push(99); yield x; }
        try { make(); } catch (e) { a = e; }
        b = make(7).next();
        break;
    }
    case 7: {
        a = (async function () { log.push(1); return 41; })();
        b = (async function () { log.push(2); throw 42; })();
        c = a.then(v => { log.push(4); return v + 2; });
        d = (async function (x) { return this.x + x + arguments.length; }).call({x: 5}, 6, 7);
        log.push(3);
        break;
    }
    case 8: {
        a = (async function () {
            log.push(1); const x = await 11; log.push(2);
            const y = await Promise.resolve(22); log.push(4); return x + y;
        })();
        log.push(3);
        break;
    }
    case 9: {
        a = (async function () {
            try { await Promise.reject(66); }
            catch (e) { log.push(e); return 77; }
            finally { log.push(88); }
        })();
        break;
    }
    case 10: {
        const thenable = { get then() {
            log.push(1);
            return function (resolve, reject) { log.push(3); resolve(21); reject(22); throw 23; };
        }};
        a = (async function () { const value = await thenable; log.push(4); return value + 1; })();
        log.push(2);
        break;
    }
    case 11: {
        let read;
        a = (async function () { let x = 3; read = () => ++x; await 0; x += 10; return x; })();
        b = read(); c = a.then(() => read());
        break;
    }
    case 12: {
        const g = (async function* () { log.push(1); yield 10; log.push(2); await 0; yield 20; log.push(3); return 30; })();
        a = g.next(); b = g.next(); c = g.next(); d = g.next();
        break;
    }
    case 13: {
        const g = (async function* () {
            try { return yield 11; }
            catch (e) { yield e; }
            finally { log.push(8); yield 77; }
        })();
        a = g.next(); b = g.throw(22); c = g.return(33); d = g.next();
        break;
    }
    case 14: {
        const g = (async function* () { try { await Promise.reject(66); } catch (e) { yield e; } return 77; })();
        a = g.next(); b = g.next();
        break;
    }
    case 15: {
        // Source defect: completed-return continuation does not drain the queued tail.
        const g = (async function* () { log.push(99); })();
        a = g.return(Promise.resolve(7)); b = g.next(); c = g.throw(9);
        break;
    }
    case 16: {
        const poison = Promise.resolve(1);
        Object.defineProperty(poison, 'constructor', {get() { log.push(2); throw 77; }});
        const g = (async function* () {})();
        a = g.return(poison); b = g.next();
        break;
    }
    case 17: {
        const next = (function* () {})().next;
        try { next.call({}); } catch (e) { a = e instanceof TypeError ? 1 : 99; }
        const asyncNext = (async function* () {})().next;
        b = asyncNext.call({});
        c = b.catch(e => e instanceof TypeError ? 2 : 99);
        break;
    }
    case 18: {
        // Source defect: COMPLETED handles only one already-queued next request.
        const g = (async function* () { await 0; return 10; })();
        a = g.next(); b = g.next(); c = g.next(); d = g.next();
        break;
    }
    case 19: {
        let g, nested;
        g = (async function* () { nested = g.next(); log.push(1); yield 11; return 22; })();
        a = g.next(); b = nested;
        break;
    }
    case 20: {
        const g = (async function* () { const value = yield* [11, 22]; log.push(value === undefined ? 0 : value); return 33; })();
        a = g.next(); b = g.next(); c = g.next();
        break;
    }
    case 21: {
        const poison = Promise.resolve(1);
        Object.defineProperty(poison, 'constructor', {get() { log.push(1); throw 77; }});
        a = (async function () { try { await poison; } catch (e) { log.push(99); return e; } })();
        break;
    }
    case 22: {
        function* make(x, y) { yield this.x + x; return arguments.length; }
        const g = make.call({x: 2}, 5);
        a = g.next(); b = g.next();
        break;
    }
    case 23: {
        const holder = {};
        function* make() { const x = holder; x.read = () => x; yield 1; }
        holder.g = make(); b = holder.g.next(); a = holder.g;
        break;
    }
    case 24: {
        const iterator = {
            [Symbol.asyncIterator]() { log.push(1); return this; },
            next(v) { log.push(v === undefined ? 0 : v); return Promise.resolve({value: 11, done: false}); },
            return(v) { log.push(2, v); return Promise.resolve({value: v, done: false}); },
            throw(v) { log.push(3, v); return Promise.resolve({value: v, done: false}); }
        };
        const g = (async function* () { return yield* iterator; })();
        a = g.next(); b = g.throw(22); c = g.return(33); d = g.next(44);
        break;
    }
    case 25: {
        const iterator = {
            [Symbol.asyncIterator]() { return this; },
            next() { return {value: 1, done: false}; },
            return() { log.push(7); return {value: 0, done: true}; }
        };
        const g = (async function* () { yield* iterator; })();
        a = g.next(); b = g.throw(22);
        break;
    }
    case 26: {
        const wait = new Promise(() => {});
        const g = (async function* () { await wait; yield 1; })();
        a = g; b = g.next(g); c = g.next(g);
        break;
    }
    case 27: {
        const holder = {}, wait = new Promise(() => {});
        a = (async function () { const x = holder; holder.read = () => x; await wait; return x; })();
        b = holder;
        break;
    }
    case 28: {
        const thenable = {get then() { log.push(1); return resolve => { log.push(3); resolve(7); }; }};
        const g = (async function* () {})();
        a = g.return(thenable); log.push(2); b = g.next();
        break;
    }
    default: throw new Error('unknown async execution scenario');
    }
    return [a, b, c, d, log];
})
