#!/usr/bin/env python3
"""Native Silk versus unchanged pinned-C closure/capture/prototype consumers.

No VM or C binding is used. Metadata is independently seeded in each executable;
all closure, global, frame-cell and lazy-property operations execute production
kernels. Allocation-failure ordinals are swept independently because allocation
layouts differ: each engine must encounter failures and success. Ordinary ledgers
must balance. An isolated string auto-init sweep identifies the pinned C orphan
at quickjs.c:8306-8308; native must preserve its slot/error state without that leak.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, validate_pins
from verify_compiler_state import execute
import toolchain

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes;
static int fault_after=-1;
static int denied(void) { if(fault_after<0)return 0;if(!fault_after)return 1;fault_after--;return 0; }
static void *allocate(JSMallocState *s,size_t n) {
 if(!n||denied())return NULL;Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(denied())return NULL;
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue value){if(JS_IsException(value))abort();return value;}
static unsigned number(JSValue value){return JS_VALUE_GET_TAG(value)==JS_TAG_INT?JS_VALUE_GET_INT(value):UINT32_MAX;}
static unsigned tdz(JSValue value){return JS_VALUE_GET_TAG(value)==JS_TAG_UNINITIALIZED;}
static JSProperty *property(JSValue value,JSAtom name){JSProperty *p; if(!find_own_property(&p,JS_VALUE_GET_OBJ(value),name))abort();return p;}
static uint32_t attrs(JSValue value,JSAtom name){JSProperty *p;JSShapeProperty *s=find_own_property(&p,JS_VALUE_GET_OBJ(value),name);return s?s->flags:UINT32_MAX;}
static unsigned error_kind(JSContext *ctx){JSValue e=JS_GetException(ctx);unsigned result=99;
 if(JS_IsObject(e))for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)
  if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))result=i;
 JS_FreeValue(ctx,e);return result;}
static JSClosureVar cv(int type,int lexical,int constant,JSAtom name,int index){
 JSClosureVar v={0};v.closure_type=type;v.is_lexical=lexical;v.is_const=constant;v.var_name=name;v.var_idx=index;return v;
}
static JSValue bytecode(JSContext *ctx,int kind,const JSClosureVar *vars,int count,int proto,int home){
 JSFunctionBytecode *b=js_mallocz(ctx,sizeof(*b)+2*sizeof(JSBytecodeVarDef)+count*sizeof(JSClosureVar));if(!b)abort();
 js_rc(b)->ref_count=1;b->realm=JS_DupContext(ctx);b->func_kind=kind;b->has_prototype=proto;b->need_home_object=home;
 b->has_simple_parameter_list=1;b->arg_count=1;b->var_count=1;b->defined_arg_count=2;b->var_ref_count=2;
 b->vardefs=(JSBytecodeVarDef*)(b+1);b->vardefs[0].is_captured=1;b->vardefs[0].var_ref_idx=0;
 b->vardefs[1].is_captured=1;b->vardefs[1].var_ref_idx=1;
 b->closure_var=(JSClosureVar*)(b->vardefs+2);b->closure_var_count=count;
 for(int i=0;i<count;i++){b->closure_var[i]=vars[i];JS_DupAtom(ctx,vars[i].var_name);}
 add_gc_object(ctx->rt,&b->header,JS_GC_OBJ_TYPE_FUNCTION_BYTECODE);return JS_MKPTR(JS_TAG_FUNCTION_BYTECODE,b);
}
static void captures(JSClosureVar *v){
 v[0]=cv(JS_CLOSURE_MODULE_IMPORT,0,0,0,0);v[1]=cv(JS_CLOSURE_MODULE_DECL,1,1,0,0);
 v[2]=cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_value,0);v[3]=cv(JS_CLOSURE_GLOBAL,0,0,JS_ATOM_done,0);
 v[4]=cv(JS_CLOSURE_LOCAL,0,0,0,0);v[5]=cv(JS_CLOSURE_ARG,0,0,0,0);
 v[6]=cv(JS_CLOSURE_REF,0,0,0,0);v[7]=cv(JS_CLOSURE_GLOBAL_REF,0,0,0,0);
}
static JSContext *prepare(JSRuntime *rt){
 JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 int ids[]={JS_CLASS_OBJECT,JS_CLASS_BYTECODE_FUNCTION,JS_CLASS_GENERATOR_FUNCTION,JS_CLASS_ASYNC_FUNCTION,
  JS_CLASS_ASYNC_GENERATOR_FUNCTION,JS_CLASS_GENERATOR,JS_CLASS_ASYNC_GENERATOR};
 for(unsigned i=0;i<sizeof(ids)/sizeof(ids[0]);i++)JS_SetClassProto(ctx,ids[i],checked(JS_NewObjectProto(ctx,JS_NULL)));
 JS_FreeValue(ctx,ctx->global_obj);JS_FreeValue(ctx,ctx->global_var_obj);
 ctx->global_obj=checked(JS_NewObjectProtoClassAlloc(ctx,JS_NULL,JS_CLASS_GLOBAL_OBJECT,64));
 JS_VALUE_GET_OBJ(ctx->global_obj)->u.global_object.uninitialized_vars=checked(JS_NewObjectProto(ctx,JS_NULL));
 ctx->global_var_obj=checked(JS_NewObjectProtoClassAlloc(ctx,JS_NULL,JS_CLASS_OBJECT,16));
 return ctx;
}
static void semantic(int kind){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=prepare(rt);uint32_t r[40]={0};
 JSValue owner=checked(js_closure(ctx,bytecode(ctx,JS_FUNC_NORMAL,NULL,0,0,0),NULL,NULL,0));
 JSFunctionBytecode *owner_b=JS_VALUE_GET_OBJ(owner)->u.func.function_bytecode;
 JSValue args[1]={JS_NewInt32(ctx,10)},locals[1]={JS_NewInt32(ctx,20)};JSVarRef *cache[2]={0};
 JSStackFrame sf={0};sf.cur_func=owner;sf.arg_buf=args;sf.var_buf=locals;sf.var_refs=cache;rt->current_stack_frame=&sf;
 JSVarRef *inherited=js_create_var_ref(ctx,0);if(!inherited)abort();inherited->value=JS_NewInt32(ctx,30);
 JSVarRef *cached_arg=get_var_ref(ctx,&sf,0,1),*cached_local=get_var_ref(ctx,&sf,0,0);if(!cached_arg||!cached_local)abort();
 JSClosureVar vars[8];captures(vars);
 JSValue fn=checked(js_closure(ctx,bytecode(ctx,kind,vars,8,kind==JS_FUNC_NORMAL,1),&inherited,&sf,0));
 JSObject *p=JS_VALUE_GET_OBJ(fn);JSVarRef **refs=p->u.func.var_refs;
 r[0]=p->class_id;r[1]=p->is_constructor;r[2]=attrs(fn,JS_ATOM_length);r[3]=attrs(fn,JS_ATOM_name);r[4]=attrs(fn,JS_ATOM_prototype);
 r[5]=refs[0]==NULL;r[6]=tdz(*refs[1]->pvalue)&&!refs[1]->is_lexical&&!refs[1]->is_const;r[7]=JS_IsUndefined(*refs[2]->pvalue);r[8]=tdz(*refs[3]->pvalue);
 r[9]=number(*refs[4]->pvalue);r[10]=number(*refs[5]->pvalue);r[11]=refs[6]==inherited&&refs[7]==inherited&&refs[5]==cached_arg&&refs[4]==cached_local;
 free_var_ref(rt,cached_arg);free_var_ref(rt,cached_local);
 *refs[5]->pvalue=JS_NewInt32(ctx,41);*refs[4]->pvalue=JS_NewInt32(ctx,42);r[12]=number(args[0]);r[13]=number(locals[0]);
 close_var_refs(rt,owner_b,&sf);rt->current_stack_frame=NULL;r[14]=number(*refs[5]->pvalue);r[15]=number(*refs[4]->pvalue);
 r[37]=refs[5]->is_detached;r[38]=refs[4]->is_detached;
 JSVarRef *unresolved=js_closure_global_var(ctx,&vars[3]);if(!unresolved)abort();r[16]=unresolved==refs[3];
 JSClosureVar declaration=cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_done,0);
 JSVarRef *declared=js_closure_define_global_var(ctx,&declaration,0);if(!declared)abort();r[17]=unresolved==declared;r[18]=JS_IsUndefined(*declared->pvalue);
 JSVarRef *first=refs[2];*first->pvalue=JS_NewInt32(ctx,9);declaration=cv(JS_CLOSURE_GLOBAL_DECL,1,1,JS_ATOM_value,0);
 JSVarRef *lexical=js_closure_define_global_var(ctx,&declaration,0);if(!lexical)abort();r[19]=lexical==first;
 JSVarRef *split=property(ctx->global_obj,JS_ATOM_value)->u.var_ref;r[20]=split!=first;r[21]=tdz(*lexical->pvalue);
 r[22]=number(*split->pvalue);r[23]=lexical->is_lexical&&lexical->is_const;
 JSValue home=checked(JS_NewObject(ctx)),replacement=checked(JS_NewObject(ctx));
 js_method_set_home_object(ctx,fn,home);r[24]=js_rc(JS_VALUE_GET_OBJ(home))->ref_count;
 js_method_set_home_object(ctx,fn,replacement);r[25]=js_rc(JS_VALUE_GET_OBJ(home))->ref_count;
 js_method_set_home_object(ctx,fn,JS_NULL);r[26]=js_rc(JS_VALUE_GET_OBJ(replacement))->ref_count;
 js_method_set_home_object(ctx,owner,home);r[27]=js_rc(JS_VALUE_GET_OBJ(home))->ref_count;
 if(kind!=JS_FUNC_ASYNC){JSValue proto=checked(JS_GetProperty(ctx,fn,JS_ATOM_prototype));r[28]=JS_IsObject(proto);r[29]=attrs(fn,JS_ATOM_prototype);
  if(kind==JS_FUNC_NORMAL){JSValue ctor=checked(JS_GetProperty(ctx,proto,JS_ATOM_constructor));r[30]=JS_VALUE_GET_PTR(ctor)==JS_VALUE_GET_PTR(fn);
   r[31]=attrs(proto,JS_ATOM_constructor);JS_FreeValue(ctx,ctor);}
  JSValue again=checked(JS_GetProperty(ctx,fn,JS_ATOM_prototype));r[32]=JS_VALUE_GET_PTR(again)==JS_VALUE_GET_PTR(proto);
  JS_FreeValue(ctx,again);JS_FreeValue(ctx,proto);}
 JSClosureVar checks[2]={cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_get,0),cv(JS_CLOSURE_GLOBAL_DECL,1,0,JS_ATOM_value,0)};
 JSValue eval=js_closure(ctx,bytecode(ctx,JS_FUNC_NORMAL,checks,2,0,0),NULL,NULL,1);r[33]=JS_IsException(eval)&&JS_HasException(ctx);
 JS_FreeValue(ctx,eval);r[33]=error_kind(ctx);r[34]=attrs(ctx->global_obj,JS_ATOM_get)==UINT32_MAX;
 JSValue length=checked(JS_GetProperty(ctx,fn,JS_ATOM_length));r[35]=number(length);JS_FreeValue(ctx,length);r[39]=attrs(ctx->global_var_obj,JS_ATOM_value);
 free_var_ref(rt,unresolved);free_var_ref(rt,declared);free_var_ref(rt,lexical);JS_FreeValue(ctx,home);JS_FreeValue(ctx,replacement);
 JS_FreeValue(ctx,fn);JS_RunGC(rt);r[36]=js_rc(inherited)->ref_count;free_var_ref(rt,inherited);JS_FreeValue(ctx,owner);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);for(int i=0;i<40;i++)word(r[i]);word(live_count==0&&live_bytes==0);
}
static void global_semantic(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=prepare(rt);uint32_t r[16]={0};JSValue object=ctx->global_obj;
 if(JS_DefinePropertyGetSet(ctx,object,JS_ATOM_get,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_CONFIGURABLE)<0)abort();r[0]=attrs(object,JS_ATOM_get);
 JSClosureVar capture=cv(JS_CLOSURE_GLOBAL,0,0,JS_ATOM_get,0);JSVarRef *captured=js_closure_global_var(ctx,&capture);r[1]=tdz(*captured->pvalue);
 JSClosureVar declaration=cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_get,0);declaration.var_kind=JS_VAR_GLOBAL_FUNCTION_DECL;
 JSVarRef *declared=js_closure_define_global_var(ctx,&declaration,0);r[2]=declared==captured;r[3]=attrs(object,JS_ATOM_get);r[4]=!declared->is_const;
 if(JS_DefinePropertyGetSet(ctx,object,JS_ATOM_set,JS_UNDEFINED,JS_UNDEFINED,0)<0)abort();declaration.var_name=JS_ATOM_set;
 JSVarRef *fixed=js_closure_define_global_var(ctx,&declaration,0);r[5]=attrs(object,JS_ATOM_set);capture.var_name=JS_ATOM_set;
 JSVarRef *fixed_capture=js_closure_global_var(ctx,&capture);r[6]=fixed==fixed_capture;
 if(JS_DefineAutoInitProperty(ctx,object,JS_ATOM_prototype,JS_AUTOINIT_ID_PROTOTYPE,NULL,JS_PROP_WRITABLE)<0)abort();r[9]=attrs(object,JS_ATOM_prototype);
 capture.var_name=JS_ATOM_prototype;JSVarRef *lazy=js_closure_global_var(ctx,&capture);if(!lazy)abort();r[10]=attrs(object,JS_ATOM_prototype);r[11]=JS_IsObject(*lazy->pvalue);
 JSValue constructor=checked(JS_GetProperty(ctx,*lazy->pvalue,JS_ATOM_constructor));r[12]=JS_VALUE_GET_PTR(constructor)==JS_VALUE_GET_PTR(object);JS_FreeValue(ctx,constructor);
 declaration=cv(JS_CLOSURE_GLOBAL_DECL,1,1,JS_ATOM_value,0);JSVarRef *lexical=js_closure_define_global_var(ctx,&declaration,0);
 JSValue tdz_value=JS_GetProperty(ctx,ctx->global_var_obj,JS_ATOM_value);r[13]=JS_IsException(tdz_value)&&JS_HasException(ctx);
 JS_FreeValue(ctx,tdz_value);r[13]=error_kind(ctx);r[14]=attrs(ctx->global_var_obj,JS_ATOM_value);
 JSClosureVar eval_capture=cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_next,0);
 JSValue eval_code=bytecode(ctx,JS_FUNC_NORMAL,&eval_capture,1,0,0);
 ((JSFunctionBytecode*)JS_VALUE_GET_PTR(eval_code))->is_direct_or_indirect_eval=1;
 JSValue eval_closure=checked(js_closure(ctx,eval_code,NULL,NULL,1));r[15]=attrs(object,JS_ATOM_next);JS_FreeValue(ctx,eval_closure);
 JS_VALUE_GET_OBJ(object)->extensible=0;declaration=cv(JS_CLOSURE_GLOBAL_DECL,0,0,JS_ATOM_done,0);
 JSVarRef *missing=js_closure_define_global_var(ctx,&declaration,0);capture.var_name=JS_ATOM_done;JSVarRef *again=js_closure_global_var(ctx,&capture);
 r[7]=attrs(object,JS_ATOM_done);r[8]=missing==again&&tdz(*missing->pvalue);
 free_var_ref(rt,captured);free_var_ref(rt,declared);free_var_ref(rt,fixed);free_var_ref(rt,fixed_capture);free_var_ref(rt,lazy);
 free_var_ref(rt,lexical);free_var_ref(rt,missing);free_var_ref(rt,again);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 for(int i=0;i<16;i++)word(r[i]);word(live_count==0&&live_bytes==0);
}
static void fault(int cutoff,int prototype){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=prepare(rt);uint32_t r[5]={0};
 JSValue owner=checked(js_closure(ctx,bytecode(ctx,JS_FUNC_NORMAL,NULL,0,0,0),NULL,NULL,0));
 JSValue args[1]={JS_NewInt32(ctx,10)},locals[1]={JS_NewInt32(ctx,20)};JSVarRef *cache[2]={0};
 JSStackFrame sf={0};sf.cur_func=owner;sf.arg_buf=args;sf.var_buf=locals;sf.var_refs=cache;rt->current_stack_frame=&sf;
 JSVarRef *inherited=js_create_var_ref(ctx,0);if(!inherited)abort();JSClosureVar vars[8];captures(vars);
 JSValue code=bytecode(ctx,JS_FUNC_NORMAL,vars,8,1,0),fn=JS_UNDEFINED;
 if(prototype)fn=checked(js_closure(ctx,code,&inherited,&sf,0));
 fault_after=cutoff;
 if(prototype){JSValue value=JS_GetProperty(ctx,fn,JS_ATOM_prototype);r[0]=!JS_IsException(value);JS_FreeValue(ctx,value);}
 else{fn=js_closure(ctx,code,&inherited,&sf,0);r[0]=!JS_IsException(fn);}
 fault_after=-1;r[1]=JS_HasException(ctx);JS_FreeValue(ctx,JS_GetException(ctx));
 JS_FreeValue(ctx,fn);JS_RunGC(rt);r[2]=cache[0]==NULL&&cache[1]==NULL;r[3]=js_rc(inherited)->ref_count;
 close_var_refs(rt,JS_VALUE_GET_OBJ(owner)->u.func.function_bytecode,&sf);rt->current_stack_frame=NULL;
 free_var_ref(rt,inherited);JS_FreeValue(ctx,owner);JS_FreeContext(ctx);JS_FreeRuntime(rt);r[4]=live_count==0&&live_bytes==0;
 for(int i=0;i<5;i++)word(r[i]);
}
/* Isolated upstream leak: atom-string initializer succeeds, global-cell allocation
   fails, and JS_AutoInitProperty drops val. The atom table finally reclaims it at
   runtime destruction, but the live-runtime ledger has one orphaned reference. */
static void global_fault(int cutoff){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=prepare(rt);uint32_t r[8]={0};
 static const JSCFunctionListEntry entry=JS_PROP_STRING_DEF("next","lazy",JS_PROP_WRITABLE);
 JSAtom prior=__JS_FindAtom(rt,"lazy",4,JS_ATOM_TYPE_STRING);if(prior)abort();
 if(JS_DefineAutoInitProperty(ctx,ctx->global_obj,JS_ATOM_next,JS_AUTOINIT_ID_PROP,(void*)&entry,JS_PROP_WRITABLE)<0)abort();
 size_t before_count=live_count,before_bytes=live_bytes;fault_after=cutoff;
 JSValue value=JS_GetProperty(ctx,ctx->global_obj,JS_ATOM_next);fault_after=-1;
 r[0]=!JS_IsException(value);r[1]=JS_HasException(ctx);r[2]=attrs(ctx->global_obj,JS_ATOM_next);
 r[3]=JS_IsException(value)?2:JS_IsString(value);JS_FreeValue(ctx,value);JS_FreeValue(ctx,JS_GetException(ctx));
 if(!r[0]){
  r[4]=live_count>before_count?live_count-before_count:0;r[5]=live_bytes>before_bytes?live_bytes-before_bytes:0;
  JSAtom found=__JS_FindAtom(rt,"lazy",4,JS_ATOM_TYPE_STRING);
  if(found){r[6]=js_rc(rt->atom_array[found])->ref_count-1;JS_FreeAtom(ctx,found);}
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);r[7]=live_count==0&&live_bytes==0;
 for(int i=0;i<8;i++)word(r[i]);
}
int main(void){for(int kind=0;kind<4;kind++)semantic(kind);global_semantic();
 for(int phase=0;phase<2;phase++)for(int n=0;n<40;n++)fault(n,phase);
 for(int n=0;n<16;n++)global_fault(n);return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import byte_buffer { ByteBuffer }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import runtime_memory { RuntimeAllocator }
import js_core_types { FunctionKind }
import js_runtime as runtime
import js_gc as gc
import js_array_storage_test_support as storage
import js_closures_test_support as fixture
import js_property_mutations_test_support { Hooks }
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
effect fn semantic(out: &mut ByteBuffer, kind: FunctionKind) -> ()
  ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
  let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make(&observer)
  run unsafe fixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let record = run unsafe fixture.observe(&mut hooks, &observer, ctx, kind) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0 while i < record.length { run out.writeU32(record[i]) i = i + 1 }
  run out.writeU32(fixture.flag(observer.stats().usedBytes == 0 && observer.stats().allocationCount == 0))
}
effect fn globalSemantic(out: &mut ByteBuffer) -> ()
  ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
  let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make(&observer)
  run unsafe fixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let record = run unsafe fixture.observeGlobals(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0 while i < record.length { run out.writeU32(record[i]) i = i + 1 }
  run out.writeU32(fixture.flag(observer.stats().usedBytes == 0 && observer.stats().allocationCount == 0))
}
effect fn probe() -> () ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError ? &mut Allocator | &mut Writer {
  let mut out = ByteBuffer.make()
  let kinds = [FunctionKind.Normal, FunctionKind.Generator, FunctionKind.Async, FunctionKind.AsyncGenerator]
  let mut i: usize = 0 while i < kinds.length { run semantic(&mut out, kinds[i]) i = i + 1 }
  run globalSemantic(&mut out)
  let mut phase: usize = 0 while phase < 2 {
    let mut cutoff: usize = 0 while cutoff < 40 {
      let record = run fixture.fault(cutoff, phase == 1)
      i = 0 while i < record.length { run out.writeU32(record[i]) i = i + 1 }
      cutoff = cutoff + 1
    }
    phase = phase + 1
  }
  let mut globalCutoff: usize = 0
  while globalCutoff < 16 {
    let globalRecord = run fixture.globalFault(globalCutoff)
    i = 0 while i < globalRecord.length { run out.writeU32(globalRecord[i]) i = i + 1 }
    globalCutoff = globalCutoff + 1
  }
  run Writer.writeAll(out.asSlice())
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
  let mut allocator = run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
  let mut writer = StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  if allocator.stats().usedBytes != 0 || allocator.stats().allocationCount != 0 { return 7 }
  return 0
}
'''


def inspect_faults(data: bytes, engine: str) -> None:
    words = struct.unpack('<709I', data)
    for offset in (40, 81, 122, 163, 180):
        if words[offset] != 1:
            raise SystemExit(f'{engine}: semantic allocation ledger at word {offset} is not zero')
    for phase in range(2):
        records = [words[181 + (phase * 40 + i) * 5:181 + (phase * 40 + i + 1) * 5] for i in range(40)]
        if not any(r[0] == 0 for r in records) or not any(r[:2] == (1, 0) for r in records):
            raise SystemExit(f'{engine}: fault phase {phase} did not cross failure and clean success')
        for cutoff, record in enumerate(records):
            success, pending, cache_empty, inherited_refs, ledger_zero = record
            if not success and not pending:
                raise SystemExit(f'{engine}: phase {phase} cutoff {cutoff} returned failure without pending exception')
            if (cache_empty, inherited_refs, ledger_zero) != (1, 1, 1):
                raise SystemExit(f'{engine}: phase {phase} cutoff {cutoff} leaked ownership: {record}')


def inspect_global_faults(data: bytes, engine: str) -> list[tuple[int, ...]]:
    words = struct.unpack('<709I', data)
    records = [words[581 + i * 8:581 + (i + 1) * 8] for i in range(16)]
    if not any(r[0] == 0 for r in records) or not any(r[:2] == (1, 0) for r in records):
        raise SystemExit(f'{engine}: global auto-init sweep did not cross failure and success')
    # Stored property flags come from the pinned public definitions, not allocator
    # ordinals. Undefined after initializer failure is deliberately not retried.
    for cutoff, record in enumerate(records):
        success, pending, flags, value_kind, excess_count, excess_bytes, orphan_refs, final_zero = record
        if final_zero != 1:
            raise SystemExit(f'{engine}: global auto-init teardown ledger {cutoff}: {record}')
        if success:
            if pending or value_kind != 1 or flags != 34 or any(record[4:7]):
                raise SystemExit(f'{engine}: unexpected successful global auto-init state {cutoff}: {record}')
        else:
            if not pending or value_kind != 2 or flags not in (2, 50):
                raise SystemExit(f'{engine}: unexpected failed global auto-init state {cutoff}: {record}')
            if engine == 'Silk' and any(record[4:7]):
                raise SystemExit(f'native global auto-init retained an orphan {cutoff}: {record}')
            if engine == 'C' and any(record[4:7]) and not (
                    flags == 2 and excess_count == 1 and excess_bytes > 0 and orphan_refs == 1):
                raise SystemExit(f'unexplained C global auto-init ownership divergence {cutoff}: {record}')
    if engine == 'C' and not any(r[4] == 1 and r[6] == 1 for r in records):
        raise SystemExit('pinned C did not reproduce the isolated global initializer leak')
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    with tempfile.TemporaryDirectory(prefix='silkjs-closures-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="closures-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if len(expected) != 709 * 4 or len(actual) != 709 * 4:
            raise SystemExit(f'incomplete closure records: C={len(expected)} bytes, Silk={len(actual)} bytes')
        inspect_faults(expected, 'C')
        inspect_faults(actual, 'Silk')
        cglobal = inspect_global_faults(expected, 'C')
        native_global = inspect_global_faults(actual, 'Silk')
        if {r[:4] for r in cglobal} != {r[:4] for r in native_global}:
            raise SystemExit('global auto-init success/error/slot states differ beyond known C ownership leak')
        leaks = [(index, record[4], record[5], record[6])
                 for index, record in enumerate(cglobal) if record[4]]
        for index in range(181):
            cword = struct.unpack_from('<I', expected, index * 4)[0]
            sword = struct.unpack_from('<I', actual, index * 4)[0]
            if cword != sword:
                raise SystemExit(f'closure observation word {index}: C={cword} Silk={sword}')
        print(f'PASS closures: 181 matched semantic/ledger words; 80 ordinary and 16 global OOM cases per engine; '
              f'{pins} pinned files; sha256={hashlib.sha256(actual[:724]).hexdigest()}')
        print(f'KNOWN SOURCE LEAK quickjs.c:8306-8308 (cutoff, excess blocks, bytes, orphan refs): {leaks}; '
              'native live-runtime excess is zero; all final runtime ledgers are zero')


if __name__ == '__main__':
    main()
