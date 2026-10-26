#!/usr/bin/env python3
"""Execute native Math adapters against a separate pinned QuickJS C consumer.

Ownership, errors, callbacks, tags, integer/rounding/precise-sum/random results
compare exactly. Only finite nonzero transcendental results may differ, by at
most four representable binary64 steps (fdlibm approximation plus platform-libm
rounding and composed hyperbolic operations). Signed zeros, infinities, domains,
and NaN classifications are never covered by this allowance. Every discrepancy
within the bound is counted and the maximum is reported, not silently normalized.
Independent C/native fault sweeps each require zero live blocks and bytes.
"""
import argparse
import hashlib
import math
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
NAMES = ('min max abs floor ceil round sqrt acos asin atan atan2 cos exp log pow sin '
         'tan trunc sign cosh sinh tanh acosh asinh atanh expm1 log1p log2 log10 cbrt '
         'hypot random f16round fround imul clz32 sumPrecise').split()
CASES = [(op, mode) for op in range(37) for mode in range(16 if op == 36 else 31)]
FIELDS = ('success', 'tag', 'bits_low', 'bits_high', 'error', 'events', 'callbacks',
          'steps', 'closes', 'iterator_refs', 'next_refs', 'random_low', 'random_high')
APPROXIMATED = {7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30}
SWEEPS = [(36, 1), (36, 5), (36, 11), (0, 30)]

# Adjacent encodings at reduction/domain/overflow boundaries plus deterministic
# unrestricted binary64 patterns. These are inputs, not implementation outputs.
BOUNDARIES = [
    0, 1, 0x000fffffffffffff, 0x0010000000000000, 0x3e30000000000000,
    0x3fe0000000000000, 0x3ff0000000000000, 0x3ff921fb54442d18,
    0x400921fb54442d18, 0x4000000000000000, 0x4045000000000000,
    0x40862e42fefa39ef, 0x408633ce8fb9f87d, 0x7e37e43c8800759c,
    0x7fefffffffffffff, 0x7ff0000000000000, 0x7ff8000000000123,
]
NUMBERS = sorted({(b + d) ^ sign for b in BOUNDARIES for d in (-1, 0, 1)
                  if 0 <= b + d < (1 << 63) for sign in (0, 1 << 63)})
_rng = random.Random(0x514A534D415448)
NUMBERS += [_rng.getrandbits(64) for _ in range(64)]
PAIRS = [(bits, NUMBERS[(i * 17 + 11) % len(NUMBERS)]) for i, bits in enumerate(NUMBERS)]
PAIRS += [(x, y) for x in (0, 1 << 63, 0x7ff0000000000000, 0xfff0000000000000)
          for y in (0, 1 << 63, 0x7ff0000000000000, 0xfff0000000000000)]
