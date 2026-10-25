#!/usr/bin/env python3
"""Execute actual native Silk and pinned-C callbacks for every native protocol.

C is a separate oracle process, never a Silk binding. Records include frame and
realm observations, padding, constructor flags, conversions, own descriptors,
iterator results and captured ownership; both allocation ledgers must be zero.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(protocol, argc, mode) for protocol in range(15)
         for argc in (0, 1, 2, 3) for mode in range(12)]
FIELDS = ('success_or_object', 'number_low', 'number_high', 'error', 'callbacks',
          'argc', 'readable', 'frame_argc', 'frame_realm_bits', 'receiver_tag',
          'magic', 'flags', 'length_attributes', 'name_attributes', 'name_length',
          'constructor', 'frame_restored', 'capture_object_refs', 'capture_string_refs',
          'coercions', 'result_tag', 'length', 'iterator_done', 'iterator_value', 'reentry')
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;
static void *allocate(JSMallocState *s,size_t n) {
 if(!n)return NULL;Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static uint32_t rec[25];static JSValue expected_function,nested;static JSContext *expected_context;
static int throwing,done_mode;
static int numeric(JSValueConst v){return JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):0;}
static JSValue inner(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv){
 if(!ctx->rt->current_stack_frame||!ctx->rt->current_stack_frame->prev_frame)abort();
 rec[24]++;return JS_NewInt32(ctx,99);
}
static JSValue observed(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int readable,int magic,int flags){
 JSStackFrame *frame=ctx->rt->current_stack_frame;rec[4]++;rec[5]=argc;rec[6]=readable;
 rec[9]=JS_VALUE_GET_TAG(receiver);rec[10]=magic;rec[11]=flags;rec[8]=ctx==expected_context?1:0;
 if(frame){rec[7]=frame->arg_count;
  if(JS_VALUE_GET_PTR(frame->cur_func)==JS_VALUE_GET_PTR(expected_function))rec[8]|=2;
  if(frame->js_mode==0)rec[8]|=4;
 }else rec[8]|=8;
 int sum=numeric(receiver)+magic;
 for(int i=0;i<readable;i++){if(i>=argc&&!JS_IsUndefined(argv[i]))abort();if(i<argc)sum+=numeric(argv[i]);}
 JS_RunGC(ctx->rt);
 if(JS_IsObject(nested)){JSValue v=checked(js_call_c_function(ctx,nested,JS_UNDEFINED,0,NULL,0));
  if(numeric(v)!=99||ctx->rt->current_stack_frame!=frame)abort();JS_FreeValue(ctx,v);}
 if(throwing)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 return JS_NewInt32(ctx,sum);
}
static JSValue generic(JSContext *c,JSValueConst t,int n,JSValueConst *a){return observed(c,t,n,a,n<2?2:n,0,0);}
static JSValue magic(JSContext *c,JSValueConst t,int n,JSValueConst *a,int m){return observed(c,t,n,a,n<2?2:n,m,0);}
static JSValue flags(JSContext *c,JSValueConst f,JSValueConst t,int n,JSValueConst *a,int flags){
 if(JS_VALUE_GET_PTR(f)!=JS_VALUE_GET_PTR(expected_function))abort();return observed(c,t,n,a,n<2?2:n,0,flags);}
static double unary(double v){rec[4]++;return v+0.5;}
static double binary(double a,double b){rec[4]++;return a*10+b;}
static JSValue getter(JSContext *c,JSValueConst t){return observed(c,t,0,NULL,0,0,0);}
static JSValue setter(JSContext *c,JSValueConst t,JSValueConst v){return observed(c,t,1,&v,1,0,0);}
static JSValue get_magic(JSContext *c,JSValueConst t,int m){return observed(c,t,0,NULL,0,m,0);}
static JSValue set_magic(JSContext *c,JSValueConst t,JSValueConst v,int m){return observed(c,t,1,&v,1,m,0);}
static JSValue iterator(JSContext *c,JSValueConst t,int n,JSValueConst *a,int *done,int m){
 *done=done_mode;return observed(c,t,n,a,n<2?2:n,m,0);}
static JSValue data(JSContext *c,JSValueConst t,int n,JSValueConst *a,int m,JSValue *captured){
 if(!JS_IsObject(captured[0])||!JS_IsString(captured[1]))abort();return observed(c,t,n,a,n<2?2:n,m,0);}
static JSValue convert(JSContext *c,JSValueConst t,int argc,JSValueConst *argv,int magic,JSValue *captured){
 rec[19]++;rec[9]=JS_VALUE_GET_TAG(t);
 if(magic==1)return JS_Throw(c,JS_NewInt32(c,3));
 if(magic==3){if(JS_DefinePropertyValue(c,t,JS_ATOM_Symbol_toPrimitive,JS_DupValue(c,captured[0]),7)<0)abort();}
 return JS_NewInt32(c,magic==0?5:3);
}
static JSValue coercion(JSContext *ctx,int fail){
 JSValue object=checked(JS_NewObject(ctx));
 JSValue replacement=checked(JS_NewCFunctionData(ctx,convert,1,0,0,NULL));
 JSValue closure=checked(JS_NewCFunctionData(ctx,convert,1,fail?1:3,1,&replacement));
 JS_FreeValue(ctx,replacement);
 if(JS_DefinePropertyValue(ctx,object,JS_ATOM_Symbol_toPrimitive,closure,7)<0)abort();return object;
}
static unsigned error_kind(JSContext *ctx,JSValue error){
 if(!JS_IsObject(error))return 99;JSObject *p=JS_VALUE_GET_OBJ(error);
 if(p->class_id!=JS_CLASS_ERROR)return 99;
 for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;
}
static void run_case(JSContext *ctx,int ordinal,int argc,int mode){
 memset(rec,0,sizeof(rec));JSContext *other=JS_NewContext(ctx->rt);if(!other)abort();
 JSValue captured[2]={checked(JS_NewObjectProto(ctx,JS_NULL)),checked(JS_NewString(ctx,"captured"))};
 int m=mode==7?32768:65535;JSCFunctionType callback={0};
 switch(ordinal){
 case 0:case 2:case 4:callback.generic=generic;break;
 case 1:case 3:case 5:callback.generic_magic=magic;break;
 case 6:callback.constructor_or_func_flags=flags;break;
 case 7:callback.f_f=unary;break;case 8:callback.f_f_f=binary;break;
 case 9:callback.getter=getter;break;case 10:callback.setter=setter;break;
 case 11:callback.getter_magic=get_magic;break;case 12:callback.setter_magic=set_magic;break;
 case 13:callback.iterator_next=iterator;break;
 }
 JSValue function=checked(ordinal==14?JS_NewCFunctionData(other,data,2,m,2,captured):
   JS_NewCFunction2(other,callback.generic,"native\0ignored",2,ordinal,m));
 expected_function=function;expected_context=ordinal==14?ctx:other;throwing=mode==2;
 done_mode=mode==5?1:mode==6?2:0;nested=JS_UNDEFINED;
 if(mode==3&&ordinal!=14)nested=checked(JS_NewCFunction(other,inner,"inner",0));
 JSValue args[3]={JS_NewInt32(ctx,3),JS_NewInt32(ctx,5),JS_NewInt32(ctx,7)};
 if((mode==4||mode==10)&&(ordinal==7||ordinal==8)){args[0]=coercion(ctx,mode==10);args[1]=JS_DupValue(ctx,args[0]);}
 rec[17]=__js_rc(JS_VALUE_GET_PTR(captured[0]))->ref_count;rec[18]=__js_rc(JS_VALUE_GET_PTR(captured[1]))->ref_count;
 if(mode==8&&ordinal==14&&JS_DefinePropertyValue(ctx,captured[0],JS_ATOM_value,JS_DupValue(ctx,function),7)<0)abort();
 JSStackFrame *previous=ctx->rt->current_stack_frame;uintptr_t limit=ctx->rt->stack_limit;
 if(mode==9)ctx->rt->stack_limit=UINTPTR_MAX;
 int flags=mode==1?5:mode==11?-1:0;
 JSValue result=ordinal==14?js_c_function_data_call(ctx,function,JS_NewInt32(ctx,11),argc,args,flags):
  js_call_c_function(ctx,function,JS_NewInt32(ctx,11),argc,args,flags);
 ctx->rt->stack_limit=limit;JSValue output=JS_UNDEFINED;
 if(JS_IsException(result)){JSValue error=JS_GetException(ctx);rec[3]=JS_IsNumber(error)?numeric(error):100+error_kind(other,error);JS_FreeValue(ctx,error);}
 else {output=result;rec[0]=1;}
 rec[16]=ctx->rt->current_stack_frame==previous;
 if(JS_IsNumber(output)){union {double d;uint64_t u;} bits;JS_ToFloat64(ctx,&bits.d,output);rec[1]=bits.u;rec[2]=bits.u>>32;}
 else if(JS_IsObject(output)){
  rec[0]=2;JSPropertyDescriptor value,done;
  if(JS_GetOwnProperty(ctx,&value,output,JS_ATOM_value)!=1||JS_GetOwnProperty(ctx,&done,output,JS_ATOM_done)!=1)abort();
  if(value.flags!=7||done.flags!=7)abort();rec[23]=numeric(value.value);rec[22]=JS_ToBool(ctx,done.value);
  JS_FreeValue(ctx,value.value);JS_FreeValue(ctx,value.getter);JS_FreeValue(ctx,value.setter);
  JS_FreeValue(ctx,done.value);JS_FreeValue(ctx,done.getter);JS_FreeValue(ctx,done.setter);
 }
 JSPropertyDescriptor length,name;
 if(JS_GetOwnProperty(ctx,&length,function,JS_ATOM_length)!=1||JS_GetOwnProperty(ctx,&name,function,JS_ATOM_name)!=1)abort();
 rec[12]=length.flags;rec[13]=name.flags;rec[14]=JS_VALUE_GET_STRING(name.value)->len;
 rec[15]=JS_VALUE_GET_OBJ(function)->is_constructor;rec[20]=JS_VALUE_GET_TAG(output);rec[21]=numeric(length.value);
 JS_FreeValue(ctx,length.value);JS_FreeValue(ctx,length.getter);JS_FreeValue(ctx,length.setter);
 JS_FreeValue(ctx,name.value);JS_FreeValue(ctx,name.getter);JS_FreeValue(ctx,name.setter);
 for(int i=0;i<25;i++)word(rec[i]);
 JS_FreeValue(ctx,output);JS_FreeValue(ctx,nested);JS_FreeValue(ctx,function);
 JS_FreeValue(ctx,captured[0]);JS_FreeValue(ctx,captured[1]);for(int i=0;i<3;i++)JS_FreeValue(ctx,args[i]);
 JS_FreeContext(other);JS_RunGC(ctx->rt);
}
int main(void){JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 CALLS
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);return live_count||live_bytes?1:0;
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
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_native_function_test_support as fixture
import js_native_function_test_support { Hooks }
import js_property_get_test_support as base
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { protocol: u32, argc: u32, mode: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe base.prepare(&mut hooks.inner.base, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 let mut writer = StdoutWriter.make()
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = '\n'.join(f'run_case(ctx,{p},{n},{m});' for p, n, m in CASES)
    rows = ',\n'.join(f'Case {{ protocol: {p}, argc: {n}, mode: {m} }}' for p, n, m in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < cases.length {
  let record = run unsafe fixture.runCase(&observer, ctx, cases[at].protocol, cases[at].argc, cases[at].mode)
    |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0
  while i < 25 { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-native-functions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Native function C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Native function C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="native-functions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native Silk function oracle', cwd=temp)
        if len(expected) != len(CASES) * 100 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C records or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset + 4], actual[offset:offset + 4]
                if c != native:
                    record, field = divmod(offset // 4, 25)
                    case = CASES[record] if record < len(CASES) else 'teardown'
                    raise SystemExit(f'Native function {case}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; '
                                     f'bytes={len(expected)}/{len(actual)}')
        print(f'PASS native functions: {len(CASES)} cases; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both allocation ledgers zero')


if __name__ == '__main__':
    main()
