/* Actual-language cases for the installed native family. Cases 0..8 and 10
   return true; case 9 returns a Promise fulfilled with true. Run each against
   the pinned QuickJS executable and the production Engine with its job drain. */
(function (operation) {
    "use strict";
    const P = Iterator.prototype;
    const raises = (f, kind) => { try { f(); return false; } catch (e) { return e instanceof kind; } };
    if (operation === 0) {
        class Derived extends Iterator { next() { return {done:true}; } }
        const value = new Derived();
        const accessor = Object.getOwnPropertyDescriptor(P, "constructor");
        const replacement = {};
        accessor.set.call(value, replacement);
        const own = Object.getOwnPropertyDescriptor(value, "constructor");
        return raises(() => Iterator(), TypeError) && raises(() => new Iterator(), TypeError) &&
            value instanceof Iterator && accessor.get === accessor.set && accessor.get.length === 0 &&
            accessor.get.call({}) === Iterator && raises(() => accessor.set.call({}, 1), TypeError) &&
            own.value === replacement && own.writable && own.configurable && !own.enumerable;
    }
    if (operation === 1) {
        let reads = 0;
        const existing = Object.create(P, {next:{get(){ reads++; return () => ({done:true}); }}});
        Object.defineProperty(Iterator, Symbol.hasInstance, {configurable:true,value(){ throw 91; }});
        let same;
        try { same = Iterator.from(existing) === existing; } finally { delete Iterator[Symbol.hasInstance]; }
        return same && reads === 1 && Iterator.from("ab").toArray().join("") === "ab" &&
            raises(() => Iterator.from(3), TypeError);
    }
    if (operation === 2) {
        let argc = -1, returns = -1, reads = 0;
        const result = {get done(){reads++; throw 99;}};
        const wrapped = Iterator.from({next(){argc=arguments.length;return {value:7,done:false};},
            return(){returns=arguments.length;return result;}});
        const yielded = wrapped.next(44);
        return yielded.value === 7 && !yielded.done && argc === 0 &&
            wrapped.return(55) === result && returns === 0 && reads === 0 &&
            Object.getPrototypeOf(wrapped) !== Object.getPrototypeOf([1].values().map(x=>x));
    }
    if (operation === 3) {
        const log = [];
        const first = {get [Symbol.iterator](){log.push(1);return function(){log.push(3);return [4].values();};}};
        const second = {get [Symbol.iterator](){log.push(2);return function(){log.push(4);return [8].values();};}};
        const it = Iterator.concat(first, second);
        if (log.join() !== "1,2") return false;
        const a = it.next(), b = it.next(), c = it.next();
        return a.value === 4 && b.value === 8 && c.done && log.join() === "1,2,3,4" &&
            raises(() => Iterator.concat("ab"), TypeError);
    }
    if (operation === 4) {
        const empty = Iterator.concat([1]);
        const pre = empty.return();
        const returned = {value:9,done:true};
        const it = Iterator.concat({[Symbol.iterator](){return this;},next(){return {value:1};},return(){return returned;}});
        it.next();
        const closed = it.return(5);
        const missing = Iterator.concat({[Symbol.iterator](){return this;},next(){return {value:1};}});
        missing.next();
        return !pre.done && pre.value === undefined && empty.next().done &&
            !closed.done && closed.value === returned && it.next().done &&
            raises(() => missing.return(), TypeError) && missing.next().done;
    }
    if (operation === 5) {
        let n=0, blocked=0, it;
        const inner = {[Symbol.iterator](){return this;},next(){
            blocked += +raises(() => it.next(), TypeError);
            return {value:++n};
        },get return(){throw 42;}};
        it=Iterator.concat(inner);
        const a=it.next(); let error;
        try { it.return(); } catch(e) { error=e; }
        const b=it.next();
        return a.value===1 && b.value===2 && error===42 && blocked===2;
    }
    if (operation === 6) {
        let calls=0, closes=0;
        const it=Iterator.concat({[Symbol.iterator](){return this;},next(){
            if (++calls===1) throw 71;
            return {value:8,done:false};
        },return(){closes++;return {};}});
        let error;try {it.next();}catch(e){error=e;}
        return error===71 && it.next().value===8 && calls===2 && closes===0;
    }
    if (operation === 7) {
        const dispose=P[Symbol.dispose], result={}; let count=-1;
        return dispose.call({return(){count=arguments.length;return result;}})===result && count===0 &&
            dispose.call({return:null})===undefined && raises(()=>dispose.call({return:1}),TypeError) &&
            P[Symbol.iterator].call(7)===7;
    }
    if (operation === 8) {
        const tag=Object.getOwnPropertyDescriptor(P,Symbol.toStringTag);
        const child=Object.create(P); tag.set.call(child,"mine");
        const own=Object.getOwnPropertyDescriptor(child,Symbol.toStringTag);
        let saved;const existing={set [Symbol.toStringTag](v){saved=v;}};
        tag.set.call(existing,8);
        return tag.get.call(null)==="Iterator" && raises(()=>tag.set.call(P,"no"),TypeError) &&
            own.value==="mine" && own.writable && own.enumerable && own.configurable && saved===8;
    }
    if (operation === 9) {
        const AP=Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})())));
        const dispose=AP[Symbol.asyncDispose]; let calls=0;
        const rejects=(object,error)=>dispose.call(object).then(()=>false,e=>e===error);
        return Promise.all([
            dispose.call({}).then(v=>v===undefined),
            rejects({get return(){throw 31;}},31),
            rejects({return(){throw 32;}},32),
            dispose.call({return(){calls++;return {then(resolve){resolve(123);}};}}).then(v=>v===undefined),
            dispose.call(null).then(()=>false,e=>e instanceof TypeError)
        ]).then(results=>results.every(Boolean)&&calls===1&&AP[Symbol.asyncIterator].call(7)===7);
    }
    if (operation === 10) {
        const AP=Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})())));
        const dispose=AP[Symbol.asyncDispose], original=Promise.prototype.then;
        const sentinel={};let argc=-1,callbackResult=9;
        Promise.prototype.then=function(callback){argc=arguments.length;callbackResult=callback(81);return sentinel;};
        let result;
        try {result=dispose.call({return(){return 4;}});}finally{Promise.prototype.then=original;}
        return result===sentinel && argc===1 && callbackResult===undefined;
    }
    throw new RangeError("unknown Iterator case");
})
