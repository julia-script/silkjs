#!/usr/bin/env python3
"""Differential JS_PrintValue proof using real native Engine and separate pinned C.

No production C linkage. Checks exact output bytes, getter/proxy nonexecution,
source option limits and native allocation cleanup at every injected ordinal.
Raw pointer-bearing output is checked structurally, not compared across processes.
Converted sparse arrays are checked against explicit bytes: only fast arrays
print a dense prefix and trailing-hole summary, matching the pinned source.
Negative depth remains a native safety assertion, NOT a passing differential:
pinned C converts uint32 max_depth through signed min_int, retains UINT_MAX,
and overflows its eight-entry print_stack (ASan: quickjs.c:14511).
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import struct
import subprocess
from verify_bytecode import executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = (False, False, 2, 1000, 100)


def cases():
    rows = []
    def add(name, source, expected=None, options=DEFAULT, argument=False, runtime=False):
        rows.append((name, source, expected, options, argument, runtime))
    for expression, expected in [('undefined', b'undefined'), ('null', b'null'), ('true', b'true'), ('false', b'false'), ('-0', b'-0'), ('NaN', b'NaN'), ('Infinity', b'Infinity'), ('-Infinity', b'-Infinity'), ('42', b'42'), ('123n', b'123n'), ('-123n', b'-123n')]:
        add('scalar-' + expression, expression, expected)
    add('bigint-positive', '1234567890123456789012345678901234567890n', b'1234567890123456789012345678901234567890n')
    add('bigint-negative', '-1234567890123456789012345678901234567890n', b'-1234567890123456789012345678901234567890n')
    add('string-escapes', r'''"a\t\r\n\b\f\\\"\x00\x7f\x9f\ud800\udc00\ud800x\udc00"''')
    add('string-empty', "''", b'""')
    add('string-truncated', "'abcd'", b'"ab"... 2 more characters', (False,False,2,2,100))
    add('string-one-truncated', "'abc'", b'"ab"... 1 more character', (False,False,2,2,100))
    add('string-unlimited', "'x'.repeat(1024)", b'"'+b'x'*1024+b'"', (False,False,2,0,100))
    add('string-surrogate-boundary', r'''"\ud83d\ude00x"''', b'"\\ud83d"... 2 more characters', (False,False,2,1,100))
    add('rope', "Array.from({length:40},(_,i)=>String.fromCharCode(65+i%26)).reduce((a,b)=>a+b,'')")
    add('raw-console-string', r'''"a\x00b\n\ud800"''', argument=True)
    add('console-object', '({x:1})', b'{ x: 1 }', argument=True)
    add('empty-object', '({})', b'{  }')
    add('array-empty', '[]', b'[  ]')
    add('array-dense', '[1,2,3]', b'[ 1, 2, 3 ]')
    add('array-holes', 'new Array(3)', b'[ <3 empty items> ]')
    add('array-one-hole', '[1,,]', b'[ 1, <1 empty item> ]')
    add('array-sparse', '(()=>{let a=[];a[5]=7;a.x=8;return a})()', b'[ 5: 7, x: 8 ]')
    add('array-index-descriptor', 'Object.defineProperty([1,2],0,{get(){throw Error("getter called")}})', b'[ 0: [Getter], 1: 2 ]')
    add('array-hidden', '[1,2]', options=(True,False,2,1000,100))
    add('array-limit', '[1,2,3,4]', b'[ 1, 2, ... 2 more items ]', (False,False,2,1000,2))
    add('property-order', '({z:1,2:2,a:3,1:4})')
    add('property-escaping', '({"":1,"a-b":2,"é":3,"1x":4,$:5,_x:6})')
    add('symbols', '({[Symbol("x")]:Symbol("a-b"),[Symbol()]:Symbol.for("global")})')
    add('getter-setter', 'Object.defineProperties({},{x:{get(){throw 1},enumerable:true},y:{set(v){throw 2},enumerable:true},z:{get(){throw 3},set(v){throw 4},enumerable:true}})', b'{ x: [Getter], y: [Setter], z: [Getter/Setter] }')
    add('non-enumerable', 'Object.defineProperty({a:1},"hidden",{value:2})', b'{ a: 1 }')
    add('show-hidden', 'Object.defineProperty({a:1},"hidden",{value:2})', b'{ a: 1, hidden: 2 }', (True,False,2,1000,100))
    add('own-property-limit', '({a:1,b:2,c:3})', b'{ a: 1, ... 2 more items }', (False,False,2,1000,1))
    add('unlimited-count', '({a:1,b:2,c:3})', b'{ a: 1, b: 2, c: 3 }', (False,False,2,1000,0))
    add('circular-root', '(()=>{let a={};a.self=a;return a})()', b'{ self: [circular 0] }')
    add('circular-child', '(()=>{let a={child:{}};a.child.self=a.child;return a})()', b'{ child: { self: [circular 1] } }')
    add('repeated-not-circular', '(()=>{let a={x:1};return [a,a]})()', b'[ { x: 1 }, { x: 1 } ]')
    add('depth-default', '({a:{b:{c:1}}})', b'{ a: { b: [Object] } }')
    add('depth-one', '({a:{b:1}})', b'{ a: [Object] }', (False,False,1,1000,100))
    for depth in [0,-1,8,100]:
        add('depth-clamped-'+str(depth), '({a:{a:{a:{a:{a:{a:{a:{a:{x:1}}}}}}}}})', b'{ a: { a: { a: { a: { a: { a: { a: { a: [Object] } } } } } } } }', options=(False,False,depth,1000,100))
    for expr in ['function named(){}','(()=>{})','(function(){}).bind(null)','async function named(){}','function* named(){}','class Named{}']:
        add('function-'+expr, '('+expr+')')
    add('function-no-name-getter', 'Object.defineProperty(function f(){},"name",{get(){throw 1}})', b'[Function (anonymous)]')
    add('function-properties', 'Object.assign(function f(){},{x:1})', b'[Function f] { x: 1 }')
    add('function-hidden', '(function f(){})', options=(True,False,2,1000,100))
    for expr in ['new Map()', 'new Set()', 'new Map([[1,2],["x",{y:3}]])','new Set([1,"x",{}])']:
        add(expr,expr)
    add('map-limit','new Map([[1,2],[3,4],[5,6]])', b'Map(3) { 1 => 2, ... 2 more items }',(False,False,2,1000,1))
    add('set-circular','(()=>{let s=new Set();s.add(s);return s})()',b'Set(1) { [circular 0] }')
    add('map-properties','Object.assign(new Map([[1,2]]),{x:3})',b'Map(1) { 1 => 2, x: 3 }')
    for cls in ['Uint8ClampedArray','Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array','Float16Array','Float32Array','Float64Array']:
        add(cls, 'new '+cls+'([0,1,-1,65537,-0,NaN,Infinity])')
    for cls in ['BigInt64Array','BigUint64Array']:
        add(cls, 'new '+cls+'([0n,1n,-1n,9223372036854775808n,18446744073709551615n])')
    add('typed-limit','new Uint8Array([1,2,3])',b'Uint8Array(3) [ 1, ... 2 more items ]',(False,False,2,1000,1))
    add('typed-shared','new Uint32Array(new SharedArrayBuffer(8))')
    add('date','new Date(0)',b'1970-01-01T00:00:00.000Z')
    add('date-invalid','new Date(NaN)',b'Date {  }')
    add('date-poisoned-method','Object.defineProperty(new Date(0),"toISOString",{get(){throw 1}})',b'1970-01-01T00:00:00.000Z')
    for expr in ['/a/gi','new RegExp("")','new RegExp("a/b\\nc\\r")','/[a/]/u','new RegExp("é")']:
        add('regexp-'+expr,expr)
    add('error','(()=>{let e=new TypeError("bad");delete e.stack;return e})()',b'TypeError: bad')
    add('error-stack','(()=>{let e=new Error("bad");e.stack="frame1\\nframe2\\n";return e})()',b'Error: bad\nframe1\nframe2')
    add('error-getter','Object.defineProperties(new Error(),{name:{get(){throw 1}},message:{get(){throw 2}},stack:{get(){throw 3}}})',b'Error')
    add('error-nul','(()=>{let e=new Error("bad\\0ignored");e.name="Oops\\0ignored";delete e.stack;return e})()',b'Oops: bad { name: "Oops\\u0000ignored" }')
    for expr in ['Promise.resolve(1)','Promise.reject(2)','new WeakMap()','new WeakSet()','new Number(1)','new String("ab")','new Boolean(true)','Object(1n)','new ArrayBuffer(3)','new DataView(new ArrayBuffer(3))']:
        add(expr,expr)
    add('proxy-no-traps','new Proxy({a:1},new Proxy({},{get(){throw Error("trap invoked")}}))',b'Object {  }')
    add('proxy-revoked','(()=>{let p=Proxy.revocable({},{});p.revoke();return p.proxy})()',b'Object {  }')
    add('class-instance','new (class X {constructor(){this.x=1}})()',b'{ x: 1 }')
    for expr in ['new Date(0)','/a/g','new Error("x")','function named(){}','123456789012345678901234567890n']:
        add('runtime-only-'+expr,'('+expr+')',runtime=True)
    add('raw-bigint-positive','123456789012345678901234567890n',options=(False,True,2,1000,100))
    add('raw-bigint-negative','-123456789012345678901234567890n',options=(False,True,2,1000,100))
    add('raw-function','(function named(){})',b'[Function]',(False,True,2,1000,100))
    add('raw-pointer-getter', '({get x(){throw 1}})', options=(False,True,2,1000,100))
    add('raw-pointer-depth', '({child:{x:1}})', options=(False,True,1,1000,100))
    add('raw-closure', '(()=>{let x=42;return function captured(){return x}})()', options=(False,True,2,1000,100))
    return rows


def literal(source):
    return 'b"'+''.join(chr(b) if 32 <= b < 127 and b not in (34,92) else '\\x%02x'%b for b in source.encode())+'"'


def generated(rows, faults):
    out=['import js_value_print { Options }',f'pub const COUNT: usize = {len(rows)}',f'pub const FAULTS: bool = {str(faults).lower()}']
    for name,typ,values in [('source',"&'static [u8]",[literal(r[1]) for r in rows]),('argument','bool',[str(r[4]).lower() for r in rows]),('runtimeOnly','bool',[str(r[5]).lower() for r in rows])]:
        out.append(f'pub fn {name}(index: usize) -> {typ} {{ return match index {{')
        out.extend(f'{i} => {v}' for i,v in enumerate(values));out.append('_ => Intrinsic.trap("invalid print case") } }')
    out.append('pub fn options(index: usize) -> Options { return match index {')
    for i,row in enumerate(rows):
        h,r,d,s,c=row[3]
        out.append(f'{i} => Options {{ showHidden: {str(h).lower()}, rawDump: {str(r).lower()}, maxDepth: {d}, maxStringLength: {s}, maxItemCount: {c} }}')
    out.append('_ => Intrinsic.trap("invalid print options") } }')
    return '\n'.join(out)+'\n'


def oracle_source(rows):
    entries=[]
    for _,src,_,opts,arg,rt in rows:
        h,r,d,s,c=opts
        entries.append('{'+json.dumps(src,ensure_ascii=True)+f',{int(h)},{int(r)},{d},{s}u,{c}u,{int(arg)},{int(rt)}'+'}')
    return r'''#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static struct {const char *source; int hidden,raw,depth; unsigned string_limit,item_limit; int argument,runtime;} cases[]={ENTRIES};
static unsigned char *buffer; static size_t length,capacity;
static void emit(void *opaque,const char *bytes,size_t size){
 if(length+size>capacity){capacity=(length+size)*2+64;buffer=realloc(buffer,capacity);if(!buffer)exit(10);}
 memcpy(buffer+length,bytes,size);length+=size;
}
static void word(unsigned n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
int main(void){
 for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){
  /* Negative depth triggers source UB, not an oracle result. Native safety is
     checked independently; retain an empty record for this excluded oracle. */
  if(cases[i].depth<0){word(0);continue;}
  JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);if(!ctx)return 2;
  JSValue value=JS_Eval(ctx,cases[i].source,strlen(cases[i].source),"value-print-case.js",0);
  if(JS_IsException(value)){fprintf(stderr,"evaluation failed at case %u\n",i);return 3;}
  JSPrintValueOptions o;JS_PrintValueSetDefaultOptions(&o);
  o.show_hidden=cases[i].hidden;o.raw_dump=cases[i].raw;o.max_depth=cases[i].depth;
  o.max_string_length=cases[i].string_limit;o.max_item_count=cases[i].item_limit;length=0;
  if(cases[i].argument && JS_IsString(value)){size_t n;const char *s=JS_ToCStringLen(ctx,&n,value);if(!s)return 4;emit(NULL,s,n);JS_FreeCString(ctx,s);}
  else if(cases[i].runtime)JS_PrintValueRT(rt,emit,NULL,value,&o);
  else JS_PrintValue(ctx,emit,NULL,value,&o);
  word(length);fwrite(buffer,1,length,stdout);JS_FreeValue(ctx,value);
  JSValue exception=JS_GetException(ctx);JS_FreeValue(ctx,exception);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);
 }
 free(buffer);return 0;
}
'''.replace('ENTRIES',',\n'.join(entries))


def records(data,count):
    out=[];at=0
    for i in range(count):
        if at+4>len(data):raise ValueError(f'missing record {i}')
        n=struct.unpack_from('<I',data,at)[0];at+=4
        if at+n>len(data):raise ValueError(f'truncated record {i}')
        out.append(data[at:at+n]);at+=n
    return out,data[at:]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--upstream',type=Path,default=Path('/private/tmp/silkjs-quickjs-reference-20261023'))
    p.add_argument('--silk',default=str(ROOT/'build/toolchain-main-dd2e99ab/silk-fixed5'))
    p.add_argument('--stdlib',type=Path,default=ROOT/'build/toolchain-main-dd2e99ab/stdlib')
    p.add_argument('--cc',default='/opt/homebrew/opt/llvm/bin/clang')
    p.add_argument('--cflag',action='append',default=[])
    p.add_argument('--build-dir',type=Path,default=ROOT/'build/value-print-differential')
    p.add_argument('--timeout',type=int,default=1800)
    p.add_argument('--case')
    p.add_argument('--skip-faults',action='store_true')
    a=p.parse_args();reference=a.upstream.resolve();validate_pins(reference)
    rows=cases()
    if a.case:rows=[r for r in rows if a.case in r[0]]
    if not rows:raise SystemExit('No printer cases selected')
    build=a.build_dir.resolve();build.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'src',build/'src',dirs_exist_ok=True)
    shutil.copyfile(ROOT/'silk.toml',build/'silk.toml')
    (build/'src/js_value_print_cases_generated.silk').write_text(generated(rows,not a.skip_faults))
    (build/'oracle.c').write_text(oracle_source(rows))
    (build/'cases.json').write_text(json.dumps([r[0] for r in rows],indent=2))
    support=[reference/n for n in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]
    process([executable_path(a.cc),'-std=gnu11','-O2','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_VERSION="2026-06-04"',*a.cflag,'-I',str(reference),str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')],a.timeout,owner='Pinned printer oracle compilation')
    expected=process([str(build/'oracle')],a.timeout,owner='Pinned printer execution')
    (build/'expected.bin').write_bytes(expected)
    process([executable_path(a.silk),'build',str(build/'src/js_value_print_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(a.stdlib.resolve()),'--optimization','speed','--debug','false'],a.timeout,owner='Native printer fixture compilation')
    native=subprocess.run([str(build/'native')],capture_output=True,timeout=a.timeout)
    (build/'actual.bin').write_bytes(native.stdout)
    if native.returncode:raise SystemExit(f'Native printer exit {native.returncode}; artifacts {build}\n'+native.stderr.decode(errors='replace'))
    wanted,rest=records(expected,len(rows));actual,trailer=records(native.stdout,len(rows))
    if rest:raise SystemExit('Unexpected oracle trailing bytes')
    differences=[]
    for row,c,n in zip(rows,wanted,actual):
        if row[3][2] < 0:
            if c != b'': differences.append(f'{row[0]} unexpectedly executed undefined C oracle')
            if row[2] is None or n != row[2]: differences.append(f'{row[0]} violates native safety bytes {row[2]!r}: native={n!r}')
            continue
        if row[0].startswith('raw-pointer-'):
            # Addresses are process-local, but grammar and nonzero identity are
            # independently required. Never normalize other printed numbers.
            if not re.search(rb'0x[1-9a-f][0-9a-f]*', c) or not re.search(rb'0x[1-9a-f][0-9a-f]*', n):
                differences.append(f'{row[0]} missing native pointer: C={c!r}, native={n!r}')
            c=re.sub(rb'0x[1-9a-f][0-9a-f]*',b'<address>',c)
            n=re.sub(rb'0x[1-9a-f][0-9a-f]*',b'<address>',n)
        if c!=n:differences.append(f'{row[0]}: C={c!r}, native={n!r}')
        if row[2] is not None and (c!=row[2] or n!=row[2]):differences.append(f'{row[0]} violates independent expected bytes {row[2]!r}: C={c!r}, native={n!r}')
    if differences:raise SystemExit('\n'.join(differences))
    if len(trailer)!=12:raise SystemExit('Missing complete allocation sweep trailer')
    count,attempts,injected=struct.unpack('<III',trailer)
    if not a.skip_faults and (count!=len(rows) or injected==0 or attempts!=injected+count):raise SystemExit(f'Incomplete sweep {(count,attempts,injected)}')
    undefined=sum(row[3][2] < 0 for row in rows)
    print(f'JS_PrintValue: {len(rows)-undefined} source-defined real Engine cases match pinned C and independent byte assertions; sha256={hashlib.sha256(expected).hexdigest()}')
    print(f'Source-undefined oracle cases: {undefined}; independently checked native safety cases: {undefined} (not passing differentials)')
    print(f'Ownership: {count} cases, {attempts} attempts, {injected} injected failures; zero live allocations/bytes after teardown')
    print(f'Artifacts: {build}')

if __name__=='__main__':main()
