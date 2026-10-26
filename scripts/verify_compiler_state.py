#!/usr/bin/env python3
"""Execute matching helper sequences in original pinned C and native Silk.

No engine is linked into Silk. Covers scope growth/chains, argument lookup,
Annex B declarations, label liveness/reference counts, source-offset emission,
atom operands and transitive closure identity. Unit tests separately exercise
owned-value destruction and allocation failure. All outputs are temporary.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
from verify_bytecode import validate_pins, executable_path, SUPPORT
import toolchain

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = r'''
#include "quickjs.c"
#if JS_LIMB_BITS != 32
#error oracle requires 32-bit limbs
#endif
static void word(uint32_t v) { for (int i=0;i<4;i++) putchar((v>>(8*i))&255); }
int main(void) {
  JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt);
  if (!rt || !ctx) return 2;
  const uint8_t source[]="abcdefghijklmnopqrstuvwxyz";
  GetLineColCache cache={0}; cache.buf_start=source; cache.ptr=source;
  JSFunctionDef *fd=js_new_function_def(ctx,NULL,FALSE,FALSE,"probe",source+2,&cache);
  if (!fd) return 3;
  JSParseState s={0}; s.ctx=ctx; s.cur_func=fd; s.buf_start=source;
  word(add_arg(ctx,fd,JS_ATOM_name)); word(push_scope(&s)); fd->body_scope=fd->scope_level;
  word(define_var(&s,fd,JS_ATOM_length,JS_VAR_DEF_FUNCTION_DECL));
  word(define_var(&s,fd,JS_ATOM_length,JS_VAR_DEF_FUNCTION_DECL));
  for(int i=0;i<80;i++) {
    word(push_scope(&s)); word(add_scope_var(ctx,fd,JS_ATOM_value,JS_VAR_NORMAL));
    word(find_var_in_scope(ctx,fd,JS_ATOM_value,fd->scope_level));
    word(find_var(ctx,fd,JS_ATOM_name));
  }
  for(int i=0;i<80;i++) { pop_scope(&s); word(fd->scope_level); word(fd->scope_first); }
  int label=new_label(&s); word(label);
  word(emit_goto(&s,OP_if_false,label)); word(fd->label_slots[label].ref_count);
  emit_op(&s,OP_return_undef); word(emit_goto(&s,OP_goto,-1));
  emit_label_raw(&s,label); word(js_is_live_code(&s));
  word(emit_label(&s,label)); word(js_is_live_code(&s));
  word(update_label(fd,label,-1));
  emit_source_pos(&s,source+12); emit_source_pos(&s,source+12);
  emit_op(&s,OP_get_var); emit_atom(&s,JS_ATOM_name);
  word(fd->last_opcode_pos); word(fd->label_slots[label].pos);
  word(fd->byte_code.size); for(size_t i=0;i<fd->byte_code.size;i++) word(fd->byte_code.buf[i]);
  JSFunctionDef *child=js_new_function_def(ctx,fd,FALSE,FALSE,"probe",source+3,&cache);
  JSFunctionDef *grand=js_new_function_def(ctx,child,FALSE,FALSE,"probe",source+4,&cache);
  word(get_closure_var(ctx,grand,fd,JS_CLOSURE_LOCAL,0,JS_ATOM_length,FALSE,TRUE,JS_VAR_FUNCTION_DECL));
  word(get_closure_var(ctx,grand,fd,JS_CLOSURE_LOCAL,0,JS_ATOM_length,FALSE,TRUE,JS_VAR_FUNCTION_DECL));
  word(child->closure_var_count); word(grand->closure_var_count);
  word(child->closure_var[0].closure_type); word(grand->closure_var[0].closure_type);
  word(child->closure_var[0].var_idx); word(grand->closure_var[0].var_idx);
  js_free_function_def(ctx,child); word(list_empty(&fd->child_list));
  js_free_function_def(ctx,fd); JS_FreeContext(ctx); JS_FreeRuntime(rt);
  return 0;
}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.pointer { Pointer }
import silk.i32
import silk.i64
import silk.u8
import silk.u16
import silk.usize
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, VariableKind, ClosureKind, NativeFunctionId, WeakRefHeader }
import js_gc { HeapHooks, Tracer }
import js_gc
import js_runtime { allocateRuntimeStorage, allocateContextStorage }
import js_compiler_types { FunctionDef, CompilerError, VariableDefinition }
import js_compiler_state as state
import js_compiler_emit as emit
import js_opcode_data as op
import js_atom_data as atoms
import js_debug_positions { SourcePositionCache }
import js_string_types { StringLengthError }
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
fn closureKind(kind:ClosureKind)->i32 {
  return match kind { ClosureKind.Local=>0 ClosureKind.Argument=>1 ClosureKind.Reference=>2
    ClosureKind.GlobalReference=>3 ClosureKind.GlobalDeclaration=>4 ClosureKind.Global=>5
    ClosureKind.ModuleDeclaration=>6 ClosureKind.ModuleImport=>7 }
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | CompilerError | WriterError ? &mut Allocator | &mut Writer {
  let runtime=run allocateRuntimeStorage(0)
  let context=run unsafe allocateContextStorage(runtime)
  let root=run unsafe state.newFunction(context,Pointer.null<HeapHeader>(),false,false,0,2,Pointer.null<SourcePositionCache>())
  let mut out=ByteBuffer.make() let mut anchor=() let mut ra=()
  let fd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut anchor,root)
  let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)
  run word(&mut out,run state.addArg(&mut fd,&mut rt.atoms,atoms.JS_ATOM_name))
  run word(&mut out,run emit.pushScope(&mut fd)) fd.bodyScope=fd.scopeLevel
  run word(&mut out,run state.defineVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_length,VariableDefinition.FunctionDeclaration))
  run word(&mut out,run state.defineVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_length,VariableDefinition.FunctionDeclaration))
  let mut i:i32=0
  while i<80 {
    run word(&mut out,run emit.pushScope(&mut fd))
    run word(&mut out,run state.addScopeVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_value,VariableKind.Normal))
    run word(&mut out,state.findVarInScope(&fd.*,atoms.JS_ATOM_value,fd.scopeLevel))
    run word(&mut out,state.findVar(&fd.*,atoms.JS_ATOM_name)) i=i+1
  }
  i=0 while i<80 { run emit.popScope(&mut fd) run word(&mut out,fd.scopeLevel) run word(&mut out,fd.scopeFirst) i=i+1 }
  let label=run emit.newLabel(&mut fd) run word(&mut out,label)
  run word(&mut out,run emit.emitGoto(&mut fd,op.OP_if_false,label))
  run word(&mut out,fd.labels.get(0).referenceCount)
  run emit.emitOp(&mut fd,op.OP_return_undef) run word(&mut out,run emit.emitGoto(&mut fd,op.OP_goto,-1))
  run emit.emitLabelRaw(&mut fd,label) if emit.isLiveCode(&fd.*) { run word(&mut out,1) } else { run word(&mut out,0) }
  run word(&mut out,run emit.emitLabel(&mut fd,label))
  if emit.isLiveCode(&fd.*) { run word(&mut out,1) } else { run word(&mut out,0) }
  run word(&mut out,emit.updateLabel(&mut fd,label,-1))
  run emit.emitSourcePosition(&mut fd,12) run emit.emitSourcePosition(&mut fd,12)
  run emit.emitOp(&mut fd,op.OP_get_var) run emit.emitAtom(&mut fd,&mut rt.atoms,atoms.JS_ATOM_name)
  run word(&mut out,fd.lastOpcodePosition) run word(&mut out,fd.labels.get(0).position)
  run word(&mut out,usize.toI32(fd.bytecode.length()))
  let mut j:usize=0 while j<fd.bytecode.length() { run word(&mut out,u8.toI32(fd.bytecode.get(j))) j=j+1 }
  drop rt drop fd
  let child=run unsafe state.newFunction(context,root,false,false,0,3,Pointer.null<SourcePositionCache>())
  let grand=run unsafe state.newFunction(context,child,false,false,0,4,Pointer.null<SourcePositionCache>())
  run word(&mut out,run unsafe state.getClosureVar(grand,root,ClosureKind.Local,0,atoms.JS_ATOM_length,false,true,VariableKind.FunctionDeclaration))
  run word(&mut out,run unsafe state.getClosureVar(grand,root,ClosureKind.Local,0,atoms.JS_ATOM_length,false,true,VariableKind.FunctionDeclaration))
  let c=unsafe HeapCell.payload<FunctionDef,()>(&anchor,child)
  let g=unsafe HeapCell.payload<FunctionDef,()>(&anchor,grand)
  run word(&mut out,usize.toI32(c.closureVars.length())) run word(&mut out,usize.toI32(g.closureVars.length()))
  run word(&mut out,closureKind(c.closureVars.get(0).kind)) run word(&mut out,closureKind(g.closureVars.get(0).kind))
  run word(&mut out,u16.toI32(c.closureVars.get(0).variableIndex)) run word(&mut out,u16.toI32(g.closureVars.get(0).variableIndex))
  drop c drop g
  let mut hooks=NoClassEdges {} unsafe state.destroyFunction(&mut hooks,child)
  let r=unsafe HeapCell.payload<FunctionDef,()>(&anchor,root)
  if Pointer.isNull<HeapHeader>(r.firstChild) { run word(&mut out,1) } else { run word(&mut out,0) }
  drop r unsafe state.destroyFunction(&mut hooks,root)
  unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime)
  run Writer.writeAll(out.asSlice())
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | CompilerError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''

def execute(command, cwd=None, timeout=300):
    result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=timeout)
    if result.returncode:
        raise SystemExit(f'{command[0]} failed ({result.returncode}):\n{result.stderr.decode(errors="replace")}\n{result.stdout.decode(errors="replace")}')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    compiler = executable_path(args.silk)
    with tempfile.TemporaryDirectory(prefix='silkjs-compiler-state-') as directory:
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
        (temp / 'silk.toml').write_text(f'[package]\nname="compiler-state-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [compiler, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4:
            raise SystemExit('C oracle did not return complete word records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                left, right = expected[offset:offset+4], actual[offset:offset+4]
                if left != right:
                    raise SystemExit(f'Compiler helper word #{offset//4}: C={left.hex()} Silk={right.hex()}; lengths {len(expected)}/{len(actual)}')
        print(f'PASS compiler state: {len(actual)//4} original-C/native helper words; {pins} pinned files; sha256={hashlib.sha256(actual).hexdigest()}')

if __name__ == '__main__':
    main()
