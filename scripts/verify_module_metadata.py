#!/usr/bin/env python3
"""Compare pinned original-C/native module metadata and ownership snapshots.

C and Silk are separate executables. The original C allocator's documented
large-block mode with no usable-size callback removes optional allocator slack;
this makes its exact 3/2 array capacities comparable to native reserveExact.
The C import probe executes original add_import with the parser's default-binding
exception, then assigns the request index as the grammar does. Native deliberately
only appends the already-validated metadata. Unit tests cover injected OOM and
owned diagnostics after teardown. Neither executable links C into native Silk.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import validate_pins, executable_path, SUPPORT
from verify_compiler_state import execute
import toolchain

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = r'''
/* Select original source's large-block allocator, not an instrumented build. */
#define __SANITIZE_ADDRESS__ 1
#include "quickjs.c"
#if JS_LIMB_BITS != 32
#error oracle requires 32-bit limbs
#endif
static size_t blocks;
static void *alloc(JSMallocState *s, size_t n) {
    void *p = js_def_malloc(s, n); if (p) blocks++; return p;
}
static void dealloc(JSMallocState *s, void *p) {
    if (p) blocks--; js_def_free(s, p);
}
static void *resize(JSMallocState *s, void *p, size_t n) {
    void *q = js_def_realloc(s, p, n);
    if (!p && q) blocks++;
    if (p && !n) blocks--;
    return q;
}
static void word(uint32_t n) { for (int i=0;i<4;i++) putchar((n>>(i*8))&255); }
static int refs(JSRuntime *rt, JSAtom atom) { return js_rc(rt->atom_array[atom])->ref_count; }
static int export_index(JSContext *ctx, JSModuleDef *m, JSAtom name) {
    JSExportEntry *e=find_export_entry(ctx,m,name); return e ? e-m->export_entries : -1;
}
int main(void) {
    const JSMallocFunctions mf={alloc,dealloc,resize,NULL};
    JSRuntime *rt=JS_NewRuntime2(&mf,NULL); if (!rt) return 2;
    JSContext *ctx=JS_NewContext(rt); if (!ctx) return 3;
    JSAtom name=JS_NewAtom(ctx,"module-oracle-name");
    JSValue text=JS_AtomToString(ctx,name);
    JSModuleDef *m=js_new_module_def(ctx,JS_DupAtom(ctx,name));
    JSModuleDef *middle=js_new_module_def(ctx,JS_ATOM_NULL);
    JSModuleDef *last=js_new_module_def(ctx,JS_ATOM_NULL);
    if (!m || !middle || !last) return 4;
    word(js_rc(m)->ref_count); word(refs(rt,name));
    word(ctx->loaded_modules.next==&m->link && ctx->loaded_modules.prev==&last->link);
    word(m->status); word(m->resolved); word(m->func_created); word(m->has_tla);
    word(m->dfs_index); word(m->dfs_ancestor_index); word(m->pending_async_dependencies);
    word(m->async_evaluation); word(m->async_evaluation_timestamp); word(m->eval_has_exception);
    word(m->init_func==NULL && m->stack_prev==NULL && m->cycle_root==NULL);
    word(JS_VALUE_GET_TAG(m->module_ns)); word(JS_VALUE_GET_TAG(m->func_obj));
    word(JS_VALUE_GET_TAG(m->promise)); word(JS_VALUE_GET_TAG(m->resolving_funcs[0]));
    word(JS_VALUE_GET_TAG(m->resolving_funcs[1])); word(JS_VALUE_GET_TAG(m->eval_exception));
    word(JS_VALUE_GET_TAG(m->meta_obj)); word(JS_VALUE_GET_TAG(m->private_value));
    const uint8_t source[]=""; GetLineColCache cache={0}; cache.buf_start=source; cache.ptr=source;
    JSFunctionDef *fd=js_new_function_def(ctx,NULL,FALSE,FALSE,"module-oracle",source,&cache);
    if (!fd) return 5;
    JSParseState parser={0}; parser.ctx=ctx; parser.cur_func=fd;
    for (int i=0;i<32;i++) {
        JSAtom exported=__JS_AtomFromUInt32(i);
        word(add_req_module_entry(ctx,m,name));
        JSExportEntry *e=add_export_entry2(ctx,NULL,m,name,exported,i&1?JS_EXPORT_TYPE_INDIRECT:JS_EXPORT_TYPE_LOCAL);
        if (!e) return 6;
        word(e-m->export_entries); word(add_star_export_entry(ctx,m,i));
        word(add_import(&parser,m,JS_ATOM_default,name,i&1));
        m->import_entries[i].req_module_idx=i;
        word(m->req_module_entries_count); word(m->req_module_entries_size);
        word(m->export_entries_count); word(m->export_entries_size);
        word(m->star_export_entries_count); word(m->star_export_entries_size);
        word(m->import_entries_count); word(m->import_entries_size);
        word(m->req_module_entries[i].module==NULL);
        word(JS_VALUE_GET_TAG(m->req_module_entries[i].attributes));
        word(e->export_type); word(e->u.req_module_idx);
        word(e->export_type!=JS_EXPORT_TYPE_LOCAL || e->u.local.var_ref==NULL);
        word(m->import_entries[i].var_idx); word(m->import_entries[i].is_star);
        word(m->import_entries[i].req_module_idx); word(m->star_export_entries[i].req_module_idx);
        word(refs(rt,name));
    }
    word(export_index(ctx,m,__JS_AtomFromUInt32(31))); word(export_index(ctx,m,name));
    word(add_export_entry2(ctx,NULL,m,JS_ATOM_NULL,__JS_AtomFromUInt32(31),JS_EXPORT_TYPE_LOCAL)==NULL);
    JSValue exception=JS_GetException(ctx); JS_FreeValue(ctx,exception);
    word(m->export_entries_count); word(m->export_entries_size); word(refs(rt,name));
    js_free_function_def(ctx,fd);
    JS_FreeValue(ctx,JS_MKPTR(JS_TAG_MODULE,middle));
    word(m->link.next==&last->link && last->link.prev==&m->link);
    JS_FreeValue(ctx,JS_MKPTR(JS_TAG_MODULE,last));
    word(ctx->loaded_modules.next==&m->link && ctx->loaded_modules.prev==&m->link);
    JSModuleDef *survivor=js_new_module_def(ctx,JS_ATOM_NULL);
    JSValue retained=JS_DupValue(ctx,JS_MKPTR(JS_TAG_MODULE,survivor));
    JS_FreeAtom(ctx,name); word(refs(rt,name));
    JS_FreeContext(ctx); JS_RunGC(rt);
    word(js_rc(survivor)->ref_count); word(survivor->link.next==NULL && survivor->link.prev==NULL);
    word(js_rc(JS_VALUE_GET_PTR(text))->ref_count);
    JS_FreeValueRT(rt,text); JS_FreeValueRT(rt,retained);
    JS_RunGC(rt); word(list_empty(&rt->gc_obj_list));
    JS_FreeRuntime(rt);
    if (blocks) return 7;
    return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.i32
import silk.num.i64
import silk.num.usize
import silk.core.option { Option }
import silk.mem.pointer { Pointer }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import runtime_memory { RuntimeAllocator }
import byte_buffer { ByteBuffer }
import js_heap { HeapCell, HeapHeader }
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringLengthError }
import js_core_types { RuntimeState, ContextState, ModuleDef, ModuleStatus, ExportBinding, ImportEntry, NativeFunctionId, WeakRefHeader }
import js_gc { HeapHooks, Tracer }
import js_gc
import js_runtime { allocateRuntimeStorage, allocateContextStorage }
import js_module_metadata { ExportKind, ModuleMetadataError, ModuleMetadataErrorKind }
import js_module_metadata as metadata
struct NoClassEdges {}
impl HeapHooks for NoClassEdges {
  unsafe fn traceClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->() { Intrinsic.trap("QuickJS invariant violated") }
  unsafe fn finalizeClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId)->() { Intrinsic.trap("QuickJS invariant violated") }
  unsafe effect fn sweepWeak(self:&mut Self,runtime:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator { Intrinsic.trap("QuickJS invariant violated") }
  unsafe fn destroyAuxiliary(self:&mut Self,runtime:*mut HeapHeader,node:*mut HeapHeader)->() { Intrinsic.trap("QuickJS invariant violated") }
}
effect fn word(out:&mut ByteBuffer,value:i32)->() ! OutOfMemoryError ? &mut Allocator {
  let mut bits=i32.toI64(value) if bits<0 { bits=bits+4294967296 }
  run out.writeU32(i64.toU32(bits))
}
fn flag(value:bool)->i32 { if value { return 1 } return 0 }
fn same(a:?*mut HeapHeader,b:?*mut HeapHeader)->bool { return Pointer.address<HeapHeader>(a)==Pointer.address<HeapHeader>(b) }
unsafe fn rc(node:*mut HeapHeader)->i32 { let anchor=() let header=unsafe Pointer.borrow<(),HeapHeader>(&anchor,node) return header.referenceCount }
unsafe fn textRc(value:ValueBits)->i32 { return match value { ValueBits.String { reference }=>unsafe rc(reference) _=>-1 } }
effect fn duplicate(error:ModuleMetadataError)->i32 { return flag(error.kind==ModuleMetadataErrorKind.DuplicateExport) }
effect fn probe()->() ! OutOfMemoryError | StringLengthError | ModuleMetadataError | WriterError ? &mut Allocator | &mut Writer {
  let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime)
  let mut anchor=() let mut ra=() let mut out=ByteBuffer.make()
  let initial=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)
  let name=run initial.atoms.internUtf8(b"module-oracle-name") let text=run initial.atoms.toValue(name,true)
  let owned=initial.atoms.duplicate(name) drop initial
  let node=run unsafe metadata.newModule(context,owned)
  let middle=run unsafe metadata.newModule(context,0) let last=run unsafe metadata.newModule(context,0)
  run word(&mut out,unsafe rc(node)) run word(&mut out,unsafe textRc(text))
  let ctx=unsafe HeapCell.payload<ContextState,()>(&anchor,context)
  run word(&mut out,flag(same(ctx.loadedModules.first,node) && same(ctx.loadedModules.last,last))) drop ctx
  let m=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut anchor,node)
  run word(&mut out,flag(m.status!=ModuleStatus.Unlinked))
  run word(&mut out,flag(m.resolved)) run word(&mut out,flag(m.functionCreated)) run word(&mut out,flag(m.hasTopLevelAwait))
  run word(&mut out,m.dfsIndex) run word(&mut out,m.dfsAncestorIndex) run word(&mut out,m.pendingAsyncDependencies)
  run word(&mut out,flag(m.asyncEvaluation)) run word(&mut out,i64.toI32(m.asyncEvaluationTimestamp)) run word(&mut out,flag(m.evaluationHasException))
  let init=match &m.initialize { Option<NativeFunctionId>.None=>true _=>false }
  run word(&mut out,flag(init && Pointer.isNull<HeapHeader>(m.stackPrevious) && Pointer.isNull<HeapHeader>(m.cycleRoot)))
  run word(&mut out,m.namespace.tag()) run word(&mut out,m.functionObject.tag()) run word(&mut out,m.promise.tag())
  run word(&mut out,m.resolvingFunctions[0].tag()) run word(&mut out,m.resolvingFunctions[1].tag())
  run word(&mut out,m.evaluationException.tag()) run word(&mut out,m.metaObject.tag()) run word(&mut out,m.privateValue.tag())
  let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)
  let mut i:usize=0
  while i<32 {
    let exported=0x80000000 | usize.toU32(i) let mut kind=ExportKind.Local if i%2!=0 { kind=ExportKind.Indirect }
    run word(&mut out,run metadata.addRequested(&mut m,&mut rt.atoms,name))
    run word(&mut out,run metadata.addExport(&mut m,&mut rt.atoms,name,exported,kind))
    run word(&mut out,run metadata.addStarExport(&mut m,usize.toI32(i)))
    run word(&mut out,run metadata.addImport(&mut m,&mut rt.atoms,ImportEntry { variableIndex:usize.toI32(i),isStar:i%2!=0,importName:name,requestedModuleIndex:usize.toI32(i) }))
    run word(&mut out,usize.toI32(m.requestedModules.length())) run word(&mut out,usize.toI32(m.requestedModules.capacity()))
    run word(&mut out,usize.toI32(m.exports.length())) run word(&mut out,usize.toI32(m.exports.capacity()))
    run word(&mut out,usize.toI32(m.starExports.length())) run word(&mut out,usize.toI32(m.starExports.capacity()))
    run word(&mut out,usize.toI32(m.imports.length())) run word(&mut out,usize.toI32(m.imports.capacity()))
    run word(&mut out,flag(Pointer.isNull<HeapHeader>(m.requestedModules.asSlice()[i].module)))
    run word(&mut out,m.requestedModules.asSlice()[i].attributes.tag())
    match m.exports.get(i).binding {
      ExportBinding.Local { variableIndex,varRef }=>{ run word(&mut out,0) run word(&mut out,variableIndex) run word(&mut out,flag(Pointer.isNull<HeapHeader>(varRef))) }
      ExportBinding.Indirect { requestedModuleIndex }=>{ run word(&mut out,1) run word(&mut out,requestedModuleIndex) run word(&mut out,1) }
    }
    run word(&mut out,m.imports.get(i).variableIndex) run word(&mut out,flag(m.imports.get(i).isStar))
    run word(&mut out,m.imports.get(i).requestedModuleIndex) run word(&mut out,m.starExports.get(i).requestedModuleIndex)
    run word(&mut out,unsafe textRc(text)) i=i+1
  }
  run word(&mut out,metadata.findExport(&m.*,0x8000001f)) run word(&mut out,metadata.findExport(&m.*,name))
  let rejected=run metadata.addExport(&mut m,&mut rt.atoms,0,0x8000001f,ExportKind.Local) |> Effect.catch<ModuleMetadataError>(duplicate)
  run word(&mut out,rejected) run word(&mut out,usize.toI32(m.exports.length())) run word(&mut out,usize.toI32(m.exports.capacity())) run word(&mut out,unsafe textRc(text))
  drop m drop rt
  let mut hooks=NoClassEdges {} unsafe js_gc.releaseHeader(&mut hooks,runtime,middle)
  let remaining=unsafe HeapCell.payload<ModuleDef,()>(&anchor,node) let l=unsafe HeapCell.payload<ModuleDef,()>(&anchor,last)
  run word(&mut out,flag(same(remaining.nextModule,last) && same(l.previousModule,node))) drop remaining drop l
  unsafe js_gc.releaseHeader(&mut hooks,runtime,last)
  let remainingContext=unsafe HeapCell.payload<ContextState,()>(&anchor,context)
  run word(&mut out,flag(same(remainingContext.loadedModules.first,node) && same(remainingContext.loadedModules.last,node))) drop remainingContext
  let survivor=run unsafe metadata.newModule(context,0) unsafe HeapCell.retain(survivor)
  let releaseRuntime=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime) releaseRuntime.atoms.release(name) drop releaseRuntime
  run word(&mut out,unsafe textRc(text)) unsafe js_gc.releaseHeader(&mut hooks,runtime,context)
  run unsafe js_gc.collect(&mut hooks,runtime,false)
  run word(&mut out,unsafe rc(survivor))
  let s=unsafe HeapCell.payload<ModuleDef,()>(&anchor,survivor)
  run word(&mut out,flag(Pointer.isNull<HeapHeader>(s.previousModule) && Pointer.isNull<HeapHeader>(s.nextModule))) drop s
  run word(&mut out,unsafe textRc(text)) Strings.release(text)
  unsafe js_gc.releaseHeader(&mut hooks,runtime,survivor) run unsafe js_gc.collect(&mut hooks,runtime,false)
  let finalRuntime=unsafe HeapCell.payload<RuntimeState,()>(&ra,runtime) run word(&mut out,flag(Pointer.isNull<HeapHeader>(finalRuntime.gcObjects.first))) drop finalRuntime
  run unsafe js_gc.destroyRuntime(&mut hooks,runtime) run Writer.writeAll(out.asSlice())
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | ModuleMetadataError | WriterError {
  let mut allocator=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  if allocator.stats().usedBytes!=0 || allocator.stats().allocationCount!=0 { return 7 }
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
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    with tempfile.TemporaryDirectory(prefix='silkjs-module-metadata-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="module-metadata-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4:
            raise SystemExit('C oracle did not return complete word records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                left, right = expected[offset:offset + 4], actual[offset:offset + 4]
                if left != right:
                    raise SystemExit(f'Module metadata word #{offset // 4}: C={left.hex()} Silk={right.hex()}; lengths {len(expected)}/{len(actual)}')
        print(f'PASS module metadata: {len(actual) // 4} original-C/native words, zero live payloads; {pins} pinned files; sha256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
