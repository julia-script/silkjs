#!/usr/bin/env python3
"""Execute native array storage sequences against unchanged pinned QuickJS C.

C is a separate executable, never linked into Silk. The upstream large-block
allocator profile plus a zero usable-size callback removes allocator slack, so
capacity words independently check the native exact geometric policy. No source
algorithm is patched. Snapshots preserve property order, tombstones, compaction,
flags, value tags, retained edges, bindings and COW siblings after every operation.
Native-only OOM/error-boundary tests live in js_array_storage_tests.silk: source
set_array_length ignores deletion -1, whereas native deliberately propagates OOM.
"""
import argparse
import hashlib
from pathlib import Path
import random
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
# A tuple begins with class (0 Array, 1 Arguments, 2 MappedArguments), initialized
# element count, then operations. All operations obey the storage-layer contract.
CASES = [
    (0, 0, [('append', i % 3, i) for i in range(40)] + [('length', 13), ('length', 60), ('append', 1, 0), ('length', 0)]),
    (0, 6, [('convert',), ('flag', 3, 6), ('length', 1), ('length', 4), ('lengthflag', 8), ('length', 4)]),
    (0, 5, [('delete', 4), ('delete', 1), ('delete', 99), ('length', 2), ('length', 9)]),
    (0, 2, [('length', 5), ('lengthflag', 8), ('append', 1, 0), ('append', 2, 0), ('append', 0, 7), ('append', 2, 0), ('length', 5)]),
    (0, 0, [('length', 4294967295), ('append', 1, 0), ('convert',), ('add', 2147483647, 7, 0, 1),
            ('add', 2147483648, 6, 1, 0), ('add', 4294967294, 7, 2, 0), ('length', 0), ('length', 2147483649)]),
    (0, 0, [('length', 4294967295), ('slow',), ('add', 4294967294, 7, 1, 0),
            ('add', 4294967293, 6, 2, 0), ('share',), ('length', 4294967293)]),
    (0, 0, [('length', 1000000), ('slow',)] + [('add', i * 101, 7, i % 3, i) for i in range(32)]
            + [('share',), ('length', 0), ('length', 0)]),
    (0, 32, [('convert',), ('length', 0), ('length', 1000), ('length', 0)]),
    (0, 0, [('length', 1000000), ('slow',)] + [('add', i * 101, 6 if i == 11 else 7, i % 3, i) for i in range(40)]
            + [('length', 0), ('length', 1112)]),
    (1, 8, [('delete', 7), ('convert',), ('delete', 3), ('delete', 0), ('delete', 6)]),
    (1, 24, [('delete', 4)] + [('delete', i) for i in range(24)]),
    (2, 8, [('delete', 7), ('delete', 2), ('binding', 3, 1, 0), ('delete', 3), ('delete', 0)]),
    (2, 24, [('convert',), ('binding', 12, 2, 0)] + [('delete', i) for i in range(24)]),
]
# Deterministic generated storage sequences supplement the semantic boundaries.
_rng = random.Random(0x93539542)
for _ in range(20):
    n = _rng.randrange(1, 48)
    ops = [('convert',)]
    if n > 2:
        barrier = _rng.randrange(n)
        ops.append(('flag', barrier, 6))
    for _ in range(8):
        ops.append(('length', _rng.randrange(0, n * 3)))
    CASES.append((0, n, ops))

