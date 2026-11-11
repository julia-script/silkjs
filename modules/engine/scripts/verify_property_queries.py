#!/usr/bin/env python3
"""Compare native HasProperty/ValueToAtom with the pinned, unmodified C source.

Includes exact keys, pending errors, callback traces, retained owners, destructive
prototype mutation, typed canonical numeric stops, symbols and object coercions.
The C engine is an independent executable, never linked into the native consumer.
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
static size_t usable(const void *p) {return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n) {for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v) {if(JS_IsException(v))abort();return v;}
static int refs(JSValue v) {return JS_VALUE_HAS_REF_COUNT(v)?js_rc(JS_VALUE_GET_PTR(v))->ref_count:0;}
static void text(JSValue value) {JSString*s=JS_VALUE_GET_STRING(value);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));}
static void pending(JSContext *ctx) {
 JSValue e=JS_GetException(ctx);
 if(JS_IsObject(e)){word(1);int kind=99;JSObject*p=JS_VALUE_GET_OBJ(e);
  for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))kind=i;
  word(kind);JSValue message=checked(JS_GetProperty(ctx,e,JS_ATOM_message));text(message);JS_FreeValue(ctx,message);
 }else{word(2);word(JS_VALUE_GET_INT(e));}JS_FreeValue(ctx,e);
}
static uint32_t events[128],event_count,finalized;
static JSValue mutation_target,replacement;
static int mutate_own,mutate_has,fail_has;
typedef struct {JSAtom atom;int present;} Stored;
static void stored_finalizer(JSRuntime*rt,JSValue object) {
 Stored*p=JS_GetOpaque(object,67);if(!p)abort();finalized++;JS_FreeAtomRT(rt,p->atom);js_free_rt(rt,p);
}
static void mutate(JSContext*ctx) {if(JS_SetPrototype(ctx,mutation_target,replacement)<0)abort();JS_RunGC(ctx->rt);}
static int own(JSContext*ctx,JSPropertyDescriptor*d,JSValueConst object,JSAtom atom) {
 if(d)abort();events[event_count++]=2;if(mutate_own)mutate(ctx);JS_RunGC(ctx->rt);
 Stored*p=JS_GetOpaque(object,67);return p->atom==atom&&p->present;
}
static int has(JSContext*ctx,JSValueConst object,JSAtom atom) {
 events[event_count++]=1;if(mutate_has)mutate(ctx);JS_RunGC(ctx->rt);
 if(fail_has){JS_Throw(ctx,JS_NewInt32(ctx,707));return -1;}
 Stored*p=JS_GetOpaque(object,67);return p->atom==atom&&p->present;
}
static JSClassExoticMethods both={.get_own_property=own,.has_property=has};
static JSClassExoticMethods own_only={.get_own_property=own};
static const JSClassDef stored_definition={.class_name="StoredKeys",.finalizer=stored_finalizer,.exotic=&both};
static JSValue exotic(JSContext*ctx,JSAtom key,int present) {
 JSValue object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored*p=js_mallocz(ctx,sizeof(*p));if(!p)abort();
 p->atom=JS_DupAtom(ctx,key);p->present=present;JS_SetOpaque(object,p);return object;
}
static const JSCFunctionListEntry lazy=JS_PROP_STRING_DEF("key","lazy",JS_PROP_C_W_E);
static const char*key_names[]={"key","absent","0","1","2","3","-0","NaN","Infinity","-Infinity","1.5","-1","2147483648","4294967295","01","1.0","1e0",""};
static void query_case(JSContext*ctx,int family) {
 word(family);event_count=finalized=0;mutate_own=mutate_has=fail_has=0;
 ctx->rt->class_array[67].exotic=family==4||family==10?&own_only:&both;
 JSAtom keys[19];for(int i=0;i<18;i++)keys[i]=JS_NewAtom(ctx,key_names[i]);
 JSValue symbol=checked(JS_NewSymbol(ctx,"symbol",FALSE));keys[18]=JS_ValueToAtom(ctx,symbol);JS_FreeValue(ctx,symbol);
 JSValue parent=checked(JS_NewObjectProto(ctx,JS_NULL));
 for(int i=0;i<19;i++)if(JS_DefinePropertyValue(ctx,parent,keys[i],JS_UNDEFINED,JS_PROP_C_W_E)<0)abort();
 JSValue object;
 if(family>=1&&family<=5||family==10||family==11) {
  object=exotic(ctx,keys[0],family==2||family==5||family==10);
  if(family==1||family==11)if(JS_DefinePropertyValue(ctx,object,keys[0],JS_UNDEFINED,JS_PROP_C_W_E)<0)abort();
  if(family==11)JS_VALUE_GET_OBJ(object)->is_exotic=0;
 }else if(family==6||family==7) {
  JSValue length=JS_NewInt32(ctx,3);object=checked(JS_NewTypedArray(ctx,1,&length,JS_TYPED_ARRAY_UINT8));
  if(family==7){JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,object,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);}
 }else object=checked(JS_NewObjectProto(ctx,JS_NULL));
 if(family!=4&&JS_SetPrototype(ctx,object,parent)<0)abort();
 if(family==3)fail_has=1;
 if(family==4){mutate_own=1;mutation_target=object;replacement=parent;}
 if(family==5){JSValue root=checked(JS_NewObjectProto(ctx,object));JS_FreeValue(ctx,object);object=root;
  mutate_has=1;mutation_target=root;replacement=JS_NULL;}
 if(family==8){JSProperty*p=add_property(ctx,JS_VALUE_GET_OBJ(object),keys[0],JS_PROP_VARREF|JS_PROP_C_W_E);if(!p)abort();p->u.var_ref=js_create_var_ref(ctx,TRUE);if(!p->u.var_ref)abort();}
 if(family==9&&JS_DefineAutoInitProperty(ctx,object,keys[0],JS_AUTOINIT_ID_PROP,(void*)&lazy,JS_PROP_C_W_E)<0)abort();
 for(int i=0;i<19;i++){
  int result=JS_HasProperty(ctx,object,keys[i]);word(result+1);word(JS_HasException(ctx));if(result<0)pending(ctx);
  word(event_count);for(unsigned j=0;j<event_count;j++)word(events[j]);word(refs(object));word(refs(parent));word(finalized);
 }
 word(JS_HasProperty(ctx,JS_NULL,keys[0]));
 if(family==9){JSProperty*p;JSShapeProperty*sh=find_own_property(&p,JS_VALUE_GET_OBJ(object),keys[0]);word(sh&&(sh->flags&JS_PROP_TMASK)==JS_PROP_AUTOINIT);}else word(0);
 JS_FreeValue(ctx,object);word(refs(parent));JS_FreeValue(ctx,parent);
 for(int i=0;i<19;i++)JS_FreeAtom(ctx,keys[i]);word(finalized);
}
typedef struct {JSValue result;int event,body;} Closure;
static void closure_finalizer(JSRuntime*rt,JSValue object) {Closure*p=JS_GetOpaque(object,JS_VALUE_GET_OBJ(object)->class_id);if(!p)abort();JS_FreeValueRT(rt,p->result);js_free_rt(rt,p);}
static void closure_mark(JSRuntime*rt,JSValueConst object,JS_MarkFunc*mark) {Closure*p=JS_GetOpaque(object,JS_VALUE_GET_OBJ(object)->class_id);JS_MarkValue(rt,p->result,mark);}
static JSValue closure_call(JSContext*ctx,JSValueConst function,JSValueConst receiver,int argc,JSValueConst*argv,int flags) {
 Closure*p=JS_GetOpaque(function,69);JSValue result=JS_DupValue(ctx,p->result);int body=p->body;events[event_count++]=p->event;
 if(argc==1){JSString*s=JS_VALUE_GET_STRING(argv[0]);if(s->len!=6||memcmp(s->u.str8,"string",6))abort();events[event_count++]=1002;}else if(argc)abort();
 JS_RunGC(ctx->rt);if(body==1)return JS_Throw(ctx,result);if(body==2){JS_FreeValue(ctx,result);return JS_DupValue(ctx,receiver);}return result;
}
static const JSClassDef object_definition={.class_name="CoercionClosure",.finalizer=closure_finalizer,.gc_mark=closure_mark};
static const JSClassDef function_definition={.class_name="CoercionClosure",.finalizer=closure_finalizer,.gc_mark=closure_mark,.call=closure_call};
static JSValue closure(JSContext*ctx,int callable,int event,int body,JSValue result) {
 JSValue object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,callable?69:68));Closure*p=js_malloc(ctx,sizeof(*p));if(!p)abort();
 *p=(Closure){JS_DupValue(ctx,result),event,body};JS_SetOpaque(object,p);return object;
}
static void method(JSContext*ctx,JSValue object,JSAtom atom,int event,int body,JSValue result) {
 JSValue function=closure(ctx,1,event,body,result);if(JS_DefinePropertyValue(ctx,object,atom,function,JS_PROP_C_W_E)<0)abort();
}
static JSValue input(JSContext*ctx,int kind) {
 switch(kind){case 0:return JS_NewInt32(ctx,0);case 1:return JS_NewInt32(ctx,INT32_MAX);case 2:return JS_NewInt32(ctx,-1);
 case 3:return __JS_NewFloat64(ctx,2147483648.0);case 4:return __JS_NewFloat64(ctx,-0.0);case 5:return __JS_NewFloat64(ctx,INFINITY);
 case 6:return __JS_NewFloat64(ctx,NAN);case 7:return JS_NULL;case 8:return JS_UNDEFINED;case 9:return JS_TRUE;
 case 10:return checked(JS_NewString(ctx,"01"));case 11:return checked(JS_NewString(ctx,"-0"));case 12:return checked(JS_NewString(ctx,"key-text"));
 case 13:return checked(JS_NewSymbol(ctx,"same",FALSE));case 14:return checked(JS_NewSymbol(ctx,"same",TRUE));
 case 15:return checked(JS_NewBigInt64(ctx,INT64_C(4294967296)));default:abort();}
}
static void atom_record(JSContext*ctx,JSAtom atom,JSValue original) {
 if(__JS_AtomIsTaggedInt(atom)){word(0);word(__JS_AtomToUInt32(atom));return;}
 JSAtomStruct*p=ctx->rt->atom_array[atom];
 if(p->atom_type==JS_ATOM_TYPE_STRING){word(1);JSValue value=checked(JS_AtomToString(ctx,atom));text(value);JS_FreeValue(ctx,value);}
 else {word(2);word(JS_IsSymbol(original)&&atom==js_symbol_to_atom(ctx,original));}
}
static void value_case(JSContext*ctx,int kind,int mode) {
 word(kind);word(mode);event_count=0;JSValue value=input(ctx,kind),object=JS_UNDEFINED;
 if(mode){object=closure(ctx,0,99,0,JS_UNDEFINED);
  if(mode==1||mode==3)method(ctx,object,JS_ATOM_Symbol_toPrimitive,7,mode==3?1:0,value);
  else{method(ctx,object,JS_ATOM_toString,1,2,JS_UNDEFINED);method(ctx,object,JS_ATOM_valueOf,2,0,value);}}
 int before=refs(value);JSAtom atom=JS_ValueToAtom(ctx,mode?object:value);word(atom!=JS_ATOM_NULL);word(JS_HasException(ctx));
 if(atom)atom_record(ctx,atom,value);else pending(ctx);
 word(event_count);for(unsigned i=0;i<event_count;i++)word(events[i]);word(refs(value)-before);word(refs(object));
 JS_FreeAtom(ctx,atom);word(refs(value)-before);JS_FreeValue(ctx,object);word(refs(value));JS_FreeValue(ctx,value);
}
int main(void) {
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,67,&stored_definition)||JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();
 for(int family=0;family<12;family++)query_case(ctx,family);
 for(int kind=0;kind<16;kind++)for(int mode=0;mode<3;mode++)value_case(ctx,kind,mode);
 value_case(ctx,2,3);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.f64
import silk.num.i32
import silk.core.option { Option }
import silk.mem.pointer { Pointer }
import silk.core.result { Result }
import silk.num.u16
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, ObjectData, ObjectPayload, PropertySlot, EXOTIC_HAS_PROPERTY, EXOTIC_GET_OWN_PROPERTY }
import js_gc as gc
import js_runtime as runtime
import js_object_allocate as objects
import js_value { ValueBits }
import js_atoms { AtomTable }
import js_atom_data as atoms
import js_strings { Strings }
import js_string_types { AtomKind, StringLengthError, stringReference }
import js_bigint { BigIntError }
import js_bigint_coercions as integers
import js_coercions as coercions
import js_coercions_test_support as conversion
import js_coercions_test_support { Hooks as ConversionHooks }
import js_property_queries as queries
import js_property_queries_test_support as fixture
import js_property_queries_test_support { Hooks }
import js_property_descriptors as descriptors
import js_property_descriptors_test_support as descriptorFixture
import js_property_descriptors_test_support { descriptor }
import js_property_ownership { releaseDescriptor }
import js_property_names_test_support as stored
import js_property_names_test_support { Entry }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, rc, trap }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_var_refs as varRefs
import js_shapes as shapes

fn signed(value: i32) -> u32 {
  if value < 0 { return i32.toU32(-(value + 1)) ^ 0xffffffff }
  return i32.toU32(value)
}
unsafe fn refs(value: ValueBits) -> i32 {
  return match value {
    ValueBits.Object { reference: node } => unsafe rc(node)
    ValueBits.String { reference: node } => unsafe rc(node)
    ValueBits.Symbol { reference: node } => unsafe rc(node)
    ValueBits.BigInt { reference: node } => unsafe rc(node)
    _ => 0
  }
}
effect fn flag(out: &mut ByteBuffer, value: bool) -> () ! OutOfMemoryError ? &mut Allocator {
  if value { run out.writeU32(1) } else { run out.writeU32(0) }
}
effect fn text(out: &mut ByteBuffer, value: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i: usize = 0
  while i < Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value, i))) i = i + 1 }
}
unsafe effect fn pending<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader) -> ()
  ! OutOfMemoryError | JsException ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx) let error = unsafe exceptions.take(rt)
  if error.isObject() {
    run out.writeU32(1) run out.writeU32(unsafe descriptorFixture.errorKind(ctx, error))
    let message = descriptor(run unsafe descriptors.getOwnProperty(&mut hooks, ctx, error, atoms.JS_ATOM_message))
    run text(&mut out, message.value) unsafe releaseDescriptor(&mut hooks, rt, move message)
  } else {
    run out.writeU32(2) match error { ValueBits.Int { value } => { run out.writeU32(signed(value)) } _ => trap() }
  }
  unsafe gc.release(&mut hooks, rt, error)
}
unsafe effect fn queryCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver,
  ctx: *mut HeapHeader, family: u32) -> () ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  run out.writeU32(family) hooks.eventCount = 0 hooks.descriptors.stored.finalized = 0
  hooks.mutateOwn = false hooks.mutateHas = false hooks.failHas = false
  let rt = unsafe runtime.contextRuntime(ctx)
  let mut mask = EXOTIC_HAS_PROPERTY | EXOTIC_GET_OWN_PROPERTY
  if family == 4 || family == 10 { mask = EXOTIC_GET_OWN_PROPERTY }
  unsafe fixture.mask(rt, mask)
  let mut keys: [u32; 19] = [0; 19] let mut i: usize = 0
  while i < 19 {
    let name: &[u8] = match i {
      0 => b"key" 1 => b"absent" 2 => b"0" 3 => b"1" 4 => b"2" 5 => b"3" 6 => b"-0"
      7 => b"NaN" 8 => b"Infinity" 9 => b"-Infinity" 10 => b"1.5" 11 => b"-1" 12 => b"2147483648"
      13 => b"4294967295" 14 => b"01" 15 => b"1.0" 16 => b"1e0" 17 => b"" _ => b"symbol"
    }
    let mut kind: u32 = 0 if i == 18 { kind = 1 }
    keys[i] = run unsafe stored.atom(rt, name, kind) i = i + 1
  }
  let parent = run unsafe objects.withPrototype(&mut hooks, memory, ctx, ValueBits.Null)
  i = 0 while i < 19 { run unsafe stored.add(&mut hooks, rt, parent, keys[i], 7, PropertySlot.Value { value: ValueBits.Undefined }) i = i + 1 }
  let mut object = ValueBits.Undefined
  if (family >= 1 && family <= 5) || family == 10 || family == 11 {
    object = run unsafe stored.exotic(&mut hooks.descriptors.stored, memory, ctx)
    run unsafe stored.store(rt, object, Entry { atom: keys[0], flags: 7, present: family == 2 || family == 5 || family == 10,
      seedEnumerable: true, value: ValueBits.Undefined, getter: ValueBits.Undefined, setter: ValueBits.Undefined })
    if family == 1 || family == 11 { run unsafe stored.add(&mut hooks, rt, object, keys[0], 7, PropertySlot.Value { value: ValueBits.Undefined }) }
    if family == 11 { let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object)) p.isExotic = false }
  } else if family == 6 || family == 7 {
    object = run unsafe descriptorFixture.typed(&mut hooks, memory, ctx)
    if family == 7 {
      let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object))
      match &mut p.payload { ObjectPayload.TypedArray { array } => { array.count = 0 array.cachedData = Pointer.null<u8>() } _ => trap() }
    }
  } else { object = run unsafe objects.withPrototype(&mut hooks, memory, ctx, ValueBits.Null) }
  if family != 4 { run unsafe fixture.prototype(&mut hooks, rt, object, parent) }
  if family == 3 { hooks.failHas = true }
  if family == 4 { hooks.mutateOwn = true hooks.mutationTarget = object hooks.replacement = parent }
  if family == 5 {
    let root = run unsafe objects.withPrototype(&mut hooks, memory, ctx, object)
    unsafe gc.release(&mut hooks, rt, object) object = root
    hooks.mutateHas = true hooks.mutationTarget = root hooks.replacement = ValueBits.Null
  }
  if family == 8 {
    let cell = run unsafe varRefs.createDetached(rt, true)
    run unsafe stored.add(&mut hooks, rt, object, keys[0], 39, PropertySlot.VarRef { reference: cell })
  }
  if family == 9 { run unsafe descriptorFixture.autoProperty(&mut hooks, ctx, object, keys[0]) }
  i = 0
  while i < 19 {
    let result = run Effect.result(unsafe queries.hasProperty(&mut hooks, ctx, object, keys[i]))
    match move result {
      Result<bool, OutOfMemoryError | JsException>.Success { value } => {
        if value { run out.writeU32(2) } else { run out.writeU32(1) }
        run flag(&mut out, unsafe exceptions.has(rt))
      }
      Result<bool, OutOfMemoryError | JsException>.Failure { error } => match move error {
        OutOfMemoryError allocation => { fail move allocation }
        JsException signal => { run out.writeU32(0) run flag(&mut out, unsafe exceptions.has(rt)) run unsafe pending(&mut out, &mut hooks, ctx) }
      }
    }
    run out.writeU32(usize.toU32(hooks.eventCount)) let mut j: usize = 0
    while j < hooks.eventCount { run out.writeU32(hooks.events[j]) j = j + 1 }
    run out.writeU32(i32.toU32(unsafe refs(object))) run out.writeU32(i32.toU32(unsafe refs(parent)))
    run out.writeU32(usize.toU32(hooks.descriptors.stored.finalized)) i = i + 1
  }
  run flag(&mut out, run unsafe queries.hasProperty(&mut hooks, ctx, ValueBits.Null, keys[0]))
  let mut dormant = false
  if family == 9 {
    let anchor = () let p = unsafe HeapCell.payload<ObjectData, ()>(&anchor, reference(object))
    let at = match unsafe shapes.lookup(p.shape, keys[0]) { Option<usize>.Some { value } => value _ => trap() }
    dormant = p.properties.get(at).isLazy()
  }
  run flag(&mut out, dormant)
  unsafe gc.release(&mut hooks, rt, object) run out.writeU32(i32.toU32(unsafe refs(parent))) unsafe gc.release(&mut hooks, rt, parent)
  i = 0 while i < 19 { unsafe stored.releaseAtom(rt, keys[i]) i = i + 1 }
  run out.writeU32(usize.toU32(hooks.descriptors.stored.finalized))
}
unsafe effect fn input(rt: *mut HeapHeader, kind: u32) -> ValueBits
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  match kind {
    0 => { return ValueBits.Int { value: 0 } } 1 => { return ValueBits.Int { value: 2147483647 } } 2 => { return ValueBits.Int { value: -1 } }
    3 => { return ValueBits.Float64 { value: 2147483648.0 } } 4 => { return ValueBits.Float64 { value: f64.fromBits(0x8000000000000000) } }
    5 => { return ValueBits.Float64 { value: f64.fromBits(0x7ff0000000000000) } } 6 => { return ValueBits.Float64 { value: f64.fromBits(0x7ff8000000000000) } }
    7 => { return ValueBits.Null } 8 => { return ValueBits.Undefined } 9 => { return ValueBits.Bool { value: true } }
    10 => { return run Strings.fromLatin1(b"01") } 11 => { return run Strings.fromLatin1(b"-0") } 12 => { return run Strings.fromLatin1(b"key-text") }
    13 => {
      let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt)
      let description = run Strings.fromLatin1(b"same") let value = run state.atoms.uniqueSymbol(Option<ValueBits>.some(description)) Strings.release(description) return value
    }
    14 => {
      let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt)
      let description = run Strings.fromLatin1(b"same") let value = run state.atoms.globalSymbol(Option<ValueBits>.some(description)) Strings.release(description) return value
    }
    _ => { return run integers.newBigInt64(4294967296) }
  }
}
unsafe effect fn method(hooks: &mut ConversionHooks, memory: &AllocationObserver, ctx: *mut HeapHeader,
  object: ValueBits, atom: u32, event: u32, body: u32, result: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx)
  let function = run unsafe conversion.closure(&mut hooks, memory, ctx, true, event, body, result, 0, ValueBits.Undefined)
  run unsafe conversion.property(&mut hooks, rt, object, atom, function, false) unsafe gc.release(&mut hooks, rt, function)
}
unsafe effect fn atomRecord(out: &mut ByteBuffer, rt: *mut HeapHeader, atom: u32, original: ValueBits) -> ()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  if AtomTable.isInteger(atom) { run out.writeU32(0) run out.writeU32(AtomTable.integer(atom)) return }
  let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt)
  if state.atoms.propertyKind(atom) == AtomKind.String {
    run out.writeU32(1) let value = run state.atoms.toValue(atom, true) run text(&mut out, value) Strings.release(value)
  } else {
    run out.writeU32(2) let mut equal = false
    if match original { ValueBits.Symbol { .. } => true _ => false } {
      let own = state.atoms.symbolAtom(original) equal = atom == own drop state unsafe stored.releaseAtom(rt, own)
    }
    run flag(&mut out, equal)
  }
}
unsafe effect fn valueCase<'a>(out: &mut ByteBuffer, hooks: &mut ConversionHooks, queryHooks: &mut Hooks<'a>,
  memory: &AllocationObserver, ctx: *mut HeapHeader, kind: u32, mode: u32) -> ()
  ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
  run out.writeU32(kind) run out.writeU32(mode) hooks.clear() hooks.collect = true
  let rt = unsafe runtime.contextRuntime(ctx) let value = run unsafe input(rt, kind) let mut object = ValueBits.Undefined
  if mode != 0 {
    object = run unsafe conversion.object(&mut hooks, memory, ctx, 99)
    if mode == 1 || mode == 3 {
      let mut body: u32 = 0 if mode == 3 { body = 1 }
      run unsafe method(&mut hooks, memory, ctx, object, atoms.JS_ATOM_Symbol_toPrimitive, 7, body, value)
    } else {
      run unsafe method(&mut hooks, memory, ctx, object, atoms.JS_ATOM_toString, 1, 2, ValueBits.Undefined)
      run unsafe method(&mut hooks, memory, ctx, object, atoms.JS_ATOM_valueOf, 2, 0, value)
    }
  }
  let before = unsafe refs(value) let mut argument = value if mode != 0 { argument = object }
  let result = run Effect.result(unsafe coercions.valueToAtom(&mut hooks, ctx, argument)) let mut atom: u32 = 0
  match move result {
    Result<u32, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Success { value: found } => {
      atom = found run out.writeU32(1) run flag(&mut out, unsafe exceptions.has(rt)) run unsafe atomRecord(&mut out, rt, atom, value)
    }
    Result<u32, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Failure { error } => match move error {
      JsException signal => { run out.writeU32(0) run flag(&mut out, unsafe exceptions.has(rt)) run unsafe pending(&mut out, &mut queryHooks, ctx) }
      OutOfMemoryError allocation => { fail move allocation } StringLengthError length => { fail move length } BigIntError integer => { fail move integer }
    }
  }
  run out.writeU32(usize.toU32(hooks.eventCount)) let mut i: usize = 0
  while i < hooks.eventCount { run out.writeU32(hooks.events[i]) i = i + 1 }
  run out.writeU32(signed(unsafe refs(value) - before)) run out.writeU32(i32.toU32(unsafe refs(object)))
  unsafe stored.releaseAtom(rt, atom) run out.writeU32(signed(unsafe refs(value) - before))
  unsafe gc.release(&mut hooks, rt, object) run out.writeU32(i32.toU32(unsafe refs(value))) unsafe gc.release(&mut hooks, rt, value)
}
effect fn probe(out: &mut ByteBuffer) -> AllocationObserver
  ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make(&observer) let mut conversionHooks = ConversionHooks.make()
  run unsafe stored.register(rt) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe conversion.register(rt) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe conversion.prepareErrors(&mut conversionHooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let mut family: u32 = 0
  while family < 12 { run unsafe queryCase(&mut out, &mut hooks, &observer, ctx, family) |> Effect.provideMut<Allocator>(&mut memory) family = family + 1 }
  let mut kind: u32 = 0
  while kind < 16 {
    let mut mode: u32 = 0
    while mode < 3 { run unsafe valueCase(&mut out, &mut conversionHooks, &mut hooks, &observer, ctx, kind, mode) |> Effect.provideMut<Allocator>(&mut memory) mode = mode + 1 }
    kind = kind + 1
  }
  run unsafe valueCase(&mut out, &mut conversionHooks, &mut hooks, &observer, ctx, 2, 3) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory) drop hooks
  return move observer
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make() let mut writer = StdoutWriter.make()
  let ledger = run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer) drop out
  if ledger.stats().usedBytes != 0 || ledger.stats().allocationCount != 0 { trap() }
  run Writer.writeAll(&[0, 0, 0, 0, 0, 0, 0, 0]) |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    with tempfile.TemporaryDirectory(prefix='silkjs-property-queries-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Property queries C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Property queries C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="property-queries-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native property queries oracle', cwd=temp)
        if not expected or len(expected) % 4 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C query output or nonzero teardown ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Query word {offset//4}: C={a.hex()} Silk={b.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS property queries: 228 HasProperty queries, 49 ValueToAtom cases; {len(actual)//4} words; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; both teardown ledgers zero')


if __name__ == '__main__':
    main()
