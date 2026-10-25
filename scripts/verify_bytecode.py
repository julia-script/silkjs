#!/usr/bin/env python3
"""Differentially verify native bytecode/debug helpers against pinned QuickJS.

Usage: python3 scripts/verify_bytecode.py QUICKJS [--silk COMPILER] [--stdlib SDK]

The independent C executable includes the original static algorithms unchanged:
compute_stack_size/ss_check, bc_byte_swap, get_line_col_cached,
add_pc2line_info/compute_pc2line_info/find_line_num and the LEB128 helpers.
It is never linked into the native executable. The C opcode inventory constructs
inputs only; all expected semantic results come from executing those algorithms,
not from the generated native metadata or a Python reimplementation.

All final opcodes (including invalid encodings for stack analysis), all operand
formats inhabited by final bytecode, both endian directions, stack/control-flow
errors and limits, cache histories, every compact PC2LINE opcode, and malformed
and noncanonical LEB inputs are mandatory. Temporary parser formats have no valid
final-bytecode encoding and are reported separately, not passed to APIs whose
preconditions exclude them. Empty stack input uses original ss_check directly:
compute_stack_size explicitly requires a nonempty buffer and may malloc(0).

C exceptions are normalized to their exposed category, PC, opcode, and join
operands. Native-only error details have no C counterpart and are not claimed as
independently verified. No error is accepted merely because both sides failed.
Coordinates and signed fields are compared as exact 32-bit representations.
Every temporary file is cleaned, including on compilation, timeout, or mismatch.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
from pathlib import Path, PurePosixPath
import random
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib
import toolchain

ROOT = Path(__file__).resolve().parents[1]
REVISION = '7d1c13c5d8f8c6b32893786ed35cdcebd88194d2'
SUPPORT = ('cutils.c', 'dtoa.c', 'libregexp.c', 'libunicode.c')
OPERATIONS = ('stack', 'endian', 'coordinates', 'collect', 'encode', 'decode', 'leb-write', 'leb-read')

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || !SHORT_OPCODES
#error The oracle requires the pinned 32-bit-limb short-opcode profile
#endif
static const char *probe_opcode_names[] = {
#define DEF(id, size, n_pop, n_push, f) #id,
#define def(id, size, n_pop, n_push, f)
#include "quickjs-opcode.h"
};
static const char *probe_format_names[] = {
#define FMT(f) #f,
#include "quickjs-opcode.h"
};
static unsigned fixture;
static DynBuf output;
static void die(const char *message) {
    fprintf(stderr, "bytecode C oracle fixture %u: %s\n", fixture, message);
    exit(1);
}
static void *allocate(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) die("adapter allocation failed");
    return p;
}
static unsigned byte(void) {
    int c = getchar();
    if (c == EOF) die("truncated fixture input");
    return c;
}
static uint32_t word(void) {
    uint32_t n = 0;
    for (unsigned i = 0; i < 4; i++) n |= (uint32_t)byte() << (8 * i);
    return n;
}
static uint8_t *blob(unsigned *length) {
    *length = word();
    /* A real preceding byte keeps the upstream backwards cache scan's
       ptr-1 within the allocation, even when the query offset is zero. */
    uint8_t *base = allocate((size_t)*length + 2), *data = base + 1;
    base[0] = 0; data[*length] = 0;
    if (fread(data, 1, *length, stdin) != *length) die("truncated blob");
    return data;
}
static void put32(uint32_t n) {
    for (unsigned i = 0; i < 4; i++) putchar((n >> (i * 8)) & 255);
}
static void emit(uint32_t n) { dbuf_put_u32(&output, n); }
static void emit_blob(const uint8_t *data, size_t size) {
    emit(size);
    for (size_t i = 0; i < size; i++) emit(data[i]);
}
static void stack_result(JSContext *ctx, uint8_t *code, unsigned size) {
    JSFunctionDef fd = {0};
    fd.byte_code.buf = code; fd.byte_code.size = size;
    int maximum = 0, result;
    if (size) result = compute_stack_size(ctx, &fd, &maximum);
    else {
        StackSizeState state = {0};
        result = ss_check(ctx, &state, 0, OP_invalid, 0, -1);
    }
    if (result == 0) {
        emit(0); emit(maximum); emit(0); emit(0); emit(0); emit(0);
        return;
    }
    JSValue exception = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, exception);
    const char *p;
    int kind = 0, pc = 0, op = 0, expected = 0, actual = 0;
    if (!text) die("exception conversion failed");
    if ((p = strstr(text, "bytecode buffer overflow ("))) {
        kind = 1;
        if (sscanf(p, "bytecode buffer overflow (op=%d, pc=%d)", &op, &pc) != 2) die(text);
    } else if ((p = strstr(text, "invalid opcode ("))) {
        kind = 2;
        if (sscanf(p, "invalid opcode (op=%d, pc=%d)", &op, &pc) != 2) die(text);
    } else if ((p = strstr(text, "stack underflow ("))) {
        kind = 3;
        if (sscanf(p, "stack underflow (op=%d, pc=%d)", &op, &pc) != 2) die(text);
    } else if ((p = strstr(text, "stack overflow ("))) {
        kind = 4;
        if (sscanf(p, "stack overflow (op=%d, pc=%d)", &op, &pc) != 2) die(text);
    } else if ((p = strstr(text, "inconsistent stack size: "))) {
        kind = 5;
        if (sscanf(p, "inconsistent stack size: %d %d (pc=%d)", &expected, &actual, &pc) != 3) die(text);
    } else if ((p = strstr(text, "inconsistent catch position: "))) {
        kind = 6;
        if (sscanf(p, "inconsistent catch position: %d %d (pc=%d)", &expected, &actual, &pc) != 3) die(text);
    } else if ((p = strstr(text, "nip_catch: no catch op ("))) {
        kind = 7;
        if (sscanf(p, "nip_catch: no catch op (pc=%d)", &pc) != 1) die(text);
    } else die(text); /* OOM and unexpected exceptions must not become a semantic failure. */
    emit(kind); emit(0); emit(pc); emit(op); emit(expected); emit(actual);
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, exception);
}
static void locations(JSContext *ctx, const uint8_t *data, unsigned size) {
    JSFunctionBytecode function = {0};
    function.has_debug = TRUE;
    function.debug.pc2line_buf = (uint8_t *)data;
    function.debug.pc2line_len = size;
    unsigned count = word();
    for (unsigned i = 0; i < count; i++) {
        int column;
        int line = find_line_num(ctx, &function, word(), &column);
        emit(line); emit(column);
    }
}
static void operate(JSContext *ctx) {
    unsigned op = byte(), size;
    uint8_t *data = blob(&size);
    if (op == 0) stack_result(ctx, data, size);
    else if (op == 1) {
        bc_byte_swap(data, size);
        for (unsigned i = 0; i < size; i++) emit(data[i]);
        bc_byte_swap(data, size);
        for (unsigned i = 0; i < size; i++) emit(data[i]);
    } else if (op == 2) {
        GetLineColCache cache = { .ptr = data, .buf_start = data };
        unsigned count = word();
        for (unsigned i = 0; i < count; i++) {
            unsigned offset = word(); int column;
            if (offset > size) die("out-of-bounds coordinate fixture");
            int line = get_line_col_cached(&cache, &column, data + offset);
            emit(line); emit(column);
        }
    } else if (op == 3 || op == 4) {
        JSFunctionDef fd = {0};
        GetLineColCache cache = { .ptr = data, .buf_start = data };
        fd.ctx = ctx; fd.get_line_col_cache = &cache;
        fd.source_pos = word(); fd.line_number_last = fd.source_pos;
        unsigned capacity = word(), count = word();
        fd.line_number_size = capacity;
        fd.line_number_slots = allocate((size_t)(capacity ? capacity : 1) * sizeof(LineNumberSlot));
        if (op == 3) {
            for (unsigned i = 0; i < count; i++) {
                unsigned pc = word(), source = word();
                int before = fd.line_number_count;
                add_pc2line_info(&fd, pc, source);
                emit(fd.line_number_count != before);
            }
            emit(fd.line_number_count);
            for (int i = 0; i < fd.line_number_count; i++) {
                emit(fd.line_number_slots[i].pc); emit(fd.line_number_slots[i].source_pos);
            }
        } else {
            if (capacity != count) die("invalid encoding fixture capacity");
            fd.line_number_count = count;
            for (unsigned i = 0; i < count; i++) {
                fd.line_number_slots[i].pc = word();
                unsigned source = word();
                if (source != UINT32_MAX && source > size) die("invalid source offset");
                fd.line_number_slots[i].source_pos = source;
            }
            compute_pc2line_info(&fd);
            if (dbuf_error(&fd.pc2line)) die("PC2LINE allocation failed");
            emit_blob(fd.pc2line.buf, fd.pc2line.size);
            locations(ctx, fd.pc2line.buf, fd.pc2line.size);
            dbuf_free(&fd.pc2line);
        }
        free(fd.line_number_slots);
    } else if (op == 5) locations(ctx, data, size);
    else if (op == 6) {
        uint32_t value = word();
        DynBuf buffer; dbuf_init(&buffer);
        dbuf_put_leb128(&buffer, value);
        if (dbuf_error(&buffer)) die("LEB allocation failed");
        emit_blob(buffer.buf, buffer.size); dbuf_free(&buffer);
        dbuf_init(&buffer); dbuf_put_sleb128(&buffer, (int32_t)value);
        if (dbuf_error(&buffer)) die("signed LEB allocation failed");
        emit_blob(buffer.buf, buffer.size); dbuf_free(&buffer);
    } else if (op == 7) {
        unsigned start = word();
        if (start > size) die("invalid LEB cursor");
        uint32_t value; int32_t signed_value;
        int n = get_leb128(&value, data + start, data + size);
        emit(n >= 0); emit(value); emit(n >= 0 ? start + n : start);
        n = get_sleb128(&signed_value, data + start, data + size);
        emit(n >= 0); emit(signed_value); emit(n >= 0 ? start + n : start);
    } else die("unknown fixture operation");
    free(data - 1);
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--inventory")) {
        for (unsigned i = 0; i < countof(probe_format_names); i++)
            printf("format %s\n", probe_format_names[i]);
        for (int op = 0; op < OP_COUNT; op++) {
            const JSOpCode *info = &short_opcode_info(op);
            printf("opcode %d %s %d %d %d %s\n", op, probe_opcode_names[op],
                   info->size, info->n_pop, info->n_push, probe_format_names[info->fmt]);
        }
        return 0;
    }
    if (argc != 1) die("unknown command line");
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = runtime ? JS_NewContext(runtime) : NULL;
    if (!ctx) die("runtime allocation failed");
    unsigned count = word(); put32(count);
    dbuf_init(&output);
    for (fixture = 0; fixture < count; fixture++) {
        output.size = 0; operate(ctx);
        if (dbuf_error(&output)) die("output allocation failed");
        put32(output.size);
        if (fwrite(output.buf, 1, output.size, stdout) != output.size) die("output failed");
        fflush(stdout);
    }
    if (getchar() != EOF) die("trailing fixture input");
    dbuf_free(&output); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    return 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.list { List }
import silk.slice { Slice }
import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.u8
import silk.u16
import silk.u32
import silk.i32
import silk.i64
import silk.usize
import byte_buffer { ByteBuffer, readU32 }
import js_bytecode { computeStackSize, swapBytecodeEndian, BytecodeError, BytecodeErrorKind }
import js_debug_positions { SourcePositionCache, PcSourcePositions, PcSourcePosition,
  encodePc2Line, decodePc2Line, readLeb128, readSignedLeb128, writeLeb128, writeSignedLeb128 }
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn byte(self:&mut Self)->u8 { let n=self.data[self.at] self.at=self.at+1 return n }
  fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
  fn blob(self:&mut Self)->&'static [u8] {
    let size=u32.toUsize(self.word()) let data=Slice.view<u8>(self.data,self.at,size)
    self.at=self.at+size return data
  }
}
fn signed(value:u32)->i32 {
  if value>=0x80000000 { return -1-u32.toI32(value^0xffffffff) }
  return u32.toI32(value)
}
fn bits(value:i64)->u32 {
  if value<0 { return i64.toU32(value+4294967296) }
  return i64.toU32(value)
}
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
fn errorKind(error:BytecodeErrorKind)->u32 {
  return match error {
    BytecodeErrorKind.BufferOverflow => 1
    BytecodeErrorKind.InvalidOpcode => 2
    BytecodeErrorKind.StackUnderflow => 3
    BytecodeErrorKind.StackOverflow => 4
    BytecodeErrorKind.InconsistentStack => 5
    BytecodeErrorKind.InconsistentCatch => 6
    BytecodeErrorKind.MissingCatch => 7
  }
}
effect fn stack(out:&mut ByteBuffer,code:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
  let result=run Effect.result(computeStackSize(code))
  match move result {
    Result<u16,BytecodeError | OutOfMemoryError>.Success { value } => {
      run out.writeU32(0) run out.writeU32(u16.toU32(value))
      run out.writeU32(0) run out.writeU32(0) run out.writeU32(0) run out.writeU32(0)
    }
    Result<u16,BytecodeError | OutOfMemoryError>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        BytecodeError e => {
          let kind=errorKind(e.kind)
          run out.writeU32(kind) run out.writeU32(0) run out.writeU32(bits(e.pc))
          let mut opcode:u32=0 let mut expected:u32=0 let mut actual:u32=0
          if kind<=4 { opcode=u8.toU32(e.opcode) }
          if kind==5 || kind==6 { expected=bits(e.expected) actual=bits(e.actual) }
          run out.writeU32(opcode) run out.writeU32(expected) run out.writeU32(actual)
        }
      }
    }
  }
}
effect fn emitBytes(out:&mut ByteBuffer,bytes:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(bytes.length)) let mut i:usize=0
  while i<bytes.length { run out.writeU32(u8.toU32(bytes[i])) i=i+1 }
}
effect fn locations(input:&mut Input,out:&mut ByteBuffer,table:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
  let count=input.word() let mut i:u32=0
  while i<count {
    let location=decodePc2Line(table,input.word())
    run out.writeU32(bits(i32.toI64(location.line))) run out.writeU32(bits(i32.toI64(location.column)))
    i=i+1
  }
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer)->() ! OutOfMemoryError ? &mut Allocator {
  let op=input.byte() let data=input.blob()
  if op==0 { run stack(&mut out,data) }
  else if op==1 {
    let mut code=ByteBuffer.make() run code.appendSlice(data) let mut pass:u32=0
    while pass<2 {
      swapBytecodeEndian(code.asMutSlice()) let mut i:usize=0
      while i<code.length() { run out.writeU32(u8.toU32(code.get(i))) i=i+1 }
      pass=pass+1
    }
  } else if op==2 {
    let mut cache=SourcePositionCache.make() let count=input.word() let mut i:u32=0
    while i<count {
      let location=cache.locate(data,u32.toUsize(input.word()))
      run out.writeU32(bits(i32.toI64(location.line))) run out.writeU32(bits(i32.toI64(location.column))) i=i+1
    }
  } else if op==3 {
    let source=input.word() let capacity=u32.toUsize(input.word()) let count=input.word()
    let mut positions=run PcSourcePositions.make(capacity,source) let mut i:u32=0
    while i<count {
      let pc=input.word() let position=input.word()
      let accepted=run positions.add(pc,position) run out.writeU32(flag(accepted)) i=i+1
    }
    let entries=positions.asSlice() run out.writeU32(usize.toU32(entries.length))
    let mut j:usize=0
    while j<entries.length {
      run out.writeU32(entries[j].pc) run out.writeU32(entries[j].sourcePosition) j=j+1
    }
  } else if op==4 {
    let source=input.word() let capacity=input.word() let count=input.word()
    let mut positions=List<PcSourcePosition>.make() let mut i:u32=0
    while i<count {
      let pc=input.word() let position=input.word()
      run positions.append(PcSourcePosition { pc:pc,sourcePosition:position }) i=i+1
    }
    let table=run encodePc2Line(data,source,positions.asSlice())
    run emitBytes(&mut out,table.asSlice()) run locations(&mut input,&mut out,table.asSlice())
  } else if op==5 { run locations(&mut input,&mut out,data) }
  else if op==6 {
    let value=input.word() let mut buffer=ByteBuffer.make()
    run writeLeb128(&mut buffer,value) run emitBytes(&mut out,buffer.asSlice()) buffer.clear()
    run writeSignedLeb128(&mut buffer,signed(value)) run emitBytes(&mut out,buffer.asSlice())
  } else if op==7 {
    let start=u32.toUsize(input.word())
    let unsigned=readLeb128(data,start) let signedValue=readSignedLeb128(data,start)
    run out.writeU32(flag(unsigned.valid)) run out.writeU32(unsigned.value) run out.writeU32(usize.toU32(unsigned.next))
    run out.writeU32(flag(signedValue.valid)) run out.writeU32(bits(i32.toI64(signedValue.value)))
    run out.writeU32(usize.toU32(signedValue.next))
  }
}
effect fn probe()->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word()
  let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut size=ByteBuffer.make() let mut i:u32=0
  while i<count {
    out.clear() size.clear() run operate(&mut input,&mut out)
    run size.writeU32(usize.toU32(out.length()))
    run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
}
pub effect fn main()->i32 ! OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def word(value):
    return struct.pack('<I', value & 0xffffffff)


def words(values):
    return b''.join(word(value) for value in values)


def blob(data):
    return word(len(data)) + data


@dataclass(frozen=True)
class Opcode:
    number: int
    name: str
    size: int
    pops: int
    pushes: int
    format: str


@dataclass(frozen=True)
class Case:
    label: str
    op: int
    data: bytes
    arguments: tuple = ()
    # Query offsets/PCs and collector attempts also name result fields.
    queries: tuple = ()
    required_status: int | None = None

    def wire(self):
        return bytes([self.op]) + blob(self.data) + words(self.arguments)


def inventory(data):
    formats, opcodes = set(), []
    for line in data.decode('ascii').splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] == 'format':
            formats.add(fields[1])
        elif len(fields) == 7 and fields[0] == 'opcode':
            _, number, name, size, pops, pushes, fmt = fields
            opcodes.append(Opcode(int(number), name, int(size), int(pops), int(pushes), fmt))
        else:
            raise SystemExit(f'Malformed C opcode inventory: {line!r}')
    if len(opcodes) != 250 or [op.number for op in opcodes] != list(range(250)):
        raise SystemExit('Pinned C inventory must contain exactly 250 contiguous final opcodes')
    if opcodes[0].name != 'invalid' or any(op.format not in formats for op in opcodes):
        raise SystemExit('Inconsistent C opcode/format inventory')
    return {op.name: op for op in opcodes}, formats


class Assembler:
    """Fixture-only labels; no stack analysis or expected-result computation."""
    def __init__(self, opcodes):
        self.opcodes = opcodes
        self.code = bytearray()
        self.labels = {}
        self.fixups = []

    def mark(self, label):
        if label in self.labels:
            raise ValueError(f'duplicate fixture label {label}')
        self.labels[label] = len(self.code)
        return self

    def emit(self, name, *, target=None, operand=0):
        op = self.opcodes[name]
        start = len(self.code)
        self.code.extend(bytes([op.number]) + bytes(op.size - 1))
        if op.size > 1:
            width = min(op.size - 1, 4)
            self.code[start + 1:start + 1 + width] = (operand & ((1 << (8 * width)) - 1)).to_bytes(width, 'little')
        if target is not None:
            offset = 5 if op.format in ('atom_label_u8', 'atom_label_u16') else 1
            width = {'label8': 1, 'label16': 2}.get(op.format, 4)
            self.fixups.append((start + offset, width, target))
        return self

    def push(self, count):
        self.code.extend(bytes([self.opcodes['undefined'].number]) * count)
        return self

    def finish(self):
        for origin, width, target in self.fixups:
            displacement = self.labels[target] - origin
            if not -(1 << (8 * width - 1)) <= displacement < (1 << (8 * width - 1)):
                raise ValueError(f'fixture branch out of range: {target}')
            self.code[origin:origin + width] = displacement.to_bytes(width, 'little', signed=True)
        return bytes(self.code)


def fixtures(opcodes, seed, random_cases):
    rng = random.Random(seed)
    cases = []

    def stack(label, code, status=None):
        if isinstance(code, Assembler):
            code = code.finish()
        cases.append(Case(label, 0, bytes(code), required_status=status))

    def asm():
        return Assembler(opcodes)

    branches = {'goto', 'goto8', 'goto16', 'if_true', 'if_false', 'if_true8', 'if_false8',
                'gosub', 'catch', 'with_get_var', 'with_delete_var', 'with_make_ref',
                'with_get_ref', 'with_put_var'}
    terminals = {'return', 'return_undef', 'return_async', 'throw', 'throw_error',
                 'tail_call', 'tail_call_method', 'ret'}
    all_endian = bytearray()
    for op in opcodes.values():
        if op.number == 0:
            continue
        # Each operand position is distinguishable and asymmetric under reversal.
        for pattern in range(3):
            data = bytes([op.number]) + bytes((op.number * 13 + j * 37 + pattern * 83) & 255
                                              for j in range(1, op.size))
            cases.append(Case(f'endian/{op.number}:{op.name}/{op.format}/pattern-{pattern}', 1, data))
            if pattern == 0:
                all_endian.extend(data)
        for count in ((0, 1, 7, 255, 256) if op.format in ('npop', 'npop_u16') else (0,)):
            extra = count if op.format in ('npop', 'npop_u16') else 0
            if op.format == 'npopx':
                extra = op.number - opcodes['call0'].number
            a = asm().push(op.pops + extra + 8)
            if op.name in branches:
                a.emit(op.name, target='taken', operand=count).emit('return_undef').mark('taken').emit('return_undef')
            else:
                a.emit(op.name, operand=count).emit('return_undef')
            stack(f'opcode/{op.number}:{op.name}/arguments-{count}/reachable', a, 7 if op.name == 'nip_catch' else 0)
            if op.pops + extra:
                a = asm().push(op.pops + extra - 1).emit(op.name, operand=count).emit('return_undef')
                stack(f'opcode/{op.number}:{op.name}/arguments-{count}/underflow', a, 3)
        for size in range(1, op.size):
            stack(f'truncated/{op.name}/{size}-of-{op.size}', bytes([op.number]) + bytes(size - 1), 1)
        if op.name in terminals:
            count = op.pops + (op.number - opcodes['call0'].number if op.format == 'npopx' else 0)
            a = asm().push(count).emit(op.name)
            a.code.extend(b'\xff\x00\xfe')
            stack(f'terminal/{op.name}/unreachable-invalid-tail', a, 0)
    cases.append(Case('endian/all-final-opcodes/stream', 1, bytes(all_endian)))
    cases.append(Case('endian/empty-valid-stream', 1, b''))
    stack('empty/ss_check-buffer-boundary', b'', 1)
    for value in (0, *range(250, 256)):
        stack(f'invalid-opcode/{value}', bytes([value]), 2)
    stack('fallthrough/end-of-buffer', asm().emit('nop'), 1)
    for name in ('goto', 'goto8', 'goto16'):
        stack(f'branch/{name}/backward-self-loop', asm().mark('again').emit(name, target='again'))
        stack(f'branch/{name}/before-buffer', asm().emit(name, operand=-2))
        stack(f'branch/{name}/past-buffer', asm().emit(name, operand=opcodes[name].size))
        stack(f'branch/{name}/dead-invalid-byte', asm().emit(name, target='end').emit('invalid').mark('end').emit('return_undef'))
    for name in ('if_true', 'if_false', 'if_true8', 'if_false8'):
        stack(f'join/{name}/equal', asm().push(1).emit(name, target='taken')
              .push(1).emit('goto8', target='join').mark('taken').push(1).mark('join').emit('return'))
        stack(f'join/{name}/inconsistent-stack', asm().push(1).emit(name, target='join')
              .push(1).emit('goto8', target='join').mark('join').emit('return_undef'), 5)
        stack(f'loop/{name}/balanced', asm().mark('loop').push(1).emit(name, target='loop').emit('return_undef'))
    stack('finally/gosub-ret', asm().emit('gosub', target='finally').emit('return_undef').mark('finally').emit('ret'))
    stack('finally/gosub-target-stack-conflict', asm().emit('gosub', target='join').emit('goto8', target='join').mark('join').emit('return_undef'))
    stack('catch/inconsistent-context', asm().emit('catch', target='join').emit('goto8', target='join').mark('join').emit('return'), 6)
    stack('catch/missing-nip-catch', asm().push(3).emit('nip_catch').emit('return'), 7)
    for removal, prefix, extra, level in (('drop', 0, 0, 0), ('nip', 0, 1, 1),
                                          ('nip1', 1, 1, 2), ('nip_catch', 0, 3, 1)):
        # Source nip1's catch-level rule requires a value below the catch entry.
        a = asm().push(prefix).emit('catch', target='handler').push(extra).emit(removal)
        a.emit('goto8', target='join').mark('handler').emit('drop').push(level - prefix)
        a.mark('join').emit('return_undef')
        stack(f'catch/restore-via-{removal}/join', a, 0)
    stack('catch/nested-finally', asm().emit('catch', target='outer').emit('catch', target='inner')
          .push(1).emit('nip_catch').emit('nip').emit('return')
          .mark('inner').emit('nip').emit('return').mark('outer').emit('return'))
    for start in ('for_of_start', 'for_await_of_start'):
        stack(f'iterator/{start}/close-join', asm().push(1).emit('if_false8', target='join')
              .push(1).emit(start).emit('iterator_close').mark('join').emit('return_undef'))
        stack(f'iterator/{start}/nip-catch', asm().push(1).emit(start).push(1)
              .emit('nip_catch').emit('drop').emit('drop').emit('drop').emit('return_undef'))
    for name, taken in (('with_get_var', 1), ('with_delete_var', 1), ('with_make_ref', 2),
                        ('with_get_ref', 2), ('with_put_var', -1)):
        a = asm().push(3).emit(name, target='taken')
        if taken >= 0:
            a.push(taken)
        else:
            a.emit('drop')
        a.emit('goto8', target='join').mark('taken').emit('nop').mark('join').emit('return_undef')
        stack(f'with/{name}/unequal-edge-effects-balanced-join', a, 0)
    for count in (65533, 65534, 65535):
        stack(f'limit/push-depth-{count}', asm().push(count).emit('return_undef'), 4 if count > 65534 else 0)
    for count in (65533, 65534):
        stack(f'limit/gosub-extra-slot-at-{count}', asm().push(count).emit('gosub', target='finally')
              .emit('return_undef').mark('finally').emit('ret'), 4 if count == 65534 else 0)
    for name in ('call', 'call_method', 'call_constructor', 'array_from', 'eval', 'tail_call', 'tail_call_method'):
        stack(f'variable-pop/{name}/65535-arguments-underflow', asm().push(8).emit(name, operand=65535).emit('return_undef'), 3)
    ordinary = [op for op in opcodes.values() if op.number and op.name not in branches | terminals
                and op.name not in ('nip_catch', 'for_of_start', 'for_await_of_start')]
    for index in range(random_cases):
        a = asm().push(rng.randrange(0, 24))
        for _ in range(rng.randrange(1, 40)):
            op = rng.choice(ordinary)
            a.emit(op.name, operand=rng.randrange(0, 10))
        stack(f'seeded/straight-stack/{index}', a.emit('return_undef'))

    def coordinates(label, source, offsets):
        offsets = tuple(offsets)
        cases.append(Case(label, 2, source, (len(offsets), *offsets), offsets))

    sources = [b'', b'abc', b'\r\n\r\n\n', b'a\x00b\rc\nd\r\ne',
               'a\u00e9\u4e2d\U0001f600\u2028\u2029\nZ'.encode(),
               bytes(range(256)), b'\x80\xbf\xc0\xc1\xf5\xff\n\xed\xa0\x80\xe2\x82']
    for index, source in enumerate(sources):
        n = len(source)
        offsets = list(range(n + 1)) + list(range(n, -1, -1))
        offsets += [value for i in range(n + 1) for value in (i, n - i, i, i)]
        coordinates(f'coordinates/{index}/forward-backward-repeated-interior-utf8', source, offsets)
    for index in range(random_cases):
        source = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 150)))
        coordinates(f'coordinates/seeded/{index}', source, [rng.randrange(len(source) + 1) for _ in range(32)])

    def collect(label, capacity, initial, entries):
        entries = tuple(entries)
        args = (initial, capacity, len(entries), *(value for pair in entries for value in pair))
        cases.append(Case(label, 3, b'', args, entries))

    attempts = ((0, 7), (0, 8), (0, 9), (1, 9), (1, 10), (0, 11), (2, 10),
                (2, 0xffffffff), (3, 12), (0xffffffff, 13), (0, 14), (0xffffffff, 15))
    for capacity in (0, 1, 2, 4, len(attempts), len(attempts) + 1):
        collect(f'collector/capacity-{capacity}/duplicates-descending-sentinel-wrap', capacity, 7, attempts)
    for index in range(random_cases):
        collect(f'collector/seeded/{index}', rng.randrange(0, 20), rng.randrange(10),
                [(rng.randrange(20), rng.randrange(10)) for _ in range(30)])

    def encode(label, source, initial, entries, queries=None):
        entries = tuple(entries)
        if queries is None:
            queries = [0xffffffff, 0, 1, 49, 50, 51, 127, 128, 0x7fffffff, 0xfffffffe]
            for pc, _ in entries:
                queries.extend(((pc - 1) & 0xffffffff, pc, (pc + 1) & 0xffffffff))
        queries = tuple(dict.fromkeys(queries))
        args = (initial, len(entries), len(entries), *(value for pair in entries for value in pair), len(queries), *queries)
        cases.append(Case(label, 4, source, args, queries))

    source = b'abc\n' * 10
    for delta_pc in range(51):
        for delta_line in range(-1, 4):
            encode(f'pc2line/compact/pc-{delta_pc}/line-{delta_line}', source, 16,
                   [(delta_pc, 16 + delta_line * 4 + 1)])
    for delta_pc in (0, 1, 49, 50, 51, 127, 128, 16383, 16384, 0x7fffffff, 0x80000000, 0xffffffff):
        for delta_line in (-2, -1, 0, 3, 4):
            encode(f'pc2line/boundary/pc-{delta_pc}/line-{delta_line}', source, 16,
                   [(delta_pc, 16 + delta_line * 4 + 1)])
    wide_source = b'x' * 300 + b'\n' + b'y' * 300
    for column in (0, 1, 63, 64, 127, 128, 255, 256, 300):
        encode(f'pc2line/signed-column/{column}', wide_source, 150,
               [(0, column), (1, 300 - column), (51, 301 + column), (52, 0)])
    encode('pc2line/no-positions/empty-source', b'', 0, [])
    encode('pc2line/no-position-sentinels-and-descending-pcs', source, 16,
           [(0, 16), (4, 0xffffffff), (3, 17), (2, 18), (3, 19), (3, 19), (60, 0), (70, 16)])
    for index in range(random_cases):
        source = bytes(rng.choice((10, 13, 32, 65, 0x80, 0xc0, 0xff)) for _ in range(80))
        entries = [(rng.randrange(0, 200), rng.randrange(81)) for _ in range(24)]
        encode(f'pc2line/seeded/{index}', source, rng.randrange(81), entries)

    def decode(label, table, queries=(0xffffffff, 0, 1, 49, 50, 51, 127, 128, 0x7fffffff, 0x80000000, 0xfffffffe)):
        cases.append(Case(label, 5, table, (len(queries), *queries), tuple(queries)))

    for opcode in range(256):
        table = b'\x03\x04' + bytes([opcode]) + (b'\x01\x00' if opcode == 0 else b'') + b'\x03'
        decode(f'pc2line/decode-opcode-{opcode}', table)
        decode(f'pc2line/truncated-column-opcode-{opcode}', table[:-1])
    tables = (b'', b'\0', b'\x80', b'\x80\0\x80\0', b'\0\0\0',
              b'\0\0\0\x80', b'\0\0\0\0\x80', b'\0\0\0\0\0\x80',
              b'\0\0\xff\0\0\x80', b'\0\0\0\x80\0\x80\0\x80\0',
              b'\xff\xff\xff\xff\x7f\xff\xff\xff\xff\x7f',
              b'\0\0\0\xff\xff\xff\xff\x0f\0\0\x06\0',
              b'\0\0\0\xff\xff\xff\xff\x07\xfe\xff\xff\xff\x0f\xff\xff\xff\xff\x0f')
    for index, table in enumerate(tables):
        for length in range(len(table) + 1):
            decode(f'pc2line/malformed-or-overlong/{index}/prefix-{length}', table[:length])

    def leb(label, data, start=0):
        cases.append(Case(label, 7, data, (start,)))

    values = {0, 1, 2, 63, 64, 127, 128, 255, 256, 0x7fffffff, 0x80000000, 0xffffffff}
    for bit in range(32):
        values.update(((1 << bit) - 1, 1 << bit, min((1 << bit) + 1, 0xffffffff)))
    values.update(rng.getrandbits(32) for _ in range(random_cases))
    for value in sorted(values):
        cases.append(Case(f'leb/write/unsigned-and-zigzag/{value:#010x}', 6, b'', (value,)))
    for depth in range(5):
        for final in range(256):
            # Exhaust every byte in every decoder position, including fifth-byte
            # overflow truncation and continuation rejection; suffix tests cursor.
            data = b'\xff' * depth + bytes([final])
            leb(f'leb/read/position-{depth}/byte-{final:02x}/bounded', data)
            leb(f'leb/read/position-{depth}/byte-{final:02x}/nonzero-cursor', b'\x55' + data + b'\x01\x00', 1)
    for length in range(8):
        leb(f'leb/unterminated/{length}', b'\x80' * length)
        leb(f'leb/overlong-zero/{length}', b'\x80' * length + b'\0')
        leb(f'leb/end-cursor/{length}', b'\xff' * length, length)
    for index in range(random_cases):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 10)))
        leb(f'leb/seeded/{index}', data, rng.randrange(len(data) + 1))
    return cases


def semantic_fields(case, record, owner):
    """Decode the transport only. Values and bytes are never recomputed here."""
    if len(record) % 4:
        raise SystemExit(f'{owner} [{case.label}]: output is not a sequence of u32 fields')
    values = struct.unpack(f'<{len(record) // 4}I', record)
    at, fields = 0, {}

    def take(name):
        nonlocal at
        if at >= len(values):
            raise SystemExit(f'{owner} [{case.label}]: missing field {name}')
        fields[name] = values[at]
        at += 1
        return fields[name]

    def byte_array(name):
        count = take(name + '.length')
        if count > len(values) - at:
            raise SystemExit(f'{owner} [{case.label}]: impossible {name} length {count}')
        for i in range(count):
            if take(f'{name}[{i}]') > 255:
                raise SystemExit(f'{owner} [{case.label}]: {name}[{i}] is not a byte')

    def locations():
        for i, pc in enumerate(case.queries):
            take(f'query[{i}]@{pc:#x}.line')
            take(f'query[{i}]@{pc:#x}.column')

    if case.op == 0:
        for name in ('status', 'maximum', 'pc', 'opcode', 'join.expected', 'join.actual'):
            take(name)
    elif case.op == 1:
        for direction in ('swapped', 'restored'):
            for i in range(len(case.data)):
                if take(f'{direction}[{i}]') > 255:
                    raise SystemExit(f'{owner} [{case.label}]: endian result is not a byte')
    elif case.op in (2, 5):
        locations()
    elif case.op == 3:
        for i, pair in enumerate(case.queries):
            take(f'add[{i}]({pair[0]:#x},{pair[1]:#x}).accepted')
        count = take('entries.length')
        if count > len(case.queries):
            raise SystemExit(f'{owner} [{case.label}]: collector returned too many entries')
        for i in range(count):
            take(f'entries[{i}].pc')
            take(f'entries[{i}].source')
    elif case.op == 4:
        byte_array('encoded')
        locations()
    elif case.op == 6:
        byte_array('unsigned')
        byte_array('zigzag')
    elif case.op == 7:
        for name in ('unsigned.valid', 'unsigned.value', 'unsigned.next', 'zigzag.valid', 'zigzag.value', 'zigzag.next'):
            take(name)
    if at != len(values):
        raise SystemExit(f'{owner} [{case.label}]: {len(values) - at} unexpected trailing fields')
    return fields


def validate_pins(upstream):
    manifest = tomllib.loads((ROOT / 'upstream.toml').read_text())
    if manifest['revision'] != REVISION:
        raise SystemExit(f'Expected pinned revision {REVISION}; got {manifest["revision"]}')
    pins = manifest['source-sha256']
    pending, seen = ['quickjs.c', *SUPPORT], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise SystemExit(f'Unsafe upstream include path: {name}')
        seen.add(name)
        if name not in pins:
            raise SystemExit(f'Missing upstream.toml source-sha256 pin: {name}')
        source = upstream / name
        if not source.is_file():
            raise SystemExit(f'Missing pinned upstream source: {source}')
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != pins[name]:
            raise SystemExit(f'Wrong upstream source {name}: pinned={pins[name]}, actual={digest}')
        for include in re.findall(rb'^\s*#\s*include\s+"([^"\r\n]+)"', data, re.MULTILINE):
            pending.append(str(relative.parent / include.decode('utf-8')))
    return len(seen)


def records(data, cases, owner):
    at = 0

    def take(size, label):
        nonlocal at
        if size > len(data) - at:
            raise SystemExit(f'{owner}: truncated {label} at byte {at}; need {size}, have {len(data) - at}')
        value = data[at:at + size]
        at += size
        return value

    count, = struct.unpack('<I', take(4, 'record count'))
    if count != len(cases):
        raise SystemExit(f'{owner}: emitted {count} records; expected {len(cases)}')
    result = []
    for index, case in enumerate(cases):
        label = f'fixture #{index} [{case.label}]'
        size, = struct.unpack('<I', take(4, label + ' length'))
        result.append(semantic_fields(case, take(size, label), owner))
    if at != len(data):
        raise SystemExit(f'{owner}: {len(data) - at} trailing output bytes')
    return result


def incomplete_record(data, cases):
    if cases is None:
        return ''
    if len(data) < 4:
        return '; no protocol header (startup or first-record failure)'
    count, = struct.unpack_from('<I', data)
    if count != len(cases):
        return f'; unexpected protocol header {count}'
    at = 4
    for index, case in enumerate(cases):
        if at + 4 > len(data):
            return f'; first unreported fixture #{index} [{case.label}]'
        size, = struct.unpack_from('<I', data, at)
        at += 4
        if at + size > len(data):
            return f'; incomplete fixture #{index} [{case.label}]'
        at += size
    return '; every record emitted; teardown failure'


def process(command, timeout, *, owner, cwd=None, data=None, cases=None):
    try:
        result = subprocess.run(command, cwd=cwd, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        position = incomplete_record(error.stdout or b'', cases)
        raise SystemExit(f'{owner}: timed out after {timeout}s{position}\n{(error.stderr or b"").decode(errors="replace")}') from None
    except OSError as error:
        raise SystemExit(f'{owner}: cannot execute {command[0]}: {error}') from None
    stderr = result.stderr.decode(errors='replace')
    if result.returncode:
        position = incomplete_record(result.stdout, cases)
        raise SystemExit(f'{owner}: exited {result.returncode}{position}\n{stderr}')
    if stderr:
        print(f'{owner} stderr:\n{stderr}', end='' if stderr.endswith('\n') else '\n')
    return result.stdout


def executable_path(value):
    candidate = Path(value).expanduser()
    if candidate.exists() or '/' in value:
        return str(candidate.resolve())
    found = shutil.which(value)
    if not found:
        raise SystemExit(f'Executable not found: {value}')
    return str(Path(found).resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()), help='native compiler executable')
    parser.add_argument('--stdlib', type=Path, help='source standard library for the selected compiler', default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc', help='independent C compiler executable')
    parser.add_argument('--seed', type=lambda value: int(value, 0), default=0xBC2A1E)
    parser.add_argument('--random-cases', type=int, default=128, help='additional cases per family; mandatory domains are never disabled')
    parser.add_argument('--timeout', type=int, default=900, help='seconds per compiler/probe subprocess')
    parser.add_argument('--max-mismatches', type=int, default=20)
    args = parser.parse_args()
    if args.random_cases < 0 or args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('random-cases must be nonnegative; timeout and max-mismatches must be positive')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    with tempfile.TemporaryDirectory(prefix='silkjs-bytecode-') as directory:
        temp = Path(directory).resolve()  # The compiler rejects macOS /var aliases.
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                args.timeout, owner='C32 oracle compilation')
        opcodes, formats = inventory(process([str(temp / 'oracle'), '--inventory'], args.timeout, owner='C32 inventory'))
        inhabited = {op.format for op in opcodes.values() if op.number}
        print(f'Pinned final opcode domain: {len(opcodes)} entries; {len(inhabited)} inhabited formats; '
              f'formats without final opcodes: {sorted(formats - inhabited)}', flush=True)
        cases = fixtures(opcodes, args.seed, args.random_cases)
        data = word(len(cases)) + b''.join(case.wire() for case in cases)
        print(f'Independent bytecode oracle: {len(cases):,} fixtures; {pins} recursively validated source hashes; seed={args.seed:#x}', flush=True)
        oracle = process([str(temp / 'oracle')], args.timeout, owner='C32 oracle', data=data, cases=cases)
        expected = records(oracle, cases, 'C32 oracle')
        # These independently hand-selected cases must actually reach their
        # named behavior; equal unrelated rejections cannot count as coverage.
        for case, result in zip(cases, expected, strict=True):
            if case.required_status is not None and result['status'] != case.required_status:
                raise SystemExit(f'C oracle fixture contract [{case.label}]: expected status '
                                 f'{case.required_status}, observed {result}')
        categories = {result['status'] for case, result in zip(cases, expected, strict=True) if case.op == 0}
        if categories != set(range(8)):
            raise SystemExit(f'Stack fixtures did not exercise every success/error category: {sorted(categories)}')
        # Expectations never enter this package. Only native source and the exact
        # same input bytes are supplied; there are no C objects or linker flags.
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="bytecode-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if stdlib is not None:
            command.extend(('--stdlib', str(stdlib)))
        print('Building and running standalone native bytecode probe (no C linkage)...', flush=True)
        native = process(command, args.timeout, owner='Native Silk probe', cwd=temp, cases=cases)
        actual = records(native, cases, 'Native Silk probe')
        failures = Counter()
        mismatches = 0
        for index, (case, reference, observed) in enumerate(zip(cases, expected, actual, strict=True)):
            if reference == observed:
                continue
            mismatches += 1
            failures[OPERATIONS[case.op]] += 1
            if mismatches <= args.max_mismatches:
                print(f'MISMATCH #{index} [{case.label}] input-sha256={hashlib.sha256(case.wire()).hexdigest()}')
                print(f'  input-prefix={case.data[:64].hex()} input-length={len(case.data)}')
                changed = [name for name in dict.fromkeys((*reference, *observed)) if reference.get(name) != observed.get(name)]
                for name in changed[:20]:
                    want, got = reference.get(name), observed.get(name)
                    def display(value):
                        if value is None:
                            return '<missing>'
                        signed_value = value if value < 0x80000000 else value - 0x100000000
                        return f'{value} (bits={value:#010x}, signed={signed_value})'
                    print(f'  {name}: C32={display(want)}; Silk={display(got)}')
                if len(changed) > 20:
                    print(f'  ... {len(changed) - 20} further differing fields')
        if mismatches:
            raise SystemExit(f'{mismatches} bytecode/debug mismatches ({dict(failures)}); showing first {min(mismatches, args.max_mismatches)}')
        totals = Counter(OPERATIONS[case.op] for case in cases)
        print(f'PASS: {len(cases):,} independent records. Operations: {dict(totals)}. Output SHA256: {hashlib.sha256(native).hexdigest()}')


if __name__ == '__main__':
    main()
