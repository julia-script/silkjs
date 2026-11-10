/* Real-language cases for js_async_execution_consumers.prepare/runCase.
   Pinned oracle: quickjs.c:45425-46015. Each case returns [1,1,1,1,log].
   Expected logs by operation:
   0:[3,2], 1:[], 2:[1,2,13,12], 3:[1,2,3],
   4:[1,2,3,4,5,6], 5:[1,2,3], 6:[3,2,1], 7:[3,2,1],
   8:[], 9:[2,1,9], 10:[2,1], 11:[2,1], 12:[], 13:[2],
   14:[], 15:[1,2,3], 16:[2,1], 17:[].
   Run against the pinned qjs and the native Engine; no host-side semantic mirror. */
(function (operation) {
    "use strict";
    const log = [];
    const out = (a, b, c, d) => [+!!a, +!!b, +!!c, +!!d, log];
    const error = f => { try { f(); } catch (e) { return e; } };
    const record = (values, close) => {
        let index = 0;
        return { next() { return index < values.length ? {value: values[index++], done:false} : {done:true}; },
            return() { if (close) return close(); return {}; } };
    };
    if (operation === 0) {
        const z = Iterator.zip([record([1]), record([2,3], () => {log.push(2); return {};}),
            record([4,5], () => {log.push(3); return {};})]);
        const a = z.next(), b = z.next(), c = z.next();
        return out(a.value.join() === "1,2,4", !a.done, b.done && c.done, z.return().value === undefined);
    }
    if (operation === 1) {
        const z = Iterator.zip([[1], [2,3,4]], {mode:"longest", padding:[8,9]});
        const a=z.next(), b=z.next(), c=z.next(), d=z.next();
        return out(a.value.join()==="1,2", b.value.join()==="8,3", c.value.join()==="8,4", d.done);
    }
    if (operation === 2) {
        const z = Iterator.zip([
            {next(){log.push(1);return {done:true};}},
            {next(){log.push(2);return {value:2};},return(){log.push(12);throw 12;}},
            {next(){log.push(3);return {value:3};},return(){log.push(13);throw 13;}}
        ], {mode:"strict"});
        const e=error(()=>z.next());
        // Strict probes stop at the first non-done; the third next is not called.
        return out(e instanceof TypeError, log.join()==="1,2,13,12", z.return().done, true);
    }
    if (operation === 3) {
        const z=Iterator.zip([1,2,3].map(n=>({next(){log.push(n);return {done:true};}})), {mode:"strict"});
        return out(z.next().done, z.next().done, z.return().done, log.join()==="1,2,3");
    }
    if (operation === 4) {
        const symbol=Symbol("zip"), proto={gone:[7]}, source=Object.create(proto);
        Object.defineProperty(source,"first",{enumerable:true,configurable:true,get(){log.push(2);delete source.gone;return [1];}});
        source.gone=[0]; source[symbol]=[9];
        Object.defineProperty(source,"hidden",{value:[8],enumerable:false});
        const p=new Proxy(source,{
            ownKeys(t){log.push(1);return Reflect.ownKeys(t);},
            getOwnPropertyDescriptor(t,k){if(k==="gone")log.push(3);if(k===symbol)log.push(5);return Reflect.getOwnPropertyDescriptor(t,k);},
            get(t,k,r){if(k==="gone")log.push(4);if(k===symbol)log.push(6);return Reflect.get(t,k,r);}
        });
        const row=Iterator.zipKeyed(p).next().value, keys=Reflect.ownKeys(row);
        return out(row.first===1&&row.gone===7, row[symbol]===9, Object.getPrototypeOf(row)===null,
            keys.length===3&&keys[0]==="first"&&keys[1]==="gone"&&keys[2]===symbol);
    }
    if (operation === 5) {
        const s=Symbol(), inputs={a:[1],b:[2,3],[s]:undefined};
        const padding={get a(){log.push(2);return 8;},get b(){log.push(3);return 9;},get [s](){throw 99;}};
        const options={get mode(){log.push(1);return "longest";},padding};
        const z=Iterator.zipKeyed(inputs,options), a=z.next().value,b=z.next().value;
        return out(a.a===1&&a.b===2,b.a===8&&b.b===3,Reflect.ownKeys(b).length===2,z.next().done);
    }
    if (operation === 6) {
        const z=Iterator.zip([1,2,3].map(n=>record([n],()=>{log.push(n);throw n;})));
        const e=error(()=>z.return(99));
        return out(e===3,log.join()==="3,2,1",z.next().done,z.return().value===undefined);
    }
    if (operation === 7) {
        const original={};
        const z=Iterator.zip([record([1],()=>{log.push(1);throw 1;}),
            record([2],()=>{log.push(2);throw 2;}),
            {next(){log.push(3);throw original;},return(){throw "must not close throwing iterator";}}]);
        return out(error(()=>z.next())===original,log.join()==="3,2,1",z.return().done,true);
    }
    if (operation === 8) {
        let z, before=false, after=false;
        z=Iterator.zip([record([1],()=>{before=z.next().done;return {};})]);
        const a=z.return();
        z=Iterator.zip([record([1],()=>{after=error(()=>z.next()) instanceof TypeError;return {};})]);
        z.next(); const b=z.return();
        return out(a.done&&before,b.done&&after,z.next().done,z.return().done);
    }
    if (operation === 9) {
        let i=0;
        const outer={ [Symbol.iterator](){return this;},
            next(){const n=++i;return {value:n<=2?record([n],()=>{log.push(n);throw n;}):0};},
            return(){log.push(9);throw 90;} };
        const e=error(()=>Iterator.zip(outer));
        return out(e instanceof TypeError,log.join()==="2,1,9",i===3,true);
    }
    if (operation === 10) {
        const padding={ [Symbol.iterator](){return this;},next(){return {value:7};},return(){log.push(2);throw 22;} };
        const e=error(()=>Iterator.zip([record([1],()=>{log.push(1);throw 11;})],{mode:"longest",padding}));
        return out(e===22,log.join()==="2,1",true,true);
    }
    if (operation === 11) {
        let paddingCloses=0;
        const padding={ [Symbol.iterator](){return this;},get next(){log.push(2);throw 22;},return(){paddingCloses++;return {};} };
        const e=error(()=>Iterator.zip([record([1],()=>{log.push(1);throw 11;})],{mode:"longest",padding}));
        return out(e===22,paddingCloses===0,log.join()==="2,1",true);
    }
    if (operation === 12) {
        const z=Iterator.zip([]), k=Iterator.zipKeyed({});
        const first=z.next(), second=k.next();
        return out(first.done&&second.done,error(()=>z.next()) instanceof TypeError,
            error(()=>z.return()) instanceof TypeError,error(()=>k.next()) instanceof TypeError);
    }
    if (operation === 13) {
        let calls=0;
        const a={next(){calls++;if(calls===1)throw 7;return {value:8};},return(){log.push(1);return {};}},
            b=record([9],()=>{log.push(2);return {};});
        const z=Iterator.zip([a,b]);
        const e=error(()=>z.next()), row=z.next();
        // A next error closes peers without setting done; CLOSED records are stepped again.
        z.return();
        return out(e===7,row.value.join()==="8,9",!row.done,calls===2&&log.join()==="2");
    }
    if (operation === 14) {
        let coerced=0, pads=0;
        const bad=error(()=>Iterator.zip([], {mode:{toString(){coerced++;return "shortest";}}}));
        const z=Iterator.zip([[1]],{mode:"shortest\0ignored",get padding(){pads++;throw 9;}});
        return out(bad instanceof TypeError,coerced===0&&pads===0,z.next().value[0]===1,
            error(()=>Iterator.zip(["not flattenable"])) instanceof TypeError);
    }
    if (operation === 15) {
        let pulls=0;
        const padding={ [Symbol.iterator](){log.push(1);return this;},
            get next(){log.push(2);return ()=>{pulls++;return {value:9};};},
            return(){log.push(3);return {};} };
        const z=Iterator.zip([],{mode:"longest",padding});
        return out(pulls===0,log.join()==="1,2,3",z.return().done,z.next().done);
    }
    if (operation === 16) {
        let i=0, outerCloses=0;
        const outer={ [Symbol.iterator](){return this;},
            next(){const n=++i;if(n===3)throw 33;return {value:record([n],()=>{log.push(n);throw n;})};},
            return(){outerCloses++;return {};} };
        return out(error(()=>Iterator.zip(outer))===33,outerCloses===0,i===3,log.join()==="2,1");
    }
    if (operation === 17) {
        let z, nextGuard=false, returnGuard=false;
        const input={next(){nextGuard=error(()=>z.next()) instanceof TypeError;
            returnGuard=error(()=>z.return()) instanceof TypeError;return {value:7};}};
        z=Iterator.zip([input]);
        const first=z.next(), second=z.next();
        return out(nextGuard,returnGuard,first.value[0]===7,second.value[0]===7);
    }
    throw new RangeError("unknown zip case");
})