NUMERIC_CASES = [(op, x, y) for op in range(36) if op != 31 for x, y in PAIRS]
RECORDS = CASES + [(op, f'bits({x:016x},{y:016x})') for op, x, y in NUMERIC_CASES]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes,remaining,fault_count;static int armed;
static int fault(void){if(!armed)return 0;if(!remaining){armed=0;fault_count++;return 1;}remaining--;return 0;}
static void *allocate(JSMallocState*s,size_t n){if(!n||fault())return NULL;Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void release(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *resize(JSMallocState*s,void*p,size_t n){if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fault())return NULL;Header*h=(Header*)p-1;size_t old=h->size;Header*r=realloc(h,sizeof(*h)+n);if(!r)return NULL;r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;}
static size_t usable(const void*p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static JSValue frombits(uint64_t bits){double d;memcpy(&d,&bits,8);return __JS_NewFloat64(NULL,d);}
static uint32_t rec[13];static int mode,operation,done,argc;static unsigned steps,closes;
static JSValue iterator,next_method,return_method,current,function,args[3];
static const char *names[]={NAMES};
static JSValue observed(JSContext*,JSValueConst,int,JSValueConst*,int);
static JSValue host(JSContext*ctx,int id){return JS_NewCFunctionMagic(ctx,observed,"math fixture",0,JS_CFUNC_generic_magic,id);}
static int accessor(JSContext*ctx,JSValue object,JSAtom atom,int id){JSValue f=host(ctx,id);if(JS_IsException(f))return -1;return JS_DefinePropertyGetSet(ctx,object,atom,f,JS_UNDEFINED,7);}
static JSValue observed(JSContext*ctx,JSValueConst receiver,int ac,JSValueConst*av,int id){
 rec[6]++;rec[5]=rec[5]*16+id;JS_RunGC(ctx->rt);
 if(id<=3){if(mode==id+4||(mode==28&&id==2)||(mode==29&&id==3))return JS_Throw(ctx,JS_NewInt32(ctx,707));if(mode==30)return JS_NewObjectProto(ctx,JS_NULL);return JS_NewInt32(ctx,id==1?3:id==2?4:-5);}
 if((id==4&&mode==10)||(id==5&&mode==9)||(id==10&&mode==6)||(id==7&&mode==7)||(id==8&&mode==8)||(id==11&&mode==11)||(id==6&&mode==12))return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(id==4)return host(ctx,9);if(id==5)return JS_DupValue(ctx,next_method);if(id==6)return JS_DupValue(ctx,return_method);
 if(id==7)return JS_NewBool(ctx,done);if(id==8)return JS_DupValue(ctx,current);if(id==9)return JS_DupValue(ctx,iterator);
 if(id==11){closes++;return JS_NULL;}
 if(id==10){
  unsigned index=steps++;done=index>=3;if(mode==0)done=1;if(mode==15)done=index>=300;
  JSValue value=frombits(UINT64_C(0x8000000000000000));
  if(mode==1||mode==14)value=index==0?frombits(UINT64_C(0x4341c37937e08000)):index==1?JS_NewInt32(ctx,1):frombits(UINT64_C(0xc341c37937e08000));
  else if(mode==3)value=JS_NewInt32(ctx,0);
  else if(mode==4)value=frombits(index==1?UINT64_C(0xfff0000000000000):UINT64_C(0x7ff0000000000000));
  else if(mode==5||mode==11||mode==12)value=JS_DupValue(ctx,iterator);
  else if(mode==13)value=index==1?JS_DupValue(ctx,iterator):frombits(UINT64_C(0x7ff8000000000000));
  else if(mode==15)value=JS_NewInt32(ctx,1);
  JS_FreeValue(ctx,current);current=value;
  JSValue result=JS_NewObjectProto(ctx,JS_NULL);if(JS_IsException(result))return result;
  if(accessor(ctx,result,JS_ATOM_done,7)<0||accessor(ctx,result,JS_ATOM_value,8)<0){JS_FreeValue(ctx,result);return JS_EXCEPTION;}
  return result;
 }
 abort();
}
static JSValue native_next(JSContext*ctx,JSValueConst receiver,int ac,JSValueConst*av,int*out,int magic){
 JSValue result=observed(ctx,receiver,ac,av,10);if(JS_IsException(result)){*out=0;return result;}JS_FreeValue(ctx,result);*out=done;return JS_DupValue(ctx,current);
}
static void setup(JSContext*ctx,int op,int m){
 mode=m;operation=op;memset(rec,0,sizeof(rec));steps=closes=done=0;
 iterator=next_method=return_method=current=JS_UNDEFINED;
 JSValue global=JS_GetGlobalObject(ctx),math=checked(JS_GetPropertyStr(ctx,global,"Math"));JS_FreeValue(ctx,global);
 function=checked(JS_GetPropertyStr(ctx,math,names[op]));JS_FreeValue(ctx,math);
 args[0]=JS_NewInt32(ctx,3);args[1]=JS_NewInt32(ctx,4);args[2]=JS_NewInt32(ctx,-5);argc=3;
 if(m==0)argc=0;if(m==10){argc=1;args[0]=frombits(UINT64_C(0x8000000000000000));}if(m==11)argc=2;
 if(m==2){args[0]=frombits(UINT64_C(0x8000000000000000));args[1]=JS_NewInt32(ctx,0);args[2]=args[0];}
 if((m>=3&&m<=7)||(m>=28&&m<=30)){for(int i=0;i<3;i++){args[i]=checked(JS_NewObjectProto(ctx,JS_NULL));if(JS_DefinePropertyValue(ctx,args[i],JS_ATOM_Symbol_toPrimitive,checked(host(ctx,i+1)),7)<0)abort();}if(m==3||m==28||m==29){JS_FreeValue(ctx,args[0]);args[0]=frombits(UINT64_C(0x7ff8000000000000));}}
 if(m==8){args[0]=JS_UNDEFINED;args[1]=JS_NULL;args[2]=JS_TRUE;}
 if(m==9){args[0]=frombits(UINT64_C(0x7ff0000000000000));args[1]=frombits(UINT64_C(0x7ff8000000000000));args[2]=frombits(UINT64_C(0xfff0000000000000));}
 static const uint64_t bits[]={UINT64_C(0xbfe0000000000000),UINT64_C(0x3ff0020000000001),UINT64_C(0x000fffffffffffff),UINT64_C(1),UINT64_C(0x7e37e43c8800759c),UINT64_C(0xfe37e43c8800759c),UINT64_C(0x7fefffffffffffff),UINT64_C(0xbff0000000000000),UINT64_C(0x3ff0000000000000),UINT64_C(0x3fe0000000000000),UINT64_C(0xfff0000000000000),UINT64_C(0xfff8000000000123),UINT64_C(0x400921fb54442d18),UINT64_C(0xc0874910d52d3051),UINT64_C(0x8000000000000001),UINT64_C(0x3ff0000010000000)};
 if(m>=12&&m<28){args[0]=frombits(bits[m-12]);args[1]=frombits(UINT64_C(0x8000000000000000));args[2]=frombits(bits[m-12]^UINT64_C(0x8000000000000000));}
 if(op==36){for(int i=0;i<3;i++){JS_FreeValue(ctx,args[i]);args[i]=JS_UNDEFINED;}iterator=checked(JS_NewObjectProto(ctx,JS_NULL));
  if(m==14){JSCFunctionType f;f.iterator_next=native_next;next_method=checked(JS_NewCFunction2(ctx,f.generic,"math fixture",0,JS_CFUNC_iterator_next,0));}else next_method=checked(host(ctx,10));
  return_method=checked(host(ctx,11));args[0]=checked(JS_NewObjectProto(ctx,JS_NULL));
  if(accessor(ctx,args[0],JS_ATOM_Symbol_iterator,4)<0||accessor(ctx,iterator,JS_ATOM_next,5)<0||accessor(ctx,iterator,JS_ATOM_return,6)<0)abort();argc=1;
 }
 ctx->random_state=m?m:1;
}
static void teardown(JSContext*ctx){JS_FreeValue(ctx,function);for(int i=0;i<3;i++)JS_FreeValue(ctx,args[i]);JS_FreeValue(ctx,current);JS_FreeValue(ctx,iterator);JS_FreeValue(ctx,next_method);JS_FreeValue(ctx,return_method);JS_RunGC(ctx->rt);}
static unsigned error_kind(JSContext*ctx,JSValue v){if(!JS_IsObject(v))return 99;JSObject*p=JS_VALUE_GET_OBJ(v);if(p->class_id!=JS_CLASS_ERROR)return 98;for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 97;}
static void run_case(JSContext*ctx,int op,int m){
 setup(ctx,op,m);JSValue result=JS_Call(ctx,function,JS_UNDEFINED,argc,args);
 if(JS_IsException(result)){JSValue error=JS_GetException(ctx);rec[4]=JS_IsNumber(error)?JS_VALUE_GET_INT(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}else rec[0]=1;
 rec[1]=JS_VALUE_GET_TAG(result);
 if(JS_IsNumber(result)){double d=JS_VALUE_GET_TAG(result)==JS_TAG_INT?JS_VALUE_GET_INT(result):JS_VALUE_GET_FLOAT64(result);uint64_t bits;memcpy(&bits,&d,8);if(isnan(d))bits=UINT64_C(0x7ff8000000000000);rec[2]=bits;rec[3]=bits>>32;}
 rec[7]=steps;rec[8]=closes;if(JS_IsObject(iterator)){rec[9]=__js_rc(JS_VALUE_GET_PTR(iterator))->ref_count;rec[10]=__js_rc(JS_VALUE_GET_PTR(next_method))->ref_count;}
 rec[11]=ctx->random_state;rec[12]=ctx->random_state>>32;
 for(int i=0;i<13;i++)word(rec[i]);JS_FreeValue(ctx,result);teardown(ctx);
}
static void run_numbers(JSContext*ctx,int op,uint64_t left,uint64_t right){
 setup(ctx,op,1);args[0]=frombits(left);args[1]=frombits(right);
 JSValue result=checked(JS_Call(ctx,function,JS_UNDEFINED,2,args));memset(rec,0,sizeof(rec));
 rec[0]=1;rec[1]=JS_VALUE_GET_TAG(result);double d=JS_VALUE_GET_TAG(result)==JS_TAG_INT?JS_VALUE_GET_INT(result):JS_VALUE_GET_FLOAT64(result);
 uint64_t bits;memcpy(&bits,&d,8);if(isnan(d))bits=UINT64_C(0x7ff8000000000000);rec[2]=bits;rec[3]=bits>>32;
 for(int i=0;i<13;i++)word(rec[i]);JS_FreeValue(ctx,result);teardown(ctx);
}
static unsigned sweep(int op,int m){unsigned failures=0,successes=0;for(size_t p=0;p<160;p++){
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();setup(ctx,op,m);
 remaining=p;fault_count=0;armed=1;JSValue result=JS_Call(ctx,function,JS_UNDEFINED,argc,args);armed=0;
 if(fault_count)failures++;else successes++;
 if(JS_IsException(result)){if(!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);JS_FreeValue(ctx,error);}else JS_FreeValue(ctx,result);
 teardown(ctx);JS_FreeContext(ctx);JS_FreeRuntime(rt);if(live_count||live_bytes)abort();
 }return 4|(failures?1:0)|(successes?2:0);}
int main(int argc,char**argv){
 if(argc==4&&strcmp(argv[1],"sweep")==0){word(sweep(atoi(argv[2]),atoi(argv[3])));word(live_count);word(live_bytes);return 0;}
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 CALLS
 JS_FreeContext(ctx);JS_FreeRuntime(rt);if(live_count||live_bytes)abort();word(live_count);word(live_bytes);return 0;
}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_runtime as runtime
import native_stack { currentFrameAddress }
import js_gc as gc
import js_string_types { StringLengthError }
import js_exceptions { JsException }
import js_math_intrinsics_test_support as fixture
import js_math_intrinsics_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { operation: u32, mode: u32 }
struct Numbers { operation: u32, left: u64, right: u64 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 SWEEPS
 let mut writer = StdoutWriter.make()
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def ordered(bits):
    return (~bits & ((1 << 64) - 1)) if bits >> 63 else bits | (1 << 63)


def compare(expected, actual):
    expected_size = len(RECORDS) * 52 + 8
    if len(expected) != expected_size or expected[-8:] != bytes(8):
        raise SystemExit(f'Invalid C records/ledger: {len(expected)} bytes')
    if len(actual) != expected_size + 4 * len(SWEEPS) or actual[expected_size - 8:expected_size] != bytes(8):
        raise SystemExit(f'Invalid native records/ledger: {len(actual)} bytes')
    differences = maximum = 0
    for row, (op, mode) in enumerate(RECORDS):
        c = struct.unpack_from('<13I', expected, row * 52)
        s = struct.unpack_from('<13I', actual, row * 52)
        for field in (0, 1, *range(4, 13)):
            if c[field] != s[field]:
                raise SystemExit(f'{NAMES[op]} mode={mode} {FIELDS[field]}: C={c[field]} native={s[field]}')
        cb, sb = c[2] | c[3] << 32, s[2] | s[3] << 32
        if cb == sb:
            continue
        cv, sv = struct.unpack('<d', struct.pack('<Q', cb))[0], struct.unpack('<d', struct.pack('<Q', sb))[0]
        distance = abs(ordered(cb) - ordered(sb))
        if op not in APPROXIMATED or not all(math.isfinite(v) and v != 0.0 for v in (cv, sv)) or distance > 4:
            raise SystemExit(f'{NAMES[op]} mode={mode}: C=0x{cb:016x} native=0x{sb:016x}, ULP={distance}')
        differences += 1
        maximum = max(maximum, distance)
    flags = struct.unpack_from(f'<{len(SWEEPS)}I', actual, expected_size)
    if flags != (7,) * len(SWEEPS):
        raise SystemExit(f'Native allocation sweeps did not exercise faults/success and empty ledgers: {flags}')
    return differences, maximum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = '\n'.join(f'run_case(ctx,{op},{mode});' for op, mode in CASES)
    rows = ',\n'.join(f'Case {{ operation: {op}, mode: {mode} }}' for op, mode in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < cases.length {
  let record = run unsafe fixture.runCase(&mut hooks, ctx, cases[at].operation, cases[at].mode) |> Effect.provideMut<Allocator>(&mut memory)
  let mut field: usize = 0
  while field < 13 { run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
  at = at + 1
 }
'''
    c_calls += '\n' + '\n'.join(f'run_numbers(ctx,{op},UINT64_C(0x{x:016x}),UINT64_C(0x{y:016x}));'
                               for op, x, y in NUMERIC_CASES)
    numeric_rows = ',\n'.join(f'Numbers {{ operation: {op}, left: 0x{x:016x}, right: 0x{y:016x} }}'
                             for op, x, y in NUMERIC_CASES)
    s_calls += f'\nlet numbers: [Numbers; {len(NUMERIC_CASES)}] = [{numeric_rows}]\n' + r'''
 at = 0
 while at < numbers.length {
  let record = run unsafe fixture.runNumbers(&mut hooks, ctx, numbers[at].operation, numbers[at].left, numbers[at].right) |> Effect.provideMut<Allocator>(&mut memory)
  let mut field: usize = 0
  while field < 13 { run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
  at = at + 1
 }
'''
    s_sweeps = '\n'.join(f'let sweep{i} = run unsafe fixture.allocationSweep({op}, {mode}) |> Effect.provideMut<Allocator>(&mut system)\nrun out.writeU32(sweep{i}) |> Effect.provideMut<Allocator>(&mut system)' for i, (op, mode) in enumerate(SWEEPS))
    with tempfile.TemporaryDirectory(prefix='silkjs-math-intrinsics-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('NAMES', ','.join(f'"{name}"' for name in NAMES)).replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Math C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Math C behavior oracle')
        # Separate processes isolate and expose source crashes/leaks per fault scenario.
        for op, mode in SWEEPS:
            result = process([str(temp / 'oracle'), 'sweep', str(op), str(mode)], 600, owner=f'Math C fault sweep {op}/{mode}')
            if result != struct.pack('<III', 7, 0, 0):
                raise SystemExit(f'C fault sweep {op}/{mode}: {result.hex()}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls).replace('SWEEPS', s_sweeps))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="math-intrinsics-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1800, owner='Native Math behavior and fault oracle', cwd=temp)
        differences, maximum = compare(expected, actual)
        print(f'PASS Math intrinsics: {len(CASES)} behavioral and {len(NUMERIC_CASES)} numeric cases; {len(SWEEPS)} independently isolated C/native fault sweeps; '
              f'{differences} bounded numeric contrasts, maximum {maximum} ULP; {pins} pinned QuickJS files; '
              f'native SHA256={hashlib.sha256(actual).hexdigest()}; both ledgers empty')


if __name__ == '__main__':
    main()
