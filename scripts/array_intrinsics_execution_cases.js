/* Real-language consumers for js_async_execution_consumers.prepare/runCase.
   Four observations plus a bounded numeric order log. No evaluator substitute. */
(function (operation) {
    "use strict";
    const log = [];
    const out = (a=0,b=0,c=0,d=0) => [a,b,c,d,log];
    const yes = x => +!!x;
    const raises = (f, type) => { try { f(); return 0; } catch (e) { return +(type ? e instanceof type : true); } };
    const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
    const A = Array.prototype;
    if (operation === 0) {
        const a=Array(3), b=Array("3"), c=Array.of(3), p=new Proxy([],{});
        const r=Proxy.revocable([],{}); r.revoke();
        return out(yes(a.length===3&&!own(a,0)&&b[0]==="3"&&c[0]===3),
            yes(Array.isArray(p)&&!Array.isArray({length:0})),
            raises(()=>Array(1.5),RangeError),raises(()=>Array.isArray(r.proxy),TypeError));
    }
    if (operation === 1) {
        function C(){log.push(1);}
        const iterable={get [Symbol.iterator](){log.push(2);return function(){log.push(3);return {
            get next(){log.push(4);return function(){log.push(5);return {value:7,done:false};};},
            return(){log.push(7);throw 99;}
        };};}};
        let error;try{Array.from.call(C,iterable,()=>{log.push(6);throw 42;});}catch(e){error=e;}
        return out(yes(error===42),1,1,1);
    }
    if (operation === 2) {
        let closes=0;
        const nextFails={[Symbol.iterator](){return {next(){throw 3;},return(){closes++;return {};}};}};
        const getterFails={[Symbol.iterator](){return {get next(){throw 4;},return(){closes++;return {};}};}};
        function C(){Object.defineProperty(this,"length",{set(){throw 5;}});}
        const done={[Symbol.iterator](){return {next(){return {done:true};},return(){closes++;return {};}};}};
        return out(raises(()=>Array.from(nextFails)),raises(()=>Array.from(getterFails)),raises(()=>Array.from.call(C,done)),yes(closes===0));
    }
    if (operation === 3) {
        const p=new Proxy({length:3,1:4},{get(t,k,r){if(k==="length")log.push(1);else if(k==="0"||k==="1"||k==="2")log.push(10+ +k);return Reflect.get(t,k,r);},has(){throw 99;}});
        const a=Array.from.call(function(n){log.push(2);this.n=n;},p,(v,k)=>{log.push(20+k);return v===undefined?8:v;});
        return out(yes(a.n===3&&a.length===3),yes(a[0]===8&&a[1]===4&&a[2]===8),1,1);
    }
    if (operation === 4) {
        const p=Object.create(A);p[1]=3;const a=[2,,4];Object.setPrototypeOf(a,p);
        let created=0; a.constructor={[Symbol.species]:function(n){created++;this.length=n;}};
        const mapped=a.map((v,k,o)=>{log.push(k);return v*2;});
        const filtered=a.filter(v=>v>2);
        let calls=0;const every=a.every(v=>{calls++;return v<3;});const some=a.some(v=>v===3);
        let sum=0;const each=a.forEach(v=>{sum+=v;});
        return out(yes(mapped[0]===4&&mapped[1]===6&&mapped[2]===8),yes(filtered[0]===3&&filtered[1]===4&&filtered.length===0),yes(created===2&&!every&&some&&calls===2),yes(sum===9&&each===undefined));
    }
    if (operation === 5) {
        const a=[,2,,5];const p=Object.create(A);p[2]=3;Object.setPrototypeOf(a,p);
        const left=a.reduce((s,v,k)=>{log.push(k);return s*10+v;});
        const right=a.reduceRight((s,v,k)=>{log.push(10+k);return s*10+v;});
        return out(yes(left===235),yes(right===532),raises(()=>Array(3).reduce(()=>0),TypeError),yes(Array(3).reduce(()=>9,7)===7));
    }
    if (operation === 6) {
        let primitive=true;const idx=A.findIndex.call("ab",function(v,k,o){primitive=primitive&&typeof o==="string";return k===1;});
        const a=[,3,,8];let count=0;const first=a.find((v,k)=>{log.push(k);count++;return v===undefined;});
        const last=a.findLastIndex((v,k)=>{log.push(10+k);return v===undefined;});
        return out(yes(idx===1&&primitive),yes(first===undefined&&count===1),yes(last===2),yes(a.findLast(v=>v!==undefined)===8));
    }
    if (operation === 7) {
        const a=[,NaN,0,-0,7];
        const p=new Proxy({length:2,1:9},{get(t,k,r){if(k==="length")log.push(1);else log.push(3);return Reflect.get(t,k,r);},has(t,k){log.push(2);return Reflect.has(t,k);}});
        const at=A.at.call(p,1);
        // Pinned dense search scans the post-fromIndex count, even beyond len.
        const grown=[1];const appended=grown.indexOf(2,{valueOf(){grown.push(2);return 0;}});
        return out(yes(a.includes(undefined)&&a.includes(NaN)&&a.indexOf(NaN)===-1),yes(a.indexOf(undefined)===-1&&a.lastIndexOf(0)===3&&appended===1),yes(at===9&&a.at(-1)===7),yes(A.includes.call({length:0},1,{valueOf(){throw 1;}})===false));
    }
    if (operation === 8) {
        const a=[1];a.constructor={get [Symbol.species](){log.push(1);return function(n){log.push(2);this.length=n;};}};
        const b={get [Symbol.isConcatSpreadable](){log.push(3);return true;},get length(){log.push(4);return 3;},get 1(){log.push(5);return 8;}};
        const c=a.concat(b,9);
        const huge={length:9007199254740991,[Symbol.isConcatSpreadable]:true};
        return out(yes(c.length===5&&c[0]===1&&c[2]===8&&c[4]===9),yes(!own(c,1)&&!own(c,3)),raises(()=>[1].concat(huge),TypeError),yes([1].concat({[Symbol.isConcatSpreadable]:false,length:2}).length===2));
    }
    if (operation === 9) {
        const a=[1,2];const n=a.push(3,4);const m=a.unshift(7,8);
        const p=new Proxy({length:2,0:1,1:2},{get:Reflect.get,has:Reflect.has,set(t,k,v,r){log.push(k==="length"?9:+k);return Reflect.set(t,k,v,r);}});
        A.unshift.call(p,8);
        return out(yes(n===4&&m===6&&a.join() === "7,8,1,2,3,4"),yes(p[0]===8&&p[1]===1&&p[2]===2&&p.length===3),raises(()=>A.push.call({length:9007199254740991},1),TypeError),yes(A.unshift.call({length:0})===0));
    }
    if (operation === 10) {
        const a=[1,2],b=[3,4];Object.defineProperty(a,"length",{writable:false});Object.defineProperty(b,"length",{writable:false});
        const x=raises(()=>a.pop(),TypeError),y=raises(()=>b.shift(),TypeError);
        const c={length:0};const popped=A.pop.call(c);
        return out(yes(x&&a.length===2&&!own(a,1)),yes(y&&b.length===2&&b[0]===4&&!own(b,1)),yes(popped===undefined&&c.length===0),1);
    }
    if (operation === 11) {
        const a=[1,,3,,];const p=new Proxy(a,{has(t,k){log.push(10+ +k);return Reflect.has(t,k);},get(t,k,r){if(k!=="length")log.push(20+ +k);return Reflect.get(t,k,r);},set(t,k,v,r){log.push(30+ +k);return Reflect.set(t,k,v,r);},deleteProperty(t,k){log.push(40+ +k);return Reflect.deleteProperty(t,k);}});
        A.reverse.call(p);const b=[1,2];Object.defineProperty(b,"length",{writable:false});b.reverse();
        return out(yes(!own(a,0)&&a[1]===3&&!own(a,2)&&a[3]===1),yes(b[0]===2&&b[1]===1),1,1);
    }
    if (operation === 12) {
        const a=[1,,3,4];a.constructor={[Symbol.species]:function(n){log.push(n);this.length=n;}};
        const b=a.slice(0,3);const c=[1,2,3];c.constructor={get [Symbol.species](){c.length=1;return undefined;}};const d=c.slice(0,3);
        return out(yes(b.length===3&&b[0]===1&&!own(b,1)&&b[2]===3),yes(d.length===3&&d[0]===1&&!own(d,1)&&!own(d,2)),yes([1,2,3].slice(-2,Infinity).join()==="2,3"),yes([1].slice(Infinity).length===0));
    }
    if (operation === 13) {
        const a=[1,,3,4];const removed=a.splice(1,2,7,8,9);
        const b=[1,2,3];b.constructor={get [Symbol.species](){b.push(4);return undefined;}};const r=b.splice(1,1,8);
        const c={length:4,0:1,2:3,3:4};const q=A.splice.call(c,1,2,9);
        return out(yes(removed.length===2&&!own(removed,0)&&removed[1]===3&&a.join()==="1,7,8,9,4"),yes(r[0]===2&&b.length===3&&b.join()==="1,8,3"),yes(q.length===2&&!own(q,0)&&q[1]===3&&c[1]===9&&c[2]===4&&c.length===3),yes([1,2].splice().length===0));
    }
    if (operation === 14) {
        const a={length:4,0:1,get 1(){throw 1;},get 2(){throw 2;},3:4};const b=A.toSpliced.call(a,1,2,8);
        const c=[,1,,].toSpliced(1,1);
        return out(yes(b.join()==="1,8,4"),yes(c.length===2&&own(c,0)&&own(c,1)&&c[0]===undefined),raises(()=>A.toSpliced.call({length:2147483648}),RangeError),yes([1,2].toSpliced().join()==="1,2"));
    }
    if (operation === 15) {
        const p=new Proxy({length:3,0:1,2:3},{get(t,k,r){if(k!=="length")log.push(20+ +k);return Reflect.get(t,k,r);},has(t,k){log.push(10+ +k);return Reflect.has(t,k);}});
        const reversed=A.toReversed.call(p);const changed=A.with.call({length:3,0:1,get 1(){throw 1;},2:3},1,8);
        return out(yes(reversed[0]===3&&reversed[1]===undefined&&own(reversed,1)&&reversed[2]===1),yes(changed.join()==="1,8,3"),raises(()=>[1].with(1,0),RangeError),raises(()=>A.with.call({length:2147483648},0,0),RangeError));
    }
    if (operation === 16) {
        const a=[1,2,3,4,5];a.copyWithin(1,0,4);
        const b={length:4,0:1,2:3,3:4};A.copyWithin.call(b,1,0,3);
        const p=Object.create({1:7});p.length=3;p[0]=1;A.copyWithin.call(p,0,1,2);
        return out(yes(a.join()==="1,1,2,3,4"),yes(b[1]===1&&!own(b,2)&&b[3]===3),yes(own(p,0)&&p[0]===7),yes([1,2].copyWithin(0,2).join()==="1,2"));
    }
    if (operation === 17) {
        const a=[1,2,3];const start={valueOf(){log.push(1);a.length=1;return 1;}};const end={valueOf(){log.push(2);return 3;}};
        const r=a.fill(9,start,end);const p=new Proxy({length:2},{set(t,k,v){log.push(10+ +k);t[k]=v;return true;}});A.fill.call(p,8);
        return out(yes(r===a&&a.length===3&&a.join()==="1,9,9"),yes(p[0]===8&&p[1]===8),yes([1,2,3].fill(0,-2,-1).join()==="1,0,3"),1);
    }
    if (operation === 18) {
        const a=[1,,[2,,[3]]];const b=a.flat(Infinity),c=a.flat(0);let calls=0;
        const d=[1,,2].flatMap((v,k,o)=>{log.push(k);calls++;return [v,[k]];});
        const e=[1,[2]];e.constructor={[Symbol.species]:function(){this.tag=7;}};const f=e.flat();
        return out(yes(b.join()==="1,2,3"&&b.length===3),yes(c.length===2&&Array.isArray(c[1])),yes(calls===2&&d.length===4&&Array.isArray(d[1])),yes(f.tag===7&&f[0]===1&&f[1]===2&&!own(f,"length")));
    }
    if (operation === 19) {
        const a=[{k:2,id:1},{k:1,id:2},{k:2,id:3},{k:1,id:4}];const r=a.sort((x,y)=>x.k-y.k);
        const b=[,3,undefined,1,,2];b.sort();const c=[,3,undefined,1].toSorted();
        return out(yes(r===a&&a.map(x=>x.id).join()==="2,4,1,3"),yes(b.length===6&&b[0]===1&&b[1]===2&&b[2]===3&&own(b,3)&&!own(b,4)&&!own(b,5)),yes(c.length===4&&c[0]===1&&c[1]===3&&own(c,2)&&own(c,3)),raises(()=>A.toSorted.call({length:2147483648}),RangeError));
    }
    if (operation === 20) {
        let calls=0;const shared={};[shared,shared,shared].sort(()=>{calls++;return 0;});
        let conversions=0;const a=[3,1,2].map(n=>({n,toString(){conversions++;return ""+n;}}));a.sort();
        const b=[1,2];b.sort((x,y)=>{b[0]=9;return x-y;});
        return out(yes(calls===0),yes(conversions===3&&a[0].n===1&&a[2].n===3),yes(b[0]===9),raises(()=>A.sort.call(null,3),TypeError));
    }
    if (operation === 21) {
        const a=[null,undefined,,"\ud800",{toString(){log.push(1);return "x";}}];const text=a.join("|");
        const x={toLocaleString(){log.push(arguments.length);return "L";}};const locale=[x,null,x].toLocaleString("xx",{});
        return out(yes(text.length===6&&text.charCodeAt(3)===0xd800&&text==="|||\ud800|x"),yes(locale==="L,,L"),yes([1,2].join({toString(){log.push(2);return ":";}})==="1:2"),yes(A.join.call({length:0},{toString(){log.push(3);return "!";}})===""));
    }
    if (operation === 22) {
        const u=A[Symbol.unscopables],d=Object.getOwnPropertyDescriptor(A,Symbol.unscopables);
        const all=["at","copyWithin","entries","fill","find","findIndex","findLast","findLastIndex","flat","flatMap","includes","keys","toReversed","toSorted","toSpliced","values"];
        return out(yes(A.values===A[Symbol.iterator]),yes(Uint8Array.prototype.toString===A.toString),yes(Object.getPrototypeOf(u)===null&&Object.keys(u).length===16&&all.every(k=>u[k]===true)&&!u.with&&d.configurable&&!d.writable&&!d.enumerable),yes(A.toString.call({join:3})==="[object Object]"&&A.toString.call({join(){return 7;}})===7));
    }
    if (operation === 23) {
        const a=[1];const it=a.values();const x=it.next();a.push(2);const y=it.next();const z=it.next();a.push(3);const done=it.next();
        const generic=A.values.call({length:4294967297,0:8});const p=generic.next(),q=generic.next();
        const getter={length:2,get 0(){throw 1;},1:9};const gi=A.values.call(getter);const failed=raises(()=>gi.next());const after=gi.next();
        return out(yes(x.value===1&&!x.done&&y.value===2&&!y.done&&z.done&&done.done),yes(p.value===8&&!p.done&&q.done),yes(failed&&after.value===9),yes([7].entries().next().value.join()==="0,7"));
    }
    if (operation === 24) {
        const source={get length(){log.push(1);return 2;},get 0(){log.push(2);return Promise.resolve(3);},get 1(){log.push(5);return 4;}};
        const p=Array.fromAsync(source,async(v,k)=>{log.push(3+k*3);await 0;log.push(4+k*3);return v*2;}).then(a=>yes(a.join()==="6,8"));
        return out(p,1,1,1);
    }
    if (operation === 25) {
        const promised=Promise.resolve(7);let n=0;
        const asyncValues={[Symbol.asyncIterator](){return {next(){return Promise.resolve(n++?{done:true}:{done:false,value:promised});}};}};
        const p=Array.fromAsync(asyncValues).then(a=>yes(a[0]===promised));
        const q=Array.fromAsync([Promise.resolve(8)]).then(a=>yes(a[0]===8));
        const r=Array.fromAsync({length:1,0:Promise.resolve(9)}).then(a=>yes(a[0]===9));
        return out(p,q,r,1);
    }
    if (operation === 26) {
        const source={[Symbol.asyncIterator](){return {next(){log.push(1);return Promise.resolve({value:7,done:false});},return(){log.push(3);return Promise.reject(99);}};}};
        const p=Array.fromAsync(source,()=>{log.push(2);throw 42;}).then(()=>0,e=>yes(e===42));
        const q=Array.fromAsync({get [Symbol.iterator](){throw 5;}},3).then(()=>0,e=>yes(e instanceof TypeError));
        return out(p,q,1,1);
    }
    if (operation === 27) {
        function C(){log.push(4);}
        const source={[Symbol.asyncIterator](){log.push(1);return {get next(){log.push(2);throw 42;},return(){log.push(3);return {};}};}};
        const p=Array.fromAsync.call(C,source).then(()=>0,e=>yes(e===42));
        const q=Array.fromAsync.call(function(n){this.n=n;},{length:2,0:1,1:2}).then(a=>yes(a.n===2&&a.length===2&&a[1]===2));
        return out(p,q,1,1);
    }
    if (operation === 28) {
        function C(){Object.defineProperty(this,"length",{set(){log.push(3);throw 42;}});}
        const source={[Symbol.asyncIterator](){return {next(){log.push(1);return {get done(){log.push(2);return true;},get value(){throw 99;}};},return(){log.push(4);return Promise.resolve({});}};}};
        const p=Array.fromAsync.call(C,source).then(()=>0,e=>yes(e===42));
        const q=Array.fromAsync({length:0}).then(a=>yes(a.length===0));
        return out(p,q,1,1);
    }
    throw new RangeError("unknown Array intrinsic consumer");
})
