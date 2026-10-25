#!/usr/bin/env python3
"""Original-C/native object coercion differential; no C is linked into Silk.

Uses registered closure classes, actual stored properties and native accessors,
not JS eval or canned property replies. Compares hint text, callback order,
results, exact TypeError messages, arbitrary thrown values, retained-reference
deltas, finalizers and independent zero-allocation ledgers after full teardown.
Run: python3 scripts/verify_object_coercions.py QUICKJS
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
FAMILIES = [*range(15), 17, 18, 19, 20, 23]
COUNT = len(FAMILIES) * 8 * 16 * 2 + 2
C_SOURCE = r'''
#include "quickjs.c"
#include <stddef.h>
#undef malloc
#undef free
#undef realloc
typedef union Header { max_align_t align; size_t size; } Header;
static size_t live_count, live_bytes;
static void *tracked_malloc(JSMallocState *s,size_t n) {
    if(!n)return NULL;Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
    h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void tracked_free(JSMallocState *s,void *p) {
    if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
    s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *tracked_realloc(JSMallocState *s,void *p,size_t n) {
    if(!p)return tracked_malloc(s,n);if(!n){tracked_free(s,p);return NULL;}
    Header *h=(Header*)p-1;size_t old=h->size;h=realloc(h,sizeof(*h)+n);if(!h)return NULL;
    h->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return h+1;
}
static size_t tracked_size(const void *p){return p?((const Header*)p-1)->size:0;}
static void word(uint32_t v){for(int i=0;i<4;i++)putchar((v>>(8*i))&255);}
static uint32_t out[2048];static unsigned used;
static void emit(uint32_t v){if(used>=2048)abort();out[used++]=v;}
static void flush(void){word(used);for(unsigned i=0;i<used;i++)word(out[i]);used=0;}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static int rc(JSValueConst v){return JS_VALUE_HAS_REF_COUNT(v)?js_rc(JS_VALUE_GET_PTR(v))->ref_count:0;}
static void text(JSValue v){JSString*s=JS_VALUE_GET_STRING(v);emit(s->len);for(int i=0;i<s->len;i++)emit(string_get(s,i));}
static uint32_t events[128],finalized[128];static unsigned event_count,finalized_count;static int collect_calls;
static int finalized_with_pending;
typedef struct {JSValue result,mutation;int event,body;JSAtom mutation_atom;} Closure;
static void finalizer(JSRuntime *rt,JSValue o){
    Closure*p=JS_GetOpaque(o,JS_VALUE_GET_OBJ(o)->class_id);if(!p)abort();
    finalized_with_pending|=JS_VALUE_GET_TAG(rt->current_exception)!=JS_TAG_UNINITIALIZED;
    finalized[finalized_count++]=p->event;JS_FreeValueRT(rt,p->result);JS_FreeValueRT(rt,p->mutation);js_free_rt(rt,p);
}
static void marker(JSRuntime *rt,JSValueConst o,JS_MarkFunc *mark){
    Closure*p=JS_GetOpaque(o,JS_VALUE_GET_OBJ(o)->class_id);if(!p)abort();
    JS_MarkValue(rt,p->result,mark);JS_MarkValue(rt,p->mutation,mark);
}
static JSValue call(JSContext *ctx,JSValueConst function,JSValueConst receiver,int argc,JSValueConst*argv,int flags){
    Closure*p=JS_GetOpaque(function,69);if(!p)abort();
    int body=p->body,event=p->event;JSAtom mutation_atom=p->mutation_atom;
    JSValue result=JS_DupValue(ctx,p->result),mutation=JS_DupValue(ctx,p->mutation);
    events[event_count++]=event;if(!JS_IsObject(receiver))abort();
    if(argc==1){JSString*s=JS_VALUE_GET_STRING(argv[0]);const char*expected;int code;
      if(string_get(s,0)=='d'){expected="default";code=1000;}
      else if(string_get(s,0)=='n'){expected="number";code=1001;}
      else if(string_get(s,0)=='s'){expected="string";code=1002;}else abort();
      if(s->len!=strlen(expected))abort();for(int i=0;i<s->len;i++)if(string_get(s,i)!=(unsigned char)expected[i])abort();
      events[event_count++]=code;
    }else if(argc)abort();
    if(collect_calls)JS_RunGC(JS_GetRuntime(ctx));
    if(body==3){JSProperty *slot;if(!find_own_property(&slot,JS_VALUE_GET_OBJ(receiver),mutation_atom))abort();
      JS_FreeValue(ctx,slot->u.value);slot->u.value=JS_DupValue(ctx,mutation);}
    JS_FreeValue(ctx,mutation);
    if(body==1)return JS_Throw(ctx,result);
    if(body==2){JS_FreeValue(ctx,result);return JS_DupValue(ctx,receiver);}
    if(body==4){void*scratch=js_malloc(ctx,37);if(!scratch){JS_FreeValue(ctx,result);return JS_EXCEPTION;}js_free(ctx,scratch);}
    return result;
}
static const JSClassDef object_definition={.class_name="CoercionClosure",.finalizer=finalizer,.gc_mark=marker};
static const JSClassDef function_definition={.class_name="CoercionClosure",.finalizer=finalizer,.gc_mark=marker,.call=call};
static JSValue closure(JSContext*ctx,int callable,int event,int body,JSValueConst result,JSAtom atom,JSValueConst mutation){
    JSValue o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,callable?69:68));
    Closure*p=js_malloc(ctx,sizeof(*p));if(!p)abort();
    *p=(Closure){JS_DupValue(ctx,result),JS_DupValue(ctx,mutation),event,body,atom};JS_SetOpaque(o,p);return o;
}
static void property(JSContext*ctx,JSValueConst o,JSAtom atom,JSValueConst value,int accessor){
    int ok;if(accessor)ok=JS_DefinePropertyGetSet(ctx,o,atom,JS_DupValue(ctx,value),JS_UNDEFINED,JS_PROP_CONFIGURABLE|JS_PROP_ENUMERABLE);
    else ok=JS_DefinePropertyValue(ctx,o,atom,JS_DupValue(ctx,value),JS_PROP_C_W_E);
    if(ok<0)abort();
}
static void method(JSContext*ctx,JSValueConst o,JSAtom atom,int event,int body,JSValueConst result,int accessor){
    JSValue f=closure(ctx,1,event+1,body,result,0,JS_UNDEFINED),installed=f;
    if(accessor)installed=closure(ctx,1,event,0,f,0,JS_UNDEFINED);
    property(ctx,o,atom,installed,accessor);if(accessor)JS_FreeValue(ctx,installed);JS_FreeValue(ctx,f);
}
static void getter(JSContext*ctx,JSValueConst o,JSAtom atom,int event,int body,JSValueConst result){
    JSValue f=closure(ctx,1,event,body,result,0,JS_UNDEFINED);property(ctx,o,atom,f,1);JS_FreeValue(ctx,f);
}
static JSValue make(JSContext*ctx,int family,JSValueConst result){
    JSValue o=closure(ctx,0,1,0,JS_UNDEFINED,0,JS_UNDEFINED);
    if(family==0||family==5||family==7||family==19)
      method(ctx,o,JS_ATOM_Symbol_toPrimitive,10,family==5?2:family==7?1:0,result,family!=19);
    else if(family==1||family==2||family==4)
      property(ctx,o,JS_ATOM_Symbol_toPrimitive,family==1?JS_NULL:family==2?JS_UNDEFINED:JS_NewInt32(ctx,3),0);
    else if(family==6)getter(ctx,o,JS_ATOM_Symbol_toPrimitive,10,1,result);
    else if(family==20)getter(ctx,o,JS_ATOM_Symbol_toPrimitive,10,0,JS_UNDEFINED);
    if(family==17)return o;
    if(family==11||family==18)property(ctx,o,JS_ATOM_valueOf,JS_NewInt32(ctx,8),0);
    else if(family==13)getter(ctx,o,JS_ATOM_valueOf,20,1,result);
    else method(ctx,o,JS_ATOM_valueOf,20,family==8||family==10?2:family==23?4:0,result,1);
    if(family==12||family==18)property(ctx,o,JS_ATOM_toString,JS_FALSE,0);
    else if(family==14)getter(ctx,o,JS_ATOM_toString,30,1,result);
    else method(ctx,o,JS_ATOM_toString,30,family==9||family==10?2:0,result,1);
    return o;
}
static JSValue leaf(JSContext*ctx,int kind){
    switch(kind){case 0:return JS_UNDEFINED;case 1:return JS_NULL;case 2:return JS_FALSE;
    case 3:return JS_NewInt32(ctx,41);case 4:return checked(JS_NewString(ctx," -0 "));
    case 5:return checked(JS_NewSymbol(ctx,"coercion-symbol",FALSE));
    case 6:return checked(JS_NewBigInt64(ctx,INT64_C(9007199254740993)));
    case 7:return __JS_NewFloat64(ctx,-0.0);default:abort();}
}
static void describe(JSContext*ctx,JSValue v,JSValue original){
    if(JS_IsUndefined(v)){emit(0);return;}if(JS_IsNull(v)){emit(1);return;}
    if(JS_IsBool(v)){emit(2);emit(JS_VALUE_GET_BOOL(v));return;}
    if(JS_IsNumber(v)){emit(3);double d=JS_VALUE_GET_NORM_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v);
      uint64_t bits=isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d);emit(bits);emit(bits>>32);return;}
    if(JS_IsString(v)){emit(4);text(v);return;}
    if(JS_IsSymbol(v)){emit(5);emit(JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(original));return;}
    if(JS_IsBigInt(ctx,v)){emit(6);JSValue s=checked(JS_ToString(ctx,v));text(s);JS_FreeValue(ctx,s);return;}
    abort();
}
static JSValue convert(JSContext*ctx,JSValue o,int op){
    if(op<3)return JS_ToPrimitive(ctx,o,op);
    if(op<6)return JS_ToPrimitiveFree(ctx,JS_DupValue(ctx,o),op-3);
    if(op<9)return JS_ToPrimitive(ctx,o,(op-6)|JS_HINT_FORCE_ORDINARY);
    if(op==9)return JS_ToNumberFree(ctx,JS_DupValue(ctx,o));
    if(op==10)return JS_ToNumericFree(ctx,JS_DupValue(ctx,o));
    if(op==11)return JS_ToNumberFree(ctx,JS_DupValue(ctx,o));
    if(op==12)return JS_ToNumeric(ctx,o);
    if(op==13)return JS_ToString(ctx,o);
    if(op==14)return JS_ToStringFree(ctx,JS_DupValue(ctx,o));
    if(op==15)return JS_ToPropertyKey(ctx,o);abort();
}
static void run_case(JSContext*ctx,int family,int kind,int op,int collect){
    event_count=finalized_count=0;collect_calls=collect;
    JSValue value=leaf(ctx,kind),o=make(ctx,family,value);int before=rc(value),object_before=rc(o);
    JSValue result=convert(ctx,o,op);
    if(JS_IsException(result)){
      JSValue ex=JS_GetException(ctx);
      if(JS_IsObject(ex)){
        JSValue proto=checked(JS_GetPrototype(ctx,ex));if(!JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR]))abort();
        emit(1);JSValue message=checked(JS_GetPropertyStr(ctx,ex,"message"));text(message);JS_FreeValue(ctx,message);JS_FreeValue(ctx,proto);
      }else{emit(2);describe(ctx,ex,value);}JS_FreeValue(ctx,ex);
    }else{emit(0);describe(ctx,result,value);}JS_FreeValue(ctx,result);
    emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
    emit(rc(o)-object_before);emit(rc(value)-before);
    JS_FreeValue(ctx,o);emit(rc(value));emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);
    JS_FreeValue(ctx,value);flush();
}
static void finalizer_witness(JSContext*ctx,int family){
    event_count=finalized_count=0;finalized_with_pending=0;collect_calls=0;
    JSValue object=make(ctx,family,JS_NULL);
    JSValue result=JS_ToPrimitiveFree(ctx,object,JS_HINT_NUMBER);
    if(!JS_IsException(result)||!JS_HasException(ctx))abort();
    emit(finalized_with_pending);emit(finalized_count);
    for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);
    JSValue error=JS_GetException(ctx),proto=checked(JS_GetPrototype(ctx,error));
    if(!JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR]))abort();
    JS_FreeValue(ctx,proto);JS_FreeValue(ctx,error);flush();
}
int main(void){
    JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};
    JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
    if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();
    const int families[]={@FAMILIES@};word(@COUNT@);
    for(unsigned i=0;i<sizeof(families)/sizeof(*families);i++)for(int k=0;k<8;k++)for(int op=0;op<16;op++)for(int collect=0;collect<2;collect++)
      run_case(ctx,families[i],k,op,collect);
    finalizer_witness(ctx,17);finalizer_witness(ctx,5);
    JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.u8
import silk.u16
import silk.u32
import silk.u64
import silk.i32
import silk.usize
import silk.f64
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader, HeapKind }
import js_core_types { RuntimeState }
import js_value { Value }
import js_gc as gc
import js_runtime as runtime
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_bigint { BigInt, BigIntError }
import js_primitive_coercions as primitive
import js_primitive_coercions { CoercionError }
import js_coercions as coercion
import js_coercion_host { CoercionHooks }
import js_coercions_test_support as fixture
import js_coercions_test_support { Hooks }
import js_coercions_cases as cases
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_atom_data as atoms
import js_array_storage_test_support { trap }
unsafe fn rc(value: Value) -> i32 {
  match value.heapReference() {
    Option<*mut HeapHeader>.None => { return 0 }
    Option<*mut HeapHeader>.Some { value: node } => {
      let anchor = () let header = unsafe Pointer.borrow<(), HeapHeader>(&anchor, node)
      return header.referenceCount
    }
  }
}
fn signed(value: i32) -> u32 {
  if value < 0 { return i32.toU32(-(value + 1)) ^ 0xffffffff }
  return i32.toU32(value)
}
effect fn text(out: &mut ByteBuffer, value: Value) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i: usize = 0
  while i < Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value, i))) i = i + 1 }
}
unsafe effect fn leaf(rt: *mut HeapHeader, kind: u32) -> Value
  ! OutOfMemoryError | StringLengthError | BigIntError ? &mut Allocator {
  if kind == 0 { return Value.Undefined } if kind == 1 { return Value.Null }
  if kind == 2 { return Value.Bool { value: false } } if kind == 3 { return Value.Int { value: 41 } }
  if kind == 4 { return run Strings.fromLatin1(b" -0 ") }
  if kind == 5 {
    let description = StringOwner.adopt(run Strings.fromLatin1(b"coercion-symbol"))
    let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt)
    return run state.atoms.uniqueSymbol(Option<Value>.some(description.get()))
  }
  if kind == 6 {
    let integer = run BigInt.fromI64(9007199254740993)
    return Value.BigInt { reference: run HeapCell.allocate(HeapKind.BigInt, move integer) }
  }
  if kind == 7 { return Value.Float64 { value: f64.fromBits(0x8000000000000000) } }
  return trap()
}
unsafe effect fn describe(out: &mut ByteBuffer, rt: *mut HeapHeader, value: Value, original: Value) -> ()
  ! OutOfMemoryError | StringLengthError | BigIntError | CoercionError ? &mut Allocator {
  match value {
    Value.Undefined => { run out.writeU32(0) }
    Value.Null => { run out.writeU32(1) }
    Value.Bool { value: boolean } => { run out.writeU32(2) let mut flag: u32 = 0 if boolean { flag = 1 } run out.writeU32(flag) }
    Value.Int { .. } => { run out.writeU32(3) run out.writeU64(f64.toBits(value.numericValue())) }
    Value.Float64 { value: number } => {
      run out.writeU32(3) let mut bits = f64.toBits(number) if f64.isNaN(number) { bits = 0x7ff8000000000000 } run out.writeU64(bits)
    }
    Value.String { .. } => { run out.writeU32(4) run text(&mut out, value) }
    Value.Symbol { reference: node } => {
      run out.writeU32(5) let mut same: u32 = 0
      match original { Value.Symbol { reference: other } => { if Pointer.address(node) == Pointer.address(other) { same = 1 } } _ => () }
      run out.writeU32(same)
    }
    Value.BigInt { .. } => {
      run out.writeU32(6) let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt)
      let textValue = StringOwner.adopt(run unsafe primitive.toString(&state.atoms, value))
      run text(&mut out, textValue.get())
    }
    Value.ShortBigInt { .. } => {
      run out.writeU32(6) let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt)
      let textValue = StringOwner.adopt(run unsafe primitive.toString(&state.atoms, value))
      run text(&mut out, textValue.get())
    }
    _ => trap()
  }
}
unsafe effect fn convert(hooks: &mut Hooks, context: *mut HeapHeader, object: Value, op: u32) -> Value
  ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
  if op < 3 { return run unsafe coercion.toPrimitive(&mut hooks, context, object, op) }
  if op < 6 { return run unsafe coercion.toPrimitiveFree(&mut hooks, context, unsafe object.retained(), op - 3) }
  if op < 9 { return run unsafe coercion.toPrimitive(&mut hooks, context, object, (op - 6) | 16) }
  if op == 9 { return run unsafe coercion.toNumberFree(&mut hooks, context, unsafe object.retained()) }
  if op == 10 { return run unsafe coercion.toNumericFree(&mut hooks, context, unsafe object.retained()) }
  if op == 11 { return run unsafe coercion.toNumber(&mut hooks, context, object) }
  if op == 12 { return run unsafe coercion.toNumeric(&mut hooks, context, object) }
  if op == 13 { return run unsafe coercion.toString(&mut hooks, context, object) }
  if op == 14 { return run unsafe coercion.toStringFree(&mut hooks, context, unsafe object.retained()) }
  if op == 15 { return run unsafe coercion.toPropertyKey(&mut hooks, context, object) }
  return trap()
}
unsafe effect fn runCase(out: &mut ByteBuffer, hooks: &mut Hooks, memory: &AllocationObserver,
  context: *mut HeapHeader, family: u32, kind: u32, op: u32, collect: bool) -> ()
  ! OutOfMemoryError | StringLengthError | BigIntError | CoercionError | JsException ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(context) hooks.clear() hooks.collect = collect
  let value = run unsafe leaf(rt, kind)
  let object = run unsafe cases.make(&mut hooks, memory, context, family, value)
  let before = unsafe rc(value) let objectBefore = unsafe rc(object)
  let outcome = run Effect.result(unsafe convert(&mut hooks, context, object, op))
  match move outcome {
    Result<Value, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Success { value: result } => {
      run out.writeU32(0) run unsafe describe(&mut out, rt, result, value) unsafe gc.release(&mut hooks, rt, result)
    }
    Result<Value, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Failure { error } => {
      match move error {
        JsException thrown => {
          let pending = unsafe exceptions.take(rt)
          if pending.isObject() {
            let name = StringOwner.adopt(run unsafe hooks.getProperty(context, pending, atoms.JS_ATOM_name))
            let expected = StringOwner.adopt(run Strings.fromLatin1(b"TypeError"))
            if !Strings.equal(name.get(), expected.get()) { trap() }
            let textValue = StringOwner.adopt(run unsafe hooks.getProperty(context, pending, atoms.JS_ATOM_message))
            run out.writeU32(1) run text(&mut out, textValue.get())
          } else { run out.writeU32(2) run unsafe describe(&mut out, rt, pending, value) }
          unsafe gc.release(&mut hooks, rt, pending)
        }
        OutOfMemoryError allocation => { fail move allocation }
        StringLengthError length => { fail move length }
        BigIntError integer => { fail move integer }
      }
    }
  }
  run out.writeU32(usize.toU32(hooks.eventCount)) let mut i: usize = 0
  while i < hooks.eventCount { run out.writeU32(hooks.events[i]) i = i + 1 }
  run out.writeU32(signed(unsafe rc(object) - objectBefore)) run out.writeU32(signed(unsafe rc(value) - before))
  unsafe gc.release(&mut hooks, rt, object) run out.writeU32(signed(unsafe rc(value)))
  run out.writeU32(usize.toU32(hooks.finalizedCount)) i = 0
  while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
  unsafe gc.release(&mut hooks, rt, value)
}
unsafe effect fn finalizerWitness(out: &mut ByteBuffer, hooks: &mut Hooks, memory: &AllocationObserver,
  context: *mut HeapHeader, family: u32) -> () ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(context) hooks.clear() hooks.collect = false
  let object = run unsafe cases.make(&mut hooks, memory, context, family, Value.Null)
  let outcome = run Effect.result(unsafe coercion.toPrimitiveFree(&mut hooks, context, object, 1))
  match move outcome {
    Result<Value, OutOfMemoryError | StringLengthError | JsException>.Success { value } => {
      unsafe gc.release(&mut hooks, rt, value) trap()
    }
    Result<Value, OutOfMemoryError | StringLengthError | JsException>.Failure { error } => match move error {
      JsException marker => ()
      OutOfMemoryError allocation => { fail move allocation }
      StringLengthError length => { fail move length }
    }
  }
  let mut observed: u32 = 0 if hooks.finalizedWithPending { observed = 1 }
  run out.writeU32(observed) run out.writeU32(usize.toU32(hooks.finalizedCount))
  let mut index: usize = 0
  while index < hooks.finalizedCount { run out.writeU32(hooks.finalized[index]) index = index + 1 }
  let pending = unsafe exceptions.take(rt)
  if !pending.isObject() { trap() }
  let name = StringOwner.adopt(run unsafe hooks.getProperty(context, pending, atoms.JS_ATOM_name))
  let expected = StringOwner.adopt(run Strings.fromLatin1(b"TypeError"))
  if !Strings.equal(name.get(), expected.get()) { trap() }
  unsafe gc.release(&mut hooks, rt, pending)
}

effect fn probe(memory: &AllocationObserver) -> ()
  ! OutOfMemoryError | StringLengthError | BigIntError | CoercionError | JsException | WriterError ? &mut Allocator | &mut Writer {
  let rt = run runtime.allocateRuntimeStorage(0) let ctx = run unsafe runtime.allocateContextStorage(rt)
  run unsafe fixture.register(rt) let mut hooks = Hooks.make() run unsafe fixture.prepareErrors(&mut hooks, memory, ctx)
  let families: [u32; @FAMILY_COUNT@] = [@FAMILIES@]
  let mut header = ByteBuffer.make() run header.writeU32(@COUNT@) run Writer.writeAll(header.asSlice())
  let mut out = ByteBuffer.make() let mut length = ByteBuffer.make() let mut familyIndex: usize = 0
  while familyIndex < families.length {
    let mut kind: u32 = 0
    while kind < 8 {
      let mut op: u32 = 0
      while op < 16 {
        let mut collect: u32 = 0
        while collect < 2 {
          out.clear() length.clear()
          run unsafe runCase(&mut out, &mut hooks, memory, ctx, families[familyIndex], kind, op, collect != 0)
          run length.writeU32(usize.toU32(out.length() / 4)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice())
          collect = collect + 1
        }
        op = op + 1
      }
      kind = kind + 1
    }
    familyIndex = familyIndex + 1
  }
  let witnessFamilies: [u32; 2] = [17, 5] let mut witness: usize = 0
  while witness < witnessFamilies.length {
    out.clear() length.clear()
    run unsafe finalizerWitness(&mut out, &mut hooks, memory, ctx, witnessFamilies[witness])
    run length.writeU32(usize.toU32(out.length() / 4)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice())
    witness = witness + 1
  }
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt)
}
pub effect fn main() -> i32
  ! OutOfMemoryError | StringLengthError | BigIntError | CoercionError | JsException | WriterError {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let mut writer = StdoutWriter.make()
  run probe(&observer) |> Effect.provideMut<Allocator>(&mut memory) |> Effect.provideMut<Writer>(&mut writer)
  if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
  let mut allocator = Allocator.systemAllocatorProvider() let mut footer = ByteBuffer.make()
  run footer.writeU32(2) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU32(usize.toU32(observer.stats().allocationCount)) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU32(usize.toU32(observer.stats().usedBytes)) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(footer.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def records(data):
    if len(data) < 4:
        raise SystemExit('Empty coercion oracle output')
    count, = struct.unpack_from('<I', data)
    if count != COUNT:
        raise SystemExit(f'Wrong coercion record count: {count}, expected {COUNT}')
    at = 4
    result = []
    for _ in range(count + 1):
        if at + 4 > len(data):
            raise SystemExit('Truncated coercion record header')
        size, = struct.unpack_from('<I', data, at)
        at += 4
        if at + size * 4 > len(data):
            raise SystemExit('Truncated coercion record')
        result.append(struct.unpack_from(f'<{size}I', data, at))
        at += size * 4
    if at != len(data) or result[-1] != (0, 0):
        raise SystemExit('Invalid coercion teardown ledger or trailing bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    substitutions = {'@FAMILY_COUNT@': str(len(FAMILIES)), '@FAMILIES@': ','.join(map(str, FAMILIES)), '@COUNT@': str(COUNT)}
    c_source, silk_source = C_SOURCE, SILK_SOURCE
    for token, value in substitutions.items():
        c_source = c_source.replace(token, value)
        silk_source = silk_source.replace(token, value)
    with tempfile.TemporaryDirectory(prefix='silkjs-object-coercions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Object coercions C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Object coercions C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="object-coercions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native object coercions oracle', cwd=temp)
        expected_records, actual_records = records(expected), records(actual)
        for index, (left, right) in enumerate(zip(expected_records, actual_records)):
            if left != right:
                if index == COUNT:
                    label = 'teardown'
                elif index >= COUNT - 2:
                    label = f'consuming-finalizer-witness={index - (COUNT - 2)}'
                else:
                    collect = index % 2
                    op = index // 2 % 16
                    kind = index // 32 % 8
                    family = FAMILIES[index // 256]
                    label = f'family={family}, value={kind}, operation={op}, collect={collect}'
                raise SystemExit(f'Object coercion mismatch {index} ({label}):\nC={left}\nSilk={right}')
        print(f'PASS object coercions: {COUNT} operations, callback/ownership/error records and zero ledgers; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
