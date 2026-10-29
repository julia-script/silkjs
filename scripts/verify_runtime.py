#!/usr/bin/env python3
"""Compare low-level native runtime behavior against unmodified pinned QuickJS.

The C oracle is a separate executable, never linked into Silk. Native contexts
are explicitly internal storage: this probe does not claim intrinsic/JS execution
coverage. C uses real JS_NewContextRaw for root/class/job API consumers. Tests in
js_runtime_tests.silk independently sweep allocation failures and check reclamation.
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
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32
#error Oracle requires the pinned 32-bit-limb profile
#endif
static void need(int ok) { if (!ok) abort(); }
static void emit(uint32_t n) { for (int i=0;i<4;i++) putchar((n>>(8*i))&255); }
static uint32_t sequence;
static JSValue job3(JSContext *ctx, int argc, JSValueConst *argv) { sequence=sequence*10+3; return JS_UNDEFINED; }
static JSValue job1(JSContext *ctx, int argc, JSValueConst *argv) {
  sequence=sequence*10+1; need(JS_EnqueueJob(ctx,job3,0,NULL)==0); return JS_DupValue(ctx,argv[0]);
}
static JSValue job2(JSContext *ctx, int argc, JSValueConst *argv) {
  sequence=sequence*10+2; return JS_Throw(ctx,JS_NewInt32(ctx,42));
}
static unsigned exotic_mask(const JSClassExoticMethods *e) {
  if (!e) return 0;
  return !!e->get_own_property | (!!e->get_own_property_names<<1) |
    (!!e->delete_property<<2) | (!!e->define_own_property<<3) |
    (!!e->has_property<<4) | (!!e->get_property<<5) | (!!e->set_property<<6);
}
int main(void) {
  JSRuntime *rt=JS_NewRuntime(); need(rt!=NULL);
  emit(rt->class_count); emit(rt->shape_hash_bits); emit(rt->shape_hash_count);
  emit(rt->malloc_gc_threshold); emit(JS_VALUE_GET_TAG(rt->current_exception));
  for(unsigned i=0;i<JS_CLASS_INIT_COUNT;i++) {
    JSClass *cl=&rt->class_array[i];
    emit(JS_IsRegisteredClass(rt,i)); emit(cl->class_name);
    emit(!!cl->finalizer); emit(!!cl->gc_mark); emit(!!cl->call); emit(exotic_mask(cl->exotic));
  }
  JSClassID a=0,b=0; emit(JS_NewClassID(&a)); emit(JS_NewClassID(&a)); emit(JS_NewClassID(&b));
  JSContext *first=JS_NewContextRaw(rt), *second=JS_NewContextRaw(rt); need(first&&second);
  JSClassDef def={.class_name="runtime-registration-name"};
  uint32_t ids[]={67,150,65535,65536,150};
  for(unsigned i=0;i<countof(ids);i++) {
    int result=JS_NewClass(rt,ids[i],&def);
    emit(result==0); emit(rt->class_count); emit(JS_IsRegisteredClass(rt,ids[i]));
    if(result==0) {
      JSValue x=JS_GetClassProto(first,ids[i]),y=JS_GetClassProto(second,ids[i]);
      emit(JS_VALUE_GET_TAG(x)); emit(JS_VALUE_GET_TAG(y)); JS_FreeValue(first,x); JS_FreeValue(second,y);
    }
  }
  JSClassDef numeric={.class_name="123"};
  emit(JS_NewClass(rt,68,&numeric)==0);
  emit(__JS_AtomIsTaggedInt(rt->class_array[68].class_name));
  JSValue text=JS_NewString(first,"runtime-root-string");
  JS_SetContextValue(first,0,text);
  JSValue copy=JS_GetContextValue(first,0); emit(js_rc(JS_VALUE_GET_PTR(copy))->ref_count);
  JS_SetClassProto(first,67,copy); JS_SetContextValue(first,0,JS_NULL);
  copy=JS_GetClassProto(first,67); emit(js_rc(JS_VALUE_GET_PTR(copy))->ref_count);
  JS_SetContextValue(first,-1,copy); emit(JS_VALUE_GET_TAG(JS_GetContextValue(first,7)));
  JS_SetClassProto(first,67,JS_NULL);
  rt->stack_top=8192; JS_SetMaxStackSize(rt,1024); emit(rt->stack_limit);
  emit((uintptr_t)(7168-0)<rt->stack_limit); emit((uintptr_t)(7168-1)<rt->stack_limit);
  JS_SetMaxStackSize(rt,0); emit(rt->stack_limit);
  JS_SetStripInfo(rt,3); emit(JS_GetStripInfo(rt)); JS_SetCanBlock(rt,1); emit(rt->can_block);
  int token1,token2;
  JS_SetRuntimeOpaque(rt,&token1); JS_SetContextOpaque(first,&token2);
  emit(JS_GetRuntimeOpaque(rt)==&token1); emit(JS_GetContextOpaque(first)==&token2);
  JSValue argument=JS_NewString(first,"runtime-job-argument");
  need(JS_EnqueueJob(first,job1,1,&argument)==0); need(JS_EnqueueJob(first,job2,1,&argument)==0);
  emit(js_rc(JS_VALUE_GET_PTR(argument))->ref_count); JS_FreeValue(first,argument);
  emit(JS_IsJobPending(rt));
  for(int i=0;i<4;i++) { emit(JS_ExecutePendingJob(rt,NULL)); emit(sequence); }
  emit(JS_IsJobPending(rt)); JSValue exception=JS_GetException(first); JS_FreeValue(first,exception);
  JS_FreeContext(first); JS_FreeContext(second); JS_FreeRuntime(rt);
  return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.core.effect { Effect }
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.u32
import silk.num.i32
import silk.num.usize
import silk.num.u8
import silk.num.u16
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, NativeFunctionId, WeakRefHeader, ExoticCallbacks }
import js_gc { HeapHooks, Tracer }
import js_gc as gc
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringLengthError }
import js_runtime as rtapi
import js_runtime_registry as registry
import js_runtime_registry { ClassIdAllocator }
import js_runtime_classes { emptyDefinition }
import js_runtime_jobs as jobs
import js_runtime_jobs { JobDispatcher }
import runtime_memory { RuntimeAllocator }
fn trap() -> never { return Intrinsic.trap("QuickJS invariant violated") }
fn flag(value:bool) -> u32 { if value { return 1 } return 0 }
fn present(value:&Option<NativeFunctionId>) -> u32 {
  return match &value.* { Option<NativeFunctionId>.Some {..} => 1 Option<NativeFunctionId>.None => 0 }
}
unsafe fn rc(value:ValueBits) -> u32 {
  let reference=match value { ValueBits.String {reference} => reference _ => trap() }
  let anchor=() unsafe { return i32.toU32(Pointer.borrow<(),HeapHeader>(&anchor,reference).referenceCount) }
}
struct Hooks { sequence:u32 }
impl HeapHooks for Hooks {
  unsafe fn traceClass(self:&mut Self,rt:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->() { trap() }
  unsafe fn finalizeClass(self:&mut Self,rt:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId)->() { trap() }
  unsafe effect fn sweepWeak(self:&mut Self,rt:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator { trap() }
  unsafe fn destroyAuxiliary(self:&mut Self,rt:*mut HeapHeader,node:*mut HeapHeader)->() { trap() }
}
impl JobDispatcher for Hooks {
  unsafe effect fn dispatchJob(self:&mut Self,context:*mut HeapHeader,function:NativeFunctionId,arguments:&[ValueBits])->ValueBits
    ! OutOfMemoryError ? &mut Allocator {
    let id=match function { NativeFunctionId.Host {id} => id _ => trap() }
    self.sequence=self.sequence*10+id
    if id==1 {
      run unsafe jobs.enqueueJob(context,NativeFunctionId.Host {id:3},&[])
      return unsafe arguments[0].retained()
    }
    if id==2 {
      let mut anchor=() let rt=unsafe rtapi.contextRuntime(context)
      let state=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,rt)
      state.currentException=ValueBits.Int {value:42}
      return ValueBits.Exception
    }
    return ValueBits.Undefined
  }
}
effect fn exercise(out:&mut ByteBuffer)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut memory=run RuntimeAllocator<SystemAllocator>.make(Allocator.systemAllocatorProvider())
  let rt=run rtapi.allocateRuntimeStorage(2097152) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks {sequence:0}
  let anchor=() let state=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(usize.toU32(state.classes.length())) run out.writeU32(i32.toU32(state.shapeHashBits))
  run out.writeU32(usize.toU32(state.shapeHashCount)) run out.writeU32(usize.toU32(state.mallocGcThreshold))
  run out.writeU32(i32.toU32(state.currentException.tag()))
  let mut i:usize=0 while i<67 {
    let cl=&state.classes.asSlice()[i]
    run out.writeU32(flag(cl.classId!=0)) run out.writeU32(cl.classNameAtom)
    run out.writeU32(present(&cl.finalizer)) run out.writeU32(present(&cl.mark)) run out.writeU32(present(&cl.call))
    let mask=match &cl.exotic { Option<ExoticCallbacks>.Some {value} => value.methodMask Option<ExoticCallbacks>.None => 0 }
    run out.writeU32(u16.toU32(mask)) i=i+1
  }
  drop state
  let ids=run ClassIdAllocator.make()
  let mut a:u32=0 let mut b:u32=0
  run out.writeU32(ids.allocate(&mut a)) run out.writeU32(ids.allocate(&mut a)) run out.writeU32(ids.allocate(&mut b))
  let first=run unsafe rtapi.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let second=run unsafe rtapi.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let registration:[u32;5]=[67,150,65535,65536,150]
  i=0 while i<5 {
    let id=registration[i]
    let accepted=run unsafe registry.registerClass(rt,id,b"runtime-registration-name",emptyDefinition()) |> Effect.provideMut<Allocator>(&mut memory)
    run out.writeU32(flag(accepted))
    let current=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
    run out.writeU32(usize.toU32(current.classes.length())) drop current
    run out.writeU32(flag(unsafe registry.isRegisteredClass(rt,id)))
    if accepted {
      let x=unsafe rtapi.getClassPrototype(first,id) let y=unsafe rtapi.getClassPrototype(second,id)
      run out.writeU32(i32.toU32(x.tag())) run out.writeU32(i32.toU32(y.tag()))
      unsafe gc.release(&mut hooks,rt,x) unsafe gc.release(&mut hooks,rt,y)
    }
    i=i+1
  }
  let numeric=run unsafe registry.registerClass(rt,68,b"123",emptyDefinition()) |> Effect.provideMut<Allocator>(&mut memory)
  run out.writeU32(flag(numeric))
  let numericState=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(flag((numericState.classes.asSlice()[68].classNameAtom & 0x80000000)!=0))
  drop numericState
  let text=run Strings.fromLatin1(b"runtime-root-string") |> Effect.provideMut<Allocator>(&mut memory)
  unsafe rtapi.setContextValue(&mut hooks,first,0,text)
  let copy=unsafe rtapi.getContextValue(first,0) run out.writeU32(unsafe rc(copy))
  unsafe rtapi.setClassPrototype(&mut hooks,first,67,copy) unsafe rtapi.setContextValue(&mut hooks,first,0,ValueBits.Null)
  let again=unsafe rtapi.getClassPrototype(first,67) run out.writeU32(unsafe rc(again))
  unsafe rtapi.setContextValue(&mut hooks,first,-1,again)
  let invalidRoot=unsafe rtapi.getContextValue(first,7)
  run out.writeU32(i32.toU32(invalidRoot.tag()))
  unsafe rtapi.setClassPrototype(&mut hooks,first,67,ValueBits.Null)
  unsafe rtapi.updateStackTop(rt,8192) unsafe rtapi.setMaxStackSize(rt,1024)
  let stacked=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(usize.toU32(stacked.stackLimit)) drop stacked
  run out.writeU32(flag(unsafe rtapi.checkStackOverflow(rt,7168,0,true)))
  run out.writeU32(flag(unsafe rtapi.checkStackOverflow(rt,7168,1,true)))
  unsafe rtapi.setMaxStackSize(rt,0)
  let disabled=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(usize.toU32(disabled.stackLimit)) drop disabled
  unsafe rtapi.setStripInfo(rt,3) run out.writeU32(u8.toU32(unsafe rtapi.getStripInfo(rt)))
  unsafe rtapi.setCanBlock(rt,true)
  let blocking=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(flag(blocking.canBlock)) drop blocking
  let mut token1:u8=0 let mut token2:u8=0
  let opaque1=Pointer.fromMutRef<u8>(&mut token1)
  let opaque2=Pointer.fromMutRef<u8>(&mut token2)
  unsafe rtapi.setRuntimeOpaque(rt,opaque1) unsafe rtapi.setContextOpaque(first,opaque2)
  run out.writeU32(flag(Pointer.address<u8>(unsafe rtapi.getRuntimeOpaque(rt))==Pointer.address<u8>(opaque1)))
  run out.writeU32(flag(Pointer.address<u8>(unsafe rtapi.getContextOpaque(first))==Pointer.address<u8>(opaque2)))
  let argument=run Strings.fromLatin1(b"runtime-job-argument") |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe jobs.enqueueJob(first,NativeFunctionId.Host {id:1},&[argument]) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe jobs.enqueueJob(first,NativeFunctionId.Host {id:2},&[argument]) |> Effect.provideMut<Allocator>(&mut memory)
  run out.writeU32(unsafe rc(argument)) unsafe gc.release(&mut hooks,rt,argument)
  run out.writeU32(flag(unsafe jobs.isJobPending(rt)))
  i=0 while i<4 {
    let result=run unsafe jobs.executePendingJob(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
    let mut status:u32 = 4294967295
    if result.status >= 0 { status = i32.toU32(result.status) }
    run out.writeU32(status) run out.writeU32(hooks.sequence) i=i+1
  }
  run out.writeU32(flag(unsafe jobs.isJobPending(rt)))
  unsafe gc.releaseHeader(&mut hooks,rt,first) unsafe gc.releaseHeader(&mut hooks,rt,second)
  run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
  if memory.stats().usedBytes!=0 || memory.stats().allocationCount!=0 { trap() }
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  let mut out=ByteBuffer.make()
  run exercise(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def labels():
    result = ['class-count', 'shape-bits', 'shape-count', 'gc-threshold', 'initial-exception-tag']
    for i in range(67):
        result += [f'class[{i}].{name}' for name in ('registered', 'name-atom', 'finalizer', 'mark', 'call', 'exotic-mask')]
    result += ['allocated-id', 'cached-id', 'second-id']
    for i, success in zip((67, 150, 65535, 65536, 150), (True, True, True, False, False)):
        result += [f'register[{i}].{name}' for name in ('accepted', 'count', 'registered')]
        if success:
            result += [f'register[{i}].first-prototype', f'register[{i}].second-prototype']
    result += ['numeric-class.accepted', 'numeric-class.tagged']
    result += ['user-root-rc', 'prototype-root-rc', 'invalid-root-tag', 'stack-limit', 'stack-equal', 'stack-below',
               'disabled-stack-limit', 'strip-flags', 'can-block', 'runtime-opaque', 'context-opaque',
               'job-argument-rc', 'jobs-pending']
    for i in range(4):
        result += [f'job[{i}].status', f'job[{i}].sequence']
    return result + ['jobs-drained']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    with tempfile.TemporaryDirectory(prefix='silkjs-runtime-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        version = (upstream / 'VERSION').read_text().strip()
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 f'-DCONFIG_VERSION="{version}"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                args.timeout, owner='C32 runtime compilation')
        expected = process([str(temp / 'oracle')], args.timeout, owner='C32 runtime oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        silk_version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="runtime-differential"\nversion="0.0.0"\nsilk-version="{silk_version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = process(command, args.timeout, owner='Native runtime probe', cwd=temp)
        names = labels()
        for owner, data in [('C32', expected), ('Native', actual)]:
            if len(data) != 4 * len(names):
                raise SystemExit(f'{owner}: expected {len(names)} records, received {len(data)} bytes')
        wanted = struct.unpack(f'<{len(names)}I', expected)
        got = struct.unpack(f'<{len(names)}I', actual)
        failures = [(label, a, b) for label, a, b in zip(names, wanted, got, strict=True) if a != b]
        if failures:
            for label, a, b in failures:
                print(f'MISMATCH {label}: C32={a} Silk={b}')
            raise SystemExit(f'{len(failures)} runtime mismatches')
        print(f'Runtime oracle: {len(names)} matching records; {pins} validated hashes; '
              f'output-sha256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
