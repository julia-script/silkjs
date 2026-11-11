#!/usr/bin/env python3
"""Original-C/native js_create_function oracle using constructed parser IR.

No parser or VM is substituted: both executables call their production assembler.
Records cover recursive bytecode, captures, all flags, variable/closure metadata,
debug/source/PC2LINE, eval preparation, module/global closure preparation, atom
balance and realm ownership. Run explicitly; importing performs no checks.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import validate_pins, executable_path, SUPPORT
from verify_compiler_state import execute, SILK_SOURCE as STATE_SOURCE
from verify_compiler_variables import SILK_HELPERS
import toolchain

ROOT = Path(__file__).resolve().parents[1]
ERRORS = 'OutOfMemoryError | StringLengthError | CompilerError | BytecodeError'

C_HELPERS = r'''
#include <stdio.h>
#include "quickjs.c"
static void word(int32_t n) { uint32_t u=n; for(int i=0;i<4;i++) putchar((u>>(i*8))&255); }
static void dump(JSFunctionBytecode *b) {
 word(b->js_mode); word(b->has_prototype); word(b->has_simple_parameter_list);
 word(b->is_derived_class_constructor); word(b->need_home_object); word(b->func_kind);
 word(b->new_target_allowed); word(b->super_call_allowed); word(b->super_allowed);
 word(b->arguments_allowed); word(b->is_direct_or_indirect_eval); word(b->func_name);
 word(b->arg_count); word(b->var_count); word(b->defined_arg_count); word(b->var_ref_count); word(b->stack_size);
 word(b->byte_code_len); for(int i=0;i<b->byte_code_len;i++) word(b->byte_code_buf[i]);
 for(int i=0;i<b->arg_count+b->var_count;i++) {
  JSBytecodeVarDef *v=&b->vardefs[i]; word(v->var_name); word(v->scope_next);
  word(v->is_const); word(v->is_lexical); word(v->is_captured); word(v->has_scope); word(v->var_kind); word(v->var_ref_idx);
 }
 word(b->closure_var_count); for(int i=0;i<b->closure_var_count;i++) {
  JSClosureVar *v=&b->closure_var[i]; word(v->closure_type); word(v->var_idx); word(v->var_name);
  word(v->is_const); word(v->is_lexical); word(v->var_kind);
 }
 word(b->has_debug); if(b->has_debug) {
  word(b->debug.filename); word(b->debug.source!=NULL); word(b->debug.source_len);
  for(int i=0;i<b->debug.source_len;i++) word((uint8_t)b->debug.source[i]);
  word(b->debug.pc2line_len); for(int i=0;i<b->debug.pc2line_len;i++) word(b->debug.pc2line_buf[i]);
 }
 word(b->cpool_count); for(int i=0;i<b->cpool_count;i++) {
  JSValue v=b->cpool[i]; word(JS_VALUE_GET_TAG(v));
  if(JS_VALUE_GET_TAG(v)==JS_TAG_FUNCTION_BYTECODE) dump(JS_VALUE_GET_PTR(v));
  else if(JS_VALUE_GET_TAG(v)==JS_TAG_INT) word(JS_VALUE_GET_INT(v));
 }
}
static JSFunctionDef *make(JSContext *ctx,JSFunctionDef *parent,const uint8_t *source,GetLineColCache *cache,int strip,int eval,int parameters,int depth,int flavor) {
 JSFunctionDef *fd=js_new_function_def(ctx,parent,FALSE,FALSE,"name",source,cache);
 JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd;
 fd->strip_debug=strip==2; fd->strip_source=strip!=0;
 fd->has_eval_call=eval; fd->has_parameter_expressions=parameters;
 fd->has_this_binding=eval; fd->has_arguments_binding=eval; fd->has_home_object=eval;
 fd->is_derived_class_constructor=eval; fd->has_prototype=1; fd->has_simple_parameter_list=!parameters;
 fd->new_target_allowed=1; fd->super_call_allowed=eval; fd->super_allowed=1; fd->arguments_allowed=1;
 fd->func_kind=flavor%4; fd->js_mode=(flavor/4)%2; fd->eval_type=flavor%4;
 fd->func_name=JS_DupAtom(ctx,JS_ATOM_length);
 int arg=add_arg(ctx,fd,JS_ATOM_name); fd->defined_arg_count=1;
 int local=add_var(ctx,fd,JS_ATOM_value);
 if(!parent) add_var(ctx,fd,JS_ATOM_length);
 if(parameters) {
  fd->scope_level=-1; push_scope(&ps);
  fd->scope_level=0; fd->scope_first=fd->scopes[0].first;
  fd->body_scope=push_scope(&ps);
  int x=add_scope_var(ctx,fd,JS_ATOM_done,JS_VAR_NORMAL); fd->vars[x].is_lexical=1;
 }
 if(!fd->strip_source && !(flavor&4)) { fd->source=js_strdup(ctx,"native body"); fd->source_len=11; }
 cpool_add(&ps,JS_NewInt32(ctx,123));
 if(depth) {
  int idx=cpool_add(&ps,JS_UNDEFINED);
  JSFunctionDef *child=make(ctx,fd,source,cache,strip,eval,parameters,depth-1,flavor);
  child->parent_cpool_idx=idx;
  idx=cpool_add(&ps,JS_UNDEFINED);
  child=make(ctx,fd,source,cache,strip,0,0,0,flavor); child->parent_cpool_idx=idx;
 }
 if(parent) { emit_op(&ps,OP_scope_get_var); emit_atom(&ps,JS_ATOM_length); emit_u16(&ps,0); emit_op(&ps,OP_drop); }
 emit_op(&ps,OP_line_num); emit_u32(&ps,2);
 emit_op(&ps,OP_scope_get_var); emit_atom(&ps,JS_ATOM_value); emit_u16(&ps,0);
 emit_op(&ps,OP_return);
 return fd;
}
'''

S_HELPERS = r'''
import js_compiler_finish { createFunction }
import js_bytecode { BytecodeError }
fn functionKind(k:FunctionKind)->i32 { return match k { FunctionKind.Normal=>0 FunctionKind.Generator=>1 FunctionKind.Async=>2 FunctionKind.AsyncGenerator=>3 } }
fn ref(value:ValueBits)->*mut HeapHeader { return match value { ValueBits.FunctionBytecode { reference }=>reference _=>Intrinsic.trap("QuickJS invariant violated") } }
effect fn dumpFinal(out:&mut ByteBuffer,cell:*mut HeapHeader)->() ! OutOfMemoryError ? &mut Allocator {
 let a=() let b=unsafe HeapCell.payload<FunctionBytecode,()>(&a,cell)
 run word(&mut out,u8.toI32(b.mode)) run bit(&mut out,b.hasPrototype) run bit(&mut out,b.hasSimpleParameterList)
 run bit(&mut out,b.isDerivedClassConstructor) run bit(&mut out,b.needsHomeObject) run word(&mut out,functionKind(b.kind))
 run bit(&mut out,b.newTargetAllowed) run bit(&mut out,b.superCallAllowed) run bit(&mut out,b.superAllowed)
 run bit(&mut out,b.argumentsAllowed) run bit(&mut out,b.isDirectOrIndirectEval) run word(&mut out,u32.toI32(b.name))
 run word(&mut out,u16.toI32(b.argumentCount)) run word(&mut out,u16.toI32(b.variableCount)) run word(&mut out,u16.toI32(b.definedArgumentCount)) run word(&mut out,u16.toI32(b.varRefCount)) run word(&mut out,u16.toI32(b.stackSize))
 run word(&mut out,usize.toI32(b.code.length())) let mut i:usize=0
 while i<b.code.length() { run word(&mut out,u8.toI32(unsafe b.code.byte(i))) i=i+1 }
 i=0 while i<b.varDefs.length() { let v=b.varDefs.get(i)
  run word(&mut out,u32.toI32(v.name)) run word(&mut out,v.scopeNext) run bit(&mut out,v.isConst) run bit(&mut out,v.isLexical)
  run bit(&mut out,v.isCaptured) run bit(&mut out,v.hasScope) run word(&mut out,vk(v.kind)) run word(&mut out,u16.toI32(v.varRefIndex)) i=i+1
 }
 run word(&mut out,usize.toI32(b.closureVars.length())) i=0
 while i<b.closureVars.length() { let v=b.closureVars.get(i)
  run word(&mut out,closureKind(v.kind)) run word(&mut out,u16.toI32(v.variableIndex)) run word(&mut out,u32.toI32(v.name))
  run bit(&mut out,v.isConst) run bit(&mut out,v.isLexical) run word(&mut out,vk(v.variableKind)) i=i+1
 }
 match &b.debug {
  Option<FunctionDebugInfo>.None=>{ run word(&mut out,0) }
  Option<FunctionDebugInfo>.Some { value }=>{
   run word(&mut out,1) run word(&mut out,u32.toI32(value.filename))
   match &value.source {
    Option<ByteStorage>.None=>{ run word(&mut out,0) run word(&mut out,0) }
    Option<ByteStorage>.Some { value:text }=>{ run word(&mut out,1) run word(&mut out,usize.toI32(text.length())) i=0 while i<text.length() { run word(&mut out,u8.toI32(unsafe text.byte(i))) i=i+1 } }
   }
   run word(&mut out,usize.toI32(value.pcToLine.length())) i=0 while i<value.pcToLine.length() { run word(&mut out,u8.toI32(unsafe value.pcToLine.byte(i))) i=i+1 }
  }
 }
 run word(&mut out,usize.toI32(b.constants.length())) i=0
 while i<b.constants.length() { let v=b.constants.get(i) run word(&mut out,v.tag())
  match v { ValueBits.FunctionBytecode { reference }=>{ run dumpFinal(&mut out,reference) } ValueBits.Int { value }=>{ run word(&mut out,value) } _=>() } i=i+1
 }
}
effect fn make(runtime:*mut HeapHeader,context:*mut HeapHeader,parent:?*mut HeapHeader,strip:i32,eval:bool,parameters:bool,depth:i32,flavor:i32)->*mut HeapHeader ! OutOfMemoryError | StringLengthError | CompilerError ? &mut Allocator {
 let cell=run unsafe state.newFunction(context,parent,false,false,atoms.JS_ATOM_name,0,Pointer.null<SourcePositionCache>())
 let mut a=() let mut r=()
 let fd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
 fd.stripDebug=strip==2 fd.stripSource=strip!=0 fd.hasEvalCall=eval fd.hasParameterExpressions=parameters
 fd.hasThisBinding=eval fd.hasArgumentsBinding=eval fd.hasHomeObject=eval fd.isDerivedClassConstructor=eval
 fd.hasPrototype=true fd.hasSimpleParameterList=!parameters fd.newTargetAllowed=true fd.superCallAllowed=eval fd.superAllowed=true fd.argumentsAllowed=true
 fd.functionKind=match flavor%4 { 0=>FunctionKind.Normal 1=>FunctionKind.Generator 2=>FunctionKind.Async _=>FunctionKind.AsyncGenerator }
 fd.jsMode=i32.toU8((flavor/4)%2) fd.evalType=flavor%4 fd.functionName=rt.atoms.duplicate(atoms.JS_ATOM_length)
 let arg=run state.addArg(&mut fd,&mut rt.atoms,atoms.JS_ATOM_name) fd.definedArgCount=1
 let local=run state.addVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_value)
 if Pointer.isNull<HeapHeader>(parent) { let captured=run state.addVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_length) }
 if parameters {
  fd.scopeLevel=-1 let argScope=run emit.pushScope(&mut fd)
  fd.scopeLevel=0 fd.scopeFirst=fd.scopes.get(0).first
  let body=run emit.pushScope(&mut fd) fd.bodyScope=body
  let x=run state.addScopeVar(&mut fd,&mut rt.atoms,atoms.JS_ATOM_done,VariableKind.Normal)
  let mut v=fd.vars.get(i32.toUsize(x)) v.isLexical=true fd.vars.set(i32.toUsize(x),v)
 }
 if !fd.stripSource && (flavor&4)==0 { run fd.source.appendSlice(b"native body") }
 run fd.constants.append(ValueBits.Int { value:123 })
 if depth>0 { run fd.constants.append(ValueBits.Undefined) run fd.constants.append(ValueBits.Undefined) }
 drop rt drop fd
 if depth>0 {
  let child=run make(runtime,context,cell,strip,eval,parameters,depth-1,flavor)
  let nested=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,child) nested.parentConstantPoolIndex=1 drop nested
  let sibling=run make(runtime,context,cell,strip,false,false,0,flavor)
  let second=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,sibling) second.parentConstantPoolIndex=2 drop second
 }
 let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let table=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
 if !Pointer.isNull<HeapHeader>(parent) { run emit.emitOp(&mut target,op.OP_scope_get_var) run emit.emitAtom(&mut target,&mut table.atoms,atoms.JS_ATOM_length) run emit.emitU16(&mut target,0) run emit.emitOp(&mut target,op.OP_drop) }
 run emit.emitOp(&mut target,op.OP_line_num) run emit.emitU32(&mut target,2)
 run emit.emitOp(&mut target,op.OP_scope_get_var) run emit.emitAtom(&mut target,&mut table.atoms,atoms.JS_ATOM_value) run emit.emitU16(&mut target,0) run emit.emitOp(&mut target,op.OP_return)
 return cell
}
'''


def fixtures():
    cases = []
    for strip in range(3):
        for eval_call in range(2):
            for parameters in range(2):
                for depth in range(3):
                    for flavor in range(8):
                        cases.append((strip, eval_call, parameters, depth, flavor, 0))
        for mode in range(1, 6):
            cases.append((strip, 0, 0, 2, 0, mode))
    return cases


def sources(cases):
    # Only scaffolding/enum serialization is shared with prior harnesses; the C
    # production algorithm is the sole expectation for every output record.
    s = [STATE_SOURCE.split('effect fn probe()')[0],
         SILK_HELPERS.split('fn makeSnapshot')[0],
         SILK_HELPERS[SILK_HELPERS.index('fn vk('):SILK_HELPERS.index('effect fn dump(')], S_HELPERS]
    c = [C_HELPERS]
    for number, (strip, ev, params, depth, flavor, mode) in enumerate(cases):
        c_extra, s_extra = '', ''
        if mode:
            c_extra = f'''fd->is_eval=1; fd->eval_type={(mode-1)%4};
JSGlobalVar *g=add_global_var(ctx,fd,JS_ATOM_done); g->is_lexical=1; g->is_const=1;'''
            s_extra = f'''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
target.isEval=true target.evalType={(mode-1)%4}
let gi=run state.addGlobalVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_done)
let mut g=target.globalVars.get(i32.toUsize(gi)) g.isLexical=true g.isConst=true target.globalVars.set(i32.toUsize(gi),g)
drop rt drop target'''
        if mode == 5:
            c_extra += '''
module=js_mallocz(ctx,sizeof(*module)); fd->module=module; fd->eval_type=1;
add_closure_var(ctx,fd,JS_CLOSURE_MODULE_IMPORT,0,JS_ATOM_next,TRUE,TRUE,JS_VAR_NORMAL);'''
            s_extra += '''
module=run makeModule()
let targetModule=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let moduleRt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
targetModule.module=module targetModule.evalType=1
let imported=run state.addClosureVar(&mut targetModule,&mut moduleRt.atoms,ClosureKind.ModuleImport,0,atoms.JS_ATOM_next,true,true,VariableKind.Normal)
drop moduleRt drop targetModule'''
        c.append(f'''static void case_{number}(JSContext *ctx) {{
int baseline=ctx->rt->atom_count,refs=js_rc(ctx)->ref_count;
const uint8_t source[]="a\\nb"; GetLineColCache cache={{0}}; cache.buf_start=source; cache.ptr=source;
JSFunctionDef *fd=make(ctx,NULL,source,&cache,{strip},{ev},{params},{depth},{flavor}); JSModuleDef *module=NULL;
{c_extra}
JSValue value=js_create_function(ctx,fd); if(JS_IsException(value)) {{ js_std_dump_error(ctx); exit(3); }}
word({number}); word(JS_VALUE_GET_TAG(value)); dump(JS_VALUE_GET_PTR(value)); word(js_rc(ctx)->ref_count-refs);
JS_FreeValue(ctx,value); if(module) js_free(ctx,module); word(js_rc(ctx)->ref_count-refs); word(ctx->rt->atom_count-baseline);
}}'''.replace('js_std_dump_error(ctx); ', ''))
        s.append(f'''effect fn case{number}(out:&mut ByteBuffer,runtime:*mut HeapHeader,context:*mut HeapHeader)->() ! {ERRORS} ? &mut Allocator {{
let mut a=() let mut r=() let before=unsafe HeapCell.payload<RuntimeState,()>(&a,runtime) let baseline=before.atoms.count() drop before
let header=unsafe Pointer.borrow<(),HeapHeader>(&a,context) let refs=header.referenceCount drop header
let cell=run make(runtime,context,Pointer.null<HeapHeader>(),{strip},{str(bool(ev)).lower()},{str(bool(params)).lower()},{depth},{flavor})
let mut module=Pointer.null<HeapHeader>()
{s_extra}
let mut hooks=NoClassEdges {{}} let value=run unsafe createFunction(&mut hooks,cell,b"a\\nb")
run word(&mut out,{number}) run word(&mut out,value.tag()) run dumpFinal(&mut out,ref(value))
let retained=unsafe Pointer.borrow<(),HeapHeader>(&a,context) run word(&mut out,retained.referenceCount-refs) drop retained
unsafe js_gc.release(&mut hooks,runtime,value)
if !Pointer.isNull<HeapHeader>(module) {{ unsafe HeapCell.destroy<ModuleDef>(unsafe Intrinsic.pointerRequalify<?*mut HeapHeader,*mut HeapHeader>(module)) }}
let after=unsafe Pointer.borrow<(),HeapHeader>(&a,context) run word(&mut out,after.referenceCount-refs) drop after
let remaining=unsafe HeapCell.payload<RuntimeState,()>(&a,runtime) run word(&mut out,usize.toI32(remaining.atoms.count())-usize.toI32(baseline))
}}''')
    c += ['int main(void) { JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt); if(!ctx) return 2;',
          *(f'case_{i}(ctx);' for i in range(len(cases))), 'JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0; }']
    s += [f'effect fn probe()->() ! {ERRORS} | WriterError ? &mut Allocator | &mut Writer {{ let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime) let mut out=ByteBuffer.make()',
          *(f'run case{i}(&mut out,runtime,context)' for i in range(len(cases))),
          'let mut hooks=NoClassEdges {} unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime) run Writer.writeAll(out.asSlice()) }',
          STATE_SOURCE[STATE_SOURCE.index('pub effect fn main()'):].replace('CompilerError | WriterError', 'CompilerError | BytecodeError | WriterError')]
    return '\n'.join(c), '\n'.join(s)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    cases = fixtures()
    c_source, silk_source = sources(cases)
    with tempfile.TemporaryDirectory(prefix='silkjs-compiler-finish-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="compiler-finish-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib: command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4: raise SystemExit('invalid original-C records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                if actual[offset:offset+4] != expected[offset:offset+4]:
                    raise SystemExit(f'assembly record {offset//4}: C={expected[offset:offset+4].hex()} Silk={actual[offset:offset+4].hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS finish: {len(cases)} fixtures; {len(actual)//4} words; {pins} pins; sha256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
