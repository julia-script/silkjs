#!/usr/bin/env python3
"""Compare production native iterator algorithms with unchanged pinned QuickJS C.

C is an independent executable, never linked into Silk. Records include property
and callback order, call-entry polls, native fastpath frame/argv observations,
exception categories, record transitions and retained wrapper edges. Both sides
also sweep their own allocation sites and require empty allocation ledgers.
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
CASES = [(operation, mode) for operation in range(11) for mode in range(26)]
FIELDS = ('result_tag', 'number', 'done', 'error', 'callbacks', 'event_order',
          'call_entry_polls', 'native_argv0_tag', 'native_no_frame', 'uncatchable',
          'iterator_slot_tag', 'next_slot_tag', 'catch_slot_tag', 'output_tag',
          'output_done', 'iterator_refs', 'next_refs', 'wrapper_iterator_identity',
          'wrapper_class_prototype', 'reentries')
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes, remaining, fault_count;
static int armed;
static int fault(void) {
 if (!armed) return 0;
 if (!remaining) { armed=0; fault_count++; return 1; }
 remaining--; return 0;
}
static void *allocate(JSMallocState *s,size_t n) {
 if (!n || fault()) return NULL;
 Header *h=malloc(sizeof(*h)+n); if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fault())return NULL;
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static uint32_t rec[20];static int mode,operation;
static JSValue iterator,result,acquire_method,next_method,return_method,nested,input,prototype;
static JSValue *catch_slot;
static int numeric(JSValueConst v){int tag=JS_VALUE_GET_TAG(v);return tag==JS_TAG_INT||tag==JS_TAG_BOOL?JS_VALUE_GET_INT(v):0;}
static JSValue observed(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int id){
 rec[4]++;rec[5]=rec[5]*16+id;JS_RunGC(ctx->rt);
 if(operation==9&&id==2&&(!catch_slot||!JS_IsUndefined(*catch_slot)))abort();
 if(id==4){rec[19]++;return JS_NewInt32(ctx,99);}
 if((mode==5&&id<=3)||(mode==4&&id>=12)||(mode==8&&id==10)||(mode==9&&id==11)||(mode==16&&id==13))
  return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(id<=3){if(mode==6)return JS_NewInt32(ctx,19);return JS_DupValue(ctx,id==1?iterator:result);}
 if(id==10){
  if(mode==13){JSValue out=checked(JS_Call(ctx,nested,JS_UNDEFINED,0,NULL));JS_FreeValue(ctx,out);}
  return JS_NewBool(ctx,mode==7||mode==9);
 }
 if(id==11)return JS_NewInt32(ctx,41);
 if(id==15){if(mode%2==0||mode==25)return JS_UNDEFINED;if(mode==17)return JS_NULL;}
 if(mode==1||mode==25)return JS_UNDEFINED;
 if(mode==2)return JS_NULL;
 if(mode==3||mode==24)return JS_NewInt32(ctx,9);
 if(id==13){if(mode==17)return JS_NULL;return JS_DupValue(ctx,next_method);}
 return JS_DupValue(ctx,id==14?return_method:acquire_method);
}
static JSValue native_next(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int *done,int magic){
 if(magic!=37)abort();rec[4]++;rec[5]=rec[5]*16+2;
 rec[7]=JS_VALUE_GET_TAG(argv[0]);rec[8]=ctx->rt->current_stack_frame==NULL;JS_RunGC(ctx->rt);
 *done=0;if(mode==19)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(mode==11){*done=1;return JS_NewInt32(ctx,41);}
 if(mode==12){*done=2;return JS_DupValue(ctx,result);}
 return JS_NewInt32(ctx,41);
}
static JSValue method(JSContext *ctx,int id){return checked(JS_NewCFunctionMagic(ctx,observed,"iterator fixture",0,JS_CFUNC_generic_magic,id));}
static void accessor(JSContext *ctx,JSValue object,JSAtom atom,int id){
 if(JS_DefinePropertyGetSet(ctx,object,atom,method(ctx,id),JS_UNDEFINED,7)<0)abort();
}
static void setup(JSContext *ctx,int op,int m){
 mode=m;operation=op;memset(rec,0,sizeof(rec));
 iterator=checked(JS_NewObjectProto(ctx,JS_NULL));result=checked(JS_NewObjectProto(ctx,JS_NULL));
 acquire_method=method(ctx,1);return_method=method(ctx,3);nested=method(ctx,4);
 if((m>=10&&m<=12)||m==15||m==19){JSCFunctionType f;f.iterator_next=native_next;
  next_method=checked(JS_NewCFunction2(ctx,f.generic,"iterator fixture",1,JS_CFUNC_iterator_next,37));
 }else next_method=method(ctx,2);
 input=checked(JS_NewObjectProto(ctx,JS_NULL));prototype=checked(JS_NewObjectProto(ctx,JS_NULL));
 JS_SetClassProto(ctx,JS_CLASS_ASYNC_FROM_SYNC_ITERATOR,JS_DupValue(ctx,prototype));
 accessor(ctx,input,JS_ATOM_Symbol_iterator,12);accessor(ctx,input,JS_ATOM_Symbol_asyncIterator,15);
 accessor(ctx,iterator,JS_ATOM_next,13);accessor(ctx,iterator,JS_ATOM_return,14);
 accessor(ctx,result,JS_ATOM_done,10);accessor(ctx,result,JS_ATOM_value,11);
 rec[4]=rec[5]=0;ctx->interrupt_counter=10000;
}
static JSValue selected(JSValue method){if(mode==1)return JS_UNDEFINED;if(mode==2)return JS_NULL;if(mode==3)return JS_MKVAL(JS_TAG_INT,9);return method;}
static JSValue execute(JSContext *ctx,JSValue *stack,int *done){
 JSValue next=selected(next_method);
 if(operation<=1){JSValue object=input;if(mode==21)object=JS_NULL;if(mode==22)object=JS_UNDEFINED;return JS_GetIterator(ctx,object,operation==1);}
 if(operation==2){JSValue arg=JS_NewInt32(ctx,23);return JS_IteratorNext2(ctx,iterator,next,mode==15,&arg,done);}
 if(operation==3)return JS_IteratorNext(ctx,iterator,next,done);
 if(operation==4)return JS_IteratorGetCompleteValue(ctx,result,done);
 if(operation==5||operation==6)return JS_IteratorClose(ctx,iterator,operation==6)<0?JS_EXCEPTION:JS_UNDEFINED;
 if(operation==7)return js_for_of_start(ctx,stack+1,mode==18)<0?JS_EXCEPTION:JS_UNDEFINED;
 if(operation==8)return js_for_of_next(ctx,stack+3,-3)<0?JS_EXCEPTION:JS_UNDEFINED;
 if(operation==9)return js_for_await_of_next(ctx,stack+3)<0?JS_EXCEPTION:JS_UNDEFINED;
 return JS_CreateAsyncFromSyncIterator(ctx,iterator);
}
static unsigned error_kind(JSContext *ctx,JSValue error){
 if(!JS_IsObject(error))return 99;JSObject *p=JS_VALUE_GET_OBJ(error);if(p->class_id!=JS_CLASS_ERROR)return 98;
 for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 97;
}
static void teardown(JSContext *ctx){
 JS_FreeValue(ctx,input);JS_FreeValue(ctx,prototype);JS_FreeValue(ctx,iterator);JS_FreeValue(ctx,result);
 JS_FreeValue(ctx,acquire_method);JS_FreeValue(ctx,next_method);JS_FreeValue(ctx,return_method);JS_FreeValue(ctx,nested);
 JS_RunGC(ctx->rt);
}
static void run_case(JSContext *ctx,int op,int m){
 setup(ctx,op,m);JSValue stack[5]={JS_UNDEFINED,JS_UNDEFINED,JS_NewInt32(ctx,123),JS_UNDEFINED,JS_UNDEFINED};
 if(op==7)stack[0]=JS_DupValue(ctx,input);else{stack[0]=JS_DupValue(ctx,iterator);stack[1]=JS_DupValue(ctx,selected(next_method));}
 if(m==18&&op==8){JS_FreeValue(ctx,stack[0]);stack[0]=JS_UNDEFINED;}
 if(op==6){ctx->rt->current_exception=JS_NewInt32(ctx,808);ctx->rt->current_exception_is_uncatchable=m==14;}
 catch_slot=&stack[2];int done=0;JSValue output=execute(ctx,stack,&done);catch_slot=NULL;
 if(JS_IsException(output)){JSValue error=JS_GetException(ctx);rec[3]=JS_IsObject(error)?100+error_kind(ctx,error):numeric(error);JS_FreeValue(ctx,error);}
 rec[0]=JS_VALUE_GET_TAG(output);rec[1]=numeric(output);rec[2]=done;rec[6]=10000-ctx->interrupt_counter;
 rec[9]=ctx->rt->current_exception_is_uncatchable;
 rec[10]=JS_VALUE_GET_TAG(stack[0]);rec[11]=JS_VALUE_GET_TAG(stack[1]);rec[12]=JS_VALUE_GET_TAG(stack[2]);
 rec[13]=JS_VALUE_GET_TAG(stack[3]);rec[14]=numeric(stack[4]);
 if(op==7){
  rec[17]=JS_IsObject(stack[0])&&JS_VALUE_GET_PTR(stack[0])==JS_VALUE_GET_PTR(iterator);
  rec[15]=__js_rc(JS_VALUE_GET_PTR(iterator))->ref_count;rec[16]=__js_rc(JS_VALUE_GET_PTR(next_method))->ref_count;
 }
 if(JS_IsObject(output)&&JS_VALUE_GET_OBJ(output)->class_id==JS_CLASS_ASYNC_FROM_SYNC_ITERATOR){
  JSAsyncFromSyncIteratorData *data=JS_GetOpaque(output,JS_CLASS_ASYNC_FROM_SYNC_ITERATOR);
  rec[15]=__js_rc(JS_VALUE_GET_PTR(iterator))->ref_count;rec[16]=__js_rc(JS_VALUE_GET_PTR(next_method))->ref_count;
  rec[17]=JS_VALUE_GET_PTR(data->sync_iter)==JS_VALUE_GET_PTR(iterator);
  rec[18]=JS_VALUE_GET_OBJ(output)->shape->proto==JS_VALUE_GET_OBJ(prototype);
 }
 for(int i=0;i<20;i++)word(rec[i]);JS_FreeValue(ctx,output);for(int i=0;i<5;i++)JS_FreeValue(ctx,stack[i]);teardown(ctx);
}
static unsigned sweep(int op){
 unsigned failures=0,successes=0;
 for(size_t point=0;point<40;point++){
  JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
  setup(ctx,op,op==7?18:0);JSValue stack[5]={JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED};
  if(op==7)stack[0]=JS_DupValue(ctx,input);
  remaining=point;fault_count=0;armed=1;int done=0;JSValue output=execute(ctx,stack,&done);armed=0;
  if(JS_IsException(output)){failures++;if(fault_count!=1||!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);if(!JS_IsObject(error))abort();JS_FreeValue(ctx,error);}
  else {successes++;JS_FreeValue(ctx,output);}
  for(int i=0;i<5;i++)JS_FreeValue(ctx,stack[i]);
  if(__js_rc(JS_VALUE_GET_PTR(iterator))->ref_count!=1||__js_rc(JS_VALUE_GET_PTR(next_method))->ref_count!=1)abort();
  teardown(ctx);JS_FreeContext(ctx);JS_FreeRuntime(rt);if(live_count||live_bytes)abort();
 }
 return 4|(failures?1:0)|(successes?2:0);
}
int main(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 CALLS
 JS_FreeContext(ctx);JS_FreeRuntime(rt);if(live_count||live_bytes)abort();
 word(sweep(1));word(sweep(7));word(sweep(10));word(live_count);word(live_bytes);return live_count||live_bytes?1:0;
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
import js_iterator_test_support as fixture
import js_iterator_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { operation: u32, mode: u32 }
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
 let acquisition = run unsafe fixture.allocationSweep(1) |> Effect.provideMut<Allocator>(&mut system)
 let start = run unsafe fixture.allocationSweep(7) |> Effect.provideMut<Allocator>(&mut system)
 let wrapper = run unsafe fixture.allocationSweep(10) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(acquisition) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(start) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(wrapper) |> Effect.provideMut<Allocator>(&mut system)
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
  let record = run unsafe fixture.runCase(&mut hooks, ctx, cases[at].operation, cases[at].mode)
    |> Effect.provideMut<Allocator>(&mut memory)
  let mut field: usize = 0
  while field < 20 { run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-iterators-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Iterator C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Iterator C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="iterators-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native Silk iterator oracle', cwd=temp)
        trailer = (7).to_bytes(4, 'little') * 3 + bytes(8)
        if len(expected) != len(CASES) * 80 + 20 or expected[-20:] != trailer:
            raise SystemExit(f'Invalid C records/sweeps/ledger: bytes={len(expected)}, trailer={expected[-20:].hex()}')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset + 4], actual[offset:offset + 4]
                if c != native:
                    record, field = divmod(offset // 4, 20)
                    case = CASES[record] if record < len(CASES) else 'fault sweep / teardown'
                    raise SystemExit(f'Iterator {case}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; '
                                     f'bytes={len(expected)}/{len(actual)}')
        print(f'PASS iterators: {len(CASES)} cases and 3 allocation sweeps; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both allocation ledgers zero')


if __name__ == '__main__':
    main()
