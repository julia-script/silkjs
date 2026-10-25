#!/usr/bin/env python3
"""Differentially verify the native RegExp compiler and VM against pinned QuickJS.

Usage: python3 scripts/verify_regexp.py /path/to/quickjs

The C oracle is a separate executable, never linked into Silk. Its original
bytecode is also executed by the native VM: agreement of the native compiler
and VM alone cannot hide a shared defect. Compiler comparison is semantic, not
byte-for-byte: flags, capture count, and names are compared, but optimization,
register allocation, and named-group scope bytes are not. VM records include
match/timeout status and every capture code-unit offset, including unset -1.
All generated sources and executable outputs live in a TemporaryDirectory.
"""
import argparse
from dataclasses import dataclass
import hashlib
import itertools
from pathlib import Path
import random
import shutil
import struct
import subprocess
import tempfile
import tomllib
import toolchain
from verify_bytecode import executable_path

ROOT = Path(__file__).resolve().parents[1]
FLAGS = dict(g=1, i=2, m=4, s=8, u=16, y=32, d=64, v=256)
INITIAL = 14695981039346656037
TIMEOUT = 0xFFFFFFFE
SKIPPED = 0xFFFFFFFD
PINNED_SOURCES = (
    'libregexp.c', 'libregexp.h', 'libregexp-opcode.h', 'libunicode.c',
    'libunicode.h', 'libunicode-table.h', 'cutils.c', 'cutils.h',
)

