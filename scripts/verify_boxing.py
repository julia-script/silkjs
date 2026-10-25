#!/usr/bin/env python3
"""Exact native boxing/String-exotic differential against the separate pinned C engine."""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bigint_coercions import leaves, KINDS, TEXTS
from verify_property_get import C_SOURCE as GET_C, SILK_SOURCE as GET_SILK

ROOT = Path(__file__).resolve().parents[1]
TOTAL_KINDS = KINDS + 6
# Independent descriptor attributes: absent, explicitly false, explicitly true.
FLAGS = [c | w | e for c in (0, 1 << 8, (1 << 8) | 1)
         for w in (0, 1 << 9, (1 << 9) | 2)
         for e in (0, 1 << 10, (1 << 10) | 4)] + [1 << 11, 1 << 12]
KEYS = ['0', '1', '2', '3', '4', '5', 'length', '-0', '00', '4294967295', 'extra']

C_PREFIX = GET_C.partition('static void word(')[0] + r'''
static uint32_t record[8192];static unsigned record_len;
static void raw(uint32_t v){for(int i=0;i<4;i++)putchar((v>>(8*i))&255);}
static void word(uint32_t v){if(record_len==8192)abort();record[record_len++]=v;}
static void wide(uint64_t v){word(v);word(v>>32);}
static void flush(void){raw(record_len);for(unsigned i=0;i<record_len;i++)raw(record[i]);record_len=0;}
''' + GET_C[GET_C.index('static JSValue checked('):GET_C.index('static unsigned calls')]
C_SOURCE = C_PREFIX + r'''
static int rc(JSValue v){return JS_VALUE_HAS_REF_COUNT(v)?__js_rc(JS_VALUE_GET_PTR(v))->ref_count:0;}
static void pending(JSContext*ctx){int has=JS_HasException(ctx);word(has);if(!has)return;
 JSValue e=JS_GetException(ctx);if(JS_IsObject(e)){JSObject*p=JS_VALUE_GET_OBJ(e);int kind=99;
 for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))kind=i;
 word(kind);JSValue m=checked(JS_GetProperty(ctx,e,JS_ATOM_message));value(m);JS_FreeValue(ctx,m);
 }else{word(99);value(e);}JS_FreeValue(ctx,e);}
static void descriptor(JSContext*ctx,JSValue object,JSAtom atom){JSPropertyDescriptor d;int found=JS_GetOwnProperty(ctx,&d,object,atom);word(found+1);
 if(found>0){word(d.flags);value(d.value);value(d.getter);value(d.setter);JS_FreeValue(ctx,d.value);JS_FreeValue(ctx,d.getter);JS_FreeValue(ctx,d.setter);}}
static JSValue leaf(JSContext*ctx,int kind){
 @C_LEAVES@
 if(kind==@KINDS@)return checked(JS_NewObjectProto(ctx,JS_NULL));
 if(kind==@KINDS@+1)return checked(JS_NewObjectClass(ctx,JS_CLASS_ERROR));
 if(kind==@KINDS@+2)return JS_EXCEPTION;
 if(kind==@KINDS@+3)return JS_UNINITIALIZED;
 if(kind==@KINDS@+4)return JS_MKVAL(JS_TAG_CATCH_OFFSET,17);
 if(kind==@KINDS@+5)return checked(js_new_string16_len(ctx,(uint16_t[]){97,233,0xd83d,0xde00,0xd800},5));
 abort();}
static int boxed(int cls){return cls==JS_CLASS_NUMBER||cls==JS_CLASS_BOOLEAN||cls==JS_CLASS_STRING||cls==JS_CLASS_SYMBOL||cls==JS_CLASS_BIG_INT||cls==JS_CLASS_DATE;}
static void box_case(JSContext*ctx,int kind,int consuming){word(0);word(kind);word(consuming);
 JSValue input=leaf(ctx,kind);int before=rc(input);if(JS_IsException(input))JS_Throw(ctx,JS_NewInt32(ctx,123));
 JSValue out=consuming?JS_ToObjectFree(ctx,JS_DupValue(ctx,input)):JS_ToObject(ctx,input);value(out);
 word(JS_IsObject(out)&&JS_IsObject(input)&&JS_VALUE_GET_PTR(out)==JS_VALUE_GET_PTR(input));
 if(JS_IsObject(out)){JSObject*p=JS_VALUE_GET_OBJ(out);word(p->class_id);if(boxed(p->class_id)){
 value(p->u.object_data);word(JS_SameValue(ctx,input,p->u.object_data));word(p->shape->proto==JS_VALUE_GET_OBJ(ctx->class_proto[p->class_id]));}
 descriptor(ctx,out,JS_ATOM_length);}
 word(JS_IsConstructor(ctx,out));word(JS_IsError(ctx,out));word(JS_SetConstructorBit(ctx,out,TRUE));word(JS_IsConstructor(ctx,out));
 word(JS_SetConstructorBit(ctx,out,FALSE));word(JS_IsConstructor(ctx,out));word(rc(input)-before);pending(ctx);
 JS_FreeValue(ctx,out);word(rc(input)-before);JS_FreeValue(ctx,input);flush();}
static const int destinations[]={JS_CLASS_NUMBER,JS_CLASS_STRING,JS_CLASS_BOOLEAN,JS_CLASS_SYMBOL,JS_CLASS_DATE,JS_CLASS_BIG_INT,JS_CLASS_OBJECT,0,-1};
static void data_case(JSContext*ctx,int destination,int kind){word(1);word(destination);word(kind);int cls=destinations[destination];
 JSValue object=cls==0?JS_EXCEPTION:cls<0?JS_NULL:checked(JS_NewObjectClass(ctx,cls));
 if(cls>0&&boxed(cls)){if(JS_SetObjectData(ctx,object,checked(JS_NewString(ctx,"old-owned"))))abort();}
 if(cls==0)JS_Throw(ctx,JS_NewInt32(ctx,123));JSValue input=leaf(ctx,kind);int before=rc(input);
 int result=JS_SetObjectData(ctx,object,JS_DupValue(ctx,input));word(result+1);word(rc(input)-before);
 if(result==0){value(JS_VALUE_GET_OBJ(object)->u.object_data);word(JS_SameValue(ctx,input,JS_VALUE_GET_OBJ(object)->u.object_data));}
 pending(ctx);JS_FreeValue(ctx,object);word(rc(input)-before);JS_FreeValue(ctx,input);flush();}
static const char*keys[]={@KEYS@};static const unsigned flags[]={@FLAGS@};
static void string_case(JSContext*ctx,int key,int attr,int variant,int throwing){word(2);word(key);word(attr);word(variant);word(throwing);
 JSValue text=leaf(ctx,@KINDS@+5),object=checked(JS_ToObject(ctx,text));JSAtom atom=JS_NewAtom(ctx,keys[key]);
 descriptor(ctx,object,atom);int exists=JS_GetOwnProperty(ctx,NULL,object,atom);word(exists+1);
 JSValue replacement=variant==0?JS_UNDEFINED:variant==1?checked(js_new_string_char(ctx,key<5?string_get(JS_VALUE_GET_STRING(text),key):120)):
 variant==2?checked(JS_NewString(ctx,"wrong")):variant==3?JS_NewInt32(ctx,97):checked(JS_NewObjectProto(ctx,JS_NULL));
 unsigned f=flags[attr]|(variant?JS_PROP_HAS_VALUE:0)|(throwing?JS_PROP_THROW:0);
 int result=JS_DefineProperty(ctx,object,atom,replacement,JS_UNDEFINED,JS_UNDEFINED,f);word(result+1);pending(ctx);
 descriptor(ctx,object,atom);word(JS_DeleteProperty(ctx,object,atom,0)+1);descriptor(ctx,object,atom);
 JS_FreeValue(ctx,replacement);JS_FreeAtom(ctx,atom);JS_FreeValue(ctx,object);JS_FreeValue(ctx,text);flush();}
static JSValue watched;static int count_at_throw;
static void watch_final(JSRuntime*rt,JSValue v){count_at_throw=rc(watched);}
static const JSClassDef watch_class={.class_name="BoxingWatch",.finalizer=watch_final};
static void failure_case(JSContext*ctx,int mode){word(3);word(mode);
 JSValue input=mode==0?leaf(ctx,@KINDS@+5):leaf(ctx,@KINDS@-2);JSValue object=mode==0?checked(JS_ToObject(ctx,input)):JS_UNDEFINED;
 watched=input;count_at_throw=0;JS_Throw(ctx,checked(JS_NewObjectClass(ctx,70)));failures=0;fail_next=1;
 if(mode==0){descriptor(ctx,object,__JS_AtomFromUInt32(0));}else{JSValue out=JS_ToObjectFree(ctx,JS_DupValue(ctx,input));value(out);JS_FreeValue(ctx,out);}
 fail_next=0;word(failures);word(count_at_throw);word(rc(input));pending(ctx);
 JS_FreeValue(ctx,object);JS_FreeValue(ctx,input);watched=JS_UNDEFINED;flush();}
int main(void){JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,70,&watch_class))abort();const int classes[]={JS_CLASS_NUMBER,JS_CLASS_STRING,JS_CLASS_BOOLEAN,JS_CLASS_SYMBOL,JS_CLASS_BIG_INT};
 for(unsigned i=0;i<sizeof(classes)/sizeof(*classes);i++)JS_SetClassProto(ctx,classes[i],checked(JS_NewObjectProto(ctx,JS_NULL)));
 for(int kind=0;kind<@TOTAL_KINDS@;kind++)for(int consume=0;consume<2;consume++)box_case(ctx,kind,consume);
 for(int dest=0;dest<9;dest++)for(int kind=0;kind<@TOTAL_KINDS@;kind++)if(dest!=1||kind<@TEXT_COUNT@||kind==@KINDS@+5)data_case(ctx,dest,kind);
 for(int key=0;key<@KEY_COUNT@;key++)for(int attr=0;attr<@FLAG_COUNT@;attr++)for(int variant=0;variant<5;variant++)for(int throwing=0;throwing<2;throwing++)string_case(ctx,key,attr,variant,throwing);
 failure_case(ctx,0);failure_case(ctx,1);JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);flush();if(live_count||live_bytes)abort();return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.f64
import silk.i32
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
import js_core_types { RuntimeState, ContextState, ObjectData, ObjectPayload, PropertyDescriptor, JS_PROP_HAS_VALUE, JS_PROP_THROW }
import js_value { Value }
import js_bigint { BigInt, BigIntError }
import js_bigint_coercions_test_support as support
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_gc as gc
import js_runtime as runtime
import js_class_data as classes
import js_atom_data as atoms
import js_object_allocate as objects
import js_boxing as boxing
import js_boxing_test_support as fixture
import js_boxing_test_support { Hooks, count, classId, data, prototype }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, trap }
import js_property_names_test_support as stored
import js_property_descriptors as descriptors
import js_property_ownership { releaseDescriptor }
import js_property_mutations as mutations
import js_property_delete as deletion
import js_primitives as primitive
import js_primitives { EqualityMode }
import js_coercion_host { CoercionHooks }
import js_errors_test_support as errors
import js_errors_test_support { FaultAllocator }
import js_exceptions { JsException }
import js_exceptions as exceptions
@SERIALIZER@
effect fn thrown(error: JsException) -> Value { drop error return Value.Exception }
effect fn ignored(error: JsException) -> () { drop error }
effect fn flag(out: &mut ByteBuffer, yes: bool) -> () ! OutOfMemoryError ? &mut Allocator {
 let mut word: u32 = 0 if yes { word = 1 } run out.writeU32(word)
}
effect fn flush(out: &mut ByteBuffer) -> () ! OutOfMemoryError | WriterError ? &mut Allocator {
 let mut header = ByteBuffer.make() run header.writeU32(usize.toU32(out.length() / 4))
 let mut writer = StdoutWriter.make() run Writer.writeAll(header.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 out.clear()
}
unsafe effect fn pending<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader) -> ()
 ! OutOfMemoryError | JsException ? &mut Allocator {
 let rt = unsafe runtime.contextRuntime(ctx) let has = unsafe exceptions.has(rt) run flag(&mut out, has)
 if !has { return () } let error = unsafe exceptions.take(rt)
 if error.isObject() {
  run out.writeU32(unsafe errors.prototypeIndex(ctx, error))
  let message = run unsafe hooks.getProperty(ctx, error, atoms.JS_ATOM_message)
  run value(&mut out, message) unsafe gc.release(&mut hooks, rt, message)
 } else { run out.writeU32(99) run value(&mut out, error) }
 unsafe gc.release(&mut hooks, rt, error)
}
unsafe effect fn descriptor<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader, object: Value, atom: u32) -> ()
 ! OutOfMemoryError | JsException ? &mut Allocator {
 let found = run unsafe descriptors.getOwnProperty(&mut hooks, ctx, object, atom)
 match move found {
  Option<PropertyDescriptor>.None => { run out.writeU32(1) }
  Option<PropertyDescriptor>.Some { value: desc } => {
   run out.writeU32(2) run out.writeU32(desc.flags) run value(&mut out, desc.value) run value(&mut out, desc.getter) run value(&mut out, desc.setter)
   unsafe releaseDescriptor(&mut hooks, unsafe runtime.contextRuntime(ctx), move desc)
  }
 }
}
unsafe effect fn leaf<'a>(hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, kind: usize) -> Value
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let rt = unsafe runtime.contextRuntime(ctx)
 @SILK_LEAVES@
 if kind == @KINDS@ { return run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null) }
 if kind == @KINDS@ + 1 { return run unsafe objects.withClass(&mut hooks, memory, ctx, classes.JS_CLASS_ERROR) }
 if kind == @KINDS@ + 2 { return Value.Exception }
 if kind == @KINDS@ + 3 { return Value.Uninitialized }
 if kind == @KINDS@ + 4 { return Value.CatchOffset { offset: 17 } }
 if kind == @KINDS@ + 5 { return run Strings.fromUtf16(&[97,233,0xd83d,0xde00,0xd800]) }
 return trap()
}
fn boxed(cls: u32) -> bool { return cls == classes.JS_CLASS_NUMBER || cls == classes.JS_CLASS_STRING || cls == classes.JS_CLASS_BOOLEAN
 || cls == classes.JS_CLASS_SYMBOL || cls == classes.JS_CLASS_BIG_INT || cls == classes.JS_CLASS_DATE }
unsafe effect fn boxCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, kind: usize, consuming: bool) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let rt = unsafe runtime.contextRuntime(ctx) run out.writeU32(0) run out.writeU32(usize.toU32(kind)) run flag(&mut out, consuming)
 let input = run unsafe leaf(&mut hooks, memory, ctx, kind) let before = unsafe count(input)
 if input.isException() { run Effect.catch<JsException>(unsafe exceptions.throwValue<(), Hooks<'a>>(&mut hooks, rt, Value.Int { value: 123 }), ignored) }
 let mut result = Value.Undefined
 if consuming { result = run Effect.catch<JsException>(unsafe boxing.toObjectFree(&mut hooks, memory, ctx, unsafe input.retained()), thrown) }
 else { result = run Effect.catch<JsException>(unsafe boxing.toObject(&mut hooks, memory, ctx, input), thrown) }
 run value(&mut out, result)
 run flag(&mut out, input.isObject() && result.isObject() && Pointer.address(reference(input)) == Pointer.address(reference(result)))
 if result.isObject() {
  let cls = unsafe classId(result) run out.writeU32(cls)
  if boxed(cls) {
   let payload = unsafe data(result) run value(&mut out, payload) run flag(&mut out, unsafe primitive.equal(input, payload, EqualityMode.SameValue))
   let anchor = () let state = unsafe HeapCell.payload<ContextState, ()>(&anchor, ctx)
   let proto = state.classPrototypes.get(u32.toUsize(cls))
   run flag(&mut out, Pointer.address(unsafe prototype(result)) == Pointer.address(reference(proto)))
  }
  run unsafe descriptor(&mut out, &mut hooks, ctx, result, atoms.JS_ATOM_length)
 }
 run flag(&mut out, unsafe boxing.isConstructor(result)) run flag(&mut out, unsafe boxing.isError(result))
 run flag(&mut out, unsafe boxing.setConstructorBit(result, true)) run flag(&mut out, unsafe boxing.isConstructor(result))
 run flag(&mut out, unsafe boxing.setConstructorBit(result, false)) run flag(&mut out, unsafe boxing.isConstructor(result))
 run out.writeU32(bits(unsafe count(input) - before)) run unsafe pending(&mut out, &mut hooks, ctx)
 unsafe gc.release(&mut hooks, rt, result) run out.writeU32(bits(unsafe count(input) - before)) unsafe gc.release(&mut hooks, rt, input)
}
unsafe effect fn dataCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, destination: usize, kind: usize) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 run out.writeU32(1) run out.writeU32(usize.toU32(destination)) run out.writeU32(usize.toU32(kind))
 let cls = [classes.JS_CLASS_NUMBER,classes.JS_CLASS_STRING,classes.JS_CLASS_BOOLEAN,classes.JS_CLASS_SYMBOL,classes.JS_CLASS_DATE,classes.JS_CLASS_BIG_INT,classes.JS_CLASS_OBJECT,0,0][destination]
 let rt = unsafe runtime.contextRuntime(ctx) let mut object = Value.Null
 if destination == 7 { object = Value.Exception } else if destination != 8 { object = run unsafe objects.withClass(&mut hooks, memory, ctx, cls) }
 if cls != 0 && boxed(cls) { run unsafe boxing.setObjectData(&mut hooks, ctx, object, run Strings.fromLatin1(b"old-owned")) }
 if destination == 7 { run Effect.catch<JsException>(unsafe exceptions.throwValue<(), Hooks<'a>>(&mut hooks, rt, Value.Int { value: 123 }), ignored) }
 let input = run unsafe leaf(&mut hooks, memory, ctx, kind) let before = unsafe count(input)
 let attempt = run Effect.result(unsafe boxing.setObjectData(&mut hooks, ctx, object, unsafe input.retained()))
 let success = match move attempt { Result<(), JsException>.Success { .. } => true Result<(), JsException>.Failure { .. } => false }
 run flag(&mut out, success) run out.writeU32(bits(unsafe count(input) - before))
 if success { let payload = unsafe data(object) run value(&mut out, payload) run flag(&mut out, unsafe primitive.equal(input, payload, EqualityMode.SameValue)) }
 run unsafe pending(&mut out, &mut hooks, ctx) unsafe gc.release(&mut hooks, rt, object)
 run out.writeU32(bits(unsafe count(input) - before)) unsafe gc.release(&mut hooks, rt, input)
}
unsafe effect fn stringCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver, ctx: *mut HeapHeader, key: usize, attr: usize, variant: usize, throwing: bool) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 run out.writeU32(2) run out.writeU32(usize.toU32(key)) run out.writeU32(usize.toU32(attr)) run out.writeU32(usize.toU32(variant)) run flag(&mut out, throwing)
 let rt = unsafe runtime.contextRuntime(ctx) let text = run unsafe leaf(&mut hooks, memory, ctx, @KINDS@ + 5)
 let object = run unsafe boxing.toObject(&mut hooks, memory, ctx, text)
 let keys: [&[u8]; @KEY_COUNT@] = [@SILK_KEYS@] let atom = run unsafe stored.atom(rt, keys[key], 0)
 run unsafe descriptor(&mut out, &mut hooks, ctx, object, atom)
 let exists = run unsafe descriptors.hasOwnProperty(&mut hooks, ctx, object, atom) let mut found: u32 = 1 if exists { found = 2 } run out.writeU32(found)
 let mut replacement = Value.Undefined
 if variant == 1 { let mut unit: u16 = 120 if key < 5 { unit = Strings.codeUnit(text, key) } replacement = run Strings.fromCodePoint(u16.toU32(unit)) }
 else if variant == 2 { replacement = run Strings.fromLatin1(b"wrong") }
 else if variant == 3 { replacement = Value.Int { value: 97 } }
 else if variant == 4 { replacement = run unsafe objects.withPrototype(&mut hooks, memory, ctx, Value.Null) }
 let attributes: [u32; @FLAG_COUNT@] = [@FLAGS@] let mut flags = attributes[attr]
 if variant != 0 { flags = flags | JS_PROP_HAS_VALUE } if throwing { flags = flags | JS_PROP_THROW }
 let attempt = run Effect.result(unsafe mutations.defineProperty(&mut hooks, ctx, object, atom, replacement, Value.Undefined, Value.Undefined, flags))
 let mut result: u32 = 0
 match move attempt {
  Result<bool, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Success { value: accepted } => { result = 1 if accepted { result = 2 } }
  Result<bool, OutOfMemoryError | StringLengthError | BigIntError | JsException>.Failure { error } => match move error { JsException signal => () _ => trap() }
 }
 run out.writeU32(result) run unsafe pending(&mut out, &mut hooks, ctx) run unsafe descriptor(&mut out, &mut hooks, ctx, object, atom)
 let removed = run unsafe deletion.deleteProperty(&mut hooks, memory, ctx, object, atom, 0) let mut deleted: u32 = 1 if removed { deleted = 2 }
 run out.writeU32(deleted) run unsafe descriptor(&mut out, &mut hooks, ctx, object, atom)
 unsafe gc.release(&mut hooks, rt, replacement) unsafe stored.releaseAtom(rt, atom) unsafe gc.release(&mut hooks, rt, object) unsafe gc.release(&mut hooks, rt, text)
}
effect fn failureCase(out: &mut ByteBuffer, mode: usize) -> ()
 ! OutOfMemoryError | StringLengthError | BigIntError | JsException ? &mut Allocator {
 let allocator = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run allocator.observe()
 let mut memory = FaultAllocator { parent: move allocator, armed: false, remaining: 0, persistent: false, failures: 0 }
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut kind: usize = @KINDS@ + 5 if mode != 0 { kind = @KINDS@ - 2 }
 let input = run unsafe leaf(&mut hooks, &observer, ctx, kind) |> Effect.provideMut<Allocator>(&mut memory)
 let mut object = Value.Undefined
 if mode == 0 { object = run unsafe boxing.toObject(&mut hooks, &observer, ctx, input) |> Effect.provideMut<Allocator>(&mut memory) }
 run out.writeU32(3) run out.writeU32(usize.toU32(mode)) hooks.watched = input memory.armed = true
 if mode == 0 {
  // Invoke the native String callback with the observing host; outward GetOwn
  // dispatch has identical descriptor semantics and is exercised above.
  let got = run unsafe jsString.getOwnProperty(&mut hooks, ctx, object, 0x80000000, true) |> Effect.provideMut<Allocator>(&mut memory)
  memory.armed = false
  match move got {
   OwnPropertyResult.Descriptor { descriptor: desc } => { run out.writeU32(2) run out.writeU32(desc.flags) run value(&mut out, desc.value)
    run value(&mut out, desc.getter) run value(&mut out, desc.setter) unsafe releaseDescriptor(&mut hooks, rt, move desc) }
   _ => trap()
  }
 } else {
  let result = run Effect.catch<JsException>(unsafe boxing.toObjectFree(&mut hooks, &observer, ctx, unsafe input.retained()), thrown) |> Effect.provideMut<Allocator>(&mut memory)
  memory.armed = false run value(&mut out, result) unsafe gc.release(&mut hooks, rt, result)
 }
 run out.writeU32(usize.toU32(memory.failures)) run out.writeU32(bits(hooks.countAtThrow)) run out.writeU32(bits(unsafe count(input)))
 run unsafe pending(&mut out, &mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 unsafe gc.release(&mut hooks, rt, object) unsafe gc.release(&mut hooks, rt, input)
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
}
import js_string_exotic as jsString
import js_property_host { OwnPropertyResult }
effect fn probe() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError ? &mut Allocator {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let classesToSet = [classes.JS_CLASS_NUMBER,classes.JS_CLASS_STRING,classes.JS_CLASS_BOOLEAN,classes.JS_CLASS_SYMBOL,classes.JS_CLASS_BIG_INT]
 let mut index: usize = 0 while index < classesToSet.length {
  let proto = run unsafe objects.withPrototype(&mut hooks, &observer, ctx, Value.Null) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe runtime.setClassPrototype(&mut hooks, ctx, classesToSet[index], proto) index = index + 1
 }
 let mut out = ByteBuffer.make() let mut kind: usize = 0
 while kind < @TOTAL_KINDS@ { let mut consume: usize = 0 while consume < 2 {
  run unsafe boxCase(&mut out, &mut hooks, &observer, ctx, kind, consume != 0) |> Effect.provideMut<Allocator>(&mut memory)
  run flush(&mut out) consume = consume + 1
 } kind = kind + 1 }
 let mut dest: usize = 0 while dest < 9 { kind = 0 while kind < @TOTAL_KINDS@ {
  if dest != 1 || kind < @TEXT_COUNT@ || kind == @KINDS@ + 5 {
   run unsafe dataCase(&mut out, &mut hooks, &observer, ctx, dest, kind) |> Effect.provideMut<Allocator>(&mut memory) run flush(&mut out)
  } kind = kind + 1
 } dest = dest + 1 }
 let mut key: usize = 0 while key < @KEY_COUNT@ { let mut attr: usize = 0 while attr < @FLAG_COUNT@ { let mut variant: usize = 0 while variant < 5 { let mut throwing: usize = 0 while throwing < 2 {
  run unsafe stringCase(&mut out, &mut hooks, &observer, ctx, key, attr, variant, throwing != 0) |> Effect.provideMut<Allocator>(&mut memory)
  run flush(&mut out) throwing = throwing + 1
 } variant = variant + 1 } attr = attr + 1 } key = key + 1 }
 run failureCase(&mut out, 0) run flush(&mut out) run failureCase(&mut out, 1) run flush(&mut out)
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 drop out let mut footer = ByteBuffer.make()
 run footer.writeU32(usize.toU32(observer.stats().allocationCount)) run footer.writeU32(usize.toU32(observer.stats().usedBytes)) run flush(&mut footer)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() } return 0
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut allocator = Allocator.systemAllocatorProvider()
 return run probe() |> Effect.provideMut<Allocator>(&mut allocator)
}
'''