C_BASE = r'''
#include "quickjs.c"
static size_t no_slack(const void *ptr) { return 0; }
static void word(uint32_t value) { for(int i=0;i<4;i++) putchar((value>>(8*i))&255); }
static void number64(uint64_t value) { word(value);word(value>>32); }
static JSValue checked(JSValue value) { if(JS_IsException(value))abort();return value; }
static JSValue item(JSContext *ctx, JSValue text, JSValue leaf, int kind, int n) {
    if(kind==1)return JS_DupValue(ctx,text);
    if(kind==2)return JS_DupValue(ctx,leaf);
    return JS_NewInt32(ctx,n);
}
static void value(JSValue v) {
    word(JS_VALUE_GET_TAG(v));
    if(JS_VALUE_GET_TAG(v)==JS_TAG_INT)word(JS_VALUE_GET_INT(v));
    else if(JS_VALUE_GET_TAG(v)==JS_TAG_FLOAT64) { union{double d;uint64_t u;}n={.d=JS_VALUE_GET_FLOAT64(v)};number64(n.u); }
    else if(JS_IsString(v)) { JSString *s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i)); }
    else if(JS_IsObject(v)) { JSObject *p=JS_VALUE_GET_OBJ(v);word(p->class_id);word(js_rc(p)->ref_count); }
}
static void binding(JSVarRef *r) { word(js_rc(r)->ref_count);value(*r->pvalue); }
static void snapshot(JSContext *ctx, JSValue arr) {
    JSObject *p=JS_VALUE_GET_OBJ(arr);JSShape *s=p->shape;
    word(p->class_id);word(p->fast_array);word(p->is_std_array_prototype);
    word(s->is_hashed);word(s->prop_count);word(s->prop_size);word(s->deleted_prop_count);word(s->prop_hash_mask);
    word(p->u.array.count);word(p->class_id==JS_CLASS_MAPPED_ARGUMENTS?0:p->u.array.u1.size);
    for(int i=0;i<s->prop_count;i++) {
        JSShapeProperty *sp=get_shape_prop(s)+i;uint32_t idx;
        if(!sp->atom){word(0);word(0);}
        else if(JS_AtomIsArrayIndex(ctx,&idx,sp->atom)){word(1);word(idx);}
        else{word(2);word(sp->atom);}
        word(sp->flags);
        if((sp->flags&JS_PROP_TMASK)==JS_PROP_VARREF)binding(p->prop[i].u.var_ref);
        else value(p->prop[i].u.value);
    }
    for(uint32_t i=0;i<p->u.array.count;i++) {
        if(p->class_id==JS_CLASS_MAPPED_ARGUMENTS)binding(p->u.array.u.var_refs[i]);
        else value(p->u.array.u.values[i]);
    }
}
static void state(JSContext *ctx, JSValue arr, JSValue sibling, JSValue text, JSValue leaf, JSVarRef **refs, int nr) {
    snapshot(ctx,arr);word(JS_IsObject(sibling));if(JS_IsObject(sibling))snapshot(ctx,sibling);
    word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);
    word(nr);for(int i=0;i<nr;i++)binding(refs[i]);
}
static void flag(JSContext *ctx, JSValue arr, JSAtom atom, int flags) {
    JSObject *p=JS_VALUE_GET_OBJ(arr);JSProperty *slot;JSShapeProperty *sp=find_own_property(&slot,p,atom);
    if(!sp||js_shape_prepare_update(ctx,p,&sp))abort();sp->flags=flags;
}
static void add(JSContext *ctx, JSValue arr, uint32_t index, int flags, JSValue v) {
    JSAtom atom=JS_NewAtomUInt32(ctx,index);if(!atom)abort();
    JSProperty *pr=add_property(ctx,JS_VALUE_GET_OBJ(arr),atom,flags);if(!pr)abort();
    pr->u.value=v;JS_FreeAtom(ctx,atom);
}
static JSValue share(JSContext *ctx, JSValue arr) {
    JSObject *p=JS_VALUE_GET_OBJ(arr);JSProperty *slots=js_malloc(ctx,p->shape->prop_count*sizeof(*slots));if(!slots)abort();
    for(int i=0;i<p->shape->prop_count;i++)slots[i].u.value=JS_DupValue(ctx,p->prop[i].u.value);
    JSValue sibling=checked(JS_NewObjectFromShape(ctx,js_dup_shape(p->shape),JS_CLASS_ARRAY,slots));
    js_free(ctx,slots);JS_VALUE_GET_OBJ(sibling)->fast_array=0;return sibling;
}
CASES
int main(void) {
    JSMallocFunctions mf=def_malloc_funcs;mf.js_malloc_usable_size=no_slack;
    JSRuntime *rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext *ctx=JS_NewContextRaw(rt);if(!ctx)abort();
    js_free_shape(rt,ctx->array_shape);ctx->array_shape=js_new_shape(ctx,NULL);if(!ctx->array_shape)abort();
    if(add_shape_property(ctx,&ctx->array_shape,NULL,JS_ATOM_length,JS_PROP_WRITABLE|JS_PROP_LENGTH))abort();
    CALLS
    JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''
SILK_BASE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.collections.list { List }
import silk.core.option { Option }
import silk.num.u8
import silk.num.u16
import silk.num.u32
import silk.num.u64
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_value { ValueBits }
import js_core_types { RuntimeState, ObjectData, ObjectPayload, ShapeData, PropertySlot, VarRef, VarRefState }
import js_gc as gc
import js_runtime as runtime
import js_shapes as shapes
import js_object_allocate as objects
import js_class_data as classes
import js_atom_data as atoms
import js_strings { Strings }
import js_string_types { StringLengthError, stringReference }
import js_array_storage as arrays
import js_array_storage { StorageOutcome, ArrayLengthError }
import js_array_storage_test_support as fixture
import js_array_storage_test_support { Hooks, trap, reference }
fn word(value:i32)->u32 { let mut wide=i32.toI64(value) if wide<0 { wide=wide+4294967296 } return i64.toU32(wide) }
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
fn outcome(value:StorageOutcome)->u32 { return match value { StorageOutcome.Accepted=>1 StorageOutcome.ReadOnlyLength=>2 StorageOutcome.NonConfigurable=>3 } }
unsafe fn item(text:ValueBits,leaf:ValueBits,kind:u32,n:i32)->ValueBits {
  if kind==1 { return unsafe text.retained() } if kind==2 { return unsafe leaf.retained() } return ValueBits.Int {value:n}
}
unsafe effect fn emitValue(out:&mut ByteBuffer,v:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(word(v.tag()))
  match v {
    ValueBits.Int {value:n}=>{run out.writeU32(word(n))}
    ValueBits.Float64 {value:n}=>{let bits=f64.toBits(n) run out.writeU32(u64.toU32(bits&0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(bits,32)))}
    ValueBits.Object {reference:node}=>{let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,node)
      run out.writeU32(p.classId) run out.writeU32(i32.toU32(unsafe fixture.rc(node)))}
    _=>{if v.isString() {run out.writeU32(usize.toU32(Strings.length(v))) let mut i:usize=0
      while i<Strings.length(v) {run out.writeU32(u16.toU32(Strings.codeUnit(v,i))) i=i+1}}}
  }
}
unsafe effect fn binding(out:&mut ByteBuffer,node:*mut HeapHeader)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(i32.toU32(unsafe fixture.rc(node))) let anchor=()
  let r=unsafe HeapCell.payload<VarRef,()>(&anchor,node)
  match r.state {VarRefState.Detached {value}=>{run unsafe emitValue(&mut out,value)} _=>trap()}
}
unsafe effect fn snapshot(out:&mut ByteBuffer,rt:*mut HeapHeader,arr:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference(arr))
  let sh=unsafe HeapCell.payload<ShapeData,()>(&anchor,p.shape)
  let state=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  run out.writeU32(p.classId) run out.writeU32(flag(p.fastArray)) run out.writeU32(flag(p.isStandardArrayPrototype))
  run out.writeU32(flag(sh.isHashed)) run out.writeU32(usize.toU32(sh.properties.length()))
  run out.writeU32(usize.toU32(sh.properties.capacity())) run out.writeU32(usize.toU32(sh.deletedPropertyCount)) run out.writeU32(sh.propertyHashMask)
  run out.writeU32(usize.toU32(unsafe fixture.count(arr)))
  let capacity=match &p.payload {ObjectPayload.FastArray {array}=>array.values.capacity() _=>0}
  run out.writeU32(usize.toU32(capacity))
  let mut i:usize=0 while i<sh.properties.length() {
    let sp=sh.properties.get(i)
    if sp.atom==0 {run out.writeU32(0) run out.writeU32(0)} else {
      match state.atoms.arrayIndex(sp.atom) {
        Option<u32>.Some {value:index}=>{run out.writeU32(1) run out.writeU32(index)}
        Option<u32>.None=>{run out.writeU32(2) run out.writeU32(sp.atom)}
      }
    }
    run out.writeU32(u8.toU32(sp.flags))
    match p.properties.get(i) {
      PropertySlot.Value {value}=>{run unsafe emitValue(&mut out,value)}
      PropertySlot.VarRef {reference:node}=>{run unsafe binding(&mut out,node)} _=>trap()
    }
    i=i+1
  }
  i=0 match &p.payload {
    ObjectPayload.FastArray {array}=>{while i<array.values.length() {run unsafe emitValue(&mut out,array.values.get(i)) i=i+1}}
    ObjectPayload.MappedArguments {arguments}=>{while i<arguments.varRefs.length() {run unsafe binding(&mut out,arguments.varRefs.get(i)) i=i+1}}
    _=>trap()
  }
}
unsafe effect fn state(out:&mut ByteBuffer,rt:*mut HeapHeader,arr:ValueBits,sibling:ValueBits,text:ValueBits,leaf:ValueBits,refs:&List<*mut HeapHeader>)->()
  ! OutOfMemoryError ? &mut Allocator {
  run unsafe snapshot(&mut out,rt,arr) run out.writeU32(flag(sibling.isObject()))
  if sibling.isObject() {run unsafe snapshot(&mut out,rt,sibling)}
  run out.writeU32(i32.toU32(unsafe fixture.rc(stringReference(text)))) run out.writeU32(i32.toU32(unsafe fixture.rc(reference(leaf))))
  run out.writeU32(usize.toU32(refs.length())) let mut i:usize=0
  while i<refs.length() {run unsafe binding(&mut out,refs.get(i)) i=i+1}
}
CASES
effect fn probe(out:&mut ByteBuffer)->AllocationObserver ! OutOfMemoryError | StringLengthError | ArrayLengthError ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe fixture.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks {finalized:0}
  CALLS
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
  return move observer
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | ArrayLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make() let mut writer=StdoutWriter.make()
  let ledger=run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  // Snapshot storage outlives the runtime allocator; verify the independent
  // ledger only after releasing that last caller-owned allocation as well.
  drop out
  if ledger.stats().usedBytes!=0 || ledger.stats().allocationCount!=0 {trap()}
  return 0
}
'''