C_SOURCE = r'''
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libregexp.h"

#define SKIPPED UINT32_C(0xfffffffd)
typedef struct { uint32_t polls, budget; } Context;
static uint32_t fixture_index;
static void die(const char *message) {
    fprintf(stderr, "C oracle fixture %u: %s\n", fixture_index, message);
    exit(1);
}
void *lre_realloc(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (!size) { free(ptr); return NULL; }
    void *result = ptr ? realloc(ptr, size) : malloc(size);
    if (!result) die("allocation failed");
    return result;
}
int lre_check_stack_overflow(void *opaque, size_t alloca_size) {
    /* Generated nesting is bounded; parser depth-limit tests live in Silk. */
    (void)opaque; (void)alloca_size; return 0;
}
int lre_check_timeout(void *opaque) {
    Context *context = opaque;
    return ++context->polls >= context->budget;
}
static uint64_t mix(uint64_t h, uint32_t value) {
    return (h ^ value) * UINT64_C(1099511628211);
}
static uint64_t initial(void) { return UINT64_C(14695981039346656037); }
static uint32_t read32(void) {
    uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i) {
        int byte = getchar();
        if (byte == EOF) die("truncated fixture input");
        value |= (uint32_t)byte << (8 * i);
    }
    return value;
}
static uint8_t *read_bytes(uint32_t length) {
    uint8_t *data = lre_realloc(NULL, NULL, (size_t)length + 1);
    if (fread(data, 1, length, stdin) != length) die("truncated fixture bytes");
    data[length] = 0;
    return data;
}
static void emit32(uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) putchar((value >> (8 * i)) & 255);
}
static void emit64(uint64_t value) {
    for (unsigned i = 0; i < 8; ++i) putchar((value >> (8 * i)) & 255);
}
static void emit_bytes(const uint8_t *data, size_t length) {
    if (length && fwrite(data, 1, length, stdout) != length) die("output write failed");
}
static void metadata(const uint8_t *code) {
    uint32_t status = code != NULL;
    uint32_t captures = code ? lre_get_capture_count(code) : 0;
    uint32_t flags = code ? lre_get_flags(code) : 0;
    const char *names = code ? lre_get_groupnames(code) : NULL;
    uint32_t length = 0;
    if (names) {
        const char *p = names;
        for (uint32_t i = 1; i < captures; ++i) {
            size_t n = strlen(p);
            length += n + 1;
            p += n + LRE_GROUP_NAME_TRAILER_LEN;
        }
    }
    emit32(status); emit32(captures); emit32(flags); emit32(length);
    uint64_t h = mix(mix(mix(mix(initial(), status), captures), flags), length);
    if (names) {
        const char *p = names;
        for (uint32_t i = 1; i < captures; ++i) {
            size_t n = strlen(p);
            emit_bytes((const uint8_t *)p, n + 1);
            for (size_t j = 0; j <= n; ++j) h = mix(h, (uint8_t)p[j]);
            p += n + LRE_GROUP_NAME_TRAILER_LEN;
        }
    }
    emit64(h);
}
static void execute(const uint8_t *code, const uint8_t *input, uint32_t wide,
                    uint32_t length, uint32_t start, uint32_t budget) {
    Context context = {0, budget};
    uint32_t status = SKIPPED, count = 0;
    uint8_t **captures = NULL;
    if (code) {
        captures = lre_realloc(NULL, NULL, lre_get_alloc_count(code) * sizeof(*captures));
        int ret = lre_exec(captures, code, input, start, length, wide, &context);
        if (ret != 0 && ret != 1 && ret != LRE_RET_TIMEOUT) die("unexpected VM error");
        status = (uint32_t)ret;
        if (ret == 1) count = 2 * lre_get_capture_count(code);
    }
    emit32(status); emit32(count);
    uint64_t h = mix(mix(initial(), status), count);
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t offset = UINT32_MAX;
        if (captures[i]) {
            ptrdiff_t bytes = captures[i] - input;
            if (bytes < 0 || (size_t)bytes > ((size_t)length << wide) ||
                (wide && (bytes & 1))) die("capture outside code-unit input");
            offset = (uint32_t)(bytes >> wide);
        }
        emit32(offset); h = mix(h, offset);
    }
    emit64(h); emit32(context.polls);
    free(captures);
}
int main(void) {
    uint32_t count = read32();
    emit32(count);
    for (fixture_index = 0; fixture_index < count; ++fixture_index) {
        uint32_t flags = read32(), length = read32();
        uint8_t *pattern = read_bytes(length);
        uint32_t runs = read32();
        char error[256] = {0};
        int code_length = 0;
        uint8_t *code = lre_compile(&code_length, error, sizeof(error),
                                   (const char *)pattern, length, flags, NULL);
        if (!code && (strstr(error, "out of memory") || strstr(error, "stack overflow")))
            die(error);
        metadata(code);
        emit32(code_length); emit_bytes(code, code_length);
        emit32(strlen(error)); emit_bytes((const uint8_t *)error, strlen(error));
        emit32(runs);
        for (uint32_t run = 0; run < runs; ++run) {
            uint32_t wide = read32(), start = read32(), budget = read32(), units = read32();
            if (wide > 1 || start > units || !budget) die("invalid execution fixture");
            uint8_t *input = read_bytes(units << wide);
            /* The wire is little-endian; lre_exec expects host-endian uint16_t. */
            if (wide) {
                for (uint32_t i = 0; i < units; ++i) {
                    uint16_t unit = (uint16_t)input[2*i] | (uint16_t)input[2*i+1] << 8;
                    memcpy(input + 2*i, &unit, sizeof(unit));
                }
            }
            execute(code, input, wide, units, start, budget);
            free(input);
        }
        free(pattern); free(code);
    }
    if (getchar() != EOF) die("extra fixture input");
    return ferror(stdout) ? 1 : 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.i32
import silk.list { List }
import silk.os_writer { StdoutWriter }
import silk.result { Result }
import silk.slice { Slice }
import silk.u8
import silk.u16
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }
import byte_buffer { readU16, readU32 }
import regexp_compile { RegExpCompiler }
import regexp_exec { RegExpExecutor }
import regexp_types { RegExpProgram, RegExpMatch, RegExpSyntaxError, RegExpStackOverflow, RegExpTimeout }

fn mix(h:u64,value:u32)->u64 { return u64.wrappingMultiply(h ^ u32.toU64(value),1099511628211) }
fn initial()->u64 { return 14695981039346656037 }
effect fn emit32(value:u32)->() ! WriterError ? &mut Writer {
  let mut bytes:[u8;4]=[0;4]
  let mut i:usize=0
  while i<4 { bytes[i]=u32.toU8(u32.shiftRight(value,usize.toU32(i*8)) & 255) i=i+1 }
  run Writer.writeAll(&bytes)
}
effect fn emit64(value:u64)->() ! WriterError ? &mut Writer {
  let mut bytes:[u8;8]=[0;8]
  let mut i:usize=0
  while i<8 { bytes[i]=u64.toU8(u64.shiftRight(value,usize.toU64(i*8)) & 255) i=i+1 }
  run Writer.writeAll(&bytes)
}
struct Compiled { status:u32, program:RegExpProgram }
effect fn compile(pattern:&[u8],flags:u32)->Compiled ! OutOfMemoryError ? &mut Allocator {
  let result=run Effect.result(RegExpCompiler.compile(pattern,flags,2048,0))
  match move result {
    Result<RegExpProgram,OutOfMemoryError | RegExpSyntaxError | RegExpStackOverflow>.Success { value } => {
      return Compiled { status:1, program:move value }
    }
    Result<RegExpProgram,OutOfMemoryError | RegExpSyntaxError | RegExpStackOverflow>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        RegExpSyntaxError e => { return Compiled { status:0, program:RegExpProgram { bytecode:List<u8>.make() } } }
        RegExpStackOverflow e => { return Compiled { status:2, program:RegExpProgram { bytecode:List<u8>.make() } } }
      }
    }
  }
}
effect fn metadata(compiled:&Compiled)->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut count:usize=0
  let mut flags:u32=0
  let mut names=List<u8>.make()
  if compiled.status==1 {
    count=compiled.program.captureCount()
    flags=compiled.program.flags()
    let trailer=compiled.program.groupNames()
    if trailer.length!=0 {
      let mut group:usize=1
      let mut at:usize=0
      while group<count {
        while trailer[at]!=0 { run names.append(trailer[at]) at=at+1 }
        run names.append(0)
        at=at+2
        group=group+1
      }
    }
  }
  let length=names.length()
  run emit32(compiled.status)
  run emit32(usize.toU32(count))
  run emit32(flags)
  run emit32(usize.toU32(length))
  let mut hash=mix(mix(mix(mix(initial(),compiled.status),usize.toU32(count)),flags),usize.toU32(length))
  let bytes=names.asSlice()
  run Writer.writeAll(bytes)
  let mut i:usize=0
  while i<length { hash=mix(hash,u8.toU32(bytes[i])) i=i+1 }
  run emit64(hash)
}
effect fn record(status:u32,captures:&[i32],polls:u32)->() ! WriterError ? &mut Writer {
  run emit32(status)
  run emit32(usize.toU32(captures.length))
  let mut hash=mix(mix(initial(),status),usize.toU32(captures.length))
  let mut i:usize=0
  while i<captures.length {
    let mut offset:u32=0
    if captures[i]>=0 { offset=i32.toU32(captures[i]) }
    else { offset=0xffffffff-i32.toU32(-(captures[i]+1)) }
    run emit32(offset)
    hash=mix(hash,offset)
    i=i+1
  }
  run emit64(hash)
  run emit32(polls)
}
effect fn executeInput<'env>(code:&[u8],bytes:&[u8],words:&[u16],wide:bool,start:usize,
  mut interrupted:for<use 'call> mut fn<'env>() -> once Effect<'call & 'env; bool ? &mut Allocator>)->RegExpMatch ! OutOfMemoryError | RegExpTimeout ? &mut Allocator {
  if wide { return run RegExpExecutor.execute16(code,words,start,move interrupted) }
  return run RegExpExecutor.execute8(code,bytes,start,move interrupted)
}
effect fn execute(code:&[u8],bytes:&[u8],words:&[u16],wide:bool,start:usize,budget:u32)->()
  ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  if code.length==0 { return run record(0xfffffffd,&[],0) }
  let mut polls:u32=0
  let callback=effect fn()->bool ? &mut Allocator { polls=polls+1 return polls>=budget }
  let result=run Effect.result(executeInput(code,bytes,words,wide,start,move callback))
  match move result {
    Result<RegExpMatch,OutOfMemoryError | RegExpTimeout>.Success { value } => {
      let mut status:u32=0
      if value.matched { status=1 }
      run record(status,value.captures.asSlice(),polls)
    }
    Result<RegExpMatch,OutOfMemoryError | RegExpTimeout>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        RegExpTimeout e => { run record(0xfffffffe,&[],polls) }
      }
    }
  }
}
effect fn probe()->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let data=FIXTURE_DATA
  let count=u32.toUsize(readU32(data,0))
  run emit32(usize.toU32(count))
  let mut at:usize=4
  let mut fixture:usize=0
  while fixture<count {
    let flags=readU32(data,at)
    let patternLength=u32.toUsize(readU32(data,at+4))
    let codeLength=u32.toUsize(readU32(data,at+8))
    let runs=u32.toUsize(readU32(data,at+12))
    at=at+16
    let pattern=Slice.view(data,at,patternLength)
    at=at+patternLength
    let reference=Slice.view(data,at,codeLength)
    at=at+codeLength
    let compiled=run compile(pattern,flags)
    run metadata(&compiled)
    let mut runIndex:usize=0
    while runIndex<runs {
      let wide=readU32(data,at)!=0
      let start=u32.toUsize(readU32(data,at+4))
      let budget=readU32(data,at+8)
      let length=u32.toUsize(readU32(data,at+12))
      at=at+16
      let mut byteLength=length
      if wide { byteLength=length*2 }
      let bytes=Slice.view(data,at,byteLength)
      at=at+byteLength
      let mut words=List<u16>.make()
      if wide {
        run words.reserve(length)
        let mut unit:usize=0
        while unit<length { run words.append(readU16(bytes,unit*2)) unit=unit+1 }
      }
      run execute(reference,bytes,words.asSlice(),wide,start,budget)
      if reference.length!=0 {
        run execute(compiled.program.asSlice(),bytes,words.asSlice(),wide,start,budget)
      } else { run record(0xfffffffd,&[],0) }
      runIndex=runIndex+1
    }
    fixture=fixture+1
  }
}
pub effect fn main()->i32 ! OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider()
  let mut out=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut out)
  return 0
}
'''


