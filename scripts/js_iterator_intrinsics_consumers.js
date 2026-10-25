/* Real VM cases for the pinned quickjs.c:46171-46553 consumers.
   Invoke the expression with operation 0..10. Every expected result is
   [1,1,1,1,[]], except case 8's log [1,2,3,4,3,3,3]. Run both the pinned
   QuickJS oracle and the native engine; no mock iterator engine is involved. */
(function (operation) {
    "use strict";
    const P = Iterator.prototype, log = [];
    const out = (a,b,c,d) => [+!!a,+!!b,+!!c,+!!d,log];
    const error = f => { try { f(); } catch (e) { return e; } };
    const sequence = values => {
        let i = 0;
        return {next() { return i < values.length ? {value:values[i++],done:false} : {done:true}; }};
    };
    if (operation === 0) {
        let closes=0, gets=0, correct=true;
        for (const name of ["every","find","forEach","some","reduce"]) {
            const it={get next(){gets++;throw 7;},return(){closes++;throw 99;}};
            correct = correct && error(()=>P[name].call(it,null)) instanceof TypeError;
        }
        let coerced=0;
        const it={get next(){gets++;throw 7;},return(){closes++;return {};}};
        const e=error(()=>P.includes.call(it,0,{valueOf(){coerced++;return 0;}}));
        return out(correct,closes===6,gets===0,e instanceof TypeError&&coerced===0);
    }
    if (operation === 1) {
        let closes=0, correct=true;
        for (const name of ["every","find","forEach","some","includes","join","toArray"]) {
            const it={get next(){throw 7;},return(){closes++;return {};}};
            correct = correct && error(()=>P[name].call(it,()=>true))===7;
        }
        const before=closes;
        const it={get next(){throw 8;},return(){closes++;throw 99;}};
        return out(correct,before===0,error(()=>P.reduce.call(it,()=>0))===8,closes===1);
    }
    if (operation === 2) {
        let closes=0, count=0, correct=true;
        for (const name of ["every","find","forEach","some","includes","join","reduce","toArray"]) {
            for (const stage of [0,1,2,3]) {
                const it={next(){count++;if(stage===0)throw 7;if(stage===1)return 0;
                    return {get done(){if(stage===2)throw 7;return false;},get value(){throw 7;}};},
                    return(){closes++;return {};}};
                const e=error(()=>P[name].call(it,()=>true));
                correct=correct&&(stage===1?e instanceof TypeError:e===7);
            }
        }
        return out(correct,closes===0,count===32,true);
    }
    if (operation === 3) {
        let closes=0, calls=0, correct=true;
        for (const name of ["every","find","forEach","some","reduce"]) {
            const it=sequence([{},{}]);it.return=()=>{closes++;throw 99;};
            correct=correct&&error(()=>P[name].call(it,()=>{calls++;throw 42;},0))===42;
        }
        const it=sequence([1]);Object.defineProperty(it,"return",{get(){closes++;throw 88;}});
        const precedence=error(()=>P.some.call(it,()=>{throw 42;}));
        return out(correct,calls===5,closes===6,precedence===42);
    }
    if (operation === 4) {
        let closes=0, steps=0, correct=true;
        const value={};
        for (const name of ["every","some","find","includes"]) {
            const it={next(){steps++;return {value,done:false};},return(){closes++;return {};}};
            const r=P[name].call(it,name==="includes"?value:()=>name!=="every");
            correct=correct&&(name==="find"?r===value:name==="every"?r===false:r===true);
        }
        const bad=sequence([1]);bad.return=()=>0;
        const throwing=sequence([1]);throwing.return=()=>{throw 33;};
        return out(correct,steps===4&&closes===4,error(()=>P.some.call(bad,()=>true)) instanceof TypeError,
            error(()=>P.includes.call(throwing,1))===33);
    }
    if (operation === 5) {
        let indices="", calls=0, closed=0, receiver=true, getter=0;
        const it=sequence([2,3]);const next=it.next;
        Object.defineProperty(it,"next",{get(){getter++;return next;}});
        it.return=()=>{closed++;return {};};
        const r=P.forEach.call(it,function(v,i){receiver=receiver&&this===undefined;
            indices+=i+":"+v+";";calls++;return {};});
        return out(r===undefined&&receiver,indices==="0:2;1:3;"&&calls===2,getter===1&&closed===0,
            P.every.call(sequence([]),()=>false)===true&&P.some.call(sequence([]),()=>true)===false&&P.find.call(sequence([]),()=>true)===undefined);
    }
    if (operation === 6) {
        let closes=0, steps=0, correct=true;
        for (const skip of [NaN,0.5,"0",null,1n,{},-1,-Infinity,9007199254740992]) {
            const it={next(){steps++;return {done:true};},return(){closes++;return {};}};
            const e=error(()=>P.includes.call(it,0,skip));
            correct=correct&&(typeof skip==="number"&&(skip<0||skip>9007199254740991)?e instanceof RangeError:e instanceof TypeError);
        }
        const object={};
        return out(correct&&closes===9&&steps===0,
            P.includes.call(sequence([NaN]),NaN)&&P.includes.call(sequence([-0]),0),
            !P.includes.call(sequence([1,2]),2,Infinity)&&!P.includes.call(sequence([1,2]),1,1),
            P.includes.call(sequence([object]),object,-0)&&!P.includes.call(sequence([{}]),{}));
    }
    if (operation === 7) {
        let closes=0, indices="";
        const empty=sequence([]);empty.return=()=>{closes++;throw 99;};
        const e=error(()=>P.reduce.call(empty,()=>0));
        const noInitial=P.reduce.call(sequence([2,3,4]),(a,v,i)=>{indices+=i;return a*10+v;});
        const initial={}, same=P.reduce.call(sequence([1,2]),(a,v,i)=>{indices+=i;return a;},initial);
        return out(e instanceof TypeError&&closes===1,
            P.reduce.call(sequence([]),()=>99,undefined)===undefined,
            noInitial===234&&indices==="1201",same===initial);
    }
    if (operation === 8) {
        const separator={toString(){log.push(1);return "\u0100";}};
        let i=0;
        const it={get next(){log.push(2);return function(){log.push(3);return i++<3?
            {value:i===1?{toString(){log.push(4);return "A";}}:i===2?null:undefined,done:false}:{done:true};};},
            return(){throw 99;}};
        const joined=P.join.call(it,separator);
        return out(joined==="A\u0100\u0100",P.join.call(sequence([null,undefined,2]))===",,2",
            P.join.call(sequence([]))==="",P.join.call(sequence(["a","b"]),"")==="ab");
    }
    if (operation === 9) {
        let closes=0, nextGets=0;
        const separatorFailure={get next(){nextGets++;return ()=>({done:true});},return(){closes++;throw 99;}};
        const a=error(()=>P.join.call(separatorFailure,{toString(){throw 42;}}));
        const itemFailure=sequence([{toString(){throw 43;}}]);itemFailure.return=()=>{closes++;throw 99;};
        const b=error(()=>P.join.call(itemFailure));
        const symbol=sequence([Symbol()]);symbol.return=()=>{closes++;return {};};
        const c=error(()=>P.join.call(symbol));
        return out(a===42&&nextGets===0,b===43,c instanceof TypeError,closes===3);
    }
    if (operation === 10) {
        const value={};let index=0, closes=0, values=0;
        const it={next(){index++;if(index===1)return {value,done:false};if(index===2)return {value:undefined,done:false};
            return {done:true,get value(){values++;throw 99;}};},return(){closes++;return {};},get [Symbol.iterator](){throw 99;}};
        const a=P.toArray.call(it);
        let coerced=0, correct=true;
        const bad={toString(){coerced++;throw 99;}};
        for(const name of ["every","find","forEach","some","includes","join","reduce","toArray"])
            correct=correct&&error(()=>P[name].call(null,bad)) instanceof TypeError;
        return out(Array.isArray(a)&&a.length===2&&a[0]===value,a[1]===undefined&&Object.prototype.hasOwnProperty.call(a,1),
            index===3&&values===0&&closes===0,correct&&coerced===0);
    }
    throw new RangeError("unknown iterator consumer case");
})
