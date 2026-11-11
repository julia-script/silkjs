#!/usr/bin/env python3
"""Compare native object allocation and shape/property ownership with pinned C.

Only constructors safe before their family-specific initialization are freed in C.
No C implementation is linked into Silk. Native OOM stages are exercised separately
by js_object_allocate_tests.silk. All binaries and generated entrypoints are temporary.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CLASSES = ('OBJECT ARRAY C_FUNCTION ARGUMENTS MAPPED_ARGUMENTS UINT8C_ARRAY INT8_ARRAY '
           'UINT8_ARRAY INT16_ARRAY UINT16_ARRAY INT32_ARRAY UINT32_ARRAY BIG_INT64_ARRAY '
           'BIG_UINT64_ARRAY FLOAT16_ARRAY FLOAT32_ARRAY FLOAT64_ARRAY DATAVIEW NUMBER '
           'STRING BOOLEAN SYMBOL DATE BIG_INT REGEXP GLOBAL_OBJECT').split()
CAPACITIES = [-99, 0, 1, 2, 3, 4, 5, 7, 8, 9, 31, 32, 33, 255, 256, 257, 65535, 65536]
C_SOURCE = r'''
#include "quickjs.c"
static void word(uint32_t value) { for(int i=0;i<4;i++) putchar((value>>(i*8))&255); }
static void snapshot(JSContext *ctx, JSValue value) {
    if(JS_IsException(value)) abort();
    JSObject *p=JS_VALUE_GET_OBJ(value); JSShape *s=p->shape;
    word(p->class_id);word(p->extensible);word(p->is_exotic);word(p->fast_array);
    word(p->is_constructor);word(p->has_immutable_prototype);word(p->is_std_array_prototype);
    word(p->is_HTMLDDA);word(p->weakref_count);word(s->prop_count);word(s->prop_size);
    word(s->proto!=NULL);word(s->is_hashed);word(s->prop_hash_mask);
    for(int i=0;i<s->prop_count;i++) {
        JSShapeProperty *sp=get_shape_prop(s)+i; JSValue v=p->prop[i].u.value;
        word(sp->atom);word(sp->flags);word(JS_VALUE_GET_TAG(v));
        if(JS_VALUE_GET_TAG(v)==JS_TAG_INT) word(JS_VALUE_GET_INT(v));
        else if(JS_IsString(v)) { JSString *str=JS_VALUE_GET_STRING(v);word(str->len);
            for(int j=0;j<str->len;j++) word(string_get(str,j)); }
    }
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt)abort(); JSContext *ctx=JS_NewContextRaw(rt);if(!ctx)abort();
    int ids[]={CLASS_IDS};
    for(unsigned i=0;i<sizeof(ids)/sizeof(ids[0]);i++) {
        JSValue value=JS_NewObjectProtoClass(ctx,JS_NULL,ids[i]);snapshot(ctx,value);JS_FreeValue(ctx,value);
    }
    JSClassExoticMethods exotic={0};JSClassDef def={.class_name="native-probe",.exotic=&exotic};
    if(JS_NewClass(rt,67,&def))abort();
    JSValue custom=JS_NewObjectClass(ctx,67);snapshot(ctx,custom);JS_FreeValue(ctx,custom);
    int capacities[]={CAPACITIES};
    for(unsigned i=0;i<sizeof(capacities)/sizeof(capacities[0]);i++) {
        JSValue value=JS_NewObjectProtoClassAlloc(ctx,JS_NULL,JS_CLASS_OBJECT,capacities[i]);
        snapshot(ctx,value);JS_FreeValue(ctx,value);
    }
    JSValue parent=JS_NewObjectProto(ctx,JS_NULL);
    JS_SetClassProto(ctx,JS_CLASS_OBJECT,JS_DupValue(ctx,parent));
    JSValue a=JS_NewObject(ctx),b=JS_NewObjectClass(ctx,JS_CLASS_OBJECT);
    snapshot(ctx,a);snapshot(ctx,b);
    word(JS_VALUE_GET_OBJ(a)->shape==JS_VALUE_GET_OBJ(b)->shape);
    word(js_rc(JS_VALUE_GET_OBJ(parent))->ref_count);
    JS_FreeValue(ctx,a);word(js_rc(JS_VALUE_GET_OBJ(parent))->ref_count);
    JS_FreeValue(ctx,b);word(js_rc(JS_VALUE_GET_OBJ(parent))->ref_count);
    JS_FreeValue(ctx,parent);
    JSValue first=JS_NewObjectProtoClass(ctx,JS_NULL,JS_CLASS_ARRAY);
    JSShape *cached=JS_VALUE_GET_OBJ(first)->shape;
    js_free_shape(rt,ctx->array_shape);ctx->array_shape=js_dup_shape(cached);
    JS_FreeValue(ctx,first);
    JSValue array=JS_NewArray(ctx);snapshot(ctx,array);word(JS_VALUE_GET_OBJ(array)->shape==ctx->array_shape);
    JSValue text=JS_NewString(ctx,"owned-property");
    JSProperty props[1];props[0].u.value=JS_DupValue(ctx,text);
    JSValue supplied=JS_NewObjectFromShape(ctx,js_dup_shape(ctx->array_shape),JS_CLASS_OBJECT,props);
    snapshot(ctx,supplied);word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);
    JS_FreeValue(ctx,supplied);word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);
    JS_FreeValue(ctx,text);JS_FreeValue(ctx,array);JS_FreeContext(ctx);JS_FreeRuntime(rt);
    return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.i32
import silk.num.i64
import silk.collections.list { List }
import silk.core.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.u8
import silk.num.u16
import silk.num.u32
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_value { ValueBits }
import js_core_types { ContextState, ObjectData, ShapeData, PropertySlot, NativeFunctionId, WeakRefHeader, ExoticCallbacks }
import js_gc { HeapHooks, Tracer }
import js_gc as gc
import js_runtime as runtime
import js_runtime_registry as registry
import js_runtime_classes { emptyDefinition }
import js_object_allocate as objects
import js_class_data as classes
import js_strings { Strings }
import js_string_types { StringLengthError, stringReference }
fn trap()->never { return Intrinsic.trap("QuickJS invariant violated") }
fn word(value:i32)->u32 { let mut wide=i32.toI64(value) if wide<0 { wide=wide+4294967296 } return i64.toU32(wide) }
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
fn reference(value:ValueBits)->*mut HeapHeader { return match value { ValueBits.Object {reference}=>reference _=>trap() } }
unsafe fn rc(node:*mut HeapHeader)->u32 { let anchor=() unsafe { return i32.toU32(Pointer.borrow<(),HeapHeader>(&anchor,node).referenceCount) } }
struct Hooks {}
impl HeapHooks for Hooks {
  unsafe fn traceClass(self:&mut Self,rt:*mut HeapHeader,obj:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->() {
    if !unsafe gc.traceCorePayload(obj,&mut tracer) { trap() }
  }
  unsafe fn finalizeClass(self:&mut Self,rt:*mut HeapHeader,obj:*mut HeapHeader,callback:NativeFunctionId)->() {
    if !unsafe gc.finalizeCorePayload(&mut self,rt,obj) { trap() }
  }
  unsafe effect fn sweepWeak(self:&mut Self,rt:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator { trap() }
  unsafe fn destroyAuxiliary(self:&mut Self,rt:*mut HeapHeader,node:*mut HeapHeader)->() { trap() }
}
unsafe effect fn snapshot(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference(value))
  let s=unsafe HeapCell.payload<ShapeData,()>(&anchor,p.shape)
  run out.writeU32(p.classId) run out.writeU32(flag(p.extensible)) run out.writeU32(flag(p.isExotic))
  run out.writeU32(flag(p.fastArray)) run out.writeU32(flag(p.isConstructor)) run out.writeU32(flag(p.hasImmutablePrototype))
  run out.writeU32(flag(p.isStandardArrayPrototype)) run out.writeU32(flag(p.isHtmlDda)) run out.writeU32(p.weakRefCount)
  run out.writeU32(usize.toU32(s.properties.length())) run out.writeU32(usize.toU32(s.properties.capacity()))
  run out.writeU32(flag(!Pointer.isNull<HeapHeader>(s.prototype))) run out.writeU32(flag(s.isHashed)) run out.writeU32(s.propertyHashMask)
  let mut i:usize=0 while i<s.properties.length() {
    let sp=s.properties.get(i)
    let v=match p.properties.get(i) { PropertySlot.Value {value:held}=>held _=>trap() }
    run out.writeU32(sp.atom) run out.writeU32(u8.toU32(sp.flags)) run out.writeU32(word(v.tag()))
    match v {
      ValueBits.Int {value:number}=>{run out.writeU32(word(number))}
      _=>{if v.isString() { let n=Strings.length(v) run out.writeU32(usize.toU32(n)) let mut j:usize=0
        while j<n { run out.writeU32(u16.toU32(Strings.codeUnit(v,j))) j=j+1 } }}
    }
    i=i+1
  }
}
unsafe fn shape(value:ValueBits)->*mut HeapHeader { let anchor=() unsafe { return HeapCell.payload<ObjectData,()>(&anchor,reference(value)).shape } }
effect fn probe(out:&mut ByteBuffer)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks {}
  let ids=[CLASS_IDS] let mut i:usize=0
  while i<ids.length {
    let value=run unsafe objects.withPrototypeClass(&mut hooks,&observer,ctx,ValueBits.Null,ids[i]) |> Effect.provideMut<Allocator>(&mut memory)
    run unsafe snapshot(&mut out,value) unsafe gc.release(&mut hooks,rt,value) i=i+1
  }
  let mut definition=emptyDefinition()
  definition.exotic=Option<ExoticCallbacks>.some(ExoticCallbacks {descriptor:NativeFunctionId.Host {id:1},methodMask:0})
  let accepted=run unsafe registry.registerClass(rt,67,b"native-probe",move definition) |> Effect.provideMut<Allocator>(&mut memory)
  if !accepted { trap() }
  let custom=run unsafe objects.withClass(&mut hooks,&observer,ctx,67) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe snapshot(&mut out,custom) unsafe gc.release(&mut hooks,rt,custom)
  let capacities:[i32;CAPACITY_COUNT]=[CAPACITIES] i=0
  while i<capacities.length {
    let value=run unsafe objects.withPrototypeClassCapacity(&mut hooks,&observer,ctx,ValueBits.Null,classes.JS_CLASS_OBJECT,capacities[i]) |> Effect.provideMut<Allocator>(&mut memory)
    run unsafe snapshot(&mut out,value) unsafe gc.release(&mut hooks,rt,value) i=i+1
  }
  let parent=run unsafe objects.withPrototype(&mut hooks,&observer,ctx,ValueBits.Null) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe runtime.setClassPrototype(&mut hooks,ctx,classes.JS_CLASS_OBJECT,unsafe parent.retained())
  let a=run unsafe objects.object(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let b=run unsafe objects.withClass(&mut hooks,&observer,ctx,classes.JS_CLASS_OBJECT) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe snapshot(&mut out,a) run unsafe snapshot(&mut out,b)
  run out.writeU32(flag(Pointer.address<HeapHeader>(unsafe shape(a))==Pointer.address<HeapHeader>(unsafe shape(b))))
  run out.writeU32(unsafe rc(reference(parent))) unsafe gc.release(&mut hooks,rt,a)
  run out.writeU32(unsafe rc(reference(parent))) unsafe gc.release(&mut hooks,rt,b)
  run out.writeU32(unsafe rc(reference(parent))) unsafe gc.release(&mut hooks,rt,parent)
  let first=run unsafe objects.withPrototypeClass(&mut hooks,&observer,ctx,ValueBits.Null,classes.JS_CLASS_ARRAY) |> Effect.provideMut<Allocator>(&mut memory)
  let cached=unsafe shape(first) unsafe HeapCell.retain(cached)
  let mut anchor=() let context=unsafe HeapCell.payloadMut<ContextState,()>(&mut anchor,ctx)
  context.arrayShape=cached drop context unsafe gc.release(&mut hooks,rt,first)
  let array=run unsafe objects.array(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe snapshot(&mut out,array) run out.writeU32(flag(Pointer.address<HeapHeader>(unsafe shape(array))==Pointer.address<HeapHeader>(cached)))
  let text=run Strings.fromLatin1(b"owned-property") |> Effect.provideMut<Allocator>(&mut memory)
  let mut slots=List<PropertySlot>.make()
  run slots.reserveExact(2) |> Effect.provideMut<Allocator>(&mut memory)
  run slots.append(PropertySlot.Value {value:unsafe text.retained()}) |> Effect.provideMut<Allocator>(&mut memory)
  unsafe HeapCell.retain(cached)
  let supplied=run unsafe objects.fromShape(&mut hooks,&observer,ctx,cached,classes.JS_CLASS_OBJECT,Option<List<PropertySlot>>.some(move slots)) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe snapshot(&mut out,supplied) run out.writeU32(unsafe rc(stringReference(text)))
  unsafe gc.release(&mut hooks,rt,supplied) run out.writeU32(unsafe rc(stringReference(text)))
  unsafe gc.release(&mut hooks,rt,text) unsafe gc.release(&mut hooks,rt,array)
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
  if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 { trap() }
  drop memory
  if observer.stats().usedBytes!=0 { trap() }
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make() let mut out=ByteBuffer.make()
  run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
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
    replacements = {'CAPACITIES': ','.join(map(str, CAPACITIES)), 'CAPACITY_COUNT': str(len(CAPACITIES))}
    c_source = C_SOURCE.replace('CLASS_IDS', ','.join('JS_CLASS_' + name for name in CLASSES))
    silk_source = SILK_SOURCE.replace('CLASS_IDS', ','.join('classes.JS_CLASS_' + name for name in CLASSES))
    for name, value in replacements.items():
        c_source, silk_source = c_source.replace(name, value), silk_source.replace(name, value)
    with tempfile.TemporaryDirectory(prefix='silkjs-objects-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Object C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Object C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="object-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 600, owner='Native object oracle', cwd=temp)
        if not expected or len(expected) % 4:
            raise SystemExit('Invalid C object output')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Object word {offset//4}: C={a.hex()} Silk={b.hex()}; byte lengths={len(expected)}/{len(actual)}')
        print(f'PASS object allocation: {len(CLASSES)+len(CAPACITIES)+5} constructor snapshots, '
              f'{len(actual)//4} exact words; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
