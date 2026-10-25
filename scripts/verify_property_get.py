#!/usr/bin/env python3
"""Compare complete native Get with unchanged pinned QuickJS in separate processes.

Records exact tags/float bits/BigInt limbs, error values/messages, registered
callback counts and finalizer events. Real typed cache bytes cover all twelve
classes. Both process ledgers must be zero; no C engine enters the native binary.
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
KEYS = ['key', 'absent', '0', '1', '2', '3', 'length', '-0', '01', '4294967295', '-1', '1.5', 'NaN', 'Infinity']
# Class order is the pinned public/native typed-array order, Uint8Clamped..Float64.
TYPED = [
    (1, [0, 127, 128, 255]), (1, [0, 127, 128, 255]), (1, [0, 127, 128, 255]),
    (2, [0, 32767, 32768, 65535]), (2, [0, 32767, 32768, 65535]),
    (4, [0, 0x7fffffff, 0x80000000, 0xffffffff]),
    (4, [0, 0x7fffffff, 0x80000000, 0xffffffff]),
    (8, [0, 0x7fffffff, 0x80000000, 0xffffffffffffffff, 0x8000000000000000]),
    (8, [0, 0x7fffffff, 0x80000000, 0xffffffffffffffff, 0x8000000000000000]),
    (2, [0, 0x8000, 0x3c00, 1, 0x7bff, 0x7c00, 0xfc00, 0x7e42]),
    (4, [0, 0x80000000, 0x3f800000, 1, 0x7f7fffff, 0x7f800000, 0xff800000, 0x7fc00042]),
    (8, [0, 0x8000000000000000, 0x3ff0000000000000, 1, 0x7fefffffffffffff,
         0x7ff0000000000000, 0xfff0000000000000, 0x7ff8000000000042]),
]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;static int fail_next,failures;
static void *allocate(JSMallocState*s,size_t n){if(!n)return NULL;if(fail_next){fail_next=0;failures++;return NULL;}Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void release(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *resize(JSMallocState*s,void*p,size_t n){if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fail_next){fail_next=0;failures++;return NULL;}Header*h=(Header*)p-1;size_t old=h->size;Header*r=realloc(h,sizeof(*h)+n);if(!r)return NULL;r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;}
static size_t usable(const void*p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t v){for(int i=0;i<4;i++)putchar((v>>(8*i))&255);}
static void wide(uint64_t v){word(v);word(v>>32);}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static void value(JSValue v){int tag=JS_VALUE_GET_NORM_TAG(v);word(tag);
 if(tag==JS_TAG_INT)word(JS_VALUE_GET_INT(v));
 else if(tag==JS_TAG_BOOL)word(JS_VALUE_GET_BOOL(v));
 else if(tag==JS_TAG_SHORT_BIG_INT){word(1);word(JS_VALUE_GET_SHORT_BIG_INT(v));}
 else if(tag==JS_TAG_BIG_INT){JSBigInt*p=JS_VALUE_GET_PTR(v);word(p->len);for(int i=0;i<p->len;i++)word(p->tab[i]);}
 else if(tag==JS_TAG_FLOAT64)wide(float64_as_uint64(JS_VALUE_GET_FLOAT64(v)));
 else if(tag==JS_TAG_STRING){JSString*s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));}}
static unsigned calls,own_calls,get_calls,auto_calls,final_count,final_events[128];
typedef struct {JSValue result,mutation;JSAtom atom;unsigned event,body;} Closure;
static void closure_final(JSRuntime*rt,JSValue obj){Closure*p=JS_GetOpaque(obj,69);final_events[final_count++]=p->event;JS_FreeValueRT(rt,p->result);JS_FreeValueRT(rt,p->mutation);js_free_rt(rt,p);}
static void closure_mark(JSRuntime*rt,JSValueConst obj,JS_MarkFunc*mark){Closure*p=JS_GetOpaque(obj,69);JS_MarkValue(rt,p->result,mark);JS_MarkValue(rt,p->mutation,mark);}
static JSValue call(JSContext*ctx,JSValueConst fn,JSValueConst receiver,int argc,JSValueConst*argv,int flags){Closure*p=JS_GetOpaque(fn,69);JSValue result=JS_DupValue(ctx,p->result);calls++;
 if(p->body==3){if(JS_DefinePropertyValue(ctx,receiver,p->atom,JS_DupValue(ctx,p->mutation),JS_PROP_C_W_E)<0)abort();}
 JS_RunGC(ctx->rt);if(p->body==1)return JS_Throw(ctx,result);if(p->body==2){JS_FreeValue(ctx,result);return JS_DupValue(ctx,receiver);}return result;}
static const JSClassDef callable={.class_name="GetClosure",.finalizer=closure_final,.gc_mark=closure_mark,.call=call};
static JSValue closure(JSContext*ctx,unsigned event,unsigned body,JSValue result,JSAtom atom,JSValue mutation){JSValue fn=checked(JS_NewObjectProtoClass(ctx,JS_NULL,69));Closure*p=js_malloc(ctx,sizeof(*p));if(!p)abort();*p=(Closure){JS_DupValue(ctx,result),JS_DupValue(ctx,mutation),atom,event,body};JS_SetOpaque(fn,p);return fn;}
typedef struct{JSAtom atom;JSValue value,getter,setter;int flags;} Stored;
static int fail_get,fail_own;
static void finalizer(JSRuntime*rt,JSValue object){Stored*p=JS_GetOpaque(object,67);JS_FreeAtomRT(rt,p->atom);JS_FreeValueRT(rt,p->value);JS_FreeValueRT(rt,p->getter);JS_FreeValueRT(rt,p->setter);js_free_rt(rt,p);}
static void marker(JSRuntime*rt,JSValueConst object,JS_MarkFunc*mark){Stored*p=JS_GetOpaque(object,67);JS_MarkValue(rt,p->value,mark);JS_MarkValue(rt,p->getter,mark);JS_MarkValue(rt,p->setter,mark);}
static int own(JSContext*ctx,JSPropertyDescriptor*d,JSValueConst object,JSAtom atom){own_calls++;JS_RunGC(ctx->rt);if(fail_own){JS_ThrowTypeError(ctx,"exotic failed");return -1;}Stored*p=JS_GetOpaque(object,67);if(p->atom!=atom)return 0;if(d){d->flags=p->flags;d->value=JS_DupValue(ctx,p->value);d->getter=JS_DupValue(ctx,p->getter);d->setter=JS_DupValue(ctx,p->setter);}return 1;}
static JSValue exotic_get(JSContext*ctx,JSValueConst object,JSAtom atom,JSValueConst receiver){get_calls++;JS_RunGC(ctx->rt);if(fail_get)return JS_ThrowTypeError(ctx,"get failed");Stored*p=JS_GetOpaque(object,67);return p->atom==atom?JS_DupValue(ctx,p->value):JS_UNDEFINED;}
static JSClassExoticMethods exotic={.get_own_property=own};
static const JSClassDef stored={.class_name="StoredKeys",.finalizer=finalizer,.gc_mark=marker,.exotic=&exotic};
static const JSCFunctionListEntry lazy=JS_PROP_STRING_DEF("key","lazy",3);
static void result(JSContext*ctx,JSValue v){value(v);if(JS_IsException(v)){int pending=JS_HasException(ctx);word(pending);if(pending){JSValue e=JS_GetException(ctx);if(JS_IsObject(e)){JSObject*p=JS_VALUE_GET_OBJ(e);int kind=99;for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))kind=i;word(kind);JSValue m=checked(JS_GetProperty(ctx,e,JS_ATOM_message));value(m);JS_FreeValue(ctx,m);}else{word(99);value(e);}JS_FreeValue(ctx,e);}}JS_FreeValue(ctx,v);}
static void query(JSContext*ctx,JSValue object,JSAtom atom){if(JS_IsObject(object)){JSProperty*p;JSShapeProperty*s=find_own_property(&p,JS_VALUE_GET_OBJ(object),atom);if(s&&(s->flags&JS_PROP_TMASK)==JS_PROP_AUTOINIT)auto_calls++;}result(ctx,JS_GetProperty(ctx,object,atom));result(ctx,JS_GetPropertyValue(ctx,object,checked(JS_AtomToValue(ctx,atom))));word(calls);word(own_calls);word(get_calls);word(auto_calls);}
static const char*keys[]={KEYS};
static void run_case(JSContext*ctx,int family){calls=own_calls=get_calls=auto_calls=final_count=0;fail_get=family==12;fail_own=family==13;exotic.get_property=(family==11||family==12)?exotic_get:NULL;
 JSAtom key=JS_NewAtom(ctx,"key");JSValue object=JS_UNDEFINED;
 if(family==17)object=JS_NULL;else if(family==18)object=JS_UNDEFINED;else if(family==19)object=JS_EXCEPTION;
 else if(family==15)object=checked(JS_NewString(ctx,"a\xC3\xA9"));
 else if(family==16){char bytes[8193];memset(bytes,'a',sizeof(bytes));JSValue a=checked(JS_NewStringLen(ctx,bytes,sizeof(bytes)));object=checked(JS_ConcatString(ctx,JS_DupValue(ctx,a),a));if(JS_VALUE_GET_TAG(object)!=JS_TAG_STRING_ROPE)abort();}
 else if(family==14||family==20||family==21||family==22||family==23){int cls=family==14?JS_CLASS_NUMBER:family==20?JS_CLASS_STRING:family==21?JS_CLASS_BOOLEAN:family==22?JS_CLASS_BIG_INT:JS_CLASS_SYMBOL;
  JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL));JSValue fn=closure(ctx,31,2,JS_UNDEFINED,0,JS_UNDEFINED);if(JS_DefinePropertyGetSet(ctx,proto,key,fn,JS_UNDEFINED,JS_PROP_CONFIGURABLE)<0)abort();JS_SetClassProto(ctx,cls,proto);
  object=family==14?JS_NewInt32(ctx,73):family==20?checked(JS_NewString(ctx,"ab")):family==21?JS_TRUE:family==22?JS_NewBigInt64(ctx,9):JS_NewSymbol(ctx,"symbol",0);}
 else if(family>=9&&family<=13){object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored*p=js_malloc(ctx,sizeof(*p));if(!p)abort();JSValue getter=JS_UNDEFINED,setter=JS_UNDEFINED;if(family==10){getter=closure(ctx,32,0,JS_NewInt32(ctx,62),0,JS_UNDEFINED);setter=closure(ctx,34,0,JS_UNDEFINED,0,JS_UNDEFINED);}*p=(Stored){JS_DupAtom(ctx,key),family==10?JS_UNDEFINED:JS_NewInt32(ctx,61),getter,setter,family==10?JS_PROP_GETSET|7:7};JS_SetOpaque(object,p);}
 else if(family>=6&&family<=8){int cls=family==6?JS_CLASS_ARRAY:family==7?JS_CLASS_ARGUMENTS:JS_CLASS_MAPPED_ARGUMENTS;object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,cls));JSObject*p=JS_VALUE_GET_OBJ(object);
  if(family==8){p->u.array.u.var_refs=js_malloc(ctx,2*sizeof(JSVarRef*));if(!p->u.array.u.var_refs)abort();for(int i=0;i<2;i++){JSVarRef*v=js_create_var_ref(ctx,FALSE);if(!v)abort();v->value=JS_NewInt32(ctx,91+i);p->u.array.u.var_refs[i]=v;}p->u.array.count=2;}
  else {if(expand_fast_array(ctx,p,2))abort();for(int i=0;i<2;i++)p->u.array.u.values[i]=JS_NewInt32(ctx,91+i);p->u.array.count=2;if(family==6)p->prop[0].u.value=JS_NewInt32(ctx,2);}}
 else {object=checked(JS_NewObjectProto(ctx,JS_NULL));if(family==5){if(JS_DefineAutoInitProperty(ctx,object,key,JS_AUTOINIT_ID_PROP,(void*)&lazy,3)<0)abort();}
  else if(family==1||family==2||family==24){JSValue fn=JS_UNDEFINED;if(family!=2)fn=closure(ctx,33,family==24?3:0,JS_NewInt32(ctx,42),key,JS_NewInt32(ctx,91));if(JS_DefinePropertyGetSet(ctx,object,key,fn,JS_UNDEFINED,JS_PROP_C_W_E)<0)abort();}
  else if(family==3||family==4){JSProperty*p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,JS_PROP_VARREF|7);if(!p)abort();p->u.var_ref=js_create_var_ref(ctx,family==4);if(!p->u.var_ref)abort();if(family==3)p->u.var_ref->value=checked(JS_NewString(ctx,"owned"));}
  else if(JS_DefinePropertyValue(ctx,object,key,checked(JS_NewString(ctx,"owned")),JS_PROP_C_W_E)<0)abort();}
 for(unsigned i=0;i<sizeof(keys)/sizeof(*keys);i++){JSAtom a=JS_NewAtom(ctx,keys[i]);query(ctx,object,a);JS_FreeAtom(ctx,a);}
 if(family!=19)result(ctx,JS_GetPropertyInternal(ctx,object,JS_ATOM_name,object,TRUE));
 if(family==5&&auto_calls!=1)abort();JS_FreeValue(ctx,object);JS_FreeAtom(ctx,key);word(final_count);for(unsigned i=0;i<final_count;i++)word(final_events[i]);
}
static void typed_case(JSContext*ctx,int cls,const unsigned char*raw,size_t n,int count){calls=own_calls=get_calls=auto_calls=0;JSValue len=JS_NewInt32(ctx,count);JSValue object=checked(JS_NewTypedArray(ctx,1,&len,cls-JS_CLASS_UINT8C_ARRAY));memcpy(JS_VALUE_GET_OBJ(object)->u.array.u.ptr,raw,n);
 JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL));for(unsigned i=0;i<sizeof(keys)/sizeof(*keys);i++)if(JS_DefinePropertyValueStr(ctx,proto,keys[i],JS_NewInt32(ctx,777),JS_PROP_C_W_E)<0)abort();if(JS_SetPrototype(ctx,object,proto)<0)abort();JS_FreeValue(ctx,proto);
 for(int i=0;i<=count;i++)result(ctx,JS_GetPropertyUint32(ctx,object,i));for(unsigned i=0;i<sizeof(keys)/sizeof(*keys);i++){JSAtom a=JS_NewAtom(ctx,keys[i]);query(ctx,object,a);JS_FreeAtom(ctx,a);}JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,object,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);result(ctx,JS_GetPropertyUint32(ctx,object,0));JS_FreeValue(ctx,object);}
static void try_query(JSContext*ctx,JSValue object,int64_t index){JSValue out=JS_NewInt32(ctx,123);int found=JS_TryGetPropertyInt64(ctx,object,index,&out);word(found+1);value(out);JS_FreeValue(ctx,out);if(found<0)result(ctx,JS_EXCEPTION);}
static void wrappers(JSContext*ctx){calls=own_calls=get_calls=auto_calls=final_count=0;fail_get=fail_own=0;exotic.get_property=NULL;
 JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL));const int64_t indices[]={-1,0,2147483647LL,2147483648LL,INT64_MIN,INT64_MAX};
 for(unsigned i=0;i<sizeof(indices)/sizeof(*indices);i++){JSAtom a=JS_NewAtomInt64(ctx,indices[i]);if(JS_DefinePropertyValue(ctx,object,a,JS_NewInt32(ctx,100+i),JS_PROP_C_W_E)<0)abort();JS_FreeAtom(ctx,a);}
 for(unsigned i=0;i<sizeof(indices)/sizeof(*indices);i++){result(ctx,JS_GetPropertyInt64(ctx,object,indices[i]));try_query(ctx,object,indices[i]);}try_query(ctx,object,99);
 result(ctx,JS_GetPropertyStr(ctx,object,"2147483648"));result(ctx,JS_GetPropertyStr(ctx,object,"0\0ignored"));
 JSValue throwing=closure(ctx,51,1,JS_NewInt32(ctx,501),0,JS_UNDEFINED);if(JS_DefinePropertyGetSet(ctx,object,__JS_AtomFromUInt32(8),throwing,JS_UNDEFINED,JS_PROP_C_W_E)<0)abort();try_query(ctx,object,8);
 JSProperty*p=add_property(ctx,JS_VALUE_GET_OBJ(object),__JS_AtomFromUInt32(9),JS_PROP_VARREF|7);if(!p)abort();p->u.var_ref=js_create_var_ref(ctx,TRUE);if(!p->u.var_ref)abort();try_query(ctx,object,9);
 for(int mode=0;mode<3;mode++){JSValue key=closure(ctx,60+mode*2,0,JS_UNDEFINED,0,JS_UNDEFINED);JSValue convert=closure(ctx,61+mode*2,mode==2?1:0,JS_NewInt32(ctx,0),0,JS_UNDEFINED);if(JS_DefinePropertyValue(ctx,key,JS_ATOM_Symbol_toPrimitive,convert,JS_PROP_C_W_E)<0)abort();result(ctx,JS_GetPropertyValue(ctx,mode==0?JS_NULL:object,key));word(calls);word(final_count);for(unsigned i=0;i<final_count;i++)word(final_events[i]);}
 JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL));JSAtom key=JS_NewAtom(ctx,"receiver");JSValue identity=closure(ctx,71,2,JS_UNDEFINED,0,JS_UNDEFINED);if(JS_DefinePropertyGetSet(ctx,proto,key,identity,JS_UNDEFINED,JS_PROP_C_W_E)<0)abort();result(ctx,JS_GetPropertyInternal(ctx,proto,key,JS_NewInt32(ctx,73),FALSE));JS_FreeValue(ctx,proto);JS_FreeAtom(ctx,key);
 JS_FreeValue(ctx,object);word(final_count);for(unsigned i=0;i<final_count;i++)word(final_events[i]);
}
static void typed_failure(JSContext*ctx){word(201);JSValue length=JS_NewInt32(ctx,1);JSValue object=checked(JS_NewTypedArray(ctx,1,&length,JS_TYPED_ARRAY_BIG_INT64));JS_VALUE_GET_OBJ(object)->u.array.u.int64_ptr[0]=INT64_C(4294967296);fail_next=1;JSValue result=JS_GetProperty(ctx,object,__JS_AtomFromUInt32(0));word(JS_IsException(result));word(failures);word(js_rc(JS_VALUE_GET_OBJ(object))->ref_count);if(!JS_IsException(result)||!JS_HasException(ctx))abort();JS_FreeValue(ctx,JS_GetException(ctx));JS_FreeValue(ctx,object);}
int main(void){JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();if(JS_NewClass(rt,67,&stored)||JS_NewClass(rt,69,&callable))abort();
 int primitive_classes[]={JS_CLASS_NUMBER,JS_CLASS_STRING,JS_CLASS_BOOLEAN,JS_CLASS_BIG_INT,JS_CLASS_SYMBOL};
 for(unsigned i=0;i<sizeof(primitive_classes)/sizeof(*primitive_classes);i++)JS_SetClassProto(ctx,primitive_classes[i],checked(JS_NewObjectProto(ctx,JS_NULL)));
 CALLS
 typed_failure(ctx);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.f64
import silk.i32
import silk.list { List }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.result { Result }
import silk.u16
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, ObjectData, ObjectPayload, PropertySlot }
import js_value { Value }
import js_bigint { BigInt, BigIntError }
import js_gc as gc
import js_runtime as runtime
import js_object_allocate as objects
import js_class_data as classes
import js_atom_data as atoms
import js_strings { Strings, StringBuilder }
import js_string_types { StringLengthError }
import js_property_get as get
import js_property_get_test_support as fixture
import js_property_get_test_support { Hooks }
import js_property_names_test_support as stored
import js_property_names_test_support { Entry }
import js_property_descriptors_test_support as descriptors
import js_property_queries_test_support { prototype, mask }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, rc, trap }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_errors_test_support { FaultAllocator }
effect fn oom(signal: OutOfMemoryError) -> Value { drop signal return Value.Exception }
fn bits(number: i32) -> u32 { if number < 0 { return i32.toU32(-(number + 1)) ^ 0xffffffff } return i32.toU32(number) }
effect fn value(out: &mut ByteBuffer, item: Value) -> () ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(bits(item.tag()))
 match item {
  Value.Int { value: number } => { run out.writeU32(bits(number)) }
  Value.Bool { value: boolean } => { if boolean { run out.writeU32(1) } else { run out.writeU32(0) } }
  Value.ShortBigInt { value: number } => { run out.writeU32(1) run out.writeU32(bits(number)) }
  Value.BigInt { reference: node } => { let anchor = () let big = unsafe HeapCell.payload<BigInt, ()>(&anchor, node)
   run out.writeU32(usize.toU32(big.length())) let mut i: usize = 0 while i < big.length() { run out.writeU32(big.limb(i)) i = i + 1 } }
  Value.Float64 { value: number } => { let raw = f64.toBits(number) run out.writeU32(u64.toU32(raw & 0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(raw, 32))) }
  Value.String { .. } => { run out.writeU32(usize.toU32(Strings.length(item))) let mut i: usize = 0 while i < Strings.length(item) { run out.writeU32(u16.toU32(Strings.codeUnit(item, i))) i = i + 1 } }
  _ => ()
 }
}
effect fn thrown(signal: JsException) -> Value { drop signal return Value.Exception }
unsafe effect fn result<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader, item: Value) -> ()
 ! OutOfMemoryError | JsException ? &mut Allocator {
 let rt = unsafe runtime.contextRuntime(ctx) run value(&mut out, item)
 if item.isException() {
  if unsafe exceptions.has(rt) {
   run out.writeU32(1) let pending = unsafe exceptions.take(rt)
   if pending.isObject() { run out.writeU32(unsafe descriptors.errorKind(ctx, pending))
    let message = run unsafe get.getProperty(&mut hooks, ctx, pending, atoms.JS_ATOM_message)
    run value(&mut out, message) unsafe gc.release(&mut hooks, rt, message)
   } else { run out.writeU32(99) run value(&mut out, pending) }
   unsafe gc.release(&mut hooks, rt, pending)
  } else { run out.writeU32(0) }
 }
 unsafe gc.release(&mut hooks, rt, item)
}
unsafe effect fn query<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader, object: Value, atom: u32) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let first = run Effect.catch<JsException>(unsafe get.getProperty(&mut hooks, ctx, object, atom), thrown)
 run unsafe result(&mut out, &mut hooks, ctx, first)
 let rt = unsafe runtime.contextRuntime(ctx) let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt)
 let key = run state.atoms.toValue(atom, false) drop state
 let second = run Effect.catch<JsException>(unsafe get.getPropertyValue(&mut hooks, ctx, object, key), thrown)
 run unsafe result(&mut out, &mut hooks, ctx, second)
 run out.writeU32(usize.toU32(hooks.calls)) run out.writeU32(usize.toU32(hooks.ownCalls))
 run out.writeU32(usize.toU32(hooks.getCalls)) run out.writeU32(usize.toU32(hooks.autoCalls))
}
unsafe effect fn runCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, family: u32) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let rt = unsafe runtime.contextRuntime(ctx) hooks.calls = 0 hooks.ownCalls = 0 hooks.getCalls = 0 hooks.autoCalls = 0 hooks.finalizedCount = 0
 hooks.failGet = family == 12 hooks.failOwn = family == 13
 if family == 11 || family == 12 { unsafe mask(rt, 33) } else { unsafe mask(rt, 1) }
 let key = run unsafe stored.atom(rt, b"key", 0)
 let mut object = Value.Undefined
 if family == 17 { object = Value.Null } else if family == 18 { object = Value.Undefined } else if family == 19 { object = Value.Exception }
 else if family == 15 { object = run Strings.fromLatin1(b"a\xe9") }
 else if family == 16 { let mut builder = StringBuilder.make() run builder.fill(97, 8193) let text = run builder.finish() object = run Strings.concat(text, text) unsafe gc.release(&mut hooks, rt, text) if object.tag() != -6 { trap() } }
 else if family == 14 || family == 20 || family == 21 || family == 22 || family == 23 {
  let mut cls = classes.JS_CLASS_NUMBER
  if family == 20 { cls = classes.JS_CLASS_STRING } else if family == 21 { cls = classes.JS_CLASS_BOOLEAN } else if family == 22 { cls = classes.JS_CLASS_BIG_INT } else if family == 23 { cls = classes.JS_CLASS_SYMBOL }
  let parent = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null)
  let function = run unsafe fixture.closure(&mut hooks, ctx, 31, 2, Value.Undefined, 0, Value.Undefined)
  run unsafe stored.add(&mut hooks, rt, parent, key, 17, PropertySlot.GetterSetter { getter: reference(function), setter: Pointer.null<HeapHeader>() })
  unsafe runtime.setClassPrototype(&mut hooks, ctx, cls, parent)
  object = Value.Int { value: 73 }
  if family == 20 { object = run Strings.fromLatin1(b"ab") } else if family == 21 { object = Value.Bool { value: true } } else if family == 22 { object = Value.ShortBigInt { value: 9 } }
  else if family == 23 { let symbol = run unsafe stored.atom(rt, b"symbol", 1) let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt) object = run state.atoms.toValue(symbol, false) drop state unsafe stored.releaseAtom(rt, symbol) }
 } else if family >= 9 && family <= 13 {
  object = run unsafe fixture.exotic(&mut hooks, ctx) let mut getter = Value.Undefined let mut setter = Value.Undefined let mut data = Value.Int { value: 61 } let mut flags: u32 = 7
  if family == 10 { getter = run unsafe fixture.closure(&mut hooks, ctx, 32, 0, Value.Int { value: 62 }, 0, Value.Undefined) setter = run unsafe fixture.closure(&mut hooks, ctx, 34, 0, Value.Undefined, 0, Value.Undefined) data = Value.Undefined flags = 23 }
  run unsafe stored.store(rt, object, Entry { atom: key, flags: flags, present: true, seedEnumerable: true, value: data, getter: getter, setter: setter })
  unsafe gc.release(&mut hooks, rt, getter) unsafe gc.release(&mut hooks, rt, setter)
 } else if family >= 6 && family <= 8 {
  let mut cls = classes.JS_CLASS_ARRAY if family == 7 { cls = classes.JS_CLASS_ARGUMENTS } else if family == 8 { cls = classes.JS_CLASS_MAPPED_ARGUMENTS }
  object = run unsafe objects.withPrototypeClass(&mut hooks, memory, ctx, Value.Null, cls)
  let mut i: i32 = 0
  while i < 2 {
   if family == 8 { let node = run unsafe storage.detached(rt, Value.Int { value: 91 + i }) run unsafe storage.appendMapped(object, node) }
   else { let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object))
    match &mut p.payload { ObjectPayload.FastArray { array } => { run array.values.append(Value.Int { value: 91 + i }) } _ => trap() } }
   i = i + 1
  }
  if family == 6 { let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object)) p.properties.set(0, PropertySlot.Value { value: Value.Int { value: 2 } }) }
 } else {
  object = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null)
  if family == 5 { run unsafe descriptors.autoProperty(&mut hooks, ctx, object, key) }
  else if family == 1 || family == 2 || family == 24 {
   let mut function = Pointer.null<HeapHeader>()
   if family != 2 { let mut body: u32 = 0 if family == 24 { body = 3 } function = reference(run unsafe fixture.closure(&mut hooks, ctx, 33, body, Value.Int { value: 42 }, key, Value.Int { value: 91 })) }
   run unsafe stored.add(&mut hooks, rt, object, key, 23, PropertySlot.GetterSetter { getter: function, setter: Pointer.null<HeapHeader>() })
  } else if family == 3 || family == 4 {
   let mut data = Value.Uninitialized if family == 3 { data = run Strings.fromLatin1(b"owned") }
   let node = run unsafe storage.detached(rt, data) run unsafe stored.add(&mut hooks, rt, object, key, 39, PropertySlot.VarRef { reference: node })
  } else { let text = run Strings.fromLatin1(b"owned") run unsafe stored.add(&mut hooks, rt, object, key, 7, PropertySlot.Value { value: text }) }
 }
 let keys: [&[u8]; KEYCOUNT] = [KEYS]
 let mut i: usize = 0 while i < keys.length { let atom = run unsafe stored.atom(rt, keys[i], 0) run unsafe query(&mut out, &mut hooks, ctx, object, atom) unsafe stored.releaseAtom(rt, atom) i = i + 1 }
 if family != 19 { let missing = run Effect.catch<JsException>(unsafe get.getPropertyReceiver(&mut hooks, ctx, object, atoms.JS_ATOM_name, object, true), thrown) run unsafe result(&mut out, &mut hooks, ctx, missing) }
 unsafe gc.release(&mut hooks, rt, object) unsafe stored.releaseAtom(rt, key)
 run out.writeU32(usize.toU32(hooks.finalizedCount)) i = 0 while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
}
unsafe effect fn typedCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, cls: u32, raw: &[u8], count: u32) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 hooks.calls = 0 hooks.ownCalls = 0 hooks.getCalls = 0 hooks.autoCalls = 0
 let rt = unsafe runtime.contextRuntime(ctx) let object = run unsafe fixture.typed(&mut hooks, ctx, cls, raw, count)
 let parent = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null)
 let keys: [&[u8]; KEYCOUNT] = [KEYS]
 let mut i: usize = 0 while i < keys.length { let atom = run unsafe stored.atom(rt, keys[i], 0) run unsafe stored.add(&mut hooks, rt, parent, atom, 7, PropertySlot.Value { value: Value.Int { value: 777 } }) unsafe stored.releaseAtom(rt, atom) i = i + 1 }
 run unsafe prototype(&mut hooks, rt, object, parent) unsafe gc.release(&mut hooks, rt, parent)
 let mut index: u32 = 0 while index <= count { let item = run unsafe get.getPropertyUint32(&mut hooks, ctx, object, index) run unsafe result(&mut out, &mut hooks, ctx, item) index = index + 1 }
 i = 0 while i < keys.length { let atom = run unsafe stored.atom(rt, keys[i], 0) run unsafe query(&mut out, &mut hooks, ctx, object, atom) unsafe stored.releaseAtom(rt, atom) i = i + 1 }
 let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object))
 match &mut p.payload { ObjectPayload.TypedArray { array } => { array.count = 0 array.cachedData = Pointer.null<u8>() } _ => trap() } drop p
 let detached = run unsafe get.getPropertyUint32(&mut hooks, ctx, object, 0) run unsafe result(&mut out, &mut hooks, ctx, detached)
 unsafe gc.release(&mut hooks, rt, object)
}
effect fn tryThrown(signal: JsException) -> i32 { drop signal return -1 }
unsafe effect fn tryPresent<'a>(hooks: &mut Hooks<'a>, ctx: *mut HeapHeader, object: Value, index: i64, output: &mut Value) -> i32
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 if run unsafe get.tryGetPropertyInt64(&mut hooks, ctx, object, index, &mut output) { return 1 }
 return 0
}
unsafe effect fn tryQuery<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader, object: Value, index: i64) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let mut output = Value.Int { value: 123 }
 let found = run Effect.catch<JsException>(unsafe tryPresent(&mut hooks, ctx, object, index, &mut output), tryThrown)
 run out.writeU32(bits(found + 1)) run value(&mut out, output)
 unsafe gc.release(&mut hooks, unsafe runtime.contextRuntime(ctx), output)
 if found < 0 { run unsafe result(&mut out, &mut hooks, ctx, Value.Exception) }
}
unsafe effect fn wrappers<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 hooks.calls = 0 hooks.ownCalls = 0 hooks.getCalls = 0 hooks.autoCalls = 0 hooks.finalizedCount = 0 hooks.failGet = false hooks.failOwn = false
 unsafe mask(unsafe runtime.contextRuntime(ctx), 1)
 let rt = unsafe runtime.contextRuntime(ctx)
 let object = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null)
 let indices: [i64; 6] = [-1,0,2147483647,2147483648,-9223372036854775807 - 1,9223372036854775807]
 let mut i: usize = 0
 while i < indices.length {
  let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt)
  let atom = run state.atoms.internInt64(indices[i]) drop state
  run unsafe stored.add(&mut hooks, rt, object, atom, 7, PropertySlot.Value { value: Value.Int { value: 100 + usize.toI32(i) } })
  unsafe stored.releaseAtom(rt, atom) i = i + 1
 }
 i = 0
 while i < indices.length { let item = run unsafe get.getPropertyInt64(&mut hooks, ctx, object, indices[i]) run unsafe result(&mut out, &mut hooks, ctx, item) run unsafe tryQuery(&mut out, &mut hooks, ctx, object, indices[i]) i = i + 1 }
 run unsafe tryQuery(&mut out, &mut hooks, ctx, object, 99)
 let named = run unsafe get.getPropertyStr(&mut hooks, ctx, object, b"2147483648") run unsafe result(&mut out, &mut hooks, ctx, named)
 let nul = run unsafe get.getPropertyStr(&mut hooks, ctx, object, b"0\0ignored") run unsafe result(&mut out, &mut hooks, ctx, nul)
 let throwing = run unsafe fixture.closure(&mut hooks, ctx, 51, 1, Value.Int { value: 501 }, 0, Value.Undefined)
 run unsafe stored.add(&mut hooks, rt, object, 0x80000008, 23, PropertySlot.GetterSetter { getter: reference(throwing), setter: Pointer.null<HeapHeader>() })
 run unsafe tryQuery(&mut out, &mut hooks, ctx, object, 8)
 let tdz = run unsafe storage.detached(rt, Value.Uninitialized)
 run unsafe stored.add(&mut hooks, rt, object, 0x80000009, 39, PropertySlot.VarRef { reference: tdz })
 run unsafe tryQuery(&mut out, &mut hooks, ctx, object, 9)
 let mut mode: u32 = 0
 while mode < 3 {
  let key = run unsafe fixture.closure(&mut hooks, ctx, 60 + mode * 2, 0, Value.Undefined, 0, Value.Undefined)
  let mut body: u32 = 0 if mode == 2 { body = 1 }
  let convert = run unsafe fixture.closure(&mut hooks, ctx, 61 + mode * 2, body, Value.Int { value: 0 }, 0, Value.Undefined)
  run unsafe stored.add(&mut hooks, rt, key, atoms.JS_ATOM_Symbol_toPrimitive, 7, PropertySlot.Value { value: convert })
  let mut receiver = object if mode == 0 { receiver = Value.Null }
  let item = run Effect.catch<JsException>(unsafe get.getPropertyValue(&mut hooks, ctx, receiver, key), thrown)
  run unsafe result(&mut out, &mut hooks, ctx, item)
  run out.writeU32(usize.toU32(hooks.calls)) run out.writeU32(usize.toU32(hooks.finalizedCount))
  i = 0 while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
  mode = mode + 1
 }
 let parent = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null)
 let key = run unsafe stored.atom(rt, b"receiver", 0)
 let identity = run unsafe fixture.closure(&mut hooks, ctx, 71, 2, Value.Undefined, 0, Value.Undefined)
 run unsafe stored.add(&mut hooks, rt, parent, key, 23, PropertySlot.GetterSetter { getter: reference(identity), setter: Pointer.null<HeapHeader>() })
 let item = run unsafe get.getPropertyReceiver(&mut hooks, ctx, parent, key, Value.Int { value: 73 }, false)
 run unsafe result(&mut out, &mut hooks, ctx, item)
 unsafe gc.release(&mut hooks, rt, parent) unsafe stored.releaseAtom(rt, key)
 unsafe gc.release(&mut hooks, rt, object)
 run out.writeU32(usize.toU32(hooks.finalizedCount))
 i = 0 while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
}
effect fn probe(out: &mut ByteBuffer) -> AllocationObserver ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let primitiveClasses = [classes.JS_CLASS_NUMBER, classes.JS_CLASS_STRING, classes.JS_CLASS_BOOLEAN, classes.JS_CLASS_BIG_INT, classes.JS_CLASS_SYMBOL]
 let mut p: usize = 0
 while p < primitiveClasses.length {
  let parent = run unsafe objects.withPrototype(&mut hooks, &observer, ctx, Value.Null) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe runtime.setClassPrototype(&mut hooks, ctx, primitiveClasses[p], parent)
  p = p + 1
 }
 CALLS
 // Native allocation effects and source pending OOM share a failure record;
 // pending source error materialization is covered by the owning errors oracle.
 let faultObject = run unsafe fixture.typed(&mut hooks, ctx, classes.JS_CLASS_BIG_INT64_ARRAY, b"\0\0\0\0\x01\0\0\0", 1) |> Effect.provideMut<Allocator>(&mut memory)
 let mut fault = FaultAllocator { parent: move memory, armed: true, remaining: 0, persistent: false, failures: 0 }
 let failed = run Effect.catch<OutOfMemoryError>(unsafe get.getProperty(&mut hooks, ctx, faultObject, 0x80000000), oom) |> Effect.provideMut<Allocator>(&mut fault)
 run out.writeU32(201)
 if failed.isException() { run out.writeU32(1) } else { trap() }
 run out.writeU32(usize.toU32(fault.failures)) run out.writeU32(bits(unsafe rc(reference(faultObject))))
 unsafe gc.release(&mut hooks, rt, faultObject)
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
 drop hooks return move observer
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut allocator = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make() let mut writer = StdoutWriter.make()
 let ledger = run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer) drop out
 if ledger.stats().usedBytes != 0 || ledger.stats().allocationCount != 0 { trap() }
 run Writer.writeAll(&[0,0,0,0,0,0,0,0]) |> Effect.provideMut<Writer>(&mut writer) return 0
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
    c_calls, s_calls = [], []
    for family in range(25):
        c_calls.append(f'word({family});run_case(ctx,{family});')
        s_calls.append(f'run out.writeU32({family}) run unsafe runCase(&mut out,&mut hooks,&observer,ctx,{family}) |> Effect.provideMut<Allocator>(&mut memory)')
    for index, (width, values) in enumerate(TYPED):
        raw = b''.join(v.to_bytes(width, 'little') for v in values)
        c_bytes = ','.join(str(v) for v in raw)
        s_bytes = ''.join(f'\\x{v:02x}' for v in raw)
        c_calls.append(f'word({100+index});typed_case(ctx,{21+index},(unsigned char[]){{{c_bytes}}},{len(raw)},{len(values)});')
        s_calls.append(f'run out.writeU32({100+index}) run unsafe typedCase(&mut out,&mut hooks,&observer,ctx,{21+index},b"{s_bytes}",{len(values)}) |> Effect.provideMut<Allocator>(&mut memory)')
    c_calls.append('word(200);wrappers(ctx);')
    s_calls.append('run out.writeU32(200) run unsafe wrappers(&mut out,&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)')
    c_source = C_SOURCE.replace('KEYS', ','.join(f'"{k}"' for k in KEYS)).replace('CALLS', '\n'.join(c_calls))
    s_source = SILK_SOURCE.replace('KEYCOUNT', str(len(KEYS))).replace('KEYS', ','.join(f'b"{k}"' for k in KEYS)).replace('CALLS', '\n'.join(s_calls))
    with tempfile.TemporaryDirectory(prefix='silkjs-property-get-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Property Get C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Property Get C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(s_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="property-get-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native property Get oracle', cwd=temp)
        if not expected or len(expected) % 4 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid source output or nonzero teardown ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Get word {offset//4}: C={a.hex()} Silk={b.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS property Get: 25 ordinary/exotic/primitive/error families, 12 typed classes; '
              f'{len(actual)//4} exact words; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; zero ledgers')


if __name__ == '__main__':
    main()
