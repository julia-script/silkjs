#!/usr/bin/env python3
"""Compare actual native RC/GC/shape operations with the pinned original QuickJS.

Run with UPSTREAM [--silk COMPILER] [--stdlib SDK].
The C executable includes unmodified quickjs.c; it is never linked into Silk.
Fixture payload callbacks own and trace real strong/weak edges and free their
native storage. IDs are fixture identities, never addresses. Output compares
finalized sets/counts, logical shape metadata and ownership, not layout/overhead.
Each native fixture requires zero allocator bytes and allocations after teardown.
Mandatory cases are always retained; --seed controls additional graph fixtures.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins, word

ROOT = Path(__file__).resolve().parents[1]
OPERATIONS = ('graph', 'typed', 'weak-object', 'weak-symbol', 'shape')

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc

/* This class is a small embedding, not a replacement collector. Its two owned
   edges and typed auxiliary ownership are traced/freed by the actual engine. */
typedef struct Fixture {
    uint32_t id, kind;
    JSValue edge;
    JSGCObjectHeader *typed;
} Fixture;
static JSClassID fixture_class;
static uint32_t finalized, final_count, aux_count;
static uint32_t output[32768], output_count;
static void need(int condition) { if (!condition) { fputs("heap fixture invariant failed\n", stderr); abort(); } }
static void emit(uint32_t value) { need(output_count < countof(output)); output[output_count++] = value; }
static uint32_t input_word(void) {
    uint8_t b[4]; need(fread(b, 1, 4, stdin) == 4);
    return (uint32_t)b[0] | (uint32_t)b[1]<<8 | (uint32_t)b[2]<<16 | (uint32_t)b[3]<<24;
}
static void write_word(uint32_t value) {
    uint8_t b[4] = {value, value>>8, value>>16, value>>24}; need(fwrite(b, 1, 4, stdout) == 4);
}
static Fixture *fixture(JSValueConst object) {
    Fixture *f = JS_GetOpaque(object, fixture_class); need(f != NULL); return f;
}
static void fixture_mark(JSRuntime *rt, JSValueConst object, JS_MarkFunc *mark) {
    Fixture *f = fixture(object);
    JS_MarkValue(rt, f->edge, mark);
    need(f->kind <= 3);
    if (f->typed) mark(rt, f->typed);
}
static void fixture_finalizer(JSRuntime *rt, JSValue object) {
    JSObject *p = JS_VALUE_GET_OBJ(object);
    Fixture *f = fixture(object);
    need(p->free_mark && !JS_IsLiveObject(rt, object));
    need(f->id < 31 && !(finalized & (1U << f->id)));
    finalized |= 1U << f->id; final_count++;
    uint32_t before = final_count;
    JS_FreeValueRT(rt, f->edge);
    switch (f->kind) {
    case 0: need(!f->typed); break;
    case 1: free_var_ref(rt, (JSVarRef *)f->typed); break;
    case 2: async_func_free(rt, (JSAsyncFunctionState *)f->typed); break;
    case 3: JS_FreeContext((JSContext *)f->typed); break;
    default: abort();
    }
    need(final_count == before); /* reentrant release queues, never recurses */
    js_free_rt(rt, f); aux_count++;
}
static JSValue object(JSContext *ctx, uint32_t id, JSValueConst prototype) {
    JSValue value = JS_NewObjectProtoClass(ctx, prototype, fixture_class);
    need(!JS_IsException(value));
    Fixture *f = js_mallocz(ctx, sizeof(*f)); need(f != NULL);
    f->id = id; f->edge = JS_UNDEFINED; JS_SetOpaque(value, f); return value;
}
static void snapshot(void) { emit(finalized); emit(final_count); emit(aux_count); }
static void assign(JSContext *ctx, JSValue parent, JSValue child, uint32_t slot) {
    JSValue old;
    if (slot == 0) {
        JSObject *p = JS_VALUE_GET_OBJ(parent);
        JSProperty *pr; JSShapeProperty *sp = find_own_property(&pr, p, __JS_AtomFromUInt32(1));
        if (!sp) { pr = add_property(ctx, p, __JS_AtomFromUInt32(1), JS_PROP_C_W_E); need(pr != NULL); pr->u.value = JS_UNDEFINED; }
        old = pr->u.value; pr->u.value = JS_DupValue(ctx, child);
    } else { need(slot == 1); Fixture *f = fixture(parent); old = f->edge; f->edge = JS_DupValue(ctx, child); }
    JS_FreeValue(ctx, old);
}
static void graph(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    uint32_t n = input_word(), roots = input_word(); need(n > 0 && n <= 12 && roots < (1U<<n));
    JSValue nodes[12];
    for (uint32_t i=0; i<n; i++) nodes[i] = object(ctx, i, JS_NULL);
    for (uint32_t i=0; i<n; i++) for (uint32_t j=0; j<2; j++) {
        uint32_t target = input_word(); need(target <= n);
        assign(ctx, nodes[i], target == n ? JS_UNDEFINED : nodes[target], j);
    }
    JS_RunGCInternal(rt, FALSE); snapshot();
    for (uint32_t i=0; i<n; i++) if (!(roots & (1U<<i))) JS_FreeValue(ctx, nodes[i]);
    JS_RunGCInternal(rt, FALSE); snapshot();
    /* Only retained roots are accessed after collection. Replacing their owned
       edges can synchronously finalize children and reenter the zero queue. */
    for (uint32_t i=0; i<n; i++) if (roots & (1U<<i)) for (uint32_t j=0; j<2; j++) {
        uint32_t target = input_word(); need(target == n || (target < n && (roots & (1U<<target))));
        assign(ctx, nodes[i], target == n ? JS_UNDEFINED : nodes[target], j);
    }
    JS_RunGCInternal(rt, FALSE); snapshot();
    for (uint32_t i=0; i<n; i++) if (roots & (1U<<i)) JS_FreeValue(ctx, nodes[i]);
    JS_RunGCInternal(rt, FALSE); snapshot();
    need(finalized == (1U<<n)-1 && final_count == n && aux_count == n);
}
static void typed(JSContext *ctx) {
    uint32_t kind = input_word(); need(kind >= 1 && kind <= 3);
    JSValue owner = object(ctx, 0, JS_NULL), leaf = object(ctx, 1, JS_NULL);
    assign(ctx, leaf, owner, 0);
    Fixture *f = fixture(owner); f->kind = kind;
    if (kind == 1) {
        JSVarRef *ref = js_mallocz(ctx, sizeof(*ref)); need(ref != NULL);
        js_rc(ref)->ref_count = 1; ref->is_detached = TRUE;
        ref->value = leaf; ref->pvalue = &ref->value;
        add_gc_object(ctx->rt, &ref->header, JS_GC_OBJ_TYPE_VAR_REF); f->typed = &ref->header;
    } else if (kind == 2) {
        JSAsyncFunctionState *s = js_mallocz(ctx, sizeof(*s) + sizeof(JSValue)); need(s != NULL);
        js_rc(s)->ref_count = 1; s->this_val = JS_DupValue(ctx, leaf);
        s->resolving_funcs[0] = JS_DupValue(ctx, leaf); s->resolving_funcs[1] = JS_UNDEFINED;
        s->frame.js_mode = JS_MODE_ASYNC; s->frame.cur_func = JS_UNDEFINED;
        s->frame.arg_buf = (JSValue *)(s + 1); s->frame.var_buf = s->frame.arg_buf;
        s->frame.arg_buf[0] = leaf; s->frame.cur_sp = s->frame.arg_buf + 1;
        add_gc_object(ctx->rt, &s->header, JS_GC_OBJ_TYPE_ASYNC_FUNCTION); f->typed = &s->header;
    } else {
        JSContext *realm = JS_NewContextRaw(ctx->rt); need(realm != NULL);
        JS_FreeValue(realm, realm->global_obj); realm->global_obj = leaf;
        JSModuleDef *m = js_new_module_def(realm, JS_ATOM_NULL); need(m != NULL);
        m->module_ns = JS_DupValue(ctx, leaf); m->promise = JS_DupValue(ctx, leaf);
        m->resolving_funcs[0] = JS_DupValue(ctx, leaf); m->resolving_funcs[1] = JS_DupValue(ctx, leaf);
        m->eval_exception = JS_DupValue(ctx, leaf); m->meta_obj = JS_DupValue(ctx, leaf);
        m->private_value = JS_DupValue(ctx, leaf); f->typed = &realm->header;
    }
    JS_RunGCInternal(ctx->rt, FALSE); snapshot(); emit(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);
    JS_FreeValue(ctx, owner); JS_RunGCInternal(ctx->rt, FALSE); snapshot();
    need(finalized == 3 && aux_count == 2);
}
static void weak_object(JSContext *ctx) {
    uint32_t cycle = input_word(); need(cycle <= 1);
    JSValue target = object(ctx, 0, JS_NULL), held = object(ctx, 1, JS_NULL);
    if (cycle) assign(ctx, target, target, 0);
    JSValue map = js_map_constructor(ctx, JS_UNDEFINED, 0, NULL, MAGIC_WEAK); need(!JS_IsException(map));
    JSValue args[2] = {target, held};
    JSValue result = js_map_set(ctx, map, 2, args, MAGIC_WEAK); need(!JS_IsException(result)); JS_FreeValue(ctx, result);
    JSValue weak = js_weakref_new(ctx, target);
    JS_FreeValue(ctx, target); JS_FreeValue(ctx, held);
    snapshot(); emit(js_weakref_is_live(weak));
    JS_RunGC(ctx->rt); snapshot(); emit(js_weakref_is_live(weak));
    JS_RunGC(ctx->rt); snapshot(); emit(js_weakref_is_live(weak));
    JSMapState *state = JS_GetOpaque(map, JS_CLASS_WEAKMAP); need(state && state->record_count == 0);
    js_weakref_free(ctx->rt, weak); JS_FreeValue(ctx, map); snapshot();
    need(finalized == 3 && aux_count == 2);
}
static void weak_symbol(JSContext *ctx) {
    JSValue symbol = JS_NewSymbol(ctx, NULL, 0); need(!JS_IsException(symbol));
    JSAtom atom = JS_ValueToAtom(ctx, symbol); JS_FreeAtom(ctx, atom);
    JSValue weak = js_weakref_new(ctx, symbol), second = js_weakref_new(ctx, symbol);
    emit(js_weakref_is_target(symbol)); emit(js_weakref_is_live(weak));
    JS_FreeValue(ctx, symbol); emit(js_weakref_is_live(weak));
    JSValue replacement = JS_NewSymbol(ctx, NULL, 0); need(!JS_IsException(replacement));
    JSAtom reused = JS_ValueToAtom(ctx, replacement); JS_FreeAtom(ctx, reused);
    emit(reused == atom); emit(js_weakref_is_live(second));
    js_weakref_free(ctx->rt, weak); emit(js_weakref_is_live(second));
    js_weakref_free(ctx->rt, second); JS_FreeValue(ctx, replacement);
}
static void shape_state(JSObject *p, uint32_t n, uint32_t stride) {
    JSShape *sh = p->shape; emit(sh->prop_count); emit(sh->deleted_prop_count); emit(sh->is_hashed);
    JSShapeProperty *props = get_shape_prop(sh);
    for (uint32_t i=0; i<sh->prop_count; i++) if (props[i].atom != JS_ATOM_NULL) {
        emit(props[i].atom); emit(props[i].flags); need(JS_IsNumber(p->prop[i].u.value)); emit(JS_VALUE_GET_INT(p->prop[i].u.value));
    }
    emit(0); /* no real fixture atom is zero */
    for (uint32_t i=0; i<n; i++) {
        JSProperty *pr; JSShapeProperty *sp = find_own_property(&pr, p, __JS_AtomFromUInt32(1+i*stride));
        emit(sp ? (uint32_t)(sp-get_shape_prop(p->shape)) : UINT32_MAX);
    }
}
static void add_integer(JSContext *ctx, JSValue obj, uint32_t key, uint32_t flags, uint32_t value) {
    JSProperty *pr = add_property(ctx, JS_VALUE_GET_OBJ(obj), __JS_AtomFromUInt32(key), flags);
    need(pr != NULL); pr->u.value = JS_NewInt32(ctx, value);
}
static void shapes(JSContext *ctx) {
    uint32_t n=input_word(), stride=input_word(), step=input_word();
    need(n>=8 && n<=96 && stride>0 && stride<=256 && step>=1 && step<=3);
    /* Unique prototype objects isolate this family from context cached shapes. */
    JSValue proto=object(ctx,0,JS_NULL), replacement=object(ctx,1,JS_NULL);
    JSValue a=object(ctx,2,proto), b=object(ctx,3,proto), c=object(ctx,4,proto), d=object(ctx,5,replacement);
    JSValue e=object(ctx,6,proto);
    emit(JS_VALUE_GET_OBJ(a)->shape == JS_VALUE_GET_OBJ(b)->shape);
    for(uint32_t i=0;i<n;i++) {
        add_integer(ctx,a,1+i*stride,7,i); add_integer(ctx,b,1+i*stride,7,i);
        add_integer(ctx,c,1+i*stride,i ? 7 : 5,i); add_integer(ctx,d,1+i*stride,7,i);
        add_integer(ctx,e,1+(i ? i : n)*stride,7,i);
    }
    JSObject *pa=JS_VALUE_GET_OBJ(a), *pb=JS_VALUE_GET_OBJ(b);
    emit(pa->shape==pb->shape); emit(pa->shape==JS_VALUE_GET_OBJ(c)->shape); emit(pa->shape==JS_VALUE_GET_OBJ(d)->shape);
    emit(pa->shape==JS_VALUE_GET_OBJ(e)->shape);
    JSShapeProperty *sp=get_shape_prop(pb->shape); need(js_update_property_flags(ctx,pb,&sp,7)==0); emit(pa->shape==pb->shape);
    need(js_update_property_flags(ctx,pb,&sp,3)==0); emit(pa->shape==pb->shape);
    shape_state(pb,n,stride); shape_state(pa,n,stride);
    for(uint32_t i=0;i<n;i+=step) need(delete_property(ctx,pa,__JS_AtomFromUInt32(1+i*stride))==1);
    shape_state(pa,n,stride); need(compact_properties(ctx,pa)==0); shape_state(pa,n,stride);
    add_integer(ctx,a,1,7,999); shape_state(pa,n,stride);
    need(JS_SetPrototype(ctx,a,replacement)==1); emit(pa->shape->proto==JS_VALUE_GET_OBJ(replacement));
    JS_FreeValue(ctx,proto); JS_FreeValue(ctx,replacement); snapshot();
    JS_FreeValue(ctx,a); JS_FreeValue(ctx,b); JS_FreeValue(ctx,c); JS_FreeValue(ctx,d); JS_FreeValue(ctx,e);
    JS_RunGC(ctx->rt); snapshot(); need(finalized==127 && aux_count==7);
}
int main(void) {
    uint32_t count=input_word(); write_word(count);
    for(uint32_t i=0;i<count;i++) {
        uint32_t op=input_word(); finalized=final_count=aux_count=output_count=0;
        JSRuntime *rt=JS_NewRuntime(); need(rt != NULL); JS_SetGCThreshold(rt,(size_t)-1);
        JSClassDef definition={"HeapFixture",fixture_finalizer,fixture_mark,NULL,NULL};
        if(!fixture_class) JS_NewClassID(&fixture_class);
        need(JS_NewClass(rt,fixture_class,&definition)==0);
        JSContext *ctx=JS_NewContext(rt); need(ctx != NULL);
        switch(op) {
        case 0: graph(ctx); break; case 1: typed(ctx); break;
        case 2: weak_object(ctx); break; case 3: weak_symbol(ctx); break;
        case 4: shapes(ctx); break; default: abort();
        }
        JS_FreeContext(ctx); JS_RunGC(rt); JS_FreeRuntime(rt);
        write_word(output_count*4); for(uint32_t j=0;j<output_count;j++) write_word(output[j]); fflush(stdout);
    }
    need(getchar()==EOF); return 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.list { List }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.i32
import silk.u8
import silk.u32
import silk.usize
import js_atoms { AtomTable }
import js_heap { HeapCell, HeapHeader, HeapKind }
import js_value { Value }
import js_string_types { StringLengthError }
import js_gc { HeapHooks, Tracer }
import js_gc as gc
import js_shapes as Shapes
import js_core_types {
  RuntimeState, ContextState, ContextList, ModuleList, HeapList, GcPhase,
  HostHook, ModuleLoaderHooks, SharedArrayBufferHooks, WeakRefList, WeakRefHeader,
  WeakRefKind, ClassDef, NativeFunctionId, ObjectData, ObjectPayload, ShapeData,
  PropertySlot, ObjectPayloadFamily, VarRef, VarRefState, FrameSlots, FrameReferences, StackFrame,
  StableFrame, ValueSlots, AsyncFrame, ModuleDef, ModuleStatus, RequestedModule,
  ExportEntry, ImportEntry, StarExportEntry, ByteStorage, JS_MODE_ASYNC,
  ExoticCallbacks, LeakTrackingState, LocaleCallbacks
}
import runtime_memory { RuntimeAllocator }
import byte_buffer { ByteBuffer, readU32 }
struct Input { data: &'static [u8], at: usize }
impl Input {
  fn word(self: &mut Self) -> u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
}
fn failInvariant() -> never { return Intrinsic.trap("QuickJS invariant violated") }
fn check(value: bool) -> () { if !value { failInvariant() } }
fn flag(value: bool) -> u32 { if value { return 1 } return 0 }
fn same(a: ?*const HeapHeader,b: ?*const HeapHeader) -> bool { return Pointer.address<HeapHeader>(a)==Pointer.address<HeapHeader>(b) }
unsafe fn required(value: ?*mut HeapHeader) -> *mut HeapHeader {
  check(!Pointer.isNull<HeapHeader>(value))
  return unsafe Intrinsic.pointerRequalify<?*mut HeapHeader,*mut HeapHeader>(value)
}
unsafe fn rc(node: *mut HeapHeader) -> u32 {
  let anchor=()
  let header=unsafe Pointer.borrow<(),HeapHeader>(&anchor,node)
  let value=header.referenceCount drop header
  check(value>=0) return i32.toU32(value)
}
fn noHook() -> HostHook { return HostHook { callback: Option<NativeFunctionId>.none(), opaque: Pointer.null<u8>() } }
effect fn runtimeFixture() -> *mut HeapHeader ! OutOfMemoryError ? &mut Allocator {
  let atoms=run AtomTable.make() let mut classes=List<ClassDef>.make() let mut i:u32=0
  while i<3 {
    let mut finalizer=Option<NativeFunctionId>.none() let mut mark=Option<NativeFunctionId>.none()
    if i==2 { finalizer=Option<NativeFunctionId>.some(NativeFunctionId.Host { id:2 }) mark=Option<NativeFunctionId>.some(NativeFunctionId.Host { id:2 }) }
    run classes.append(ClassDef { classId:i,classNameAtom:0,finalizer:move finalizer,mark:move mark,
      call:Option<NativeFunctionId>.none(),exotic:Option<ExoticCallbacks>.none() }) i=i+1
  }
  return run HeapCell.allocate<RuntimeState>(HeapKind.Auxiliary,RuntimeState {
    runtimeInfo:Option<ByteStorage>.none(),atoms:move atoms,classes:move classes,
    contexts:ContextList { first:Pointer.null<HeapHeader>(),last:Pointer.null<HeapHeader>() },
    gcObjects:HeapList.make(),zeroReferenceObjects:HeapList.make(),temporaryGcObjects:HeapList.make(),
    gcPhase:GcPhase.None,mallocGcThreshold:0,
    weakReferences:WeakRefList { first:Pointer.null<WeakRefHeader>(),last:Pointer.null<WeakRefHeader>() },
    leakTracking:Option<LeakTrackingState>.none(),stackSize:0,stackTop:0,stackLimit:0,
    currentException:Value.Null,currentExceptionIsUncatchable:false,inOutOfMemory:false,
    currentStackFrame:Pointer.null<StackFrame>(),interrupt:noHook(),promiseRejectionTracker:noHook(),jobs:HeapList.make(),
    moduleLoader:ModuleLoaderHooks { normalize:Option<NativeFunctionId>.none(),load:Option<NativeFunctionId>.none(),
      checkSupportedImportAttributes:Option<NativeFunctionId>.none(),loaderHasAttributes:false,opaque:Pointer.null<u8>() },
    moduleAsyncEvaluationNextTimestamp:0,canBlock:false,
    sharedArrayBuffers:SharedArrayBufferHooks { allocate:Option<NativeFunctionId>.none(),free:Option<NativeFunctionId>.none(),
      duplicate:Option<NativeFunctionId>.none(),opaque:Pointer.null<u8>() },
    stripFlags:0,shapeHashBits:0,shapeHashCount:0,shapeHash:List<?*mut HeapHeader>.make(),userOpaque:Pointer.null<u8>()
  })
}
// Each class instance owns this typed allocation. A weak-map instance uses its
// actual weak key and strong entry; an empty swept entry stays linked until its
// owner finalizes, exactly as required by the collector callback contract.
struct Fixture {
  id:u32, kind:u32, edge:Value, typed:?*mut HeapHeader, target:Value,
  weak:WeakRefHeader
}
struct Hooks { finalized:u32, count:u32, auxiliary:u32 }
unsafe fn fixture(object:*mut HeapHeader) -> *mut HeapHeader {
  let anchor=() let data=unsafe HeapCell.payload<ObjectData,()>(&anchor,object)
  match &data.payload {
    ObjectPayload.Opaque { family,reference } => {
      check(family==ObjectPayloadFamily.DataView || family==ObjectPayloadFamily.WeakMap)
      return unsafe required(reference)
    }
    _ => failInvariant()
  }
}
fn descriptor(value:NativeFunctionId) -> () {
  match value { NativeFunctionId.Host { id } => { check(id==2) } _ => failInvariant() }
}
impl HeapHooks for Hooks {
  unsafe fn traceClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,
    callback:NativeFunctionId,tracer:&mut Tracer) -> () {
    descriptor(callback) let anchor=() let reference=unsafe fixture(object)
    let data=unsafe HeapCell.payload<Fixture,()>(&anchor,reference)
    check(data.kind<=4) unsafe tracer.value(data.edge) unsafe tracer.optional(data.typed)
  }
  unsafe fn finalizeClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,
    callback:NativeFunctionId) -> () {
    descriptor(callback) let anchor=() let data=unsafe HeapCell.payload<ObjectData,()>(&anchor,object)
    check(data.freeMark && data.properties.length()==0) drop data
    check(!unsafe gc.isLiveObject(Value.Object { reference:object }))
    let reference=unsafe fixture(object) let owned=unsafe HeapCell.payload<Fixture,()>(&anchor,reference)
    let id=owned.id drop owned
    if id!=31 { check(id<31 && (self.finalized & u32.shiftLeft(1,id))==0)
      self.finalized=self.finalized | u32.shiftLeft(1,id) self.count=self.count+1 }
    unsafe gc.releaseHeader(&mut self,runtime,reference)
  }
  unsafe effect fn sweepWeak(self:&mut Self,runtime:*mut HeapHeader,node:*mut WeakRefHeader) -> () ? &mut Allocator {
    let mut anchor=() let weak=unsafe Pointer.borrow<(),WeakRefHeader>(&anchor,node)
    check(weak.kind==WeakRefKind.Map) let owner=weak.owner drop weak
    let reference=unsafe fixture(owner) let data=unsafe HeapCell.payloadMut<Fixture,()>(&mut anchor,reference)
    check(data.kind==4)
    if unsafe gc.isWeakLive(data.target) { return () }
    let target=data.target let held=data.edge data.target=Value.Undefined data.edge=Value.Undefined drop data
    let before=self.count unsafe gc.releaseWeak(target) unsafe gc.release(&mut self,runtime,held)
    check(self.count==before)
  }
  unsafe fn destroyAuxiliary(self:&mut Self,runtime:*mut HeapHeader,node:*mut HeapHeader) -> () {
    let mut anchor=() let data=unsafe HeapCell.payloadMut<Fixture,()>(&mut anchor,node)
    let id=data.id let kind=data.kind let edge=data.edge let typed=data.typed let target=data.target
    let weak=Pointer.fromMutRef<WeakRefHeader>(&mut data.weak) drop data
    check(kind<=4)
    if kind==4 { unsafe gc.unlinkWeak(runtime,weak) unsafe gc.releaseWeak(target) }
    else { check(!unsafe gc.isWeakTarget(target)) }
    let before=self.count
    unsafe gc.release(&mut self,runtime,edge) unsafe gc.releaseOptional(&mut self,runtime,typed)
    check(self.count==before)
    unsafe HeapCell.destroy<Fixture>(node)
    if id!=31 { self.auxiliary=self.auxiliary+1 }
  }
}
effect fn object(rt:*mut HeapHeader,id:u32,prototype:?*mut HeapHeader) -> *mut HeapHeader
  ! OutOfMemoryError ? &mut Allocator {
  let shape=run unsafe Shapes.empty(rt,prototype)
  let reference=run HeapCell.allocate<Fixture>(HeapKind.Auxiliary,Fixture {
    id:id,kind:0,edge:Value.Undefined,typed:Pointer.null<HeapHeader>(),target:Value.Undefined,
    weak:WeakRefHeader { previous:Pointer.null<WeakRefHeader>(),next:Pointer.null<WeakRefHeader>(),kind:WeakRefKind.Map,owner:rt }
  })
  let result=run HeapCell.allocate<ObjectData>(HeapKind.Object,ObjectData {
    isStandardArrayPrototype:false,extensible:true,freeMark:false,isExotic:false,fastArray:false,
    isConstructor:false,hasImmutablePrototype:false,temporaryMark:false,isHtmlDda:false,classId:2,weakRefCount:0,
    shape:shape,properties:List<PropertySlot>.make(),payload:ObjectPayload.Opaque { family:ObjectPayloadFamily.DataView,reference:reference }
  })
  unsafe gc.publish(rt,result) return result
}
effect fn snapshot(out:&mut ByteBuffer,hooks:&Hooks) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(hooks.finalized) run out.writeU32(hooks.count) run out.writeU32(hooks.auxiliary)
}
effect fn assign(hooks:&mut Hooks,rt:*mut HeapHeader,parent:*mut HeapHeader,child:Value,slot:u32) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let mut anchor=() let mut old=Value.Undefined
  if slot==0 {
    let data=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,parent)
    let mut index:usize=0 let mut retired=Pointer.null<HeapHeader>()
    match unsafe Shapes.lookup(data.shape,0x80000001) {
      Option<usize>.Some { value } => { index=value }
      Option<usize>.None => { let result=run unsafe Shapes.addProperty(rt,&mut data,0x80000001,7) index=result.index retired=result.retiredShape }
    }
    old=match data.properties.get(index) { PropertySlot.Value { value } => value _ => failInvariant() }
    data.properties.set(index,PropertySlot.Value { value:unsafe child.retained() }) drop data
    unsafe gc.releaseOptional(&mut hooks,rt,retired)
  } else {
    check(slot==1) let reference=unsafe fixture(parent)
    let data=unsafe HeapCell.payloadMut<Fixture,()>(&mut anchor,reference)
    old=data.edge data.edge=unsafe child.retained()
  }
  unsafe gc.release(&mut hooks,rt,old)
}
effect fn graph(input:&mut Input,out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let n=input.word() let roots=input.word() check(n>0 && n<=12 && roots<u32.shiftLeft(1,n))
  let mut nodes=List<*mut HeapHeader>.make() let mut i:u32=0
  while i<n { run nodes.append(run object(rt,i,Pointer.null<HeapHeader>())) i=i+1 }
  i=0
  while i<n { let mut j:u32=0 while j<2 {
    let target=input.word() check(target<=n) let mut value=Value.Undefined
    if target<n { value=Value.Object { reference:nodes.get(u32.toUsize(target)) } }
    run assign(&mut hooks,rt,nodes.get(u32.toUsize(i)),value,j) j=j+1
  } i=i+1 }
  run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks)
  i=0 while i<n { if (roots & u32.shiftLeft(1,i))==0 { unsafe gc.releaseHeader(&mut hooks,rt,nodes.get(u32.toUsize(i))) } i=i+1 }
  run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks)
  i=0 while i<n { if (roots & u32.shiftLeft(1,i))!=0 { let mut j:u32=0 while j<2 {
    let target=input.word() let mut value=Value.Undefined
    check(target==n || (target<n && (roots & u32.shiftLeft(1,target))!=0))
    if target<n { value=Value.Object { reference:nodes.get(u32.toUsize(target)) } }
    run assign(&mut hooks,rt,nodes.get(u32.toUsize(i)),value,j) j=j+1
  } } i=i+1 }
  run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks)
  i=0 while i<n { if (roots & u32.shiftLeft(1,i))!=0 { unsafe gc.releaseHeader(&mut hooks,rt,nodes.get(u32.toUsize(i))) } i=i+1 }
  run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks)
  check(hooks.finalized==u32.shiftLeft(1,n)-1 && hooks.count==n && hooks.auxiliary==n)
}
effect fn contextFixture(rt:*mut HeapHeader) -> *mut HeapHeader ! OutOfMemoryError ? &mut Allocator {
  let context=run HeapCell.allocate<ContextState>(HeapKind.Context,ContextState {
    runtime:rt,previousContext:Pointer.null<HeapHeader>(),nextContext:Pointer.null<HeapHeader>(),
    binaryObjectCount:0,binaryObjectSize:0,arrayShape:Pointer.null<HeapHeader>(),
    argumentsShape:Pointer.null<HeapHeader>(),mappedArgumentsShape:Pointer.null<HeapHeader>(),
    regexpShape:Pointer.null<HeapHeader>(),regexpResultShape:Pointer.null<HeapHeader>(),
    classPrototypes:List<Value>.make(),functionPrototype:Value.Undefined,functionConstructor:Value.Undefined,
    arrayConstructor:Value.Undefined,regexpConstructor:Value.Undefined,promiseConstructor:Value.Undefined,
    nativeErrorPrototypes:[Value.Undefined;9],iteratorConstructor:Value.Undefined,
    asyncIteratorPrototype:Value.Undefined,arrayPrototypeValues:Value.Undefined,throwTypeError:Value.Undefined,
    evalObject:Value.Undefined,userValues:[Value.Undefined;7],globalObject:Value.Undefined,
    globalVarObject:Value.Undefined,randomState:0,interruptCounter:10000,
    loadedModules:ModuleList { first:Pointer.null<HeapHeader>(),last:Pointer.null<HeapHeader>() },
    regexpCompilerEnabled:false,evalEnabled:false,
    localeCallbacks:Option<LocaleCallbacks>.none(),userOpaque:Pointer.null<u8>()
  })
  let mut anchor=() let state=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,rt)
  let previous=state.contexts.last state.contexts.last=context
  if Pointer.isNull<HeapHeader>(previous) { state.contexts.first=context }
  drop state
  if !Pointer.isNull<HeapHeader>(previous) {
    let prior=unsafe required(previous)
    let data=unsafe HeapCell.payloadMut<ContextState,()>(&mut anchor,prior) data.nextContext=context
  }
  let data=unsafe HeapCell.payloadMut<ContextState,()>(&mut anchor,context)
  data.previousContext=previous drop data unsafe gc.publish(rt,context) return context
}
effect fn moduleFixture(rt:*mut HeapHeader,realm:*mut HeapHeader) -> *mut HeapHeader
  ! OutOfMemoryError ? &mut Allocator {
  let module=run HeapCell.allocate<ModuleDef>(HeapKind.Module,ModuleDef {
    name:0,previousModule:Pointer.null<HeapHeader>(),nextModule:Pointer.null<HeapHeader>(),
    requestedModules:List<RequestedModule>.make(),exports:List<ExportEntry>.make(),
    starExports:List<StarExportEntry>.make(),imports:List<ImportEntry>.make(),
    namespace:Value.Undefined,functionObject:Value.Undefined,initialize:Option<NativeFunctionId>.none(),
    hasTopLevelAwait:false,resolved:true,functionCreated:false,status:ModuleStatus.Unlinked,
    dfsIndex:-1,dfsAncestorIndex:-1,stackPrevious:Pointer.null<HeapHeader>(),
    asyncParentModules:List<*mut HeapHeader>.make(),pendingAsyncDependencies:0,asyncEvaluation:false,
    asyncEvaluationTimestamp:0,cycleRoot:Pointer.null<HeapHeader>(),promise:Value.Undefined,
    resolvingFunctions:[Value.Undefined;2],evaluationHasException:false,evaluationException:Value.Undefined,
    metaObject:Value.Undefined,privateValue:Value.Undefined
  })
  let mut anchor=() let context=unsafe HeapCell.payloadMut<ContextState,()>(&mut anchor,realm)
  let previous=context.loadedModules.last context.loadedModules.last=module
  if Pointer.isNull<HeapHeader>(previous) { context.loadedModules.first=module }
  drop context
  if !Pointer.isNull<HeapHeader>(previous) {
    let prior=unsafe required(previous)
    let data=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut anchor,prior) data.nextModule=module
  }
  let data=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut anchor,module)
  data.previousModule=previous drop data unsafe gc.publish(rt,module) return module
}
effect fn asyncFixture(rt:*mut HeapHeader,local:Value) -> *mut HeapHeader
  ! OutOfMemoryError ? &mut Allocator {
  let arguments=run ValueSlots.make(0) let mut locals=run ValueSlots.make(1)
  drop locals.replace(0,local) let stack=run ValueSlots.make(2)
  let frame=run StableFrame.make(StackFrame {
    previous:Pointer.null<StackFrame>(),asyncOwner:Pointer.null<HeapHeader>(),currentFunction:Value.Undefined,
    arguments:FrameSlots.Owned { slots:move arguments },locals:FrameSlots.Owned { slots:move locals },
    stack:FrameSlots.Owned { slots:move stack },varRefs:FrameReferences.Owned { slots:List<?*mut HeapHeader>.make() },
    currentPc:Option<usize>.some(0),argumentCount:0,mode:JS_MODE_ASYNC,stackPointer:Option<usize>.some(0)
  })
  let activation=run HeapCell.allocate<AsyncFrame>(HeapKind.AsyncFunction,AsyncFrame {
    thisValue:Value.Undefined,argumentCount:0,throwFlag:false,isCompleted:false,
    resolvingFunctions:[Value.Undefined;2],frame:move frame
  })
  let mut anchor=() let data=unsafe HeapCell.payloadMut<AsyncFrame,()>(&mut anchor,activation)
  let stableFrame=unsafe data.frame.getMut() stableFrame.asyncOwner=activation drop stableFrame drop data
  unsafe gc.publish(rt,activation) return activation
}

effect fn typed(input:&mut Input,out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let kind=input.word() check(kind>=1 && kind<=3)
  let owner=run object(rt,0,Pointer.null<HeapHeader>()) let leaf=run object(rt,1,Pointer.null<HeapHeader>())
  run assign(&mut hooks,rt,leaf,Value.Object { reference:owner },0)
  let mut owned=Pointer.null<HeapHeader>() let mut anchor=()
  if kind==1 {
    let reference=run HeapCell.allocate<VarRef>(HeapKind.VarRef,VarRef {
      isLexical:false,isConst:false,state:VarRefState.Detached { value:Value.Object { reference:leaf } }
    }) unsafe gc.publish(rt,reference) owned=reference
  } else if kind==2 {
    let activation=run asyncFixture(rt,Value.Object { reference:leaf })
    let data=unsafe HeapCell.payloadMut<AsyncFrame,()>(&mut anchor,activation)
    data.thisValue=unsafe Value.Object { reference:leaf }.retained()
    data.resolvingFunctions[0]=unsafe Value.Object { reference:leaf }.retained() drop data
    owned=activation
  } else {
    let realm=run contextFixture(rt) let module=run moduleFixture(rt,realm)
    let context=unsafe HeapCell.payloadMut<ContextState,()>(&mut anchor,realm)
    context.globalObject=Value.Object { reference:leaf } drop context
    let data=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut anchor,module)
    data.namespace=unsafe Value.Object { reference:leaf }.retained()
    data.promise=unsafe Value.Object { reference:leaf }.retained()
    data.resolvingFunctions[0]=unsafe Value.Object { reference:leaf }.retained()
    data.resolvingFunctions[1]=unsafe Value.Object { reference:leaf }.retained()
    data.evaluationException=unsafe Value.Object { reference:leaf }.retained()
    data.metaObject=unsafe Value.Object { reference:leaf }.retained()
    data.privateValue=unsafe Value.Object { reference:leaf }.retained() drop data
    owned=realm
  }
  let reference=unsafe fixture(owner) let data=unsafe HeapCell.payloadMut<Fixture,()>(&mut anchor,reference)
  data.kind=kind data.typed=owned drop data
  run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks) run out.writeU32(unsafe rc(leaf))
  unsafe gc.releaseHeader(&mut hooks,rt,owner) run unsafe gc.collect(&mut hooks,rt,false) run snapshot(&mut out,&hooks)
  check(hooks.finalized==3 && hooks.auxiliary==2)
}
effect fn weakObject(input:&mut Input,out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let cycle=input.word() check(cycle<=1)
  let target=run object(rt,0,Pointer.null<HeapHeader>()) let held=run object(rt,1,Pointer.null<HeapHeader>())
  if cycle==1 { run assign(&mut hooks,rt,target,Value.Object { reference:target },0) }
  let map=run object(rt,31,Pointer.null<HeapHeader>()) let reference=unsafe fixture(map)
  let mut anchor=() let data=unsafe HeapCell.payloadMut<Fixture,()>(&mut anchor,reference)
  data.kind=4 data.target=unsafe gc.retainWeak(Value.Object { reference:target })
  data.edge=Value.Object { reference:held } data.weak.owner=map
  let node=Pointer.fromMutRef<WeakRefHeader>(&mut data.weak) drop data unsafe gc.publishWeak(rt,node)
  let weak=unsafe gc.retainWeak(Value.Object { reference:target })
  unsafe gc.releaseHeader(&mut hooks,rt,target)
  run snapshot(&mut out,&hooks) run out.writeU32(flag(unsafe gc.isWeakLive(weak)))
  run unsafe gc.collect(&mut hooks,rt,true) run snapshot(&mut out,&hooks) run out.writeU32(flag(unsafe gc.isWeakLive(weak)))
  run unsafe gc.collect(&mut hooks,rt,true) run snapshot(&mut out,&hooks) run out.writeU32(flag(unsafe gc.isWeakLive(weak)))
  let swept=unsafe HeapCell.payload<Fixture,()>(&anchor,reference)
  check(match swept.edge { Value.Undefined => true _ => false }) drop swept
  unsafe gc.releaseWeak(weak) unsafe gc.releaseHeader(&mut hooks,rt,map) run snapshot(&mut out,&hooks)
  check(hooks.finalized==3 && hooks.auxiliary==2)
}
effect fn weakSymbol(out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader) -> ()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut anchor=() let state=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,rt)
  let symbol=run state.atoms.uniqueSymbol(Option<Value>.none())
  let atom=state.atoms.symbolAtom(symbol) state.atoms.release(atom) drop state
  let weak=unsafe gc.retainWeak(symbol) let second=unsafe gc.retainWeak(symbol)
  run out.writeU32(flag(unsafe gc.isWeakTarget(symbol))) run out.writeU32(flag(unsafe gc.isWeakLive(weak)))
  unsafe gc.release(&mut hooks,rt,symbol) run out.writeU32(flag(unsafe gc.isWeakLive(weak)))
  let replacementState=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,rt)
  let replacement=run replacementState.atoms.uniqueSymbol(Option<Value>.none())
  let reused=replacementState.atoms.symbolAtom(replacement) replacementState.atoms.release(reused) drop replacementState
  run out.writeU32(flag(atom==reused)) run out.writeU32(flag(unsafe gc.isWeakLive(second)))
  unsafe gc.releaseWeak(weak) run out.writeU32(flag(unsafe gc.isWeakLive(second)))
  unsafe gc.releaseWeak(second) unsafe gc.release(&mut hooks,rt,replacement)
}
unsafe fn shapeOf(node:*mut HeapHeader) -> *mut HeapHeader {
  let anchor=() unsafe { return HeapCell.payload<ObjectData,()>(&anchor,node).shape }
}
effect fn addInteger(hooks:&mut Hooks,rt:*mut HeapHeader,node:*mut HeapHeader,key:u32,flags:u8,value:u32) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let mut anchor=() let data=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,node)
  let result=run unsafe Shapes.addProperty(rt,&mut data,key | 0x80000000,flags)
  data.properties.set(result.index,PropertySlot.Value { value:Value.Int { value:u32.toI32(value) } }) drop data
  unsafe gc.releaseOptional(&mut hooks,rt,result.retiredShape)
}
effect fn shapeState(out:&mut ByteBuffer,node:*mut HeapHeader,n:u32,stride:u32) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let anchor=() let data=unsafe HeapCell.payload<ObjectData,()>(&anchor,node)
  let other=() let shape=unsafe HeapCell.payload<ShapeData,()>(&other,data.shape)
  run out.writeU32(usize.toU32(shape.properties.length())) run out.writeU32(usize.toU32(shape.deletedPropertyCount))
  run out.writeU32(flag(shape.isHashed)) let mut i:usize=0
  while i<shape.properties.length() {
    let property=shape.properties.get(i)
    if property.atom!=0 {
      run out.writeU32(property.atom) run out.writeU32(u8.toU32(property.flags))
      let storedSlot=match data.properties.get(i) { PropertySlot.Value { value:slotValue } => slotValue _ => failInvariant() }
      let integer=match storedSlot { Value.Int { value:integerValue } => integerValue _ => failInvariant() }
      check(integer>=0) run out.writeU32(i32.toU32(integer))
    } i=i+1
  }
  run out.writeU32(0) i=0
  while i<u32.toUsize(n) {
    let key=(1+usize.toU32(i)*stride) | 0x80000000
    let mut index:u32=0xffffffff
    match unsafe Shapes.lookup(data.shape,key) { Option<usize>.Some { value } => { index=usize.toU32(value) } Option<usize>.None => () }
    run out.writeU32(index) i=i+1
  }
}
effect fn shapes(input:&mut Input,out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader) -> ()
  ! OutOfMemoryError ? &mut Allocator {
  let n=input.word() let stride=input.word() let step=input.word()
  check(n>=8 && n<=96 && stride>0 && stride<=256 && step>=1 && step<=3)
  let proto=run object(rt,0,Pointer.null<HeapHeader>()) let replacement=run object(rt,1,Pointer.null<HeapHeader>())
  let a=run object(rt,2,proto) let b=run object(rt,3,proto) let c=run object(rt,4,proto) let d=run object(rt,5,replacement)
  let e=run object(rt,6,proto)
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(b)))) let mut i:u32=0
  while i<n {
    run addInteger(&mut hooks,rt,a,1+i*stride,7,i) run addInteger(&mut hooks,rt,b,1+i*stride,7,i)
    let mut flags:u8=7 let mut key=1+i*stride
    if i==0 { flags=5 key=1+n*stride }
    run addInteger(&mut hooks,rt,c,1+i*stride,flags,i) run addInteger(&mut hooks,rt,d,1+i*stride,7,i)
    run addInteger(&mut hooks,rt,e,key,7,i) i=i+1
  }
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(b))))
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(c)))) run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(d))))
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(e))))
  let mut anchor=() let data=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,b)
  run unsafe Shapes.updateFlags(rt,&mut data,0,7) drop data
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(b))))
  let changed=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,b)
  run unsafe Shapes.updateFlags(rt,&mut changed,0,3) drop changed
  run out.writeU32(flag(same(unsafe shapeOf(a),unsafe shapeOf(b))))
  run shapeState(&mut out,b,n,stride) run shapeState(&mut out,a,n,stride)
  i=0 while i<n {
    let deleting=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,a)
    let retired=run unsafe Shapes.deleteProperty(rt,&mut deleting,(1+i*stride) | 0x80000000) drop deleting
    match move retired {
      Option<Shapes.RetiredProperty>.Some { value } => {
        check(value.flags==7)
        let old=match value.slot { PropertySlot.Value { value:retiredSlot } => retiredSlot _ => failInvariant() }
        unsafe gc.release(&mut hooks,rt,old)
      }
      Option<Shapes.RetiredProperty>.None => failInvariant()
    } i=i+step
  }
  run shapeState(&mut out,a,n,stride)
  let compacting=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,a) run unsafe Shapes.compact(&mut compacting) drop compacting
  run shapeState(&mut out,a,n,stride) run addInteger(&mut hooks,rt,a,1,7,999) run shapeState(&mut out,a,n,stride)
  let replacing=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,a)
  let old=run unsafe Shapes.replacePrototype(rt,&mut replacing,replacement) let shape=replacing.shape drop replacing
  unsafe gc.releaseOptional(&mut hooks,rt,old)
  let metadata=unsafe HeapCell.payload<ShapeData,()>(&anchor,shape)
  run out.writeU32(flag(same(metadata.prototype,replacement))) drop metadata
  unsafe gc.releaseHeader(&mut hooks,rt,proto) unsafe gc.releaseHeader(&mut hooks,rt,replacement) run snapshot(&mut out,&hooks)
  unsafe gc.releaseHeader(&mut hooks,rt,a) unsafe gc.releaseHeader(&mut hooks,rt,b)
  unsafe gc.releaseHeader(&mut hooks,rt,c) unsafe gc.releaseHeader(&mut hooks,rt,d)
  unsafe gc.releaseHeader(&mut hooks,rt,e)
  run unsafe gc.collect(&mut hooks,rt,true) run snapshot(&mut out,&hooks)
  check(hooks.finalized==127 && hooks.auxiliary==7)
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer) -> () ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let op=input.word()
  let mut memory=run RuntimeAllocator<SystemAllocator>.make(Allocator.systemAllocatorProvider())
  let rt=run runtimeFixture() |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks { finalized:0,count:0,auxiliary:0 }
  if op==0 { run graph(&mut input,&mut out,&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) }
  else if op==1 { run typed(&mut input,&mut out,&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) }
  else if op==2 { run weakObject(&mut input,&mut out,&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) }
  else if op==3 { run weakSymbol(&mut out,&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) }
  else if op==4 { run shapes(&mut input,&mut out,&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) }
  else { failInvariant() }
  run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
  // Output storage belongs to memory while each scenario is executing; release it
  // before requiring complete zero storage, after copying the transport outside.
  let bytes=out.asSlice() let mut copy=ByteBuffer.make() run copy.appendSlice(bytes)
  drop bytes
  out.*=move copy
  check(memory.stats().usedBytes==0 && memory.stats().allocationCount==0)
}
effect fn probe() -> () ! OutOfMemoryError | StringLengthError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word()
  let mut size=ByteBuffer.make() run size.writeU32(count) run Writer.writeAll(size.asSlice())
  let mut i:u32=0 while i<count {
    let mut out=ByteBuffer.make() run operate(&mut input,&mut out)
    size.clear() run size.writeU32(usize.toU32(out.length())) run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  } check(input.at==input.data.length)
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


@dataclass(frozen=True)
class Case:
    label: str
    op: int
    arguments: tuple[int, ...] = ()

    def wire(self):
        return b''.join(word(value) for value in (self.op, *self.arguments))


def fixtures(seed, random_cases):
    cases = []

    def graph(label, edges, roots, replacement=None):
        n = len(edges)
        if replacement is None:
            replacement = [(n, n) for i in range(n) if roots & (1 << i)]
        cases.append(Case(label, 0, (n, roots, *(v for pair in edges for v in pair),
                                    *(v for pair in replacement for v in pair))))

    graph('unreachable-self-cycle', [(0, 1)], 0)
    graph('rooted-two-node-cycle-then-mutation', [(1, 2), (2, 0)], 1)
    graph('shared-child-and-reentrant-finalizer', [(2, 2), (2, 2), (3, 3)], 3)
    graph('payload-only-unreachable-cycle', [(3, 1), (3, 2), (3, 0)], 0)
    graph('disconnected-root-and-unreachable-cycle', [(4, 4), (2, 4), (1, 4), (0, 0)], 1)
    graph('long-release-chain', [(i + 1, 12) for i in range(12)], 1)
    rng = random.Random(seed)
    for index in range(random_cases):
        n = rng.randrange(1, 13)
        roots = rng.randrange(1 << n)
        edges = [(rng.randrange(n + 1), rng.randrange(n + 1)) for _ in range(n)]
        live = [i for i in range(n) if roots & (1 << i)]
        replacement = [(rng.choice([n, *live]), rng.choice([n, *live])) for _ in live]
        graph(f'seeded-graph-{index}', edges, roots, replacement)
    cases += [Case('detached-varref-cycle', 1, (1,)), Case('suspended-async-frame-cycle', 1, (2,)),
              Case('context-module-multi-edge-cycle', 1, (3,)),
              Case('weak-acyclic-zombie-and-held-value', 2, (0,)),
              Case('weak-cycle-zombie-next-pass', 2, (1,)), Case('symbol-zombie-atom-reuse', 3)]
    for n in (8, 24, 64, 96):
        for stride in (1, 256):
            for step in (1, 2, 3):
                cases.append(Case(f'shape-order-cow-compact-{n}-stride-{stride}-delete-{step}', 4, (n, stride, step)))
    return cases


def semantic_fields(case, data, owner):
    if len(data) % 4:
        raise SystemExit(f'{owner} [{case.label}]: non-word record length {len(data)}')
    values = struct.unpack(f'<{len(data) // 4}I', data)
    at, result = 0, {}

    def take(name):
        nonlocal at
        if at == len(values):
            raise SystemExit(f'{owner} [{case.label}]: missing {name}')
        result[name] = value = values[at]
        at += 1
        return value

    def snapshot(name):
        mask = take(name + '.finalized')
        count = take(name + '.count')
        destroyed = take(name + '.auxiliary')
        if mask.bit_count() != count or count != destroyed:
            raise SystemExit(f'{owner} [{case.label}]: inconsistent finalizer/auxiliary identity counts at {name}')

    if case.op == 0:
        for name in ('all-rooted', 'selected-roots', 'mutated', 'unreachable'):
            snapshot(name)
        n = case.arguments[0]
        if result['all-rooted.finalized'] or result['unreachable.finalized'] != (1 << n) - 1:
            raise SystemExit(f'{owner} [{case.label}]: graph root/lifetime invariant')
        required = {
            'unreachable-self-cycle': (1, 1),
            'rooted-two-node-cycle-then-mutation': (0, 2),
            'shared-child-and-reentrant-finalizer': (0, 4),
            'payload-only-unreachable-cycle': (7, 7),
            'disconnected-root-and-unreachable-cycle': (14, 14),
            'long-release-chain': (0, 4094),
        }
        if case.label in required:
            pair = result['selected-roots.finalized'], result['mutated.finalized']
            if pair != required[case.label]:
                raise SystemExit(f'{owner} [{case.label}]: fixture failed to exercise intended lifetime: {pair}')
    elif case.op == 1:
        snapshot('rooted')
        refs = take('leaf.references')
        snapshot('unreachable')
        if result['rooted.finalized'] or result['unreachable.finalized'] != 3 or refs != (1, 3, 8)[case.arguments[0] - 1]:
            raise SystemExit(f'{owner} [{case.label}]: typed-edge lifetime invariant')
    elif case.op == 2:
        for name in ('released', 'first-pass', 'second-pass'):
            snapshot(name)
            take(name + '.weak-live')
        snapshot('cleaned')
        cycle = case.arguments[0]
        required = (0, 1, 3) if cycle else (1, 3, 3)
        observed = tuple(result[name + '.finalized'] for name in ('released', 'first-pass', 'second-pass'))
        if observed != required or result['released.weak-live'] != cycle or result['first-pass.weak-live'] or result['second-pass.weak-live']:
            raise SystemExit(f'{owner} [{case.label}]: weak-pass ordering invariant: {result}')
    elif case.op == 3:
        for name in ('target', 'live', 'dead', 'atom-reused', 'second-dead', 'surviving-weak-dead'):
            take(name)
        if tuple(result.values()) != (1, 1, 0, 1, 0, 0):
            raise SystemExit(f'{owner} [{case.label}]: symbol zombie/atom ownership invariant: {result}')
    elif case.op == 4:
        for name in ('empty-shared', 'transition-shared', 'different-flags-shared', 'different-prototype-shared', 'different-atoms-shared', 'unchanged-shared', 'cow-shared'):
            take(name)
        if tuple(result.values()) != (1, 1, 0, 0, 0, 1, 0):
            raise SystemExit(f'{owner} [{case.label}]: interning/COW fixture did not exercise sharing')
        n, stride, step = case.arguments
        for stage in ('cow', 'original', 'deleted', 'compacted', 'reinserted'):
            count = take(stage + '.slots')
            deleted = take(stage + '.deleted')
            hashed = take(stage + '.hashed')
            live = []
            while True:
                atom = take(f'{stage}.property[{len(live)}].atom')
                if not atom:
                    break
                flags = take(f'{stage}.property[{len(live)}].flags')
                value = take(f'{stage}.property[{len(live)}].value')
                live.append((atom, flags, value))
                if len(live) > n:
                    raise SystemExit(f'{owner} [{case.label}]: unbounded property output')
            if count - deleted != len(live) or hashed not in (0, 1):
                raise SystemExit(f'{owner} [{case.label}]: property accounting invariant at {stage}')
            expected_keys = list(range(n))
            if stage in ('deleted', 'compacted', 'reinserted'):
                expected_keys = [i for i in expected_keys if i % step]
            if stage == 'reinserted':
                expected_keys.append(0)
            expected_order = [0x80000000 | (1 + i * stride) for i in expected_keys]
            if [row[0] for row in live] != expected_order:
                raise SystemExit(f'{owner} [{case.label}]: insertion order invariant at {stage}')
            for index in range(n):
                found = take(f'{stage}.lookup[{index}]')
                if found != 0xffffffff and found >= count:
                    raise SystemExit(f'{owner} [{case.label}]: lookup escaped property storage')
            if stage in ('compacted', 'reinserted') and deleted:
                raise SystemExit(f'{owner} [{case.label}]: compaction retained tombstones')
        if take('prototype-replaced') != 1:
            raise SystemExit(f'{owner} [{case.label}]: prototype update did not occur')
        snapshot('prototype-roots-released')
        snapshot('all-released')
        if result['prototype-roots-released.finalized'] or result['all-released.finalized'] != 127:
            raise SystemExit(f'{owner} [{case.label}]: shape prototype ownership invariant')
    else:
        raise SystemExit(f'Unsupported fixture operation {case.op}')
    if at != len(values):
        raise SystemExit(f'{owner} [{case.label}]: {len(values) - at} trailing fields')
    return result


def records(data, cases, owner):
    at = 0

    def take(size, label):
        nonlocal at
        if size > len(data) - at:
            raise SystemExit(f'{owner}: truncated {label} at byte {at}')
        value = data[at:at + size]
        at += size
        return value

    count, = struct.unpack('<I', take(4, 'record count'))
    if count != len(cases):
        raise SystemExit(f'{owner}: emitted {count} records, expected {len(cases)}')
    result = []
    for case in cases:
        size, = struct.unpack('<I', take(4, case.label + ' length'))
        result.append(semantic_fields(case, take(size, case.label), owner))
    if at != len(data):
        raise SystemExit(f'{owner}: {len(data) - at} trailing bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--seed', type=lambda value: int(value, 0), default=0x6C5A9E)
    parser.add_argument('--random-cases', type=int, default=128)
    parser.add_argument('--timeout', type=int, default=900)
    parser.add_argument('--max-mismatches', type=int, default=20)
    args = parser.parse_args()
    if args.random_cases < 0 or args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('random-cases must be nonnegative; timeout and max-mismatches must be positive')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    cases = fixtures(args.seed, args.random_cases)
    data = word(len(cases)) + b''.join(case.wire() for case in cases)
    print(f'Heap oracle: {len(cases)} fixtures; {pins} recursively validated hashes; seed={args.seed:#x}; '
          f'input-sha256={hashlib.sha256(data).hexdigest()}', flush=True)
    with tempfile.TemporaryDirectory(prefix='silkjs-heap-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        version = (upstream / 'VERSION').read_text().strip()
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', f'-DCONFIG_VERSION="{version}"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                args.timeout, owner='C32 heap compilation')
        oracle = process([str(temp / 'oracle')], args.timeout, owner='C32 heap oracle', data=data, cases=cases)
        expected = records(oracle, cases, 'C32 heap oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        silk_version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="heap-differential"\nversion="0.0.0"\nsilk-version="{silk_version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if stdlib is not None:
            command += ['--stdlib', str(stdlib)]
        native = process(command, args.timeout, owner='Native heap probe', cwd=temp, cases=cases)
        actual = records(native, cases, 'Native heap probe')
        failures = Counter()
        for index, (case, wanted, got) in enumerate(zip(cases, expected, actual, strict=True)):
            if wanted == got:
                continue
            failures[OPERATIONS[case.op]] += 1
            if failures.total() <= args.max_mismatches:
                print(f'MISMATCH #{index} [{case.label}] input-sha256={hashlib.sha256(case.wire()).hexdigest()}')
                for name in sorted(wanted.keys() | got.keys()):
                    if wanted.get(name) != got.get(name):
                        print(f'  {name}: C32={wanted.get(name)} Silk={got.get(name)}')
        if failures:
            raise SystemExit(f'{failures.total()} heap mismatches: {dict(failures)}')
        totals = Counter(OPERATIONS[case.op] for case in cases)
        print(f'PASS: {len(cases)} independent heap records; operations={dict(totals)}; '
              f'output-sha256={hashlib.sha256(native).hexdigest()}')


if __name__ == '__main__':
    main()