@dataclass(frozen=True)
class Run:
    wide: bool
    data: bytes
    start: int
    budget: int = 64
    must_timeout: bool = False

    @property
    def units(self):
        return len(self.data) // (2 if self.wide else 1)

    def wire(self):
        return struct.pack('<4I', self.wide, self.start, self.budget, self.units) + self.data

    def label(self):
        text = self.data.decode('utf-16-le' if self.wide else 'latin1', errors='surrogatepass')
        preview = repr(text[:100]) + ('...' if len(text) > 100 else '')
        return f'{"UTF16" if self.wide else "Latin1"} input={preview} units={self.units} start={self.start} budget={self.budget}'


@dataclass(frozen=True)
class Fixture:
    label: str
    pattern: bytes
    flags: int
    runs: tuple

    def describe(self):
        pattern = self.pattern.decode('utf-8', errors='surrogatepass')
        preview = repr(pattern[:160]) + ('...' if len(pattern) > 160 else '')
        flags = ''.join(name for name, bit in FLAGS.items() if self.flags & bit)
        return f'{self.label} /{preview}/{flags}'


@dataclass(frozen=True)
class Metadata:
    status: int
    captures: int
    flags: int
    names: bytes
    digest: int


@dataclass(frozen=True)
class Execution:
    status: int
    captures: tuple
    digest: int
    polls: int

    def summary(self):
        status = {0: 'no-match', 1: 'match', TIMEOUT: 'typed-timeout', SKIPPED: 'not-compiled'}.get(self.status, str(self.status))
        offsets = tuple(-1 if value == 0xFFFFFFFF else value for value in self.captures)
        return f'{status} captures={offsets} polls={self.polls} digest={self.digest:016x}'


