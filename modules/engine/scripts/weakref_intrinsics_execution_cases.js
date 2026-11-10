/* Evaluate as a function in the production Engine and pinned QuickJS.
 * Operations 0..7 return 1. Operations 8..15 return a phase callback consumed by
 * js_weakref_intrinsics_consumers: drop roots; collect; drain; collect; drain.
 * The source collector sweeps BEFORE cycle collection, so cyclic targets enqueue
 * only on the second collection. No mocked GC or cleanup callbacks are used. */
(function (operation) {
    const raises = f => { try { f(); return false; } catch (e) { return e instanceof TypeError; } };
    if (operation === 0) {
        const t = {}, w = new WeakRef(t), s = Symbol('local'), ws = new WeakRef(s);
        return +(w.deref() === t && ws.deref() === s && raises(() => WeakRef(t)) && raises(() => new WeakRef(Symbol.for('global'))));
    }
    if (operation === 1) {
        const log = [], nt = new Proxy(function () {}, {get(t, k) { if (k === 'prototype') { log.push(1); throw 42; } }});
        const bad = raises(() => Reflect.construct(WeakRef, [1], nt));
        let thrown; try { Reflect.construct(WeakRef, [{}], nt); } catch (e) { thrown = e; }
        return +(bad && thrown === 42 && log.join() === '1' && raises(() => WeakRef.prototype.deref.call(new Proxy(new WeakRef({}), {}))));
    }
    if (operation === 2) {
        const r = new FinalizationRegistry(() => {}), t = {}, token = {};
        return +(raises(() => FinalizationRegistry(() => {})) && raises(() => new FinalizationRegistry({})) &&
            raises(() => r.register(1, 2)) && raises(() => r.register(t, t)) && raises(() => r.register(t, 2, null)) &&
            raises(() => r.unregister(undefined)) && r.register(t, 2, token) === undefined && r.unregister(token) && !r.unregister(token));
    }
    if (operation === 3) {
        const r = new FinalizationRegistry(() => {}), t = {}, token = Symbol('token');
        r.register(t, 1, token); r.register(t, 2, token); r.register(t, 3);
        return +(r.unregister(token) && !r.unregister(token) && raises(() => r.register(t, 4, Symbol.for('token'))) &&
            raises(() => FinalizationRegistry.prototype.register.call({}, t, 1)) && raises(() => FinalizationRegistry.prototype.unregister.call({}, token)));
    }
    if (operation === 4) {
        class W extends WeakRef {} class R extends FinalizationRegistry {}
        const t = {}, w = new W(t), r = new R(() => {});
        return +(w instanceof W && w.deref() === t && r instanceof R && r.register(t, 1) === undefined &&
            Object.prototype.toString.call(w) === '[object WeakRef]' && Object.prototype.toString.call(r) === '[object FinalizationRegistry]');
    }
    if (operation === 5) {
        const w = Object.getOwnPropertyDescriptor(WeakRef.prototype, 'deref');
        const t = Object.getOwnPropertyDescriptor(FinalizationRegistry.prototype, Symbol.toStringTag);
        return +(WeakRef.length === 1 && FinalizationRegistry.length === 1 && w.value.length === 0 && w.writable && w.configurable && !w.enumerable &&
            FinalizationRegistry.prototype.register.length === 2 && FinalizationRegistry.prototype.unregister.length === 1 && t.value === 'FinalizationRegistry' && t.configurable && !t.writable && !t.enumerable);
    }
    if (operation === 6) {
        const log = [], nt = new Proxy(function () {}, {get(t, k) { if (k === 'prototype') { log.push(1); return {}; } }});
        const bad = raises(() => Reflect.construct(FinalizationRegistry, [1], nt));
        const r = Reflect.construct(FinalizationRegistry, [() => {}], nt);
        return +(bad && log.join() === '1' && FinalizationRegistry.prototype.register.call(r, {}, 1) === undefined);
    }
    if (operation === 7) {
        const r = new FinalizationRegistry(() => {}), s = Symbol(), w = new WeakRef(s);
        r.register(s, 'held', s);
        return +(w.deref() === s && r.unregister(s) && raises(() => r.register(Symbol.for('target'), 1)) && raises(() => new WeakRef(WeakRef.prototype)) === false);
    }
    if (operation === 16) {
        const registry = new FinalizationRegistry(() => { throw 999; });
        registry.self = registry;
        registry.register({}, 1);
        return registry; // native shutdown must collect owner without queuing work
    }
    const cyclic = operation === 9;
    const symbol = operation === 15;
    const log = [];
    let target = symbol ? Symbol('target') : {};
    if (cyclic) target.self = target;
    let token = operation === 13 ? target : {};
    let registry = new FinalizationRegistry(function (held) {
        'use strict';
        if (this !== undefined) throw 999;
        log.push(held);
        if (operation === 12 && held === 1) throw 77;
    });
    const weak = new WeakRef(target), weakToken = new WeakRef(token);
    registry.register(target, 1, token);
    registry.register(target, 2);
    if (operation === 14) registry.unregister(token);
    return function (phase) {
        if (phase === 0) {
            target = null; token = null;
            if (operation === 11) registry = null;
            return +((weak.deref() !== undefined) === cyclic && weakToken.deref() === undefined && log.length === 0);
        }
        if (phase === 1) {
            if (operation === 10) registry = null;
            return +(weak.deref() === undefined && log.length === 0);
        }
        const expected = operation === 11 ? '' : operation === 14 ? '2' : '1,2';
        if (phase === 2) return +(log.join() === (cyclic ? '' : expected));
        if (phase === 3) return +(log.join() === expected);
        if (phase === 4) return +(log.length === 0); // enqueue OOM consumes all failed records
        throw new Error('invalid phase');
    };
})
