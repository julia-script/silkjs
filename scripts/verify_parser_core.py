#!/usr/bin/env python3
"""Compare native parser diagnostics with pinned QuickJS in separate executables."""
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
SOURCE = b'\n\xf0\x9f\x98\x80\r\nx\xe2\x80\xa8y'
ERRORS = 'SyntaxError | OutOfMemoryError | StringLengthError'
C_HEADER = r'''
#include "quickjs.c"
static void word(int32_t n) { uint32_t u=n; for(int i=0;i<4;i++) putchar((u>>(8*i))&255); }
static void record(JSContext *ctx) {
 JSValue e=JS_GetException(ctx), m=JS_GetPropertyStr(ctx,e,"message");
 if(!JS_IsString(m)) exit(8);
 JSString *s=JS_VALUE_GET_STRING(m); word(s->len);
 for(int i=0;i<s->len;i++) word(string_get(s,i));
 JSValue l=JS_GetPropertyStr(ctx,e,"lineNumber"), c=JS_GetPropertyStr(ctx,e,"columnNumber");
 int32_t line,column; if(JS_ToInt32(ctx,&line,l)||JS_ToInt32(ctx,&column,c)) exit(9);
 word(line); word(column);
 JS_FreeValue(ctx,l); JS_FreeValue(ctx,c); JS_FreeValue(ctx,m); JS_FreeValue(ctx,e);
}
'''
S_HEADER = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.pointer { Pointer }
import silk.usize
import silk.u16
import silk.i32
import silk.i64
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, NativeFunctionId, WeakRefHeader }
import js_compiler_state as state
import js_debug_positions { SourcePositionCache }
import js_runtime { allocateRuntimeStorage, allocateContextStorage }
import js_gc { HeapHooks, Tracer }
import js_gc
import js_parser_core { Parser }
import js_parser_diagnostics { SyntaxError }
import js_tokens { LexError }
import js_tokens as tok
import js_string_types { StringLengthError }
import js_strings { Strings }
import js_atom_data as atoms
struct Hooks {}
impl HeapHooks for Hooks {
 unsafe fn traceClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->() { Intrinsic.trap("QuickJS invariant violated") }
 unsafe fn finalizeClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId)->() { Intrinsic.trap("QuickJS invariant violated") }
 unsafe effect fn sweepWeak(self:&mut Self,runtime:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator { Intrinsic.trap("QuickJS invariant violated") }
 unsafe fn destroyAuxiliary(self:&mut Self,runtime:*mut HeapHeader,node:*mut HeapHeader)->() { Intrinsic.trap("QuickJS invariant violated") }
}
effect fn word(out:&mut ByteBuffer,n:i32)->() ! OutOfMemoryError ? &mut Allocator {
 let mut value=i32.toI64(n) if value<0 { value=value+4294967296 } run out.writeU32(i64.toU32(value))
}
effect fn record(out:&mut ByteBuffer,error:SyntaxError)->() ! OutOfMemoryError ? &mut Allocator {
 let value=error.message.get() run word(&mut out,usize.toI32(Strings.length(value)))
 let mut i:usize=0 while i<Strings.length(value) { run word(&mut out,u16.toI32(Strings.codeUnit(value,i))) i=i+1 }
 run word(&mut out,error.location.line) run word(&mut out,error.location.column)
}
'''

def byte_literal(data):
    return 'b"' + ''.join(f'\\x{x:02x}' for x in data) + '"'

def c_bytes(data):
    return ','.join(str(x) for x in data + b'\0')

def cases():
    rows = []
    for data in [b'', b'plain', b'quote\'"\\\n', b'a\0hidden', b'\xff', b'\xed\xa0\x80', b'\xf0\x9f\x98\x80']:
        rows.append(('text', data))
    for n in [1, 58, 63, 254, 255, 256, 600]:
        for ending in [b'z', b'\xc3\xa9', b'\xf0\x9f\x98\x80']:
            rows.append(('text', b'a' * n + ending))
    for char in [0, 1, 10, 39, 59, 127, 128, 255, -1, -128, 'TOK_TEMPLATE', 'TOK_WHILE']:
        rows.append(('char', char))
    for char in [0, 64, 128, 255]:
        rows.append(('lex', char))
    for atom in [0, 0x80000000, 0x80000001, 0xffffffff]:
        rows.append(('integer', atom))
    atoms = [[], [97], [97,0,98], [39,92,10], [0xe9], [0x100], [0xd800], [0xdc00], [0xd83d,0xde00], [97]*600]
    for n in [0, 1, 55, 56, 57, 58, 59, 60, 63, 255]:
        atoms += [[97]*n+[0xe9]*50, [97]*n+[0x100]*50, [0xd83d,0xde00]*n+[98]]
    rows += [('atom', units) for units in atoms]
    return [(kind, data, offset) for kind, data in rows for offset in [0, 2, 7, len(SOURCE)]]

def sources(rows):
    c = [C_HEADER, f'static const uint8_t input[]={{{c_bytes(SOURCE)}}};']
    s = [S_HEADER]
    for number, (kind, data, offset) in enumerate(rows):
        c_setup = s_setup = c_cleanup = s_cleanup = ''
        if kind == 'text':
            c_setup = f'const uint8_t text[]={{{c_bytes(data)}}};'
            c_call = 'js_parse_error_pos(&p,input+OFFSET,"%s",text);'
            s_call = f'parser.syntaxAt<()>(OFFSET,{byte_literal(data)})'
        elif kind == 'char':
            c_arg = str(data)
            s_arg = 'tok.' + data if isinstance(data, str) else str(data)
            c_call = f'js_parse_error_pos(&p,input+OFFSET,"expecting \'%c\'",{c_arg});'
            s_call = f'parser.expected<()>({s_arg})'
        elif kind == 'lex':
            c_call = f'js_parse_error_pos(&p,input+OFFSET,"Unexpected token \'%c\'",{data});'
            s_call = f'parser.lexicalError(LexError {{ offset:OFFSET,message:"Unexpected token \'%c\'",detail:{data} }})'
        else:
            if kind == 'atom':
                c_setup = f'const uint16_t units[]={{{",".join(str(x) for x in data) or "0"}}};\nJSValue text=js_new_string16_len(ctx,units,{len(data)});\nJSAtom atom=JS_NewAtomStr(ctx,JS_VALUE_GET_STRING(text));'
                s_setup = f'let units:[u16;{len(data)}]=[{",".join(str(x) for x in data)}]\nlet mut anchor=() let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,runtime)\nlet atom=run rt.atoms.internOwned(run Strings.fromUtf16(&units)) drop rt'
            else:
                c_setup = f'JSAtom atom={data}u;'
                s_setup = f'let atom:u32={data}'
            c_setup += '\nchar scratch[64];'
            c_call = 'js_parse_error_pos(&p,input+OFFSET,"\'%s\' is a reserved identifier",JS_AtomGetStr(ctx,scratch,sizeof(scratch),atom));'
            s_call = 'unsafe parser.syntaxAtom<()>(b"\'",atom,b"\' is a reserved identifier")'
            c_cleanup = 'JS_FreeAtom(ctx,atom);'
            s_cleanup = 'let mut endAnchor=() let endRt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut endAnchor,runtime) endRt.atoms.release(atom) drop endRt'
        c.append(f'''static void case_{number}(JSContext *ctx) {{
 JSParseState p; js_parse_init(ctx,&p,(const char *)input,sizeof(input)-1,"native-core.js");
 {c_setup}
 {c_call.replace('OFFSET', str(offset))}
 record(ctx); {c_cleanup}
}}''')
        s_record = f'''let outcome=run Effect.result({s_call.replace('OFFSET', str(offset))})
 match move outcome {{
  Result<(),{ERRORS}>.Success {{ value }}=>{{ run word(&mut out,-999) }}
  Result<(),{ERRORS}>.Failure {{ error }}=>{{ match move error {{
   SyntaxError e=>{{ run record(&mut out,move e) }}
   OutOfMemoryError e=>{{ fail move e }} StringLengthError e=>{{ fail move e }}
  }} }}
 }}'''
        if kind == 'lex':
            s_record = f'let error=run {s_call.replace("OFFSET", str(offset))}\nrun record(&mut out,move error)'
        s.append(f'''effect fn case{number}(out:&mut ByteBuffer,runtime:*mut HeapHeader,context:*mut HeapHeader)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {{
 let root=run unsafe state.newFunction(context,Pointer.null<HeapHeader>(),false,false,atoms.JS_ATOM_name,0,Pointer.null<SourcePositionCache>())
 let mut parser=run unsafe Parser.make({byte_literal(SOURCE)},root,false,true)
 parser.token.start={offset}
 {s_setup}
 {s_record}
 {s_cleanup}
 drop parser let mut hooks=Hooks {{}} unsafe state.destroyFunction(&mut hooks,root)
}}''')
    c += ['int main(void) { JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt); if(!ctx)return 2;', *(f'case_{i}(ctx);' for i in range(len(rows))), 'JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0; }']
    s += ['effect fn probe()->() ! OutOfMemoryError | StringLengthError | WriterError ? &mut Allocator | &mut Writer { let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime) let mut out=ByteBuffer.make()', *(f'run case{i}(&mut out,runtime,context)' for i in range(len(rows))), 'let mut hooks=Hooks {} unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime) run Writer.writeAll(out.asSlice()) }', '''pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
 let mut allocator=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let mut writer=StdoutWriter.make()
 run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
 if allocator.stats().usedBytes!=0 || allocator.stats().allocationCount!=0 { return 7 } return 0
}''']
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
    rows = cases()
    c_source, silk_source = sources(rows)
    with tempfile.TemporaryDirectory(prefix='silkjs-parser-core-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'), *(str(upstream / n) for n in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="parser-core-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib: command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4: raise SystemExit('invalid original-C diagnostic records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                if actual[offset:offset+4] != expected[offset:offset+4]:
                    raise SystemExit(f'diagnostic word {offset//4}: C={expected[offset:offset+4].hex()} Silk={actual[offset:offset+4].hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS parser diagnostics: {len(rows)} fixtures; {len(actual)//4} words; {pins} pins; sha256={hashlib.sha256(actual).hexdigest()}')

if __name__ == '__main__':
    main()