@dataclass(frozen=True)
class Reference:
    metadata: Metadata
    bytecode: bytes
    error: str
    executions: tuple


class Reader:
    def __init__(self, data, source):
        self.data, self.source, self.at = data, source, 0
        self.context = 'header'

    def take(self, length):
        end = self.at + length
        if end > len(self.data):
            raise SystemExit(f'{self.source}: truncated output at {self.context}; byte {self.at}, need {length}, have {len(self.data)-self.at}')
        result = self.data[self.at:end]
        self.at = end
        return result

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def u64(self):
        return struct.unpack('<Q', self.take(8))[0]

    def blob(self):
        return self.take(self.u32())

    def finish(self):
        if self.at != len(self.data):
            raise SystemExit(f'{self.source}: {len(self.data)-self.at} unexpected trailing bytes')


def digest(values):
    result = INITIAL
    for value in values:
        result = ((result ^ value) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return result


def read_metadata(reader):
    status, captures, flags = reader.u32(), reader.u32(), reader.u32()
    names, actual = reader.blob(), reader.u64()
    expected = digest([status, captures, flags, len(names), *names])
    if expected != actual:
        raise SystemExit(f'{reader.source}: corrupt metadata digest at {reader.context}: {actual:016x} != {expected:016x}')
    return Metadata(status, captures, flags, names, actual)


def read_execution(reader):
    status, count = reader.u32(), reader.u32()
    captures = tuple(reader.u32() for _ in range(count))
    actual, polls = reader.u64(), reader.u32()
    expected = digest([status, count, *captures])
    if actual != expected:
        raise SystemExit(f'{reader.source}: corrupt execution digest at {reader.context}: {actual:016x} != {expected:016x}')
    return Execution(status, captures, actual, polls)


def make_runs(texts, *, all_starts=False, budget=64, must_timeout=False):
    runs = []
    for text in texts:
        encodings = [(True, text.encode('utf-16-le', errors='surrogatepass'))]
        if all(ord(char) <= 255 for char in text):
            encodings.insert(0, (False, text.encode('latin1')))
        for wide, data in encodings:
            length = len(data) // (2 if wide else 1)
            starts = range(length + 1) if all_starts else sorted({0, min(1, length), length // 2, length})
            for start in starts:
                runs.append(Run(wide, data, start, budget, must_timeout and start == 0))
    return tuple(dict.fromkeys(runs))


def fixtures():
    result = []

    def add(label, pattern, flags='', texts=('', 'a', 'b', 'ab', 'aab', 'ba'), **options):
        result.append(Fixture(label, pattern.encode('utf-8', errors='surrogatepass'),
                              sum(FLAGS[flag] for flag in flags), make_runs(texts, **options)))

    # Each fixture runs Latin-1 and UTF-16 where possible, at zero, interior,
    # and end offsets. Non-BMP inputs also exercise starts between surrogates.
    basics = ['', 'a', 'ab', 'a|b', '(a)|(b)', 'a|', '|a', '(?:)', '()',
              '.', '^', '$', '^$', '^a$', '\\b', '\\B', '\\b(a+)\\b', '\\B(a+)\\B']
    for pattern in basics:
        for flags in ('', 'g', 'y', 'd', 'm', 's', 'i', 'u', 'v', 'gimsydu', 'gimsydv'):
            add('anchors-empty-flags', pattern, flags, ('', 'a', 'A', 'ba', 'a\nb', '\r\n', '\u2028a\u2029', '😀a'))
    # All independent public flag combinations, excluding the mutually exclusive u/v.
    for bits in range(64):
        flags = ''.join(flag for i, flag in enumerate('gimsyd') if bits & (1 << i))
        for unicode_flag in ('', 'u', 'v'):
            add('flag-combinations', '^(.)(a?)$', flags + unicode_flag, ('a', 'Aa', '\na', '😀a'))

    escaped = [r'\0', r'\00', r'\07', r'\077', r'\377', r'\777', r'\8', r'\9', r'\11',
               r'\x00', r'\x41', r'\xE9', r'\x', r'\x0G', r'\u0041', r'\uD800', r'\uDC00',
               r'\uD83D\uDE00', r'\u{1F600}', r'\u{000041}', r'\u{110000}', r'\u{}', r'\u{',
               r'\u12', r'\cA', r'\cz', r'\c0', r'\c_', r'\c', r'\a', r'\-', r'\/',
               r'\f', r'\n', r'\r', r'\t', r'\v', r'\d', r'\D', r'\s', r'\S', r'\w', r'\W',
               r'[\b]', r'[\c0\c_]', r'[\0-\x1f]', '\\', '\x00', 'a\x00b', 'é', '😀',
               '\ud800', '\udc00', r'\k<x>', r'\k', r'\1(a)', r'(a)\1', r'(a)\2']
    escape_inputs = ('', '\0', 'a\0b', 'A', 'é', '\a', '\b', '\f\n\r\t\v', '077', '8', '11',
                     'aa', '😀', '\ud800', '\udc00', '\ud800a\udc00', '\u017f\u212a', '\u00a0\ufeff')
    for index, pattern in enumerate(escaped):
        for flags in ('', 'u', 'v'):
            add(f'escapes-{index}', pattern, flags, escape_inputs)
    for character in r'^$.*+?()[]{}\/':
        for flags in ('', 'u', 'v'):
            add('escaped-syntax-character', '\\' + character, flags, ('', character, 'a' + character))
    for pattern in ('k', 's', 'σ', '𐐀', '[a-z]', '[^a-z]', r'\w', r'\W', r'\b.', r'\B.',
                    r'(k)\1', r'(s)\1', r'(𐐀)\1', r'(?<=k)s', r'(?i:k)(?-i:s)'):
        for flags in ('i', 'iu', 'iv'):
            add('unicode-case-folding', pattern, flags,
                ('k', 'K', 'K', 's', 'S', 'ſ', 'σ', 'Σ', 'ς', '𐐀', '𐐨',
                 'kK', 'sſ', '𐐀𐐨', 'Kſ', 'Ks'), all_starts=True)

    classes = ['[]', '[^]', '[a-z]', '[^a-z]', '[z-a]', '[-a]', '[a-]', '[a-b-c]',
               '[a\\d]', '[\\d-a]', '[a-\\d]', '[\\s\\S]', '[\\w\\W]', '[\\D]', '[\\S]', '[\\W]',
               '[\\uD800-\\uDFFF]', '[😀-🙏]', '[\\u{10000}-\\u{10ffff}]', '[', '[a', '[\\]',
               '[[a-z]&&[d-f]]', '[[a-z]--[aeiou]]', '[[a-z]&&[^aeiou]]',
               '[[a-c][x-z]]', '[[a-z]--[[b-f]--[d]]]', '[a&&b]', '[a--b]',
               '[[a]--[b]&&[c]]', '[a&&]', '[&&a]', '[a--]', '[a-b--c]',
               '[!!]', '[##]', '[&&]', '[()]', r'[\!\#\&\(\)]',
               r'[\q{a|ab|abc|}]', r'[\q{ab|cd}]', r'[\q{ab|a}x]', r'[\q{a\|b|c}]',
               r'[[\q{ab|cd}]&&[\q{cd|ef}]]', r'[[\q{ab|cd}]--[\q{cd}]]',
               r'[^\q{ab}]', r'[\q{}]', r'[\q{😀|😀a}]', r'[\q{ab|a}]+']
    for index, pattern in enumerate(classes):
        for flags in ('', 'u', 'v', 'iv'):
            add(f'classes-{index}', pattern, flags,
                ('', 'abcdefxyz', 'ABC', '123_-', '\n\u00a0', 'ab', 'abc', 'cd', 'a|b', '😀a', '\ud800'))

    properties = ['ASCII', 'Any', 'Assigned', 'ASCII_Hex_Digit', 'AHex', 'White_Space', 'space',
                  'Letter', 'L', 'gc=Lu', 'General_Category=Uppercase_Letter', 'Nd',
                  'Script=Greek', 'sc=Grek', 'Script_Extensions=Hiragana', 'scx=Hira',
                  'Emoji', 'Extended_Pictographic', 'Lowercase', 'ID_Start',
                  'Basic_Emoji', 'Emoji_Keycap_Sequence', 'RGI_Emoji_Modifier_Sequence',
                  'RGI_Emoji_Flag_Sequence', 'RGI_Emoji_Tag_Sequence', 'RGI_Emoji_ZWJ_Sequence', 'RGI_Emoji',
                  'Not_A_Property', 'ascii', 'Script=NotAScript', 'gc=NotACategory',
                  'General_Category', 'Script', 'Script_Extensions', 'Script=Grek=Latn', '']
    property_inputs = ('', 'Aa0', 'éΩα', 'あー', '\u017f\u212a', '\n\u00a0\u200d', '😀', '1️⃣',
                       '👍🏽', '🇺🇸', '👩\u200d💻', '🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f')
    for name in properties:
        for prefix, flags in itertools.product(('p', 'P'), ('u', 'iu', 'v', 'iv')):
            add('properties-' + name, '\\' + prefix + '{' + name + '}', flags, property_inputs)
    for pattern in (r'\p', r'\p{', r'\p{ASCII', r'[\p{ASCII}]', r'[\P{Lowercase_Letter}]',
                    r'[[\p{ASCII}]&&[\p{Letter}]]', r'[[\p{Letter}]--[A-Z]]'):
        for flags in ('', 'u', 'iv'):
            add('property-syntax', pattern, flags, ('A', 'a', '0', 'é', 'p{ASCII'))

    groups = [r'(a)?b\1', r'(a|ab)\1', r'(a)?\1', r'(a|(b))+', r'((a)?b)+',
              r'(?=(a+))a*b\1', r'(?!((a)))b', r'(a)(?!(b))\1', r'(?=(a))a|b',
              r'(?<=([ab]+)([bc]+))$', r'(?<!ab)c', r'(?<=(a)\1)b', r'(?<=\1(a))b',
              r'(?<=((a)|(b))+)c', r'(?<=(?<x>a))\k<x>', r'(?<=(😀))\1',
              r'(?<x>a)\k<x>', r'\k<x>(?<x>a)', r'(?<x>a)|(?<x>b)',
              r'(?:(?<x>a)|(?<x>b))\k<x>', r'(?:(?<x>a)|(?<x>b))+\k<x>',
              r'(?<x>a)(?<x>b)', r'(?<x>a)|(?:(?<x>b)|(?<x>c))',
              r'(?:(?<x>a)|b)(?<x>c)', r'(?<x>a)|(?<y>b)', r'(a)(?<x>b)(c)',
              r'(?<\u0061>a)\k<a>', r'(?<α>a)\k<α>', r'(?<𐐀>a)\k<𐐀>',
              r'(?<1>a)', r'(?<>a)', r'(?<x>a)\k<y>', r'(?<x>a)\k<',
              r'(?i:a)b', r'(?i:a(?-i:b)c)', r'(?m:^a$)', r'(?s:.)', r'(?ims-m:a.)',
              r'(?i-m:a)', r'(?-i:a)', r'(?ii:a)', r'(?i-i:a)', r'(?g:a)', r'(?u:a)',
              r'(?v:a)', r'(?d:a)', r'(?y:a)', r'(?-:a)', r'(?i)', '(?', '(a', 'a)',
              r'(?=a)*', r'(?!a)?', r'(?<=a)*', r'(?>a)', r'(?(1)a|b)']
    for index, pattern in enumerate(groups):
        for flags in ('', 'i', 'u', 'v'):
            add(f'groups-direction-reset-{index}', pattern, flags,
                ('', 'a', 'b', 'c', 'ab', 'aa', 'aAa', 'aba', 'abb', 'abc', 'aabb', 'babac', '😀😀', '\na\n'), all_starts=True)

    quantifiers = ['', '?', '*', '+', '??', '*?', '+?', '{0}', '{1}', '{2}', '{0,2}', '{2,4}', '{2,}',
                   '{0,2}?', '{2,4}?', '{2,}?', '{3,2}', '{', '{q}', '{,2}', '{1,2', '{-1}',
                   '{999999999999999999999999}', '**', '++', '?+']
    for atom in ('a', '(a)', '(a|ab)', '(?:a?)', '(a?)*', '(?=a)', '[a-c]'):
        for quantifier in quantifiers:
            for flags in ('', 'u', 'v'):
                add('quantifier-progress', atom + quantifier + 'b', flags,
                    ('', 'b', 'ab', 'aab', 'aaaab', 'abab', 'aaaaac'))
    for pattern in ('*', '+', '?', '{1}', 'a{2147483647}', 'a{2147483648}',
                    'a{0,2147483647}', 'a{2147483647,2147483646}'):
        for flags in ('', 'u', 'v'):
            add('quantifier-boundary', pattern, flags, ('', 'a', 'b'))

    # Deterministic generated grammar, including all short binary inputs.
    rng = random.Random(0x51_1C_7E)
    atoms = ['a', 'b', '.', '[ab]', '[^b]', '\\w', '(a)', '(b?)', '(?:ab|b)', '(?=a)', '(?!b)']
    suffixes = ['', '?', '*', '+', '{0,2}', '{1,3}?']
    binary = tuple(''.join(chars) for length in range(4) for chars in itertools.product('ab', repeat=length))
    for index in range(160):
        terms = [rng.choice(atoms) + rng.choice(suffixes) for _ in range(rng.randrange(1, 4))]
        pattern = ''.join(terms)
        if index % 3 == 0:
            pattern = '(?:' + pattern + '|' + rng.choice(atoms) + ')'
        if index % 4 == 0:
            pattern = '^' + pattern + '$'
        add(f'generated-{index:03}', pattern, rng.choice(('', 'i', 'y', 'u', 'v', 'iu', 'my')), binary)

    # Large undo logs (well beyond the C VM's 32-word inline stack), captures,
    # rollback, long loops, and non-empty names surrounding unnamed captures.
    for pattern, texts in [
        (r'^(a|aa)+b$', ('a' * 320 + 'b', 'a' * 24 + 'c')),
        (r'^((a)|(b))+$', ('ab' * 180, 'ab' * 180 + 'c')),
        (r'^(a?){96}a{96}$', ('a' * 96, 'a' * 192)),
        (r'^((a)?b){64}$', ('ab' * 64, 'b' * 64)),
        ('^' + '(a?)' * 96 + '$', ('a' * 96, '')),
        ('(?:' * 96 + 'a' + ')' * 96, ('a', 'b')),
        (r'^(?<first>a)(b){80}(?<last>c)\k<first>$', ('a' + 'b' * 80 + 'ca',)),
        (r'^a{20001}$', ('a' * 20001,)),
    ]:
        for flags in ('', 'u', 'v'):
            add('stack-spill-and-long-loops', pattern, flags, texts, budget=256)
    for captures in (253, 254, 255, 256):
        for flags in ('', 'u', 'v'):
            add(f'capture-limit-{captures}', '()' * captures, flags, ('', 'a'))
    for budget in (1, 2, 3):
        for pattern in (r'^(a+)+$', r'^(a|aa)+$', r'^(a?){96}a{96}$'):
            add(f'typed-timeout-{budget}', pattern, 'y', ('a' * 48 + '!',), budget=budget, must_timeout=True)
    return result


def read_reference(data, cases):
    reader = Reader(data, 'C oracle')
    if reader.u32() != len(cases):
        raise SystemExit('C oracle: wrong fixture count')
    references = []
    for index, case in enumerate(cases):
        reader.context = f'fixture {index}: {case.describe()}'
        metadata = read_metadata(reader)
        code, error = reader.blob(), reader.blob().decode('utf-8', errors='replace')
        if metadata.status not in (0, 1) or bool(code) != bool(metadata.status):
            raise SystemExit(f'C oracle: inconsistent compilation record at {reader.context}')
        if reader.u32() != len(case.runs):
            raise SystemExit(f'C oracle: wrong run count at {reader.context}')
        executions = []
        for run_index, run in enumerate(case.runs):
            reader.context = f'fixture {index} run {run_index}: {case.describe()} {run.label()}'
            execution = read_execution(reader)
            if run.must_timeout and execution.status != TIMEOUT:
                raise SystemExit(f'C oracle: timeout control did not time out at {reader.context}: {execution.summary()}')
            if execution.status == TIMEOUT and execution.polls != run.budget:
                raise SystemExit(f'C oracle: timeout callback budget violated at {reader.context}')
            executions.append(execution)
        references.append(Reference(metadata, code, error, tuple(executions)))
    reader.finish()
    return references


def native_data(cases, references):
    data = bytearray(struct.pack('<I', len(cases)))
    for case, reference in zip(cases, references, strict=True):
        data.extend(struct.pack('<4I', case.flags, len(case.pattern), len(reference.bytecode), len(case.runs)))
        data.extend(case.pattern)
        data.extend(reference.bytecode)
        for run in case.runs:
            data.extend(run.wire())
    return data


def compare_native(data, cases, references, max_mismatches):
    reader = Reader(data, 'Silk probe')
    if reader.u32() != len(cases):
        raise SystemExit('Silk probe: wrong fixture count')
    mismatches = 0
    totals = {'metadata': 0, 'reference-bytecode VM': 0, 'native-bytecode end-to-end': 0}

    def mismatch(kind, label, expected, actual):
        nonlocal mismatches
        totals[kind] += 1
        mismatches += 1
        if mismatches <= max_mismatches:
            print(f'MISMATCH [{kind}] {label}\n  C:    {expected}\n  Silk: {actual}')

    for index, (case, reference) in enumerate(zip(cases, references, strict=True)):
        reader.context = f'fixture {index}: {case.describe()}'
        actual_metadata = read_metadata(reader)
        if actual_metadata != reference.metadata:
            mismatch('metadata', reader.context, f'{reference.metadata} error={reference.error!r}', actual_metadata)
        for run_index, (run, expected) in enumerate(zip(case.runs, reference.executions, strict=True)):
            label = f'fixture {index} run {run_index}: {case.describe()} {run.label()}'
            for kind in ('reference-bytecode VM', 'native-bytecode end-to-end'):
                reader.context = f'{kind}: {label}'
                actual = read_execution(reader)
                # Poll counts must agree on identical reference instructions.
                # Native compiler optimizations may legitimately change counts.
                if ((actual.status, actual.captures, actual.digest) != (expected.status, expected.captures, expected.digest)
                        or (kind == 'reference-bytecode VM' and actual.polls != expected.polls)):
                    mismatch(kind, label, expected.summary(), actual.summary())
    reader.finish()
    if mismatches:
        counts = ', '.join(f'{kind}={count}' for kind, count in totals.items())
        raise SystemExit(f'{mismatches} RegExp records disagree ({counts}); showing first {min(mismatches,max_mismatches)}')


def validate_pins(upstream):
    pins = tomllib.loads((ROOT / 'upstream.toml').read_text())['source-sha256']
    for name in PINNED_SOURCES:
        if name not in pins:
            raise SystemExit(f'Missing upstream.toml source-sha256 pin: {name}')
        actual = hashlib.sha256((upstream / name).read_bytes()).hexdigest()
        if actual != pins[name]:
            raise SystemExit(f'Wrong upstream source: {name}\n  pinned: {pins[name]}\n  actual: {actual}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--timeout', type=int, default=600, help='wall-clock seconds allowed per compiler/probe process (default: 600)')
    parser.add_argument('--max-mismatches', type=int, default=30)
    args = parser.parse_args()
    if args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('--timeout and --max-mismatches must be positive')
    upstream = args.upstream.resolve()
    validate_pins(upstream)
    cases = fixtures()
    input_data = bytearray(struct.pack('<I', len(cases)))
    for case in cases:
        input_data.extend(struct.pack('<2I', case.flags, len(case.pattern)))
        input_data.extend(case.pattern)
        input_data.extend(struct.pack('<I', len(case.runs)))
        for run in case.runs:
            input_data.extend(run.wire())
    with tempfile.TemporaryDirectory(prefix='silkjs-regexp-') as directory:
        temp = Path(directory)
        (temp / 'oracle.c').write_text(C_SOURCE)
        subprocess.run(['cc', '-O2', '-fwrapv', '-funsigned-char', '-std=c11', '-I', str(upstream), str(temp / 'oracle.c'),
                        str(upstream / 'libregexp.c'), str(upstream / 'libunicode.c'), str(upstream / 'cutils.c'),
                        '-o', str(temp / 'oracle')], check=True, timeout=args.timeout)
        print(f'Running independent pinned RegExp C oracle: {len(cases):,} compiler fixtures...', flush=True)
        oracle = subprocess.run([str(temp / 'oracle')], input=input_data, stdout=subprocess.PIPE, timeout=args.timeout)
        if oracle.returncode:
            print(f'C oracle exited with status {oracle.returncode}; decoding completed records for location.', flush=True)
        references = read_reference(oracle.stdout, cases)
        if oracle.returncode:
            raise SystemExit(f'C oracle failed with status {oracle.returncode}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        data = native_data(cases, references)
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="regexp-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        accepted = sum(reference.metadata.status == 1 for reference in references)
        vm_cases = sum(len(case.runs) for case, reference in zip(cases, references, strict=True) if reference.bytecode)
        timeouts = sum(execution.status == TIMEOUT for reference in references for execution in reference.executions)
        controls = sum(run.must_timeout for case in cases for run in case.runs)
        latin1 = sum(not run.wide for case, reference in zip(cases, references, strict=True) if reference.bytecode for run in case.runs)
        print(f'C oracle exercised {accepted:,} accepted / {len(cases)-accepted:,} rejected patterns; '
              f'{vm_cases:,} VM cases ({latin1:,} Latin1, {vm_cases-latin1:,} UTF16), '
              f'{timeouts:,} timeouts including {controls} mandatory controls.', flush=True)
        print('Building and running standalone native Silk compiler plus both bytecode streams...', flush=True)
        native = subprocess.run([executable_path(args.silk), 'run', '--quiet', '--release', '--stdlib', str(args.stdlib.resolve())], cwd=temp, stdout=subprocess.PIPE, timeout=args.timeout)
        if native.returncode:
            print(f'Silk probe exited with status {native.returncode}; decoding completed records for location.', flush=True)
        compare_native(native.stdout, cases, references, args.max_mismatches)
        if native.returncode:
            raise SystemExit(f'Silk probe failed with status {native.returncode}')
        print(f'PASS: {len(cases):,} compiler metadata cases, {vm_cases:,} native VM executions of reference bytecode, '
              f'and {vm_cases:,} executions of native-compiled bytecode. '
              f'All public flags, deterministic grammar, captures/names, Unicode sets/properties, '
              f'Latin1/UTF16 starts, stack spill, and typed timeouts; no C linked into Silk.')


if __name__ == '__main__':
    main()
