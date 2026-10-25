#!/usr/bin/env python3
"""Compare argument constructors and consumer property operations with pinned QuickJS.

The unchanged C engine is compiled into a separate process, never linked to Silk.
Records include descriptors, both-direction formal aliases, independent excess
values, all mapping-severance paths, strict callee errors and post-return reads.
Native deterministic constructor allocation failure tests are in
js_arguments_tests.silk. Both differential runtimes enforce zero allocator ledgers.
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
CASES = [(mapped, argc, operation) for mapped in (False, True)
         for argc in (0, 1, 2, 3, 4) for operation in range(5)]
FIELDS = ('length', 'length_flags', 'iterator_flags', 'iterator_identity',
          'callee_flags', 'callee_identity', 'initial_zero', 'formal_to_index',
          'set_accepted', 'index_to_formal', 'formal_after_define', 'index_after_formal',
          'extra_after_frame_write', 'frame_after_extra_write', 'callee_get_error',
          'callee_set_error', 'zero_after_return_gc', 'one_after_return_gc',
          'zero_present', 'zero_flags')
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes;
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
static uint32_t number(JSValue v){if(JS_IsUndefined(v))return UINT32_MAX;if(JS_VALUE_GET_TAG(v)!=JS_TAG_INT)abort();return JS_VALUE_GET_INT(v);}
static uint32_t property(JSContext *ctx,JSValue obj,JSAtom atom){JSValue v=checked(JS_GetProperty(ctx,obj,atom));uint32_t n=number(v);JS_FreeValue(ctx,v);return n;}
static unsigned error_kind(JSContext *ctx){JSValue e=JS_GetException(ctx);unsigned n=99;
 if(JS_IsObject(e))for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))n=i;
 JS_FreeValue(ctx,e);return n;}
static void run_case(JSContext *ctx,int mapped,int argc,int operation){
 const char *source="(function(a,b){return arguments;})";
 JSValue callable=checked(JS_Eval(ctx,source,strlen(source),"arguments.js",JS_EVAL_TYPE_GLOBAL));
 JSFunctionBytecode *b=JS_VALUE_GET_OBJ(callable)->u.func.function_bytecode;
 assert(b->arg_count==2&&b->vardefs[0].is_captured&&b->vardefs[1].is_captured);
 JSValue slots[4]={JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED},input[4];
 for(int i=0;i<argc;i++)input[i]=slots[i]=JS_NewInt32(ctx,i+10);
 JSVarRef **refs=calloc(b->var_ref_count,sizeof(*refs));if(!refs)abort();
 JSStackFrame sf={0};sf.cur_func=callable;sf.arg_buf=slots;sf.arg_count=argc;sf.var_refs=refs;sf.cur_pc=b->byte_code_buf+1;
 ctx->rt->current_stack_frame=&sf;
 JSValue object=checked(mapped?js_build_mapped_arguments(ctx,argc,input,&sf,argc<2?argc:2):js_build_arguments(ctx,argc,input));
 uint32_t out[20]={0};JSPropertyDescriptor d;
 out[0]=property(ctx,object,JS_ATOM_length);
 if(JS_GetOwnProperty(ctx,&d,object,JS_ATOM_length)!=1)abort();out[1]=d.flags;js_free_desc(ctx,&d);
 if(JS_GetOwnProperty(ctx,&d,object,JS_ATOM_Symbol_iterator)!=1)abort();out[2]=d.flags;
 out[3]=JS_VALUE_GET_PTR(d.value)==JS_VALUE_GET_PTR(ctx->array_proto_values);js_free_desc(ctx,&d);
 if(JS_GetOwnProperty(ctx,&d,object,JS_ATOM_callee)!=1)abort();out[4]=d.flags;
 out[5]=mapped?JS_VALUE_GET_PTR(d.value)==JS_VALUE_GET_PTR(callable):
   JS_VALUE_GET_PTR(d.getter)==JS_VALUE_GET_PTR(ctx->throw_type_error)&&JS_VALUE_GET_PTR(d.setter)==JS_VALUE_GET_PTR(ctx->throw_type_error);
 js_free_desc(ctx,&d);
 JSAtom zero=__JS_AtomFromUInt32(0),one=__JS_AtomFromUInt32(1),two=__JS_AtomFromUInt32(2);
 out[6]=property(ctx,object,zero);set_value(ctx,&slots[0],JS_NewInt32(ctx,31));out[7]=property(ctx,object,zero);
 int accepted=JS_SetProperty(ctx,object,zero,JS_NewInt32(ctx,42));if(accepted<0)abort();out[8]=accepted;out[9]=number(slots[0]);
 int changed;
 if(operation==0)changed=JS_DefineProperty(ctx,object,zero,JS_NewInt32(ctx,51),JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_VALUE);
 else if(operation==1)changed=JS_DefineProperty(ctx,object,zero,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_WRITABLE);
 else if(operation==2)changed=JS_DefineProperty(ctx,object,zero,JS_NewInt32(ctx,51),JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_VALUE|JS_PROP_HAS_WRITABLE);
 else if(operation==3)changed=JS_DefineProperty(ctx,object,zero,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_SET);
 else changed=JS_DeleteProperty(ctx,object,zero,0);
 if(changed!=1)abort();out[10]=number(slots[0]);set_value(ctx,&slots[0],JS_NewInt32(ctx,61));out[11]=property(ctx,object,zero);
 if(argc>2){set_value(ctx,&slots[2],JS_NewInt32(ctx,81));out[12]=property(ctx,object,two);
  if(JS_SetProperty(ctx,object,two,JS_NewInt32(ctx,82))!=1)abort();out[13]=number(slots[2]);}
 if(!mapped){JSValue result=JS_GetProperty(ctx,object,JS_ATOM_callee);if(JS_IsException(result))out[14]=error_kind(ctx);else JS_FreeValue(ctx,result);
  if(JS_SetProperty(ctx,object,JS_ATOM_callee,JS_NewInt32(ctx,1))<0)out[15]=error_kind(ctx);}
 close_var_refs(ctx->rt,b,&sf);ctx->rt->current_stack_frame=NULL;
 for(int i=0;i<4;i++)JS_FreeValue(ctx,slots[i]);free(refs);JS_RunGC(ctx->rt);
 out[16]=property(ctx,object,zero);out[17]=property(ctx,object,one);
 int found=JS_GetOwnProperty(ctx,&d,object,zero);if(found<0)abort();if(found){out[18]=1;out[19]=d.flags;js_free_desc(ctx,&d);}
 for(int i=0;i<20;i++)word(out[i]);JS_FreeValue(ctx,object);JS_FreeValue(ctx,callable);
}
int main(void){JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 CALLS
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;
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
import js_gc as gc
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_arguments_test_support as fixture
import js_property_mutations_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { mapped: bool, argc: usize, operation: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
 let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx=run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks=Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make()
 CALLS
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
 if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 {trap()}
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 let mut writer=StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
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
    calls = '\n'.join(f'run_case(ctx,{int(mapped)},{argc},{op});' for mapped, argc, op in CASES)
    rows = ',\n'.join(f'Case {{ mapped: {str(mapped).lower()}, argc: {argc}, operation: {op} }}' for mapped, argc, op in CASES)
    native_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize=0
 while at<cases.length {
  let record=run unsafe fixture.runCase(&mut hooks,&observer,ctx,cases[at].mapped,cases[at].argc,cases[at].operation)
   |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize=0
  while i<20 {run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i=i+1}
  at=at+1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-arguments-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Arguments C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Arguments C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', native_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="arguments-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native arguments oracle', cwd=temp)
        if len(expected) != len(CASES) * 80 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C argument record count or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset+4], actual[offset:offset+4]
                if c != native:
                    case, field = divmod(offset // 4, 20)
                    label = CASES[case] if case < len(CASES) else 'teardown'
                    raise SystemExit(f'Arguments {label}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; '
                                     f'bytes={len(expected)}/{len(actual)}')
        print(f'PASS arguments: {len(CASES)} cases, {len(actual)//4} words; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both teardown ledgers zero')


if __name__ == '__main__':
    main()