def records(data):
    result, offset = [], 0
    while offset < len(data):
        if offset + 4 > len(data):
            raise SystemExit('Truncated boxing record header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated boxing record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if not result or result[-1] != (0, 0):
        raise SystemExit('Nonzero boxing teardown ledger')
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
    c_leaves, silk_leaves = leaves()
    serializer = GET_SILK[GET_SILK.index('fn bits('):GET_SILK.index('effect fn thrown(')]
    replacements = {'@C_LEAVES@': c_leaves, '@SILK_LEAVES@': silk_leaves, '@KINDS@': str(KINDS),
                    '@TOTAL_KINDS@': str(TOTAL_KINDS), '@TEXT_COUNT@': str(len(TEXTS)), '@SERIALIZER@': serializer,
                    '@KEYS@': ','.join(f'"{key}"' for key in KEYS), '@SILK_KEYS@': ','.join(f'b"{key}"' for key in KEYS),
                    '@KEY_COUNT@': str(len(KEYS)), '@FLAGS@': ','.join(str(flag) for flag in FLAGS), '@FLAG_COUNT@': str(len(FLAGS))}
    c_source, silk_source = C_SOURCE, SILK_SOURCE
    for key, replacement in replacements.items():
        c_source, silk_source = c_source.replace(key, replacement), silk_source.replace(key, replacement)
    with tempfile.TemporaryDirectory(prefix='silkjs-boxing-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Boxing C compilation')
        expected = records(process([str(temp / 'oracle')], 600, owner='Boxing C oracle'))
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="boxing-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual_bytes = process(command, 1200, owner='Native boxing oracle', cwd=temp)
        actual = records(actual_bytes)
        if len(actual) != len(expected):
            raise SystemExit(f'Wrong boxing record count C={len(expected)}, Silk={len(actual)}')
        for index, (left, right) in enumerate(zip(expected, actual)):
            if left != right:
                raise SystemExit(f'Boxing record {index}, label={left[:5]}:\nC={left}\nSilk={right}')
        print(f'PASS boxing/String exotic: {len(actual)-1} exact records, {TOTAL_KINDS} value kinds, '
              f'{len(KEYS)} keys, {len(FLAGS)} descriptor attribute combinations, both throw modes, two one-shot OOM paths; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual_bytes).hexdigest()}; zero ledgers')


if __name__ == '__main__':
    main()
