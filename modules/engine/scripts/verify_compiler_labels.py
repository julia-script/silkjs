#!/usr/bin/env python3
"""Exact final compiler-pass differential oracle; no C is linked into Silk.

python3 scripts/verify_compiler_labels.py /tmp/silkjs-quickjs-reference-20261023

Runs the pinned original resolve_labels, including its original matcher and
skip_dead_code. Compares final bytes, PC2LINE, capture indices/counts, retained
atom references, source-position collector state and short-opcode mode. Label
widths are observed through exact signed branch operands, not a reimplementation
of branch resolution. Fixtures are post-variable-pass input (positions2 and
reference counts are assembled independently). Temporary package and C executable
are always removed. Mandatory boundary and rewrite families cannot be disabled.
"""
import argparse
from dataclasses import dataclass
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import process, executable_path, validate_pins, SUPPORT
import toolchain

ROOT = Path(__file__).resolve().parents[1]
SENTINEL = 0x7ffffffe
SOURCE = b'first line\nsecond line\nthird line\nfourth line\n'

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if !SHORT_OPCODES || JS_LIMB_BITS != 32
#error wrong oracle profile
#endif
static unsigned word(void) { unsigned n=0; for(int i=0;i<4;i++){int c=getchar();if(c<0)abort();n|=(unsigned)c<<(8*i);}return n; }
static void put32(unsigned n) { for(int i=0;i<4;i++)putchar((n>>(8*i))&255); }
static void blob(DynBuf *out,const uint8_t *p,size_t n){dbuf_put_u32(out,n);dbuf_put(out,p,n);}
static uint8_t *input(unsigned *n) { *n=word();uint8_t *base=malloc(*n+2);if(!base)abort();uint8_t *p=base+1;base[0]=0;if(fread(p,1,*n,stdin)!=*n)abort();p[*n]=0;return p; }
static int has_atom(int f) { return f==OP_FMT_atom||f==OP_FMT_atom_u8||f==OP_FMT_atom_u16||f==OP_FMT_atom_label_u8||f==OP_FMT_atom_label_u16; }
static void inventory(void) {
#define FMT(f)
#define DEF(id,size,pop,push,fmt) printf("op %s %d %d %s\n",#id,OP_##id,size,#fmt);
#define def(id,size,pop,push,fmt) DEF(id,size,pop,push,fmt)
#include "quickjs-opcode.h"
#undef FMT
#undef DEF
#undef def
#define ATOM(name) printf("atom %s %u\n",#name,JS_ATOM_##name)
ATOM(empty_string);ATOM(length);ATOM(undefined);ATOM(function);ATOM(name);
}
static void operate(JSContext *ctx,DynBuf *out) {
    JSFunctionDef s={0};s.ctx=ctx;
    unsigned flags=word();s.strip_debug=flags&1;s.has_simple_parameter_list=!!(flags&2);
    s.js_mode=(flags&4)?JS_MODE_STRICT:0;s.is_derived_class_constructor=!!(flags&8);
    s.home_object_var_idx=(int)word();s.this_active_func_var_idx=(int)word();
    s.new_target_var_idx=(int)word();s.this_var_idx=(int)word();s.arguments_var_idx=(int)word();
    s.arguments_arg_idx=(int)word();s.func_var_idx=(int)word();s.var_object_idx=(int)word();s.arg_var_object_idx=(int)word();
    s.arg_count=word();s.args=js_mallocz(ctx,sizeof(*s.args)*(s.arg_count+1));
    s.source_pos=word();unsigned source_n;uint8_t *source=input(&source_n);
    GetLineColCache cache={.ptr=source,.buf_start=source};s.get_line_col_cache=&cache;
    unsigned length;uint8_t *bytes=input(&length);js_dbuf_bytecode_init(ctx,&s.byte_code);dbuf_put(&s.byte_code,bytes,length);free(bytes-1);
    s.label_count=word();s.label_slots=js_mallocz(ctx,sizeof(*s.label_slots)*(s.label_count+1));
    for(int i=0;i<s.label_count;i++){s.label_slots[i].ref_count=word();s.label_slots[i].pos2=(int)word();s.label_slots[i].pos=s.label_slots[i].pos2;s.label_slots[i].addr=-1;}
    s.jump_size=word();s.line_number_size=word();
    JSAtom dynamic=JS_NewAtom(ctx,"compiler-owned-atom");
    for(unsigned pos=0;pos<length;){int code=s.byte_code.buf[pos];const JSOpCode *info=&opcode_info[code];
      if(has_atom(info->fmt)){JSAtom atom=get_u32(s.byte_code.buf+pos+1);if(atom==0x7ffffffe)atom=dynamic;put_u32(s.byte_code.buf+pos+1,JS_DupAtom(ctx,atom));}pos+=info->size;}
    if(resolve_labels(ctx,&s))abort();
    dbuf_put_u32(out,s.use_short_opcodes);dbuf_put_u32(out,s.var_ref_count);
    dbuf_put_u32(out,s.line_number_last);dbuf_put_u32(out,s.line_number_last_pc);
    dbuf_put_u32(out,js_rc(ctx->rt->atom_array[dynamic])->ref_count);
    for(int i=0;i<s.arg_count;i++){dbuf_put_u32(out,s.args[i].is_captured);dbuf_put_u32(out,s.args[i].var_ref_idx);}
    for(unsigned pos=0;pos<s.byte_code.size;){int code=s.byte_code.buf[pos];const JSOpCode *info=&short_opcode_info(code);
      if(has_atom(info->fmt)){JSAtom atom=get_u32(s.byte_code.buf+pos+1);JS_FreeAtom(ctx,atom);if(atom==dynamic)put_u32(s.byte_code.buf+pos+1,0x7ffffffe);}pos+=info->size;}
    blob(out,s.byte_code.buf,s.byte_code.size);blob(out,s.pc2line.buf,s.pc2line.size);
    JS_FreeAtom(ctx,dynamic);dbuf_free(&s.byte_code);dbuf_free(&s.pc2line);js_free(ctx,s.args);free(source-1);
}
int main(int argc,char **argv){if(argc==2){inventory();return 0;}JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);
unsigned count=word();put32(count);for(unsigned i=0;i<count;i++){DynBuf out;dbuf_init(&out);operate(ctx,&out);put32(out.size);fwrite(out.buf,1,out.size,stdout);dbuf_free(&out);fflush(stdout);}JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.mem.pointer { Pointer }
import silk.collections.slice { Slice }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.u32
import silk.num.u8
import silk.num.u16
import silk.num.i32
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_heap { HeapHeader, HeapCell }
import js_core_types { RuntimeState, NativeFunctionId, WeakRefHeader }
import js_string_types { StringLengthError, StringOwner, stringReference }
import js_gc { HeapHooks, Tracer }
import js_gc
import js_runtime { allocateRuntimeStorage, allocateContextStorage }
import js_compiler_state { newFunction, destroyFunction }
import js_compiler_types { FunctionDef, CompilerVar, LabelSlot }
import js_compiler_labels { resolveLabels }
import js_compiler_code { signedWord, unsignedWord }
import js_debug_positions { SourcePositionCache }
import js_opcode_data as op
struct NoClassEdges {}
impl HeapHooks for NoClassEdges {
  unsafe fn traceClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->(){Intrinsic.trap("QuickJS invariant violated")}
  unsafe fn finalizeClass(self:&mut Self,runtime:*mut HeapHeader,object:*mut HeapHeader,callback:NativeFunctionId)->(){Intrinsic.trap("QuickJS invariant violated")}
  unsafe effect fn sweepWeak(self:&mut Self,runtime:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator {Intrinsic.trap("QuickJS invariant violated")}
  unsafe fn destroyAuxiliary(self:&mut Self,runtime:*mut HeapHeader,node:*mut HeapHeader)->(){Intrinsic.trap("QuickJS invariant violated")}
}
struct Input { data:&'static [u8],at:usize }
impl Input {
  fn word(self:&mut Self)->u32{let value=readU32(self.data,self.at) self.at=self.at+4 return value}
  fn blob(self:&mut Self)->&'static [u8]{let size=u32.toUsize(self.word()) let data=Slice.view<u8>(self.data,self.at,size) self.at=self.at+size return data}
}
fn hasAtom(format:u8)->bool{return format==op.OP_FMT_atom||format==op.OP_FMT_atom_u8||format==op.OP_FMT_atom_u16||format==op.OP_FMT_atom_label_u8||format==op.OP_FMT_atom_label_u16}
fn flag(value:bool)->u32{if value{return 1}return 0}
effect fn blob(out:&mut ByteBuffer,bytes:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(usize.toU32(bytes.length)) run out.appendSlice(bytes)
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime)
 let cell=run unsafe newFunction(context,Pointer.null<HeapHeader>(),false,false,0,0,Pointer.null<SourcePositionCache>())
 let mut anchor=() let fd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut anchor,cell)
 let flags=input.word() fd.stripDebug=(flags&1)!=0 fd.hasSimpleParameterList=(flags&2)!=0 fd.isDerivedClassConstructor=(flags&8)!=0
 if (flags&4)!=0{fd.jsMode=1}
 fd.homeObjectVarIndex=signedWord(input.word()) fd.thisActiveFunctionVarIndex=signedWord(input.word())
 fd.newTargetVarIndex=signedWord(input.word()) fd.thisVarIndex=signedWord(input.word()) fd.argumentsVarIndex=signedWord(input.word())
 fd.argumentsArgIndex=signedWord(input.word()) fd.functionVarIndex=signedWord(input.word()) fd.varObjectIndex=signedWord(input.word()) fd.argVarObjectIndex=signedWord(input.word())
 let arguments=input.word() let mut i:u32=0
 while i<arguments{run fd.args.append(CompilerVar.make(0)) i=i+1}
 fd.sourcePosition=input.word() let source=input.blob() let bytes=input.blob() run fd.bytecode.appendSlice(bytes)
 let labels=input.word() i=0
 while i<labels{let references=signedWord(input.word()) let position=signedWord(input.word()) run fd.labels.append(LabelSlot{referenceCount:references,position:position,position2:position,address:-1,firstRelocation:-1}) i=i+1}
 fd.jumpCapacity=u32.toUsize(input.word()) fd.lineNumberCapacity=u32.toUsize(input.word())
 let mut runtimeAnchor=() let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut runtimeAnchor,runtime)
 let dynamic=run rt.atoms.internUtf8(b"compiler-owned-atom")
 let mut pos:usize=0
 while pos<fd.bytecode.length(){let info=op.opcodeInfo(fd.bytecode.get(pos),false)
   if hasAtom(info.format){let mut atom=readU32(fd.bytecode.asSlice(),pos+1) if atom==0x7ffffffe{atom=dynamic}let retained=rt.atoms.duplicate(atom) fd.bytecode.patchU32(pos+1,retained)} pos=pos+u8.toUsize(info.size)}
 drop rt drop fd
 run unsafe resolveLabels(cell,source)
 let mut finalAnchor=() let resolved=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut finalAnchor,cell)
 let mut atomAnchor=() let atomRuntime=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut atomAnchor,runtime)
 run out.writeU32(flag(resolved.useShortOpcodes)) run out.writeU32(unsignedWord(resolved.varRefCount))
 run out.writeU32(resolved.lineNumberLast) run out.writeU32(resolved.lineNumberLastPc)
 let value=StringOwner.adopt(run atomRuntime.atoms.toValue(dynamic,true))
 let reference=stringReference(value.get()) let countAnchor=() let header=unsafe Pointer.borrow<(),HeapHeader>(&countAnchor,reference)
 run out.writeU32(i32.toU32(header.referenceCount-1)) drop header drop value
 i=0 while i<arguments{let argument=resolved.args.get(u32.toUsize(i)) run out.writeU32(flag(argument.isCaptured)) run out.writeU32(u16.toU32(argument.varRefIndex)) i=i+1}
 // Normalize only atom operands in the serialized copy, retaining original ownership.
 let mut normalized=ByteBuffer.make() run normalized.appendSlice(resolved.bytecode.asSlice()) pos=0
 while pos<normalized.length(){let info=op.opcodeInfo(normalized.get(pos),true)
   if hasAtom(info.format)&&readU32(normalized.asSlice(),pos+1)==dynamic{normalized.patchU32(pos+1,0x7ffffffe)}pos=pos+u8.toUsize(info.size)}
 run blob(&mut out,normalized.asSlice()) run blob(&mut out,resolved.pc2line.asSlice())
 atomRuntime.atoms.release(dynamic) drop atomRuntime drop resolved
 let mut hooks=NoClassEdges{} unsafe destroyFunction(&mut hooks,cell) unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime)
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | WriterError ? &mut Allocator | &mut Writer {
 let mut input=Input{data:FIXTURE_DATA,at:0} let count=input.word()
 let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
 let mut out=ByteBuffer.make() let mut size=ByteBuffer.make() let mut i:u32=0
 while i<count{out.clear() size.clear() run operate(&mut input,&mut out) run size.writeU32(usize.toU32(out.length())) run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1}
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
 let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
 run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def word(value):
    return struct.pack('<I', value & 0xffffffff)


def blob(value):
    return word(len(value)) + value


@dataclass
class Case:
    label: str
    data: bytes


class Assembler:
    """Only assembles post-variable-pass input; never computes final expectations."""
    def __init__(self, opcodes):
        self.opcodes, self.code, self.labels, self.references = opcodes, bytearray(), {}, {}
        self.jumps = self.lines = 0

    def emit(self, name, *operands):
        number, size, fmt = self.opcodes[name]
        self.code.append(number)
        if fmt in ('label', 'atom_label_u8') and name != 'label':
            label = operands[0 if fmt == 'label' else 1]
            self.references[label] = self.references.get(label, 0) + 1
            self.jumps += 1
        if name == 'line_num':
            self.lines += 1
        widths = {'none': (), 'u8': (1,), 'loc8': (1,), 'u16': (2,), 'npop': (2,),
                  'loc': (2,), 'arg': (2,), 'var_ref': (2,), 'i32': (4,), 'u32': (4,),
                  'const': (4,), 'label': (4,), 'atom': (4,), 'atom_u8': (4, 1),
                  'atom_u16': (4, 2), 'atom_label_u8': (4, 4, 1)}[fmt]
        assert len(widths) == len(operands), (name, operands)
        for width, operand in zip(widths, operands):
            self.code.extend((operand & ((1 << (width * 8)) - 1)).to_bytes(width, 'little'))
        assert sum(widths) + 1 == size
        return self

    def mark(self, label):
        self.emit('label', label)
        self.labels[label] = len(self.code)
        return self

    def case(self, name, flags=0, indices=None, arguments=0, source_position=0):
        indices = [-1] * 9 if indices is None else indices
        count = max(self.labels, default=-1) + 1
        assert set(self.references) <= set(self.labels)
        metadata = b''.join(word(self.references.get(i, 0)) + word(self.labels[i]) for i in range(count))
        data = word(flags) + b''.join(map(word, indices)) + word(arguments) + word(source_position)
        data += blob(SOURCE) + blob(self.code) + word(count) + metadata + word(self.jumps) + word(self.lines)
        return Case(name, data)


def fixtures(opcodes, atoms):
    cases = []
    def add(name, instructions, **options):
        asm = Assembler(opcodes)
        for instruction in instructions:
            if instruction[0] == 'mark':
                asm.mark(instruction[1])
            else:
                asm.emit(*instruction)
        cases.append(asm.case(name, **options))
    for value in (-2147483648, -32769, -32768, -129, -128, -2, -1, 0, 1, 7, 8, 127, 128, 32767, 32768, 2147483647):
        for suffix in ([], [('neg',)], [('neg',), ('drop',)], [('drop',)]):
            add(f'int/{value}/{suffix}', [('push_i32', value), *suffix, ('return_undef',)])
        add(f'bigint/{value}', [('push_bigint_i32', value), ('neg',), ('return',)])
    for code in ('get_loc', 'get_arg', 'get_var_ref', 'put_loc', 'put_arg', 'put_var_ref', 'put_loc_check', 'call', 'call_method'):
        for index in (0, 3, 4, 255, 256, 65533):
            suffix = 'return' if code.startswith('call') else 'return_undef'
            add(f'short/{code}/{index}', [(code, index), (suffix,)])
    for code in ('push_const', 'fclosure'):
        for index in (0, 255, 256, 65536):
            add(f'pool/{code}/{index}', [(code, index), ('return',)])
    for atom in (SENTINEL, atoms['empty_string'], atoms['length']):
        for suffix in ([], [('drop',)]):
            add(f'atom/{atom}/{suffix}', [('push_atom_value', atom), *suffix, ('return_undef',)])
        add(f'field/{atom}', [('get_field', atom), ('return',)])
    for constant in [('null',), ('undefined',), ('push_false',), ('push_true',), ('push_i32', 0), ('push_i32', 1)]:
        for branch in ('if_true', 'if_false'):
            add(f'constant/{constant}/{branch}', [constant, (branch, 0), ('push_i32', 8), ('drop',), ('mark', 0), ('nop',), ('return_undef',)])
    for constant in ('null', 'undefined'):
        add(f'test/{constant}/eq', [(constant,), ('line_num', 12), ('strict_eq',), ('return',)])
        for branch in ('if_true', 'if_false'):
            add(f'test/{constant}/{branch}', [(constant,), ('strict_neq',), (branch, 0), ('nop',), ('mark', 0), ('nop',), ('return',)])
    for atom in (atoms['undefined'], atoms['function'], SENTINEL):
        for comparison in ('eq', 'neq', 'strict_eq', 'strict_neq'):
            for suffix in ([], [('if_false', 0), ('nop',), ('mark', 0)]):
                add(f'typeof/{atom}/{comparison}/{bool(suffix)}', [('typeof',), ('push_atom_value', atom), ('line_num', 13), (comparison,), *suffix, ('nop',), ('return',)])
    for store, load in [('put_loc', 'get_loc'), ('put_loc_check', 'get_loc_check'), ('put_arg', 'get_arg'), ('put_var_ref', 'get_var_ref')]:
        for index in (0, 4, 255, 256):
            for suffix in ([], [('drop',)], [('drop',), (load, index)]):
                add(f'dup/{store}/{index}/{suffix}', [('dup',), (store, index), ('line_num', 15), *suffix, ('return_undef',)])
            add(f'put-get/{store}/{index}', [(store, index), (load, index), ('return',)])
    for update in ('post_inc', 'post_dec', 'inc', 'dec'):
        for index in (0, 255, 256):
            middle = [] if update.startswith('post') else [('dup',)]
            add(f'local/{update}/{index}', [('get_loc', index), (update,), *middle, ('put_loc', index), ('drop',), ('return_undef',)])
    for operand in [('push_atom_value', SENTINEL), ('push_atom_value', atoms['empty_string']), ('push_i32', -129), ('get_loc', 5), ('get_arg', 5), ('get_var_ref', 5)]:
        add(f'add-local/{operand}', [('get_loc', 4), operand, ('add',), ('dup',), ('put_loc', 4), ('drop',), ('return_undef',)])
    for update in ('post_inc', 'post_dec'):
        for store, load in [('put_loc', 'get_loc'), ('put_arg', 'get_arg'), ('put_var_ref', 'get_var_ref')]:
            for suffix in ([], [(load, 5)]):
                add(f'post/{update}/{store}/{bool(suffix)}', [(update,), (store, 5), ('drop',), *suffix, ('return',)])
        add(f'post-field/{update}', [(update,), ('perm3',), ('put_field', SENTINEL), ('drop',), ('return_undef',)])
        add(f'post-array/{update}', [(update,), ('perm4',), ('put_array_el',), ('drop',), ('return_undef',)])
    add('insert-field', [('insert2',), ('put_field', SENTINEL), ('drop',), ('return_undef',)])
    for value in [('get_loc', 2), ('get_arg', 2), ('get_var_ref', 2), ('push_i32', 2), ('push_const', 2), ('push_atom_value', SENTINEL), ('undefined',), ('null',), ('push_true',), ('push_false',), ('object',)]:
        add(f'propkey/{value}', [('to_propkey',), value, ('put_array_el',), ('return_undef',)])
    add('dead-atom-and-branch', [('return_undef',), ('push_atom_value', SENTINEL), ('with_get_var', SENTINEL, 0, 1), ('line_num', 22), ('mark', 0), ('nop',)])
    add('drop-before-return', [('drop',), ('line_num', 12), ('drop',), ('return_undef',)])
    add('undefined-return', [('undefined',), ('return',), ('push_atom_value', SENTINEL), ('drop',)])
    add('conditional-invert', [('if_false', 0), ('line_num', 5), ('goto', 1), ('mark', 0), ('nop',), ('mark', 1), ('nop',), ('return_undef',)])
    add('threaded-return', [('goto', 0), ('mark', 0), ('goto', 1), ('mark', 1), ('return',)])
    add('cycle', [('mark', 0), ('goto', 1), ('mark', 1), ('goto', 0)])
    for branch in ('goto', 'if_false', 'if_true', 'gosub', 'catch'):
        for distance in (0, 1, 122, 123, 124, 125, 126, 127, 128, 129, 32762, 32763, 32764, 32767, 32768):
            # A referenced conditional target prevents goto dead-code removal of
            # the measured forward body. Nops prevent jump-to-return replacement.
            asm = Assembler(opcodes).emit('if_true', 1).emit(branch, 0).mark(1)
            for _ in range(distance):
                asm.emit('nop')
            asm.mark(0).emit('nop').emit('return_undef')
            cases.append(asm.case(f'forward/{branch}/{distance}'))
        for distance in (1, 125, 126, 127, 128, 129, 32765, 32766, 32767, 32768):
            asm = Assembler(opcodes).mark(0).emit('nop')
            for _ in range(distance):
                asm.emit('nop')
            asm.emit(branch, 0).emit('return_undef')
            cases.append(asm.case(f'backward/{branch}/{distance}'))
    for code in ('with_get_var', 'with_put_var', 'with_delete_var', 'with_make_ref', 'with_get_ref'):
        add(f'with/{code}', [(code, SENTINEL, 0, 1), ('if_false', 1), ('line_num', 22), ('nop',), ('mark', 0), ('nop',), ('mark', 1), ('return',)])
    # Raw source distances force the second shrink pass after compacting pushes;
    # both a later atom-label relocation and source PCs must move with the branch.
    asm = Assembler(opcodes).emit('if_true', 0).emit('with_get_var', SENTINEL, 1, 1)
    for i in range(30):
        asm.emit('line_num', i % len(SOURCE)).emit('push_i32', i % 7)
    asm.mark(0).emit('nop').mark(1).emit('return_undef')
    cases.append(asm.case('shrink-fixes-later-jump-and-source-pcs'))
    for flags in (0, 1, 2, 4, 6, 8, 10, 14):
        add(f'prelude/{flags}', [('line_num', 12), ('nop',), ('return_undef',)], flags=flags,
            indices=[0, 3, 4, 255, 256, 2, 257, 1, 5], arguments=3, source_position=2)
    add('source-sentinel', [('line_num', -1), ('nop',), ('line_num', 22), ('nop',), ('return_undef',)])
    return cases


def records(data, cases, owner):
    if len(data) < 4 or struct.unpack_from('<I', data)[0] != len(cases):
        raise SystemExit(f'{owner}: missing record header')
    result, at = [], 4
    for case in cases:
        if at + 4 > len(data):
            raise SystemExit(f'{owner}: missing {case.label}')
        size, = struct.unpack_from('<I', data, at)
        at += 4
        if at + size > len(data):
            raise SystemExit(f'{owner}: truncated {case.label}')
        result.append(data[at:at + size])
        at += size
    if at != len(data):
        raise SystemExit(f'{owner}: trailing bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    validate_pins(upstream)
    with tempfile.TemporaryDirectory(prefix='silkjs-labels-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                args.timeout, owner='Label C oracle compilation')
        inventory = process([str(temp / 'oracle'), '--inventory'], args.timeout, owner='Label opcode inventory')
        opcodes, atoms = {}, {}
        for row in inventory.decode().splitlines():
            fields = row.split()
            if fields[0] == 'op':
                _, name, number, size, fmt = fields
                opcodes[name] = int(number), int(size), fmt
            else:
                _, name, number = fields
                atoms[name] = int(number)
        cases = fixtures(opcodes, atoms)
        data = word(len(cases)) + b''.join(case.data for case in cases)
        expected = records(process([str(temp / 'oracle')], args.timeout, owner='Original resolve_labels', data=data, cases=cases), cases, 'C')
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="compiler-labels-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = records(process(command,
                                 args.timeout, owner='Native resolveLabels', cwd=temp, cases=cases), cases, 'Silk')
        mismatches = 0
        for case, reference, observed in zip(cases, expected, actual, strict=True):
            if reference != observed:
                mismatches += 1
                first = next((i for i, (a, b) in enumerate(zip(reference, observed)) if a != b), min(len(reference), len(observed)))
                print(f'MISMATCH {case.label}: byte {first}; C={reference[first:first+32].hex()} Silk={observed[first:first+32].hex()}; sizes {len(reference)}/{len(observed)}')
        if mismatches:
            raise SystemExit(f'{mismatches} label resolver mismatches')
        print(f'PASS: {len(cases)} exact independent label/peephole/short-opcode records')


if __name__ == '__main__':
    main()
