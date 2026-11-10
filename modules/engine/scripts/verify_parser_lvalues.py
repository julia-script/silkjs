#!/usr/bin/env python3
"""Exact get/put-lvalue and inferred-name bytecode versus original QuickJS."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import validate_pins, executable_path, SUPPORT
from verify_compiler_state import execute
from verify_parser_core import C_HEADER, S_HEADER
import toolchain

ROOT = Path(__file__).resolve().parents[1]
ERRORS = 'OutOfMemoryError | StringLengthError | CompilerError'
C_DUMP = r'''
static void dump(JSFunctionDef *fd) {
 word(fd->last_opcode_pos); word(dbuf_error(&fd->byte_code)); word(fd->byte_code.size);
 for(int i=0;i<fd->byte_code.size;i++) word(fd->byte_code.buf[i]);
 word(fd->label_count); for(int i=0;i<fd->label_count;i++) { word(fd->label_slots[i].ref_count); word(fd->label_slots[i].pos); }
}
'''
S_DUMP = r'''
import silk.num.u8
import silk.num.u32
import js_core_types { VariableKind }
import js_compiler_types { FunctionDef, CompilerError }
import js_parser_lvalues { LValue, PutLValue }
import js_parser_lvalues as lv
import js_compiler_emit as emit
import js_opcode_data as op
fn special(n:i32)->PutLValue { return match n { 0=>PutLValue.NoKeep 1=>PutLValue.NoKeepDepth 2=>PutLValue.KeepTop 3=>PutLValue.KeepSecond _=>PutLValue.NoKeepBottom } }
effect fn dump(out:&mut ByteBuffer,cell:*mut HeapHeader)->() ! OutOfMemoryError ? &mut Allocator {
 let anchor=() let fd=unsafe HeapCell.payload<FunctionDef,()>(&anchor,cell)
 run word(&mut out,fd.lastOpcodePosition) let mut error:i32=0 if fd.bytecodeError { error=1 } run word(&mut out,error)
 run word(&mut out,usize.toI32(fd.bytecode.length())) let mut i:usize=0
 while i<fd.bytecode.length() { run word(&mut out,u8.toI32(fd.bytecode.get(i))) i=i+1 }
 run word(&mut out,usize.toI32(fd.labels.length())) i=0
 while i<fd.labels.length() { let label=fd.labels.get(i) run word(&mut out,label.referenceCount) run word(&mut out,label.position) i=i+1 }
}
'''

def fixtures():
    rows = []
    for opcode in ['scope_get_var','get_field','scope_get_private_field','get_array_el','get_super_value','call','call_method']:
        for with_scope in (range(3) if opcode == 'scope_get_var' else [0]):
            for keep in range(2):
                for special in range(5):
                    rows.append((opcode,'value',with_scope,keep,special,0,61,0))
    tokens = [61, 'TOK_FOR', 'TOK_INC', 'TOK_DEC', 91, 123, 'TOK_LAND_ASSIGN', 'TOK_LOR_ASSIGN', 'TOK_DOUBLE_QUESTION_MARK_ASSIGN']
    for opcode in ['scope_get_var','call','call_method','add']:
        for name in (['arguments','eval','this','new_target'] if opcode == 'scope_get_var' else ['value']):
            for strict in range(2):
                for token in tokens:
                    rows.append((opcode,name,0,0,0,strict,token,0))
    for lexical in range(2):
        for special in range(5):
            rows.append(('binding','value',0,0,special,0,61,lexical))
    for code in ['set_name','set_class_name','nop']:
        for computed in range(2):
            rows.append((code,'value',0,0,computed,0,61,0))
    return rows

def sources(rows):
    c = [C_HEADER, C_DUMP]
    s = [S_HEADER, S_DUMP]
    for index, (code, name, with_scope, keep, mode, strict, token, lexical) in enumerate(rows):
        c_init = f'fd->js_mode={strict};'
        s_init = f'let fd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut anchor,cell) fd.jsMode={strict}\nlet rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)'
        if with_scope:
            c_init += f'add_scope_var(ctx,{"root" if with_scope == 2 else "fd"},JS_ATOM__with_,JS_VAR_NORMAL);'
            s_init += f'\ndrop rt drop fd\nlet withCell={"root" if with_scope == 2 else "cell"}'
            s_init += '\nlet withFd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut anchor,withCell) let withRt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)\nlet wi=run state.addScopeVar(&mut withFd,&mut withRt.atoms,atoms.JS_ATOM__with_,VariableKind.Normal) drop withRt drop withFd'
            s_init += '\nlet outputFd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut anchor,cell) let outputRt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut ra,runtime)'
            fd_name, rt_name = 'outputFd', 'outputRt'
        else:
            fd_name, rt_name = 'fd', 'rt'
        if code == 'set_class_name':
            c_init += 'emit_op(&p,OP_define_class); emit_atom(&p,JS_ATOM_empty_string); emit_u8(&p,0); emit_op(&p,OP_set_class_name); emit_u32(&p,7);'
            s_init += f'\nrun emit.emitOp(&mut {fd_name},op.OP_define_class) run emit.emitAtom(&mut {fd_name},&mut {rt_name}.atoms,atoms.JS_ATOM_empty_string) run emit.emitU8(&mut {fd_name},0) run emit.emitOp(&mut {fd_name},op.OP_set_class_name) run emit.emitU32(&mut {fd_name},7)'
        elif code != 'binding':
            c_init += f'emit_op(&p,OP_{code});'
            s_init += f'\nrun emit.emitOp(&mut {fd_name},op.OP_{code})'
            if code in ['scope_get_var','get_field','scope_get_private_field','set_name']:
                operand = 'empty_string' if code == 'set_name' else name
                c_init += f'emit_atom(&p,JS_ATOM_{operand});'
                s_init += f' run emit.emitAtom(&mut {fd_name},&mut {rt_name}.atoms,atoms.JS_ATOM_{operand})'
            if code in ['scope_get_var','scope_get_private_field','call','call_method']:
                c_init += 'emit_u16(&p,0);'
                s_init += f' run emit.emitU16(&mut {fd_name},0)'
        s_init += f'\ndrop {rt_name} drop {fd_name}'
        if code in ['set_name','set_class_name','nop']:
            c_body = 'set_object_name_computed(&p);' if mode else f'set_object_name(&p,JS_ATOM_{name});'
            s_body = 'run unsafe lv.setObjectNameComputed(&mut parser)' if mode else f'run unsafe lv.setObjectName(&mut parser,atoms.JS_ATOM_{name})'
        elif code == 'binding':
            c_body = f'put_lvalue(&p,OP_scope_get_var,0,JS_DupAtom(ctx,JS_ATOM_{name}),-1,{mode},{lexical});'
            s_body = f'let binding=LValue.variable(runtime,atoms.JS_ATOM_{name},0)\nrun unsafe lv.putLValue(&mut parser,move binding,special({mode}),{str(bool(lexical)).lower()})'
        else:
            c_body = f'''int code,scope,label,depth; JSAtom name;
 int result=get_lvalue(&p,&code,&scope,&name,&label,&depth,{keep},{token}); word(result<0);
 if(result<0) record(ctx); else {{ word(code); word(scope); word(name); word(label); word(depth); put_lvalue(&p,code,scope,name,label,{mode},{lexical}); }}'''
            native_token = 'tok.' + token if isinstance(token, str) else str(token)
            s_body = f'''let outcome=run Effect.result(unsafe lv.getLValue(&mut parser,{str(bool(keep)).lower()},{native_token}))
 match move outcome {{
  Result<LValue,SyntaxError | OutOfMemoryError | StringLengthError>.Success {{ value }}=>{{
   run word(&mut out,0) run word(&mut out,u8.toI32(value.opcode)) run word(&mut out,value.scope)
   run word(&mut out,u32.toI32(value.name())) run word(&mut out,value.label) run word(&mut out,value.depth)
   run unsafe lv.putLValue(&mut parser,move value,special({mode}),{str(bool(lexical)).lower()})
  }}
  Result<LValue,SyntaxError | OutOfMemoryError | StringLengthError>.Failure {{ error }}=>{{ match move error {{
   SyntaxError e=>{{ run word(&mut out,1) run record(&mut out,move e) }}
   OutOfMemoryError e=>{{ fail move e }} StringLengthError e=>{{ fail move e }}
  }} }}
 }}'''
        c_child = 'JSFunctionDef *fd=root;'
        s_child = 'let cell=root'
        if with_scope == 2:
            c_child = 'JSFunctionDef *fd=js_new_function_def(ctx,root,FALSE,FALSE,"name",input,&cache);'
            s_child = 'let cell=run unsafe state.newFunction(context,root,false,false,atoms.JS_ATOM_name,0,Pointer.null<SourcePositionCache>())'
        c.append(f'''static void case_{index}(JSContext *ctx) {{
 const uint8_t input[]="name"; GetLineColCache cache={{0}}; cache.buf_start=input; cache.ptr=input;
 JSFunctionDef *root=js_new_function_def(ctx,NULL,FALSE,FALSE,"name",input,&cache);
 {c_child}
 JSParseState p; js_parse_init(ctx,&p,(const char *)input,4,"name"); p.cur_func=fd; p.token.ptr=input;
 {c_init}
 {c_body}
 dump(fd); js_free_function_def(ctx,root);
}}''')
        s.append(f'''effect fn case{index}(out:&mut ByteBuffer,runtime:*mut HeapHeader,context:*mut HeapHeader)->() ! {ERRORS} ? &mut Allocator {{
 let root=run unsafe state.newFunction(context,Pointer.null<HeapHeader>(),false,false,atoms.JS_ATOM_name,0,Pointer.null<SourcePositionCache>())
 {s_child}
 let mut parser=run unsafe Parser.make(b"name",cell,false,true)
 let mut anchor=() let mut ra=()
 {s_init}
 {s_body}
 run dump(&mut out,cell) drop parser let mut hooks=Hooks {{}} unsafe state.destroyFunction(&mut hooks,root)
}}''')
    c += ['int main(void) { JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt); if(!ctx)return 2;', *(f'case_{i}(ctx);' for i in range(len(rows))), 'JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0; }']
    s += [f'effect fn probe()->() ! {ERRORS} | WriterError ? &mut Allocator | &mut Writer {{ let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime) let mut out=ByteBuffer.make()', *(f'run case{i}(&mut out,runtime,context)' for i in range(len(rows))), 'let mut hooks=Hooks {} unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime) run Writer.writeAll(out.asSlice()) }', f'''pub effect fn main()->i32 ! {ERRORS} | WriterError {{
 let mut allocator=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let mut writer=StdoutWriter.make()
 run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
 if allocator.stats().usedBytes!=0 || allocator.stats().allocationCount!=0 {{ return 7 }} return 0
}}''']
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
    rows = fixtures()
    c_source, silk_source = sources(rows)
    with tempfile.TemporaryDirectory(prefix='silkjs-lvalues-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'), *(str(upstream / n) for n in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="lvalue-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib: command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4: raise SystemExit('invalid original-C lvalue records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                if actual[offset:offset+4] != expected[offset:offset+4]:
                    raise SystemExit(f'lvalue word {offset//4}: C={expected[offset:offset+4].hex()} Silk={actual[offset:offset+4].hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS lvalues: {len(rows)} fixtures; {len(actual)//4} words; {pins} pins; sha256={hashlib.sha256(actual).hexdigest()}')

if __name__ == '__main__':
    main()