def emit_case(number, family, size, operations):
    class_name = ('ARRAY', 'ARGUMENTS', 'MAPPED_ARGUMENTS')[family]
    c = [f'static void case{number}(JSContext *ctx) {{',
         'JSValue text=checked(JS_NewString(ctx,"held-array-string")),leaf=checked(JS_NewObjectProto(ctx,JS_NULL)),sibling=JS_UNDEFINED;',
         f'JSVarRef *refs[{max(size, 1)}];int nr=0;',
         f'JSValue arr=checked(js_allocate_fast_array(ctx,{size}));' if family == 0 else
         f'JSValue arr=checked(JS_NewObjectProtoClass(ctx,JS_NULL,JS_CLASS_{class_name}));',
         'JSObject *p=JS_VALUE_GET_OBJ(arr);']
    s = [f'unsafe effect fn case{number}(out:&mut ByteBuffer,rt:*mut HeapHeader,ctx:*mut HeapHeader,hooks:&mut Hooks,memory:&AllocationObserver)->()'
         ' ! OutOfMemoryError | StringLengthError | ArrayLengthError ? &mut Allocator {',
         'let text=run Strings.fromLatin1(b"held-array-string") let leaf=run unsafe objects.withPrototype(&mut hooks,memory,ctx,ValueBits.Null)',
         'let mut sibling=ValueBits.Undefined let mut refs=List<*mut HeapHeader>.make()',
         f'let arr=run unsafe arrays.allocateFastArray(&mut hooks,memory,ctx,{size})' if family == 0 else
         f'let arr=run unsafe objects.withPrototypeClass(&mut hooks,memory,ctx,ValueBits.Null,classes.JS_CLASS_{class_name})',
         'let node=reference(arr)']
    if family == 1 and size:
        c += [f'if(expand_fast_array(ctx,p,{size}))abort();p->u.array.count={size};']
        s += [f'run unsafe arrays.expandFastValues(&mut hooks,ctx,node,{size})']
    if family == 2 and size:
        c += [f'p->u.array.u.var_refs=js_malloc(ctx,{size}*sizeof(JSVarRef*));if(!p->u.array.u.var_refs)abort();p->u.array.count={size};']
    for i in range(size):
        cv, sv = f'item(ctx,text,leaf,{i%3},{i})', f'unsafe item(text,leaf,{i%3},{i})'
        if family == 2:
            c += [f'refs[nr]=js_create_var_ref(ctx,FALSE);if(!refs[nr])abort();refs[nr]->value={cv};'
                  f'js_rc(refs[nr])->ref_count++;p->u.array.u.var_refs[{i}]=refs[nr];nr++;']
            s += [f'let r{i}=run unsafe fixture.detached(rt,{sv}) unsafe HeapCell.retain(r{i})',
                  f'run refs.append(r{i}) run unsafe fixture.appendMapped(arr,r{i})']
        elif family == 1:
            c += [f'p->u.array.u.values[{i}]={cv};']
            s += [f'let mut a{i}=() let p{i}=unsafe HeapCell.payloadMut<ObjectData,()>(&mut a{i},node)',
                  f'match &mut p{i}.payload {{ObjectPayload.FastArray {{array}}=>{{run array.values.append({sv})}} _=>trap()}} drop p{i}']
        else:
            c += [f'p->u.array.u.values[{i}]={cv};']
            s += [f'unsafe fixture.setFastSlot(arr,{i},{sv})']
    # This marker exercises invalidation on conversion, not just the default flag.
    c += ['p->is_std_array_prototype=1;']
    s += ['let mut marker=() let marked=unsafe HeapCell.payloadMut<ObjectData,()>(&mut marker,node) marked.isStandardArrayPrototype=true drop marked']

    def snap(step):
        c.extend([f'word({number});word({step});state(ctx,arr,sibling,text,leaf,refs,nr);'])
        s.extend([f'run out.writeU32({number}) run out.writeU32({step}) run unsafe state(&mut out,rt,arr,sibling,text,leaf,&refs)'])

    snap(0)
    for step, op in enumerate(operations, 1):
        kind = op[0]
        if kind == 'length':
            c += [f'{{int readonly=!(get_shape_prop(p->shape)[0].flags&JS_PROP_WRITABLE);'
                  f'int r=set_array_length(ctx,p,JS_NewUint32(ctx,{op[1]}u),0);if(r<0)abort();word(r?1:readonly?2:3);}}']
            s += [f'let result{step}=run unsafe arrays.setArrayLength(&mut hooks,ctx,node,{op[1]}) run out.writeU32(outcome(result{step}))']
        elif kind == 'append':
            c += [f'{{int r=add_fast_array_element(ctx,p,item(ctx,text,leaf,{op[1]},{op[2]}),0);if(r<0)abort();word(r?1:2);}}']
            s += [f'let result{step}=run unsafe arrays.appendFastElement(&mut hooks,ctx,node,unsafe item(text,leaf,{op[1]},{op[2]})) run out.writeU32(outcome(result{step}))']
        elif kind == 'convert':
            c += ['if(convert_fast_array_to_array(ctx,p))abort();']
            s += ['run unsafe arrays.convertFastToSlow(&mut hooks,ctx,node)']
        elif kind == 'delete':
            c += [f'{{JSAtom atom=JS_NewAtomUInt32(ctx,{op[1]}u);if(!atom)abort();int r=delete_property(ctx,p,atom);JS_FreeAtom(ctx,atom);if(r<0)abort();word(r?1:3);}}']
            s += [f'let result{step}=run unsafe arrays.deleteOwnIndex(&mut hooks,ctx,node,{op[1]}) run out.writeU32(outcome(result{step}))']
        elif kind == 'flag':
            c += [f'flag(ctx,arr,__JS_AtomFromUInt32({op[1]}u),{op[2]});']
            s += [f'run unsafe fixture.flags(rt,arr,{op[1] | 0x80000000},{op[2]})']
        elif kind == 'lengthflag':
            c += [f'flag(ctx,arr,JS_ATOM_length,{op[1]});']
            s += [f'run unsafe fixture.flags(rt,arr,atoms.JS_ATOM_length,{op[1]})']
        elif kind == 'slow':
            c += ['p->fast_array=0;']
            s += ['unsafe fixture.markSlow(arr)']
        elif kind == 'add':
            c += [f'add(ctx,arr,{op[1]}u,{op[2]},item(ctx,text,leaf,{op[3]},{op[4]}));']
            s += [f'run unsafe fixture.addIndex(&mut hooks,rt,arr,{op[1]},{op[2]},unsafe item(text,leaf,{op[3]},{op[4]}))']
        elif kind == 'share':
            c += ['JS_FreeValue(ctx,sibling);sibling=share(ctx,arr);']
            s += ['unsafe gc.release(&mut hooks,rt,sibling) sibling=run unsafe fixture.shareSlow(&mut hooks,memory,ctx,arr)']
        elif kind == 'binding':
            c += [f'set_value(ctx,refs[{op[1]}]->pvalue,item(ctx,text,leaf,{op[2]},{op[3]}));']
            s += [f'let mut bindingAnchor{step}=() let binding{step}=unsafe HeapCell.payloadMut<VarRef,()>(&mut bindingAnchor{step},refs.get({op[1]}))',
                  f'let oldBinding{step}=match binding{step}.state {{VarRefState.Detached {{value}}=>value _=>trap()}}',
                  f'binding{step}.state=VarRefState.Detached {{value:unsafe item(text,leaf,{op[2]},{op[3]})}} drop binding{step}',
                  f'unsafe gc.release(&mut hooks,rt,oldBinding{step})']
        else:
            raise ValueError(op)
        snap(step)
    c += ['JS_FreeValue(ctx,sibling);JS_FreeValue(ctx,arr);for(int i=0;i<nr;i++)free_var_ref(ctx->rt,refs[i]);',
          'word(js_rc(JS_VALUE_GET_STRING(text))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);',
          'JS_FreeValue(ctx,text);JS_FreeValue(ctx,leaf);}']
    s += ['unsafe gc.release(&mut hooks,rt,sibling) unsafe gc.release(&mut hooks,rt,arr)',
          'let mut i:usize=0 while i<refs.length() {unsafe gc.releaseHeader(&mut hooks,rt,refs.get(i)) i=i+1}',
          'run out.writeU32(i32.toU32(unsafe fixture.rc(stringReference(text)))) run out.writeU32(i32.toU32(unsafe fixture.rc(reference(leaf))))',
          'unsafe gc.release(&mut hooks,rt,text) unsafe gc.release(&mut hooks,rt,leaf)', '}']
    return '\n'.join(c), '\n'.join(s)


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
    generated = [emit_case(i, *case) for i, case in enumerate(CASES)]
    c = C_BASE.replace('CASES', '\n'.join(pair[0] for pair in generated)).replace('CALLS', '\n'.join(f'case{i}(ctx);' for i in range(len(CASES))))
    s = SILK_BASE.replace('CASES', '\n'.join(pair[1] for pair in generated)).replace('CALLS', '\n'.join(
        f'run unsafe case{i}(&mut out,rt,ctx,&mut hooks,&observer) |> Effect.provideMut<Allocator>(&mut memory)' for i in range(len(CASES))))
    with tempfile.TemporaryDirectory(prefix='silkjs-array-storage-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__=1', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Array storage C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Array storage C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(s)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="array-storage-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 900, owner='Native array storage oracle', cwd=temp)
        if not expected or len(expected) % 4:
            raise SystemExit('Invalid C array-storage output')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Array storage word {offset//4}: C={a.hex()} Silk={b.hex()}; byte lengths={len(expected)}/{len(actual)}')
        snapshots = sum(1 + len(case[2]) for case in CASES)
        print(f'PASS array storage: {len(CASES)} sequences, {snapshots} ordered snapshots, {len(actual)//4} exact words; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
