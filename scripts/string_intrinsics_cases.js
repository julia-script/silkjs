(function (which) {
    function units(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a.join(','); }
    function error(f) { try { f(); return 'none'; } catch (e) { return e.name; } }
    var log = [], s, a, r, it;
    switch (which) {
    case 0:
        return [String(), String(undefined), String(Symbol('x')), String(Symbol()),
            error(function () { new String(Symbol('x')); })].join('|');
    case 1:
        s = new String('A\ud800B');
        var d = Object.getOwnPropertyDescriptor(s, '1'), l = Object.getOwnPropertyDescriptor(s, 'length');
        return [s.length, units(s[1]), d.writable, d.enumerable, d.configurable,
            l.writable, l.enumerable, l.configurable, s.valueOf() === 'A\ud800B',
            error(function () { String.prototype.valueOf.call({}); })].join('|');
    case 2:
        return [units(String.fromCharCode(-1, 65536, 65537, NaN)),
            units(String.fromCodePoint(0x1f600, 0xd800, 0x10ffff)),
            error(function () { String.fromCodePoint(1.5); }),
            error(function () { String.fromCodePoint(Infinity); })].join('|');
    case 3:
        return [error(function () { String.fromCodePoint({valueOf:function(){log.push(1);return 65;}},
            {valueOf:function(){log.push(2);return 0x110000;}}, {valueOf:function(){log.push(3);return 66;}}); }), log.join(',')].join('|');
    case 4:
        s = String.raw({get raw(){log.push(1);return {get length(){log.push(2);return 3;},
            get 0(){log.push(3);return 'a';},get 1(){log.push(5);return 'b';},get 2(){log.push(7);return 'c';}};}},
            {toString:function(){log.push(4);return 'X';}}, {toString:function(){log.push(6);return 'Y';}});
        return s + '|' + log.join(',') + '|' + String.raw({raw:['a','b','c']}, 'X');
    case 5:
        s = 'A\ud83d\ude00\ud800Z';
        return [s.length, units(s.at(-2)), units(s.charAt(2)), s.charCodeAt(1), s.codePointAt(1),
            s.codePointAt(2), s.at(99), s.codePointAt(-1), Number.isNaN(s.charCodeAt(99)), s.charAt(-1)].join('|');
    case 6:
        s = 'abcabc';
        return [s.indexOf('bc',2),s.lastIndexOf('bc'),s.lastIndexOf('bc',NaN),s.lastIndexOf('',Infinity),
            s.includes('bc',4),s.startsWith('bc',1),s.endsWith('bc',3),s.endsWith('',0),
            s.indexOf(''),s.indexOf('abcdabc'),s.lastIndexOf('abcdabc')].join('|');
    case 7:
        var needle = {get [Symbol.match](){log.push(2);return true;},toString:function(){log.push(3);return 'x';}};
        var receiver = {toString:function(){log.push(1);return 'x';}};
        return error(function(){String.prototype.includes.call(receiver,needle,{valueOf:function(){log.push(4);return 0;}});})+'|'+log.join(',');
    case 8:
        s = 'abcdef';
        return [s.substring(4,1),s.substring(-2,2),s.substr(-3,2),s.substr(2,-1),s.slice(-4,-1),s.slice(4,1),
            s.slice(-Infinity,Infinity)].join('|');
    case 9:
        s = {toString:function(){log.push(1);return 'abc';}};
        r = String.prototype.slice.call(s,{valueOf:function(){log.push(2);return 1;}},{valueOf:function(){log.push(3);return 2;}});
        return r+'|'+log.join(',');
    case 10:
        return ['x'.padStart(6,'ab'),'x'.padEnd(6,'ab'),'x'.padStart(100,''),
            'ab'.repeat(3),'x'.repeat(NaN),error(function(){''.repeat(Infinity);}),
            error(function(){'x'.repeat(-1);}),error(function(){'x'.repeat(0x40000000);})].join('|');
    case 11:
        r = 'long'.padStart({valueOf:function(){log.push(1);return 2;}},{toString:function(){log.push(2);throw 1;}});
        return r+'|'+log.join(',')+'|'+'x'.padEnd(Infinity,'');
    case 12:
        s = '\uFEFF\u2000 a \u2029';
        return [s.trim(),units(s.trimStart()),units(s.trimEnd()),'\u0085'.trim().length,
            String.prototype.trimLeft === String.prototype.trimStart,
            String.prototype.trimRight === String.prototype.trimEnd].join('|');
    case 13:
        return [units('A\u03a3'.toLowerCase()),units('A\u03a3\u0301'.toLowerCase()),
            units('A\u03a3B'.toLowerCase()),units('\u0130'.toLowerCase()),
            'Stra\u00dfe'.toUpperCase(),units('\ud800'.toUpperCase()),
            '\ud801\udc00'.toLowerCase().codePointAt(0)].join('|');
    case 14:
        return [units('e\u0301'.normalize()),units('\u00e9'.normalize('NFD')),
            units('\ufb03'.normalize('NFKC')),units('\u212b'.normalize('NFKD')),
            units('\ud800'.normalize()),error(function(){'x'.normalize('NFC\0');})].join('|');
    case 15:
        return ['e\u0301'.localeCompare('\u00e9'),'\ud800\udc00'.localeCompare('\uffff'),
            'a'.localeCompare('z'),'I'.toLocaleLowerCase('tr'), '\u0130'.toLocaleLowerCase('tr').length,
            'i'.toLocaleUpperCase({toString:function(){throw 1;}})].join('|');
    case 16:
        s='\ud800A\udc00\ud83d\ude00';
        return [s.isWellFormed(),units(s.toWellFormed()),'\ud83d\ude00'.isWellFormed(),
            '\ud83d\ude00'.toWellFormed() === '\ud83d\ude00'].join('|');
    case 17:
        var left='x'.repeat(64)+'\ud83d', right='\ude00'+'y'.repeat(64);
        s=left.concat(right);
        return [s.length,s.codePointAt(64),s.isWellFormed(),units(s.slice(64,66)),s.indexOf('\ud83d\ude00'),
            s.replace('\ud83d\ude00','Q').length,s.split('\ud83d\ude00').map(function(v){return v.length;}).join(',')].join('|');
    case 18:
        it='A\ud83d\ude00\ud800'[Symbol.iterator]();a=[];
        while(!(r=it.next()).done)a.push(units(r.value));
        return a.join(';')+'|'+it.next().done+'|'+it.next().value+'|'+
            error(function(){it.next.call({});})+'|'+Object.prototype.toString.call(it);
    case 19:
        var receiver={toString:function(){log.push(9);return 'bad';}};
        var matcher={get [Symbol.match](){log.push(1);return function(x){log.push(x===receiver?2:3);return 77;};}};
        return String.prototype.match.call(receiver,matcher)+'|'+log.join(',');
    case 20:
        var matcher={get [Symbol.matchAll](){log.push(1);return function(){log.push(4);return 5;};},
            get [Symbol.match](){log.push(2);return true;},get flags(){log.push(3);return '';}};
        return error(function(){'a'.matchAll(matcher);})+'|'+log.join(',');
    case 21:
        var matcher={get [Symbol.match](){log.push(1);return true;},get flags(){log.push(2);return '';},
            get [Symbol.replace](){log.push(3);return function(){return 1;};}};
        return error(function(){'a'.replaceAll(matcher,'b');})+'|'+log.join(',');
    case 22:
        return ['abc'.replace('b',"[$$][$&][$`][$'][$1][$<x>]"),
            'aba'.replaceAll('a','X'),'ab'.replaceAll('','-'),''.replaceAll('','-'),
            'abc'.replace('z',{toString:function(){log.push(1);return 'x';}}),log.join(',')].join('|');
    case 23:
        s='aba'.replaceAll('a',function(match,index,input){log.push(match+':'+index+':'+input);return {toString:function(){log.push('s');return index;}};});
        return s+'|'+log.join(',');
    case 24:
        return ['abc'.replace(/(?<x>b)(c)?/,"$<x>-$2-$1-$01-$3"),
            'aba'.replace(/a/g,function(m,i,s){log.push(m+':'+i+':'+s);return i;}),log.join(',')].join('|');
    case 25:
        r='a1b22'.match(/\d+/g);a=Array.from('a1b22'.matchAll(/(\d+)/g),function(m){return m[1]+':'+m.index;});
        var rx=/b/g;rx.lastIndex=2;
        return r.join(',')+'|'+a.join(',')+'|'+'abc'.search(rx)+'|'+rx.lastIndex+'|'+'abc'.match('b')[0];
    case 26:
        return ['ab'.split('').join(','),'a,b,'.split(',').join(':'),''.split('').length,
            ''.split(',').length,'abc'.split(undefined).join(','),'abc'.split(',',0).length,
            'a1b2'.split(/(\d)/).join(':')].join('|');
    case 27:
        var separator={get [Symbol.split](){log.push(1);return undefined;},toString:function(){log.push(4);return ',';}};
        var receiver={toString:function(){log.push(2);return 'a,b';}};
        r=String.prototype.split.call(receiver,separator,{valueOf:function(){log.push(3);return 0;}});
        return r.length+'|'+log.join(',');
    case 28:
        return ['x'.anchor('a"<&'),'x'.link('"'),'x'.fontcolor('red'),'x'.fontsize(3),
            error(function(){'x'.anchor();}),error(function(){'x'.link(null);})].join('|');
    case 29:
        return ['x'.big(),'x'.blink(),'x'.bold(),'x'.fixed(),'x'.italics(),'x'.small(),'x'.strike(),'x'.sub(),'x'.sup()].join('|');
    case 30:
        var target=function(){};target.prototype={p:42};
        s=Reflect.construct(String,['xy'],target);
        return [s.p,s.length,s[0],String.prototype.valueOf.call(s),Object.getPrototypeOf(s)===target.prototype].join('|');
    case 31:
        var target=new Proxy(function(){},{get:function(t,k){if(k==='prototype'){log.push('p');return {};}return t[k];}});
        s=Reflect.construct(String,[{toString:function(){log.push('s');return 'x';}}],target);
        return String.prototype.valueOf.call(s)+'|'+log.join(',');
    case 32:
        var rx=/a/g;rx.exec=function(){log.push('exec');if(log.length===1)return {0:'a',1:'Z',length:2,index:0,groups:{get x(){log.push('group');return 'N';}}};return null;};
        return 'abc'.replace(rx,'$1:$<x>')+'|'+log.join(',');
    case 33:
        var proto=String.prototype, names=['at','charAt','charCodeAt','codePointAt','concat','includes','slice','repeat','trim','normalize','isWellFormed','toWellFormed','match','matchAll','search','replace','replaceAll','split'];
        a=[];for(var i=0;i<names.length;i++)a.push(error((function(n){return function(){proto[n].call(null);};})(names[i])));
        return a.every(function(x){return x==='TypeError';})+'|'+error(function(){String.raw(null);});
    case 34:
        var receiver={toString:function(){throw 1;}}, replacement={}, limit={};
        var matcher={
            get [Symbol.search](){log.push(1);return function(x){return x===receiver?11:0;};},
            get [Symbol.replace](){log.push(2);return function(x,y){return x===receiver&&y===replacement?22:0;};},
            get [Symbol.split](){log.push(3);return function(x,y){return x===receiver&&y===limit?33:0;};}};
        a=[String.prototype.search.call(receiver,matcher),String.prototype.replace.call(receiver,matcher,replacement),
            String.prototype.split.call(receiver,matcher,limit)];
        a.push(error(function(){String.prototype.search.call(null,matcher);}));
        return a.join('|')+'|'+log.join(',');
    case 35:
        var matcher={get [Symbol.matchAll](){log.push(1);return null;},get [Symbol.match](){log.push(2);return true;},
            get flags(){log.push(3);return null;}};
        return error(function(){'x'.matchAll(matcher);})+'|'+log.join(',');
    case 36:
        s=String.raw({get raw(){log.push(1);return {get length(){log.push(2);return -1;},get 0(){throw 1;}};}},
            {toString:function(){throw 1;}});
        return s+'|'+log.join(',')+'|'+String.raw({raw:'ab'},'X');
    case 37:
        var raw='x'.repeat(64)+'y'.repeat(64);
        s='a'.concat(raw,{toString:function(){log.push(1);return 'b';}},{toString:function(){log.push(2);return 'c';}});
        return [s.length,s.slice(0,2),s.slice(-3),s.indexOf('y'),log.join(',')].join('|');
    default: throw new Error('unknown String intrinsic consumer');
    }
})
