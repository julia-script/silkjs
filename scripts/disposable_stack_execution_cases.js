/* Production Engine cases 0..25: return [a,b,c,d,log]. Each a..d is 1 or a
   genuine Promise that must fulfill with 1 after draining native jobs. Expected
   logs are stated independently per case. Case 26 takes real foreign constructors.
   Run the same function against pinned QuickJS as the differential oracle;
   allocation-failure sweeps belong to the native Engine harness, not JS mocks. */
(function (operation, foreign) {
    'use strict';
    const log = [];
    const yes = value => +!!value;
    const out = (a, b, c, d) => [a, b, c, d, log];
    const raises = (f, C) => { try { f(); return false; } catch (e) { return e instanceof C; } };
    const data = (o, k, v) => {
        const d = Object.getOwnPropertyDescriptor(o, k);
        return d && d.value === v && d.writable && !d.enumerable && d.configurable;
    };
    if (operation === 0) { // log []
        const p = DisposableStack.prototype, get = Object.getOwnPropertyDescriptor(p, 'disposed');
        return out(yes(raises(() => DisposableStack(), TypeError) && DisposableStack.length === 0),
            yes(p[Symbol.dispose] === p.dispose && data(p, Symbol.dispose, p.dispose)),
            yes(get.get.name === 'get disposed' && !get.set && !get.enumerable && get.configurable && raises(() => get.get.call(p), TypeError)),
            yes(p.adopt.length === 2 && p.defer.length === 1 && p.use.length === 1 && p.move.length === 0 && p.dispose.length === 0 &&
                Object.prototype.toString.call(new DisposableStack()) === '[object DisposableStack]'));
    }
    if (operation === 1) { // log [3,2,1]
        const s = new DisposableStack(), resource = {[Symbol.dispose]() { log.push(1); if (this !== resource || arguments.length) throw 90; }};
        const used = s.use(resource), adopted = s.adopt(42, function (v) { log.push(2); if (this !== undefined || v !== 42 || arguments.length !== 1) throw 91; });
        const deferred = s.defer(function () { log.push(3); if (this !== undefined || arguments.length) throw 92; });
        const result = s.dispose();
        return out(yes(used === resource && adopted === 42), yes(deferred === undefined && result === undefined),
            yes(s.disposed && log.join(',') === '3,2,1'), yes(s.dispose() === undefined && log.length === 3));
    }
    if (operation === 2) { // log [1,2]
        const s = new DisposableStack(); let reads = 0;
        const resource = {get [Symbol.dispose]() { ++reads; log.push(1); return function () { log.push(2); }; }};
        const used = s.use(resource); Object.defineProperty(resource, Symbol.dispose, {value() { throw 99; }});
        const n = s.use(null), u = s.use(undefined); s.dispose();
        return out(yes(used === resource), yes(reads === 1 && log.join(',') === '1,2'), yes(n === null && u === undefined), yes(s.disposed));
    }
    if (operation === 3) { // log [1]
        const s = new DisposableStack(); let live = false, rejected = false, noop = false;
        s.defer(() => { log.push(1); live = s.disposed; rejected = raises(() => s.use(null), ReferenceError) && raises(() => s.adopt(1, () => {}), ReferenceError) && raises(() => s.defer(() => {}), ReferenceError) && raises(() => s.move(), ReferenceError); noop = s.dispose() === undefined; });
        s.dispose();
        return out(yes(live), yes(rejected), yes(noop), yes(log.length === 1));
    }
    if (operation === 4) { // log [1]
        class Derived extends DisposableStack {}
        const original = new Derived(); original.defer(() => log.push(1));
        Object.defineProperty(original, 'constructor', {get() { throw 99; }});
        const moved = original.move(), empty = new DisposableStack().move();
        original.dispose(); moved.dispose();
        return out(yes(original.disposed && moved.disposed && !empty.disposed), yes(Object.getPrototypeOf(moved) === DisposableStack.prototype),
            yes(!(moved instanceof Derived) && raises(() => original.move(), ReferenceError)), yes(log.join(',') === '1'));
    }
    if (operation === 5) { // log [3,2,1]
        const s = new DisposableStack();
        s.defer(() => { log.push(1); throw 11; }); s.defer(() => { log.push(2); throw null; }); s.defer(() => { log.push(3); throw undefined; });
        let error; try { s.dispose(); } catch (e) { error = e; }
        return out(yes(error instanceof SuppressedError && error.error === 11),
            yes(error.suppressed instanceof SuppressedError && error.suppressed.error === null && error.suppressed.suppressed === undefined),
            yes(s.disposed && s.dispose() === undefined), yes(log.join(',') === '3,2,1'));
    }
    if (operation === 6) { // log []
        const s = new DisposableStack(), prior = SuppressedError.prototype.constructor; let error;
        SuppressedError.prototype.constructor = function () { throw 99; };
        s.defer(() => { throw 1; }); s.defer(() => { throw 2; });
        try { s.dispose(); } catch (e) { error = e; } finally { SuppressedError.prototype.constructor = prior; }
        const descriptor = Object.getOwnPropertyDescriptor(error, 'error');
        return out(yes(Object.getPrototypeOf(error) === SuppressedError.prototype), yes(error.error === 1 && error.suppressed === 2),
            yes(descriptor.writable && descriptor.configurable && !descriptor.enumerable), yes(!Object.prototype.hasOwnProperty.call(error, 'message')));
    }
    if (operation === 7) { // log [1]
        const s = new DisposableStack(); let caught;
        try { s.use({get [Symbol.dispose]() { log.push(1); throw 42; }}); } catch (e) { caught = e; }
        const a = raises(() => s.use(1), TypeError) && raises(() => s.use({}), TypeError) && raises(() => s.use({[Symbol.dispose]: 0}), TypeError);
        const b = raises(() => s.adopt(1, null), TypeError) && raises(() => s.defer({}), TypeError);
        s.dispose();
        return out(yes(a), yes(b), yes(caught === 42 && log.join(',') === '1'), yes(s.disposed));
    }
    if (operation === 8) { // log [1,2] -- source does not recheck after method getter
        const s = new DisposableStack(); s.defer(() => log.push(2));
        const resource = {get [Symbol.dispose]() { log.push(1); s.dispose(); return () => log.push(99); }};
        const returned = s.use(resource); s.dispose();
        return out(yes(returned === resource), yes(s.disposed), yes(log.join(',') === '1,2'), yes(raises(() => s.use(null), ReferenceError)));
    }
    if (operation === 9) { // log []
        const p = AsyncDisposableStack.prototype, get = Object.getOwnPropertyDescriptor(p, 'disposed');
        const tag = Object.getOwnPropertyDescriptor(p, Symbol.toStringTag);
        return out(yes(raises(() => AsyncDisposableStack(), TypeError) && AsyncDisposableStack.length === 0),
            yes(p[Symbol.asyncDispose] === p.disposeAsync && data(p, Symbol.asyncDispose, p.disposeAsync)),
            yes(get.configurable && !get.enumerable && get.set === undefined && raises(() => get.get.call(new DisposableStack()), TypeError)),
            yes(p.adopt.length === 2 && p.defer.length === 1 && p.use.length === 1 && p.disposeAsync.length === 0 && tag.value === 'AsyncDisposableStack' && tag.configurable && !tag.writable && !tag.enumerable));
    }
    if (operation === 10) { // log [3,4,2,1,5]
        const s = new AsyncDisposableStack(); s.defer(() => log.push(1)); s.defer(() => log.push(2)); s.defer(() => log.push(3));
        const promise = s.disposeAsync(), immediate = log.join(',') === '3'; log.push(4);
        const again = s.disposeAsync();
        const a = promise.then(v => { log.push(5); return yes(v === undefined && log.join(',') === '3,4,2,1,5'); });
        return out(a, yes(immediate && s.disposed), yes(promise instanceof Promise && again !== promise), again.then(v => yes(v === undefined)));
    }
    if (operation === 11) { // log [1,2,3,4,5]
        const s = new AsyncDisposableStack(); let touched = false;
        s.defer(() => log.push(5));
        const resource = {get [Symbol.asyncDispose]() { log.push(1); return null; }, get [Symbol.dispose]() { log.push(2); return function () {
            log.push(3); if (this !== resource) throw 99; return {get then() { touched = true; throw 98; }};
        }; }};
        const used = s.use(resource), promise = s.disposeAsync(); log.push(4);
        return out(promise.then(v => yes(v === undefined && !touched)), yes(used === resource),
            promise.then(() => yes(log.join(',') === '1,2,3,4,5')), yes(s.disposed));
    }
    if (operation === 12) { // log [2,3,1]
        const s = new AsyncDisposableStack(); let bound = false;
        s.defer(() => { log.push(1); throw 11; });
        const adopted = s.adopt(22, function (v) { bound = this === undefined && arguments.length === 1 && v === 22; log.push(2); return {then(resolve, reject) { log.push(3); reject(22); }}; });
        const result = s.disposeAsync().then(() => 0, e => yes(e instanceof SuppressedError && e.error === 11 && e.suppressed === 22));
        return out(result, yes(adopted === 22 && bound), result.then(() => yes(log.join(',') === '2,3,1')), yes(s.disposed));
    }
    if (operation === 13) { // log [4,2,3,1]
        const s = new AsyncDisposableStack();
        s.defer(() => { log.push(1); throw 7; });
        s.defer(() => { log.push(2); return {then(resolve) { log.push(3); resolve(99); }}; });
        s.defer(() => { log.push(4); throw 42; });
        const result = s.disposeAsync().then(() => 0, e => yes(e instanceof SuppressedError && e.error === 7 && e.suppressed === 42));
        return out(result, yes(s.disposed), result.then(() => yes(log.join(',') === '4,2,3,1')), yes(raises(() => s.defer(() => {}), ReferenceError)));
    }
    if (operation === 14) { // log [1,2,3]
        const s = new AsyncDisposableStack(); s.defer(() => log.push(2));
        const n = s.use(null), u = s.use(undefined), promise = s.disposeAsync(), deferred = log.length === 0;
        log.push(1);
        return out(promise.then(v => { log.push(3); return yes(v === undefined && log.join(',') === '1,2,3'); }),
            yes(n === null && u === undefined), yes(deferred), yes(s.disposed));
    }
    if (operation === 15) { // log []
        const p = AsyncDisposableStack.prototype; let thrown = false, promise;
        try { promise = p.disposeAsync.call(new DisposableStack()); } catch (e) { thrown = true; }
        const get = Object.getOwnPropertyDescriptor(p, 'disposed').get;
        return out(yes(!thrown && promise instanceof Promise), promise.then(() => 0, e => yes(e instanceof TypeError)),
            yes(raises(() => get.call({}), TypeError) && raises(() => p.use.call({}, null), TypeError)),
            yes(raises(() => DisposableStack.prototype.dispose.call(new AsyncDisposableStack()), TypeError)));
    }
    if (operation === 16) { // log [1,2,3,4]
        const s = new AsyncDisposableStack(); let release;
        s.defer(() => { log.push(1); return new Promise(resolve => { release = resolve; }); });
        const first = s.disposeAsync(), second = s.disposeAsync();
        const b = second.then(v => { log.push(2); return yes(v === undefined); });
        Promise.resolve().then(() => { log.push(3); release(77); });
        const a = first.then(v => { log.push(4); return yes(v === undefined && log.join(',') === '1,2,3,4'); });
        return out(a, b, yes(first !== second && s.disposed), yes(raises(() => s.move(), ReferenceError)));
    }
    if (operation === 17) { // log [1]
        class Derived extends AsyncDisposableStack {}
        const s = new Derived(); s.defer(() => log.push(1)); Object.defineProperty(s, 'constructor', {get() { throw 99; }});
        const moved = s.move(), first = s.disposeAsync(), second = moved.disposeAsync();
        return out(yes(s.disposed && moved.disposed), yes(Object.getPrototypeOf(moved) === AsyncDisposableStack.prototype && !(moved instanceof Derived)),
            first.then(v => yes(v === undefined)), second.then(v => yes(v === undefined && log.join(',') === '1')));
    }
    if (operation === 18) { // log [3,10,10,10,2,1]
        const original = Promise.prototype.then, s = new AsyncDisposableStack();
        s.defer(() => log.push(1)); s.defer(() => log.push(2)); s.defer(() => log.push(3));
        Promise.prototype.then = function () { log.push(10); return original.apply(this, arguments); };
        let result; try { result = s.disposeAsync(); } finally { Promise.prototype.then = original; }
        const sync = log.join(',') === '3,10,10,10';
        return out(result.then(v => yes(v === undefined)), yes(sync), result.then(() => yes(log.join(',') === '3,10,10,10,2,1')), yes(s.disposed));
    }
    if (operation === 19) { // log [1,2] -- source PromiseResolve abrupt completion is synchronous
        const s = new AsyncDisposableStack(), poison = Promise.resolve(1); let caught;
        Object.defineProperty(poison, 'constructor', {get() { log.push(2); throw 77; }});
        s.defer(() => log.push(99)); s.defer(() => { log.push(1); return poison; });
        try { s.disposeAsync(); } catch (e) { caught = e; }
        return out(yes(caught === 77), yes(s.disposed), s.disposeAsync().then(v => yes(v === undefined)), yes(log.join(',') === '1,2'));
    }
    if (operation === 20) { // log [3,9] -- failed chain installation drops uncalled resources
        const original = Object.getOwnPropertyDescriptor(Promise.prototype, 'then'), s = new AsyncDisposableStack(); let caught;
        s.defer(() => log.push(1)); s.defer(() => log.push(2)); s.defer(() => log.push(3));
        Object.defineProperty(Promise.prototype, 'then', {configurable: true, get() { log.push(9); throw 77; }});
        try { s.disposeAsync(); } catch (e) { caught = e; } finally { Object.defineProperty(Promise.prototype, 'then', original); }
        return out(yes(caught === 77), yes(s.disposed), s.disposeAsync().then(v => yes(v === undefined && log.join(',') === '3,9')), yes(raises(() => s.move(), ReferenceError)));
    }
    if (operation === 21) { // log [1,2,3]
        const s = new AsyncDisposableStack(); let fallback = false;
        const bad = raises(() => s.use({get [Symbol.asyncDispose]() { log.push(1); return 0; }, get [Symbol.dispose]() { fallback = true; return () => {}; }}), TypeError);
        const resource = {get [Symbol.asyncDispose]() { log.push(2); return function () { log.push(3); if (this !== resource) throw 99; return 42; }; }, get [Symbol.dispose]() { fallback = true; throw 98; }};
        const returned = s.use(resource), result = s.disposeAsync();
        return out(yes(bad && !fallback), yes(returned === resource), result.then(v => yes(v === undefined && !fallback)), yes(log.join(',') === '1,2,3'));
    }
    if (operation === 22) { // log [3,2,1]
        const s = new AsyncDisposableStack();
        s.defer(() => { log.push(1); return Promise.reject(1); }); s.defer(() => { log.push(2); return Promise.reject(2); }); s.defer(() => { log.push(3); throw 3; });
        const result = s.disposeAsync().then(() => 0, e => yes(e instanceof SuppressedError && e.error === 1 && e.suppressed instanceof SuppressedError && e.suppressed.error === 2 && e.suppressed.suppressed === 3));
        return out(result, yes(s.disposed), result.then(() => yes(log.join(',') === '3,2,1')), s.disposeAsync().then(v => yes(v === undefined)));
    }
    if (operation === 23) { // log [1,2,3,4,5]
        const s = new AsyncDisposableStack(); s.defer(() => log.push(5));
        s.defer(() => { log.push(1); return {get then() { log.push(2); return resolve => { log.push(4); resolve(9); }; }}; });
        const result = s.disposeAsync(); log.push(3);
        return out(result.then(v => yes(v === undefined && log.join(',') === '1,2,3,4,5')), yes(log.join(',') === '1,2,3'), yes(s.disposed), yes(raises(() => s.use(null), ReferenceError)));
    }
    if (operation === 24) { // log [3,1] -- thrown undefined survives null-resource and successful-await steps
        const s = new AsyncDisposableStack(); s.defer(() => { log.push(1); return Promise.resolve(8); }); s.use(null); s.defer(() => { log.push(3); throw undefined; });
        const result = s.disposeAsync().then(() => 0, e => yes(e === undefined));
        return out(result, yes(s.disposed), result.then(() => yes(log.join(',') === '3,1')), s.disposeAsync().then(v => yes(v === undefined)));
    }
    if (operation === 25) { // log [15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0]
        const s = new DisposableStack(); const resources = [];
        for (let i = 0; i < 16; ++i) { const resource = {i, owner: s, [Symbol.dispose]() { log.push(this.i); }}; resources.push(resource); s.use(resource); }
        const moved = s.move(); moved.dispose();
        return out(yes(log.join(',') === '15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0'), yes(resources.every(r => r.owner === s)), yes(s.disposed && moved.disposed), yes(moved.dispose() === undefined));
    }
    if (operation === 26) { // log []; foreign holds actual constructors from a second live realm
        const target = new Proxy(foreign.DisposableStack.bind(null), {get(t, k, r) { return k === 'prototype' ? null : Reflect.get(t, k, r); }});
        const created = Reflect.construct(DisposableStack, [], target), moved = DisposableStack.prototype.move.call(created);
        const asyncTarget = new Proxy(foreign.AsyncDisposableStack.bind(null), {get(t, k, r) { return k === 'prototype' ? 0 : Reflect.get(t, k, r); }});
        const asyncCreated = Reflect.construct(AsyncDisposableStack, [], asyncTarget), asyncMoved = AsyncDisposableStack.prototype.move.call(asyncCreated);
        return out(yes(Object.getPrototypeOf(created) === foreign.DisposableStack.prototype && created.disposed), yes(Object.getPrototypeOf(moved) === DisposableStack.prototype),
            yes(Object.getPrototypeOf(asyncCreated) === foreign.AsyncDisposableStack.prototype && asyncCreated.disposed), yes(Object.getPrototypeOf(asyncMoved) === AsyncDisposableStack.prototype));
    }
    throw new RangeError('unknown disposable stack execution scenario');
})
