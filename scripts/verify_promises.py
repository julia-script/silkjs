#!/usr/bin/env python3
"""Compare real native Promise callbacks/jobs with a separately compiled pinned C oracle.

No JavaScript VM substitutes or captured expected records. Fault sweeps are independent
per implementation and stay armed across job draining. Pinned C leaks a fulfillment
callback on allSettled rejection-callback allocation failure (quickjs.c:57123-57125),
and both an input promise and callback on any result-slot allocation failure
(57128-57130). The consumer measures these orphans before reclaiming them after
all jobs and roots are gone. Other C crashes/leaks fail; native ledgers must be
empty without corrective cleanup.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
CASES = [(op, 0) for op in range(30)] + [(op, 1) for op in (2, 5, 6, 7, 8, 11, 12, 17, 18, 19, 22)] + [(7, 2)]
SWEEPS = [(0, 0), (2, 0), (4, 0), (5, 0), (6, 1), (7, 2), (10, 0), (11, 0), (15, 0), (18, 0), (19, 1), (22, 0), (29, 0)]
FIELDS = ('success', 'initial_state_plus_one', 'final_state_plus_one', 'result', 'first', 'second',
          'callbacks', 'events', 'unhandled', 'handled', 'closes', 'jobs', 'pending_error',
          'extra', 'original_state_plus_one', 'keyed_null_prototype')
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
static unsigned operation,mode,calls,events,unhandled,handled,closes,steps,jobs,nested;
static JSValue roots[12];
static void tracker(JSContext*ctx,JSValueConst p,JSValueConst reason,JS_BOOL h,void*opaque){if(h)handled++;else unhandled++;JS_RunGC(ctx->rt);}
static unsigned number(JSValue v){return JS_IsNumber(v)?(unsigned)(JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v)):0;}
static JSValue observed(JSContext*,JSValueConst,int,JSValueConst*,int);
static JSValue host(JSContext*ctx,int id){return JS_NewCFunctionMagic(ctx,observed,"promise fixture",2,id==11?JS_CFUNC_constructor_magic:JS_CFUNC_generic_magic,id);}
static int define(JSContext*ctx,JSValue object,JSAtom atom,JSValue value){return JS_DefinePropertyValue(ctx,object,atom,value,7);}
static void accessor(JSContext*ctx,JSValue object,JSAtom atom,int id){if(JS_DefinePropertyGetSet(ctx,object,atom,checked(host(ctx,id)),JS_UNDEFINED,7)<0)abort();}
static int discard(JSContext*ctx,JSValue function,JSValue value){JSValue r=JS_Call(ctx,function,JS_UNDEFINED,1,&value);if(JS_IsException(r))return -1;JS_FreeValue(ctx,r);return 0;}
static int one_job(JSRuntime*rt){JSContext*ctx=NULL;int r=JS_ExecutePendingJob(rt,&ctx);if(r)jobs++;if(r<0){JSValue e=JS_GetException(ctx);JS_FreeValue(ctx,e);}return r;}
static void drain(JSRuntime*rt){while(JS_IsJobPending(rt)){one_job(rt);if(jobs>1000)abort();}}
static JSValue observed(JSContext*ctx,JSValueConst receiver,int argc,JSValueConst*argv,int id){
 calls++;events=events*17+id;JS_RunGC(ctx->rt);JSValue first=argc>0?argv[0]:JS_UNDEFINED,second=argc>1?argv[1]:JS_UNDEFINED;
 if(id==1||id==2){JSValue resolve=first,reject=second;if(mode==1&&id==2){resolve=second;reject=first;}if(discard(ctx,resolve,JS_NewInt32(ctx,41))<0||discard(ctx,reject,JS_NewInt32(ctx,99))<0)return JS_EXCEPTION;return JS_Throw(ctx,JS_NewInt32(ctx,707));}
 if(id==3){if(operation==20)return JS_Throw(ctx,JS_NewInt32(ctx,707));if(operation==27&&!nested){nested=1;one_job(ctx->rt);}return JS_NewInt32(ctx,number(first)+1);}
 if(id==4){if(mode==1)return JS_Throw(ctx,JS_NewInt32(ctx,707));return JS_NewInt32(ctx,5);}
 if(id==5)return JS_DupValue(ctx,receiver);
 if(id==6){if(operation==23)return JS_Throw(ctx,JS_NewInt32(ctx,707));unsigned at=steps++;int done=at>=2||operation==28;JSValue value=JS_NewInt32(ctx,at==1?22:11);
  if((mode==1&&at==1)||mode==2||operation==18)value=js_promise_resolve(ctx,ctx->promise_ctor,1,&value,1);
  if(JS_IsException(value))return value;return js_create_iterator_result(ctx,value,done);}
 if(id==7){closes++;if(mode==1)return JS_Throw(ctx,JS_NewInt32(ctx,909));return JS_NewObjectProto(ctx,JS_NULL);}
 if(id==8)return JS_DupValue(ctx,first);
 if(id==9){if(discard(ctx,first,JS_NewInt32(ctx,31))<0||discard(ctx,second,JS_NewInt32(ctx,32))<0||discard(ctx,first,JS_NewInt32(ctx,33))<0)return JS_EXCEPTION;return JS_UNDEFINED;}
 if(id==10)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(id==11){JSValue funcs[2],p=JS_NewPromiseCapability(ctx,funcs);if(JS_IsException(p))return p;JSValue r=JS_Call(ctx,first,JS_UNDEFINED,2,funcs);JS_FreeValue(ctx,r);
  if(mode==1&&operation==19){r=JS_Call(ctx,first,JS_UNDEFINED,2,funcs);if(JS_IsException(r)){JS_FreeValue(ctx,funcs[0]);JS_FreeValue(ctx,funcs[1]);JS_FreeValue(ctx,p);return JS_EXCEPTION;}JS_FreeValue(ctx,r);}
  JS_FreeValue(ctx,funcs[0]);JS_FreeValue(ctx,funcs[1]);return p;}
 if(id==12){if(JS_DeleteProperty(ctx,receiver,JS_ATOM_reason,0)<0)return JS_EXCEPTION;return JS_NewInt32(ctx,11);}
 abort();
}
static JSValue builtin(JSContext*ctx,int method){
 static const char*names[]={"Promise","resolve","reject","all","allSettled","allKeyed","allSettledKeyed","any","try","race","withResolvers","", "then","catch","finally"};
 if(method==0)return JS_DupValue(ctx,ctx->promise_ctor);
 if(method>=28&&method<=30)return JS_NewCFunctionMagic(ctx,js_async_from_sync_iterator_next,method==28?"next":method==29?"return":"throw",1,JS_CFUNC_generic_magic,method-28);
 if(method>=12&&method<=14)return JS_GetPropertyStr(ctx,ctx->class_proto[JS_CLASS_PROMISE],names[method]);
 return JS_GetPropertyStr(ctx,ctx->promise_ctor,names[method]);
}
static JSValue method_call(JSContext*ctx,int method,JSValue receiver,int argc,JSValueConst*argv){
 JSValue function=builtin(ctx,method);if(JS_IsException(function))return function;JSValue unused=JS_UNDEFINED;
 JSValue r=JS_Call(ctx,function,receiver,argc,argc?argv:&unused);JS_FreeValue(ctx,function);return r;
}
static void setup(JSContext*ctx,unsigned op,unsigned m){
 operation=op;mode=m;calls=events=unhandled=handled=closes=steps=jobs=nested=0;for(int i=0;i<12;i++)roots[i]=JS_UNDEFINED;
 roots[0]=checked(JS_NewPromiseCapability(ctx,&roots[1]));roots[3]=checked(JS_NewObjectProto(ctx,JS_NULL));roots[4]=checked(host(ctx,3));roots[5]=checked(host(ctx,4));roots[7]=checked(host(ctx,1));roots[8]=checked(host(ctx,11));
 if(op==2||op==21){if(op==21)accessor(ctx,roots[3],JS_ATOM_then,10);else if(define(ctx,roots[3],JS_ATOM_then,checked(host(ctx,2)))<0)abort();}
 if((op>=5&&op<=8)||(op>=15&&op<=18)||op==22||op==23||op==28){
  if(define(ctx,roots[3],JS_ATOM_Symbol_iterator,checked(host(ctx,5)))<0||define(ctx,roots[3],JS_ATOM_next,checked(host(ctx,6)))<0||define(ctx,roots[3],JS_ATOM_return,checked(host(ctx,7)))<0)abort();
  if(op>=15&&op<=18)roots[9]=checked(JS_CreateAsyncFromSyncIterator(ctx,roots[3]));
 }
 if(op==16){JS_FreeValue(ctx,roots[3]);roots[3]=checked(JS_NewObjectProto(ctx,JS_NULL));JS_FreeValue(ctx,roots[9]);roots[9]=checked(JS_CreateAsyncFromSyncIterator(ctx,roots[3]));}
 if(op==9||op==10){if(define(ctx,roots[3],JS_ATOM_value,JS_NewInt32(ctx,11))<0||define(ctx,roots[3],JS_ATOM_reason,JS_NewInt32(ctx,22))<0)abort();
  if(op==10){roots[10]=checked(JS_NewObjectProto(ctx,JS_NULL));if(define(ctx,roots[10],JS_ATOM_then,checked(host(ctx,9)))<0||define(ctx,roots[3],JS_ATOM_value,JS_DupValue(ctx,roots[10]))<0||define(ctx,roots[3],JS_ATOM_reason,JS_DupValue(ctx,roots[10]))<0||define(ctx,roots[8],JS_ATOM_resolve,checked(host(ctx,8)))<0)abort();}
 }
 if(op==22&&define(ctx,roots[8],JS_ATOM_resolve,checked(host(ctx,10)))<0)abort();
 if(op==24)accessor(ctx,roots[0],JS_ATOM_constructor,10);
 if(op==29){accessor(ctx,roots[3],JS_ATOM_value,12);if(define(ctx,roots[3],JS_ATOM_reason,JS_NewInt32(ctx,22))<0||define(ctx,roots[3],JS_ATOM_Symbol_toStringTag,JS_NewInt32(ctx,33))<0)abort();}
}
static JSValue execute(JSContext*ctx){
 unsigned op=operation;JSValue original=roots[0],resolve=roots[1],reject=roots[2],input=roots[3],handler=roots[4],onFinally=roots[5],custom=roots[8],ctor=ctx->promise_ctor,args[2]={handler,JS_UNDEFINED};
 if(op==0)return JS_CallConstructor(ctx,ctor,1,&roots[7]);
 if(op==1||op==12){if(discard(ctx,reject,JS_NewInt32(ctx,41))<0)return JS_EXCEPTION;}
 else if(op==2||op==21){if(discard(ctx,resolve,input)<0)return JS_EXCEPTION;return JS_DupValue(ctx,original);}
 else if(op==3){if(discard(ctx,resolve,original)<0)return JS_EXCEPTION;return JS_DupValue(ctx,original);}
 else if(op==4||op==27||op==26){roots[6]=method_call(ctx,12,original,2,args);if(JS_IsException(roots[6]))return JS_EXCEPTION;
  if(op==26){if(define(ctx,original,JS_ATOM_value,JS_DupValue(ctx,resolve))<0)return JS_EXCEPTION;return JS_DupValue(ctx,original);}
  roots[11]=method_call(ctx,12,original,2,args);if(JS_IsException(roots[11]))return JS_EXCEPTION;if(discard(ctx,resolve,JS_NewInt32(ctx,41))<0)return JS_EXCEPTION;return JS_DupValue(ctx,roots[6]);}
 if(op>=5&&op<=10){int methods[]={3,4,7,9,5,6};return method_call(ctx,methods[op-5],op==10?custom:ctor,1,&input);}
 if(op==29)return method_call(ctx,5,ctor,1,&input);
 if(op==13){JSValue thrown=host(ctx,10);if(JS_IsException(thrown))return thrown;JSValue r=method_call(ctx,8,ctor,1,&thrown);JS_FreeValue(ctx,thrown);return r;}
 if(op==14)return method_call(ctx,10,ctor,0,NULL);
 if(op>=15&&op<=18){JSValue value=JS_NewInt32(ctx,51);return method_call(ctx,op==16?29:op==17?30:28,roots[9],1,&value);}
 if(op==19){JSValue value=JS_NewInt32(ctx,41);return method_call(ctx,1,custom,1,&value);}
 if(op==22)return method_call(ctx,3,custom,1,&input);
 if(op==23||op==28)return method_call(ctx,op==28?7:3,ctor,1,&input);
 if(op==24)return method_call(ctx,12,original,1,&handler);
 if(op!=1&&op!=12&&discard(ctx,resolve,JS_NewInt32(ctx,41))<0)return JS_EXCEPTION;
 if(op==11||op==12)return method_call(ctx,14,original,1,&onFinally);
 if(op==25){args[0]=JS_NewInt32(ctx,1);args[1]=JS_NewInt32(ctx,2);return method_call(ctx,12,original,2,args);}
 args[1]=handler;return method_call(ctx,12,original,2,args);
}
static void teardown(JSContext*ctx){for(int i=0;i<12;i++){JS_FreeValue(ctx,roots[i]);roots[i]=JS_UNDEFINED;}JS_RunGC(ctx->rt);}
static unsigned error_kind(JSContext*ctx,JSValue v){if(!JS_IsObject(v))return 99;JSObject*p=JS_VALUE_GET_OBJ(v);if(p->class_id!=JS_CLASS_ERROR)return 99;for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;}
static unsigned code(JSContext*ctx,JSValue v){
 if(JS_IsNumber(v))return number(v);if(JS_IsBool(v))return JS_VALUE_GET_BOOL(v);if(!JS_IsObject(v))return 0;if(JS_VALUE_GET_OBJ(v)->class_id==JS_CLASS_ERROR)return 100+error_kind(ctx,v);
 JSValue status=checked(JS_GetProperty(ctx,v,JS_ATOM_status));int has=JS_IsString(status);JS_FreeValue(ctx,status);
 if(has){JSValue value=checked(JS_GetProperty(ctx,v,JS_ATOM_value));if(!JS_IsUndefined(value)){unsigned r=1000+number(value);JS_FreeValue(ctx,value);return r;}JSValue reason=checked(JS_GetProperty(ctx,v,JS_ATOM_reason));unsigned r=2000+number(reason);JS_FreeValue(ctx,reason);return r;}return 500;
}
static void run_case(JSContext*ctx,unsigned op,unsigned m){
 setup(ctx,op,m);uint32_t rec[16]={0};JSValue output=execute(ctx);if(!JS_IsException(output))rec[0]=1;else{JSValue e=JS_GetException(ctx);rec[12]=code(ctx,e);JS_FreeValue(ctx,e);}
 rec[1]=JS_PromiseState(ctx,output)+1;drain(ctx->rt);rec[2]=JS_PromiseState(ctx,output)+1;JSValue result=JS_PromiseResult(ctx,output);
 if(op==14&&JS_IsObject(output)){result=checked(JS_GetProperty(ctx,output,JS_ATOM_promise));JSValue resolve=checked(JS_GetProperty(ctx,output,JS_ATOM_resolve));if(discard(ctx,resolve,JS_NewInt32(ctx,61))<0)abort();JS_FreeValue(ctx,resolve);rec[13]=JS_PromiseState(ctx,result)+1;JSValue resolved=JS_PromiseResult(ctx,result);JS_FreeValue(ctx,result);result=resolved;}
 rec[3]=code(ctx,result);if(JS_IsObject(result)){JSAtom a=__JS_AtomFromUInt32(0),b=__JS_AtomFromUInt32(1);if(op==9||op==10){a=JS_ATOM_value;b=JS_ATOM_reason;}if(op>=15&&op<=18){a=JS_ATOM_value;b=JS_ATOM_done;}
 if(op==29){a=JS_ATOM_value;b=JS_ATOM_Symbol_toStringTag;rec[13]=JS_HasProperty(ctx,result,JS_ATOM_reason);}
 JSValue detail=result,errors=JS_UNDEFINED;if((op==7&&m==2)||op==28){errors=checked(JS_GetProperty(ctx,result,JS_ATOM_errors));detail=errors;}
 JSValue first=checked(JS_GetProperty(ctx,detail,a)),second=checked(JS_GetProperty(ctx,detail,b));rec[4]=code(ctx,first);rec[5]=code(ctx,second);JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);JS_FreeValue(ctx,errors);if((op==9||op==10||op==29)&&JS_VALUE_GET_OBJ(result)->shape->proto==NULL)rec[15]=1;}
 rec[6]=calls;rec[7]=events;rec[8]=unhandled;rec[9]=handled;rec[10]=closes;rec[11]=jobs;rec[14]=JS_PromiseState(ctx,roots[0])+1;
 if(JS_HasException(ctx)){JSValue e=JS_GetException(ctx);rec[12]=code(ctx,e);JS_FreeValue(ctx,e);}JS_FreeValue(ctx,result);JS_FreeValue(ctx,output);teardown(ctx);for(int i=0;i<16;i++)word(rec[i]);
}
static unsigned source_orphans;
static void recover_source_orphans(JSContext*ctx,size_t cutoff){
 int any=operation==7&&mode==2;
 if((!any&&(operation!=6||mode!=1))||!fault_count)return;
 if(JS_IsJobPending(ctx->rt))abort();
 struct list_head*el;
 list_for_each(el,&ctx->rt->gc_obj_list){
  JSGCObjectHeader*h=list_entry(el,JSGCObjectHeader,link);
  if(js_rc(h)->gc_obj_type!=JS_GC_OBJ_TYPE_JS_OBJECT)continue;
  JSObject*p=(JSObject*)h;if(p->class_id!=JS_CLASS_C_FUNCTION_DATA)continue;
  JSValue value=JS_MKPTR(JS_TAG_OBJECT,p);
  JSCFunctionDataRecord*s=JS_GetOpaque(value,JS_CLASS_C_FUNCTION_DATA);
  if(!s||s->func!=js_promise_all_resolve_element||s->magic!=(any?PROMISE_MAGIC_any:PROMISE_MAGIC_allSettled))continue;
  if(s->data_len!=5||__js_rc(p)->ref_count!=1)abort();
  JSValue input=JS_UNDEFINED;
  if(any){
   /* The fixture creates rejected inputs 11 and 22. The lost callback retains
      its input index but never owns next_promise; identify that separate root. */
   if(JS_VALUE_GET_TAG(s->data[1])!=JS_TAG_INT)abort();
   int index=JS_VALUE_GET_INT(s->data[1]);if(index<0||index>1)abort();
   struct list_head*cursor;
   list_for_each(cursor,&ctx->rt->gc_obj_list){
    JSGCObjectHeader*node=list_entry(cursor,JSGCObjectHeader,link);
    if(js_rc(node)->gc_obj_type!=JS_GC_OBJ_TYPE_JS_OBJECT)continue;
    JSObject*object=(JSObject*)node;if(object->class_id!=JS_CLASS_PROMISE)continue;
    JSValue candidate=JS_MKPTR(JS_TAG_OBJECT,object);
    JSPromiseData*state=JS_GetOpaque(candidate,JS_CLASS_PROMISE);
    if(!state||state->promise_state!=JS_PROMISE_REJECTED||state->is_handled||
       JS_VALUE_GET_TAG(state->promise_result)!=JS_TAG_INT||JS_VALUE_GET_INT(state->promise_result)!=11*(index+1))continue;
    if(!JS_IsUndefined(input)||js_rc(object)->ref_count!=1)abort();
    input=candidate;
   }
   if(JS_IsUndefined(input))abort();
  }
  fprintf(stderr,"C Promise source orphans op=%u cutoff=%zu: callback owners=1, input promise owners=%d before reclaim\n",operation,cutoff,any);
  source_orphans+=1+any;JS_FreeValue(ctx,input);JS_FreeValue(ctx,value);JS_RunGC(ctx->rt);return;
 }
}
static unsigned sweep(unsigned op,unsigned m){unsigned failures=0,successes=0;for(size_t p=0;p<384;p++){
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();JS_SetHostPromiseRejectionTracker(rt,tracker,NULL);setup(ctx,op,m);
 remaining=p;fault_count=0;armed=1;JSValue result=execute(ctx);if(JS_IsException(result)&&!JS_HasException(ctx))abort();drain(rt);armed=0;if(fault_count)failures++;else successes++;
 JS_FreeValue(ctx,result);if(JS_HasException(ctx)){JSValue error=JS_GetException(ctx);JS_FreeValue(ctx,error);}teardown(ctx);recover_source_orphans(ctx,p);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(live_count||live_bytes){fprintf(stderr,"C Promise leak op=%u mode=%u fault=%zu blocks=%zu bytes=%zu\n",op,m,p,live_count,live_bytes);abort();}
 }return 4|(failures?1:0)|(successes?2:0);}
int main(int argc,char**argv){
 if(argc==4&&strcmp(argv[1],"sweep")==0){word(sweep(atoi(argv[2]),atoi(argv[3])));word(live_count);word(live_bytes);word(source_orphans);return 0;}
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();JS_SetHostPromiseRejectionTracker(rt,tracker,NULL);
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
import js_promise_test_support as fixture
import js_promise_test_support { Hooks }
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
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 SWEEPS
 let mut writer = StdoutWriter.make()
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def compare(expected, actual):
    size = 64 * len(CASES) + 8
    if len(expected) != size or expected[-8:] != bytes(8):
        raise SystemExit(f'Invalid C record stream/ledger: {len(expected)} bytes')
    if len(actual) != size + 4 * len(SWEEPS) or actual[size - 8:size] != bytes(8):
        raise SystemExit(f'Invalid native record stream/ledger: {len(actual)} bytes')
    for index, case in enumerate(CASES):
        c = struct.unpack_from('<16I', expected, 64 * index)
        native = struct.unpack_from('<16I', actual, 64 * index)
        for field, (a, b) in enumerate(zip(c, native)):
            if a != b:
                raise SystemExit(f'Promise case={case} {FIELDS[field]}: C={a} native={b}')
    sweeps = struct.unpack_from(f'<{len(SWEEPS)}I', actual, size)
    if sweeps != (7,) * len(SWEEPS):
        raise SystemExit(f'Native fault coverage/ledgers failed: {sweeps}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = '\n'.join(f'run_case(ctx,{op},{mode});' for op, mode in CASES)
    rows = ',\n'.join(f'Case {{ operation: {op}, mode: {mode} }}' for op, mode in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut index: usize = 0
 while index < cases.length {
  let record = run unsafe fixture.runCase(&mut hooks, ctx, cases[index].operation, cases[index].mode) |> Effect.provideMut<Allocator>(&mut memory)
  let mut field: usize = 0
  while field < 16 { run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
  index = index + 1
 }
'''
    s_sweeps = '\n'.join(f'let sweep{i} = run unsafe fixture.allocationSweep({op}, {mode}) |> Effect.provideMut<Allocator>(&mut system)\nrun out.writeU32(sweep{i}) |> Effect.provideMut<Allocator>(&mut system)' for i, (op, mode) in enumerate(SWEEPS))
    with tempfile.TemporaryDirectory(prefix='silkjs-promises-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Promise C consumer compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Promise C behavior oracle')
        # No source fault ordinal is compared with a native ordinal.
        source_orphans = 0
        for op, mode in SWEEPS:
            result = process([str(temp / 'oracle'), 'sweep', str(op), str(mode)], 600, owner=f'Promise C fault sweep {op}/{mode}')
            if len(result) != 16:
                raise SystemExit(f'C Promise fault sweep {op}/{mode}: wrong record size {len(result)}')
            coverage, blocks, byte_count, recovered = struct.unpack('<IIII', result)
            if (coverage, blocks, byte_count) != (7, 0, 0) or (recovered and (op, mode) not in ((6, 1), (7, 2))):
                raise SystemExit(f'C Promise fault sweep {op}/{mode}: {result.hex()}')
            source_orphans += recovered
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls).replace('SWEEPS', s_sweeps))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="promise-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1800, owner='Native Promise behavior and fault consumer', cwd=temp)
        compare(expected, actual)
        print(f'PASS Promises: {len(CASES)} behavior records; {len(SWEEPS)} independent native/C fault sweeps; '
              f'{pins} pinned source files; native ledgers empty; C ledgers empty after measuring/reclaiming '
              f'{source_orphans} source Promise orphan owners; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
