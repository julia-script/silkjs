#!/usr/bin/env python3
"""Compare native own descriptors with unchanged pinned QuickJS source.

Separate C/native executables exercise data/accessor/varref-TDZ/autoinit, all
fast array families, real Uint8 cache bytes, registered exotic decisions and
exceptions. Every record includes owned-edge counts; both allocators must reach
zero after teardown. No engine C is linked into the native consumer.
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
CASES = [(family, flags) for family in range(14) for flags in range(8)]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;static int fail_next,failures;
static void *allocate(JSMallocState *s,size_t n) {
 if(!n)return NULL;if(fail_next){fail_next=0;failures++;return NULL;}Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}
 if(fail_next){fail_next=0;failures++;return NULL;}
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p) {return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n) {for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v) {if(JS_IsException(v))abort();return v;}
static void value(JSValue v) {
 if(JS_IsUndefined(v))word(0);
 else if(JS_VALUE_GET_TAG(v)==JS_TAG_INT){word(1);word(JS_VALUE_GET_INT(v));}
 else if(JS_IsString(v)){word(2);JSString *s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));}
 else if(JS_IsObject(v))word(3);else abort();
}
typedef struct {JSAtom atom;int flags;JSValue value,getter,setter;} Stored;
static int calls,exists_calls,fail_exotic;
static void finalizer(JSRuntime *rt,JSValue object) {
 Stored *p=JS_GetOpaque(object,67);if(!p)abort();JS_FreeAtomRT(rt,p->atom);
 JS_FreeValueRT(rt,p->value);JS_FreeValueRT(rt,p->getter);JS_FreeValueRT(rt,p->setter);js_free_rt(rt,p);
}
static void marker(JSRuntime *rt,JSValueConst object,JS_MarkFunc *mark) {
 Stored *p=JS_GetOpaque(object,67);JS_MarkValue(rt,p->value,mark);JS_MarkValue(rt,p->getter,mark);JS_MarkValue(rt,p->setter,mark);
}
static int own(JSContext *ctx,JSPropertyDescriptor *d,JSValueConst object,JSAtom atom) {
 calls++;exists_calls+=d==NULL;JS_RunGC(ctx->rt);
 if(fail_exotic){JS_ThrowTypeError(ctx,"exotic failed");return -1;}
 Stored *p=JS_GetOpaque(object,67);if(p->atom!=atom)return 0;
 if(d){d->flags=p->flags;d->value=JS_DupValue(ctx,p->value);d->getter=JS_DupValue(ctx,p->getter);d->setter=JS_DupValue(ctx,p->setter);}return 1;
}
static JSClassExoticMethods exotic={.get_own_property=own};
static const JSClassDef definition={.class_name="StoredKeys",.finalizer=finalizer,.gc_mark=marker,.exotic=&exotic};
static const JSCFunctionListEntry lazy=JS_PROP_STRING_DEF("key","lazy",JS_PROP_CONFIGURABLE|JS_PROP_WRITABLE);
static void error(JSContext *ctx) {
 JSValue e=JS_GetException(ctx);if(!JS_IsObject(e))abort();
 JSObject *p=JS_VALUE_GET_OBJ(e);int kind=99;
 for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))kind=i;
 word(kind);JSValue message=checked(JS_GetProperty(ctx,e,JS_ATOM_message));value(message);
 JS_FreeValue(ctx,message);JS_FreeValue(ctx,e);
}
static void query(JSContext *ctx,JSValue object,JSAtom atom,int requested,JSValue text,JSValue leaf) {
 JSPropertyDescriptor d;int result=JS_GetOwnProperty(ctx,requested?&d:NULL,object,atom);
 word(result+1);
 if(result<0)error(ctx);
 if(result>0&&requested){word(d.flags);value(d.value);value(d.getter);value(d.setter);
   word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);js_free_desc(ctx,&d);}
 word(calls);word(exists_calls);
 word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);
}
static void run_case(JSContext *ctx,int family,int flags) {
 calls=0;exists_calls=0;fail_exotic=family==12;
 JSValue text=checked(JS_NewString(ctx,"owned")),leaf=checked(JS_NewObjectProto(ctx,JS_NULL));
 JSAtom key=JS_NewAtom(ctx,"key");JSValue object;
 if(family==10)object=JS_NewInt32(ctx,73);
 else if(family==9||family==12){object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored *s=js_mallocz(ctx,sizeof(*s));if(!s)abort();
   *s=(Stored){JS_DupAtom(ctx,key),flags,JS_DupValue(ctx,text),JS_DupValue(ctx,leaf),JS_DupValue(ctx,leaf)};JS_SetOpaque(object,s);}
 else if(family>=5&&family<=7){int cls=family==5?JS_CLASS_ARRAY:family==6?JS_CLASS_ARGUMENTS:JS_CLASS_MAPPED_ARGUMENTS;
   object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,cls));JSObject *p=JS_VALUE_GET_OBJ(object);
   if(family==7){p->u.array.u.var_refs=js_malloc(ctx,2*sizeof(JSVarRef*));if(!p->u.array.u.var_refs)abort();
     for(int i=0;i<2;i++){JSVarRef *v=js_create_var_ref(ctx,FALSE);if(!v)abort();v->value=JS_DupValue(ctx,text);p->u.array.u.var_refs[i]=v;}p->u.array.count=2;}
   else if(family==6){if(expand_fast_array(ctx,p,2))abort();for(int i=0;i<2;i++)p->u.array.u.values[i]=JS_DupValue(ctx,text);p->u.array.count=2;}
   else for(int i=0;i<2;i++)if(add_fast_array_element(ctx,p,JS_DupValue(ctx,text),0)<0)abort();}
 else if(family==8||family==13){JSValue len=JS_NewInt32(ctx,3);object=checked(JS_NewTypedArray(ctx,1,&len,JS_TYPED_ARRAY_UINT8));
   JSObject *p=JS_VALUE_GET_OBJ(object);p->u.array.u.uint8_ptr[0]=19;p->u.array.u.uint8_ptr[1]=203;p->u.array.u.uint8_ptr[2]=7;
   if(family==13){JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,object,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);}}
 else {object=checked(JS_NewObjectProto(ctx,JS_NULL));if(family==11)JS_VALUE_GET_OBJ(object)->is_exotic=1;}
 if(family<=3){int stored_flags=flags|(family==0?JS_PROP_LENGTH:family==1?JS_PROP_GETSET:JS_PROP_VARREF);
   JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,stored_flags);if(!p)abort();
   if(family==0)p->u.value=JS_DupValue(ctx,text);
   else if(family==1){p->u.getset.getter=JS_VALUE_GET_OBJ(JS_DupValue(ctx,leaf));p->u.getset.setter=JS_VALUE_GET_OBJ(JS_DupValue(ctx,leaf));}
   else {p->u.var_ref=js_create_var_ref(ctx,family==3);if(!p->u.var_ref)abort();if(family==2)p->u.var_ref->value=JS_DupValue(ctx,text);}}
 if(family==4&&JS_DefineAutoInitProperty(ctx,object,key,JS_AUTOINIT_ID_PROP,(void*)&lazy,flags)<0)abort();
 JSAtom queries[8]={key,JS_NewAtom(ctx,"absent"),__JS_AtomFromUInt32(0),__JS_AtomFromUInt32(1),__JS_AtomFromUInt32(2),__JS_AtomFromUInt32(3),JS_NewAtom(ctx,"01"),JS_NewAtom(ctx,"2147483648")};
 for(int i=0;i<8;i++){query(ctx,object,queries[i],0,text,leaf);query(ctx,object,queries[i],1,text,leaf);query(ctx,object,queries[i],1,text,leaf);}
 for(int i=1;i<8;i++)JS_FreeAtom(ctx,queries[i]);
 JS_FreeValue(ctx,object);JS_FreeAtom(ctx,key);
 word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);
 JS_FreeValue(ctx,text);JS_FreeValue(ctx,leaf);
}
static void typed_failure(JSContext *ctx) {
 JSValue length=JS_NewInt32(ctx,1);
 JSValue object=checked(JS_NewTypedArray(ctx,1,&length,JS_TYPED_ARRAY_BIG_INT64));
 JS_VALUE_GET_OBJ(object)->u.array.u.int64_ptr[0]=INT64_C(4294967296);
 fail_next=1;JSPropertyDescriptor d;
 int exists=JS_GetOwnProperty(ctx,NULL,object,__JS_AtomFromUInt32(0));
 word(exists);word(failures);
 int found=JS_GetOwnProperty(ctx,&d,object,__JS_AtomFromUInt32(0));
 word(found);if(found!=1)abort();word(d.flags);word(JS_IsException(d.value));
 word(JS_IsUndefined(d.getter));word(JS_IsUndefined(d.setter));word(JS_HasException(ctx));word(failures);
 error(ctx);js_free_desc(ctx,&d);JS_FreeValue(ctx,object);
}
int main(void) {
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,67,&definition))abort();
 CALLS
 typed_failure(ctx);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.i32
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.core.result { Result }
import silk.num.u16
import silk.num.u32
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_core_types { ObjectData, ObjectPayload, PropertySlot, PropertyDescriptor }
import js_gc as gc
import js_runtime as runtime
import js_object_allocate as objects
import js_class_data as classes
import js_atom_data as atoms
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringLengthError, stringReference }
import js_var_refs as varRefs
import js_property_descriptors as descriptors
import js_property_descriptors_test_support as fixture
import js_property_descriptors_test_support { Hooks, descriptor }
import js_property_names_test_support as stored
import js_property_names_test_support { Entry }
import js_property_ownership { releaseDescriptor }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, rc, trap }
import js_errors_test_support as errorFixture
import js_errors_test_support { FaultAllocator as OneShotAllocator }
import js_exceptions { JsException }
import js_exceptions as exceptions

effect fn value(out: &mut ByteBuffer, item: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  match item {
    ValueBits.Undefined => { run out.writeU32(0) }
    ValueBits.Int { value: number } => { run out.writeU32(1) run out.writeU32(i32.toU32(number)) }
    ValueBits.String { .. } => {
      run out.writeU32(2) run out.writeU32(usize.toU32(Strings.length(item)))
      let mut i: usize = 0
      while i < Strings.length(item) { run out.writeU32(u16.toU32(Strings.codeUnit(item, i))) i = i + 1 }
    }
    ValueBits.Object { .. } => { run out.writeU32(3) }
    _ => trap()
  }
}
unsafe effect fn error<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader) -> ()
  ! OutOfMemoryError | JsException ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx) let pending = unsafe exceptions.take(rt)
  run out.writeU32(unsafe fixture.errorKind(ctx, pending))
  let message = descriptor(run unsafe descriptors.getOwnProperty(&mut hooks, ctx, pending, atoms.JS_ATOM_message))
  run value(&mut out, message.value) unsafe releaseDescriptor(&mut hooks, rt, move message)
  unsafe gc.release(&mut hooks, rt, pending)
}
unsafe effect fn query<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, ctx: *mut HeapHeader,
  object: ValueBits, atom: u32, requested: bool, text: ValueBits, leaf: ValueBits) -> ()
  ! OutOfMemoryError | JsException ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx)
  if requested {
    let result = run Effect.result(unsafe descriptors.getOwnProperty(&mut hooks, ctx, object, atom))
    match move result {
      Result<Option<PropertyDescriptor>, OutOfMemoryError | JsException>.Success { value: found } => {
        match move found {
          Option<PropertyDescriptor>.None => { run out.writeU32(1) }
          Option<PropertyDescriptor>.Some { value: d } => {
            run out.writeU32(2) run out.writeU32(d.flags)
            run value(&mut out, d.value) run value(&mut out, d.getter) run value(&mut out, d.setter)
            run out.writeU32(i32.toU32(unsafe rc(stringReference(text)))) run out.writeU32(i32.toU32(unsafe rc(reference(leaf))))
            unsafe releaseDescriptor(&mut hooks, rt, move d)
          }
        }
      }
      Result<Option<PropertyDescriptor>, OutOfMemoryError | JsException>.Failure { error: failure } => {
        match move failure { OutOfMemoryError allocation => { fail move allocation } JsException signal => { run out.writeU32(0) run unsafe error(&mut out, &mut hooks, ctx) } }
      }
    }
  } else {
    let result = run Effect.result(unsafe descriptors.hasOwnProperty(&mut hooks, ctx, object, atom))
    match move result {
      Result<bool, OutOfMemoryError | JsException>.Success { value: found } => { if found { run out.writeU32(2) } else { run out.writeU32(1) } }
      Result<bool, OutOfMemoryError | JsException>.Failure { error: failure } => {
        match move failure { OutOfMemoryError allocation => { fail move allocation } JsException signal => { run out.writeU32(0) run unsafe error(&mut out, &mut hooks, ctx) } }
      }
    }
  }
  run out.writeU32(usize.toU32(hooks.exoticCalls)) run out.writeU32(usize.toU32(hooks.existenceCalls))
  run out.writeU32(i32.toU32(unsafe rc(stringReference(text)))) run out.writeU32(i32.toU32(unsafe rc(reference(leaf))))
}
unsafe effect fn runCase<'a>(out: &mut ByteBuffer, hooks: &mut Hooks<'a>, memory: &AllocationObserver,
  ctx: *mut HeapHeader, family: u32, flags: u32) -> ()
  ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  hooks.exoticCalls = 0 hooks.existenceCalls = 0 hooks.failExotic = family == 12
  let rt = unsafe runtime.contextRuntime(ctx)
  let text = run Strings.fromLatin1(b"owned") let leaf = run unsafe objects.withPrototype(&mut hooks, memory, ctx, ValueBits.Null)
  let key = run unsafe stored.atom(rt, b"key", 0)
  let mut object = ValueBits.Undefined
  if family == 10 { object = ValueBits.Int { value: 73 } }
  else if family == 9 || family == 12 {
    object = run unsafe stored.exotic(&mut hooks.stored, memory, ctx)
    run unsafe stored.store(rt, object, Entry { atom: key, flags: flags, present: true, seedEnumerable: true,
      value: text, getter: leaf, setter: leaf })
  } else if family >= 5 && family <= 7 {
    let mut classId = classes.JS_CLASS_ARRAY
    if family == 6 { classId = classes.JS_CLASS_ARGUMENTS } if family == 7 { classId = classes.JS_CLASS_MAPPED_ARGUMENTS }
    object = run unsafe objects.withPrototypeClass(&mut hooks, memory, ctx, ValueBits.Null, classId)
    let mut i: usize = 0
    while i < 2 {
      if family == 7 { let cell = run unsafe storage.detached(rt, unsafe text.retained()) run unsafe storage.appendMapped(object, cell) }
      else {
        let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object))
        match &mut p.payload { ObjectPayload.FastArray { array } => { run array.values.append(unsafe text.retained()) } _ => trap() }
      }
      i = i + 1
    }
  } else if family == 8 || family == 13 {
    object = run unsafe fixture.typed(&mut hooks, memory, ctx)
    if family == 13 {
      let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object))
      match &mut p.payload { ObjectPayload.TypedArray { array } => { array.count = 0 array.cachedData = Pointer.null<u8>() } _ => trap() }
    }
  } else {
    object = run unsafe objects.withPrototype(&mut hooks, memory, ctx, ValueBits.Null)
    if family == 11 { let mut anchor = () let p = unsafe HeapCell.payloadMut<ObjectData, ()>(&mut anchor, reference(object)) p.isExotic = true }
  }
  if family == 0 { run unsafe stored.add(&mut hooks, rt, object, key, u32.toU8(flags | 8), PropertySlot.Value { value: unsafe text.retained() }) }
  else if family == 1 {
    unsafe HeapCell.retain(reference(leaf)) unsafe HeapCell.retain(reference(leaf))
    run unsafe stored.add(&mut hooks, rt, object, key, u32.toU8(flags | 16), PropertySlot.GetterSetter { getter: reference(leaf), setter: reference(leaf) })
  } else if family == 2 || family == 3 {
    let cell = run unsafe varRefs.createDetached(rt, family == 3)
    if family == 2 { let old = unsafe varRefs.replace(cell, unsafe text.retained()) }
    run unsafe stored.add(&mut hooks, rt, object, key, u32.toU8(flags | 32), PropertySlot.VarRef { reference: cell })
  } else if family == 4 {
    run unsafe fixture.autoProperty(&mut hooks, ctx, object, key)
    run unsafe storage.flags(rt, object, key, u32.toU8(flags | 48))
  }
  let absent = run unsafe stored.atom(rt, b"absent", 0)
  let leading = run unsafe stored.atom(rt, b"01", 0)
  let large = run unsafe stored.atom(rt, b"2147483648", 0)
  let queries: [u32; 8] = [key, absent, 0x80000000, 0x80000001, 0x80000002, 0x80000003, leading, large]
  let mut i: usize = 0
  while i < 8 {
    run unsafe query(&mut out, &mut hooks, ctx, object, queries[i], false, text, leaf)
    run unsafe query(&mut out, &mut hooks, ctx, object, queries[i], true, text, leaf)
    run unsafe query(&mut out, &mut hooks, ctx, object, queries[i], true, text, leaf)
    i = i + 1
  }
  unsafe stored.releaseAtom(rt, absent) unsafe stored.releaseAtom(rt, leading) unsafe stored.releaseAtom(rt, large)
  unsafe gc.release(&mut hooks, rt, object) unsafe stored.releaseAtom(rt, key)
  run out.writeU32(i32.toU32(unsafe rc(stringReference(text)))) run out.writeU32(i32.toU32(unsafe rc(reference(leaf))))
  unsafe gc.release(&mut hooks, rt, text) unsafe gc.release(&mut hooks, rt, leaf)
}
effect fn probe(out: &mut ByteBuffer) -> AllocationObserver ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make(&observer)
  run unsafe stored.register(rt) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe errorFixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  CALLS
  let object = run unsafe fixture.typedBigInt(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let mut fault = OneShotAllocator { parent: move memory, armed: true, remaining: 0, persistent: false, failures: 0 }
  let exists = run unsafe descriptors.hasOwnProperty(&mut hooks, ctx, object, 0x80000000) |> Effect.provideMut<Allocator>(&mut fault)
  if exists { run out.writeU32(1) } else { run out.writeU32(0) }
  run out.writeU32(usize.toU32(fault.failures))
  let found = run unsafe descriptors.getOwnProperty(&mut hooks, ctx, object, 0x80000000) |> Effect.provideMut<Allocator>(&mut fault)
  let d = descriptor(move found)
  run out.writeU32(1) run out.writeU32(d.flags)
  if d.value.isException() { run out.writeU32(1) } else { run out.writeU32(0) }
  if match d.getter { ValueBits.Undefined => true _ => false } { run out.writeU32(1) } else { run out.writeU32(0) }
  if match d.setter { ValueBits.Undefined => true _ => false } { run out.writeU32(1) } else { run out.writeU32(0) }
  if unsafe exceptions.has(rt) { run out.writeU32(1) } else { run out.writeU32(0) }
  run out.writeU32(usize.toU32(fault.failures))
  run unsafe error(&mut out, &mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut fault)
  unsafe releaseDescriptor(&mut hooks, rt, move d)
  unsafe gc.release(&mut hooks, rt, object)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
  drop hooks
  return move observer
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make() let mut writer = StdoutWriter.make()
  let ledger = run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  drop out
  if ledger.stats().usedBytes != 0 || ledger.stats().allocationCount != 0 { trap() }
  run Writer.writeAll(&[0, 0, 0, 0, 0, 0, 0, 0]) |> Effect.provideMut<Writer>(&mut writer)
  return 0
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
    c_calls = '\n'.join(f'word({i});run_case(ctx,{family},{flags});' for i, (family, flags) in enumerate(CASES))
    s_calls = '\n'.join(f'run out.writeU32({i}) run unsafe runCase(&mut out,&mut hooks,&observer,ctx,{family},{flags}) |> Effect.provideMut<Allocator>(&mut memory)' for i, (family, flags) in enumerate(CASES))
    with tempfile.TemporaryDirectory(prefix='silkjs-property-descriptors-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        # Expose every indexed-read allocation to the one-shot fault allocator;
        # this source profile switch does not enable sanitizer instrumentation.
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Property descriptors C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Property descriptors C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="property-descriptors-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native property descriptors oracle', cwd=temp)
        if not expected or len(expected) % 4 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C descriptor output or nonzero teardown ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Descriptor word {offset//4}: C={a.hex()} Silk={b.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS own descriptors: {len(CASES)} cases plus typed-read failure, {len(actual)//4} words; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; both teardown ledgers zero')


if __name__ == '__main__':
    main()
