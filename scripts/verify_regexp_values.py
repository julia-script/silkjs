#!/usr/bin/env python3
"""Exact js_compile_regexp bytecode/errors against unmodified pinned QuickJS.

Usage: python3 scripts/verify_regexp_values.py QUICKJS [--silk COMPILER] [--stdlib SDK]
Every subset/permutation of d g i m s u v y, duplicate position, UTF16/NUL,
named captures, invalid syntax and native rope inputs is exercised. C is a
separate executable, never a native dependency. Exact-byte disagreement is a
failure (unlike the semantic compiler comparator in verify_regexp.py).
"""
import argparse
import itertools
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bigint import SUPPORT, validate_pins, executable_path
from verify_compiler_state import execute
import toolchain

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
static uint32_t word(void) { uint32_t n=0; for(int i=0;i<4;i++){int c=getchar();if(c==EOF)abort();n|=(uint32_t)c<<(8*i);}return n; }
static void emit(uint32_t n) { for(int i=0;i<4;i++)putchar((n>>(8*i))&255); }
static JSValue text(JSContext *ctx) {
 uint32_t n=word(); uint16_t *p=malloc((n+1)*sizeof(*p)); if(!p)abort();
 for(uint32_t i=0;i<n;i++)p[i]=word();
 JSValue v=js_new_string16_len(ctx,p,n);free(p);if(JS_IsException(v))abort();return v;
}
int main(void) {
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 uint32_t n=word();
 for(uint32_t i=0;i<n;i++) {
  uint32_t shape=word(),undefined=word();(void)shape;
  JSValue pattern=text(ctx),flagText=text(ctx);
  JSValue code=js_compile_regexp(ctx,pattern,undefined?JS_UNDEFINED:flagText);
  if(JS_IsException(code)) {
   JSValue error=JS_GetException(ctx),message=JS_GetPropertyStr(ctx,error,"message");
   size_t len;const char *s=JS_ToCStringLen(ctx,&len,message);if(!s)abort();
   emit(0);emit(len);fwrite(s,1,len,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,message);JS_FreeValue(ctx,error);
  } else {
   JSString *s=JS_VALUE_GET_STRING(code);if(s->is_wide_char)abort();
   emit(1);emit(s->len);fwrite(s->u.str8,1,s->len,stdout);
  }
  JS_FreeValue(ctx,code);JS_FreeValue(ctx,pattern);JS_FreeValue(ctx,flagText);
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.collections.list { List }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.u16
import silk.num.u32
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringOwner, StringLengthError }
import js_regexp_compile { compileString }
import regexp_types { RegExpSyntaxError, RegExpStackOverflow }
struct Input { data: &[u8], at: usize }
impl Input {
 fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
 effect fn text(self:&mut Self)->ValueBits ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let n=u32.toUsize(self.word()) let mut units=List<u16>.make() let mut i:usize=0
  while i<n { run units.append(u32.toU16(self.word())) i=i+1 }
  return run Strings.fromUtf16(units.asSlice())
 }
}
effect fn diagnostic(error:RegExpSyntaxError)->ValueBits ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 return run Strings.fromLatin1(Intrinsic.stringUtf8Bytes(error.message))
}
effect fn compile(pattern:ValueBits,flags:ValueBits,status:&mut u32)->ValueBits
 ! OutOfMemoryError | StringLengthError | RegExpSyntaxError | RegExpStackOverflow ? &mut Allocator {
 let result=run compileString(pattern,flags,4096) status.*=1 return result
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | RegExpStackOverflow | WriterError ? &mut Allocator | &mut Writer {
 let mut input=Input { data:FIXTURE_DATA,at:0 } let n=input.word() let mut i:u32=0
 while i<n {
  let shape=input.word() let undefined=input.word()
  let mut pattern=StringOwner.adopt(run input.text()) let flags=StringOwner.adopt(run input.text())
  if shape!=0 {
   let half=Strings.length(pattern.get())/2
   let left=StringOwner.adopt(run Strings.substring(pattern.get(),0,half))
   let right=StringOwner.adopt(run Strings.substring(pattern.get(),half,Strings.length(pattern.get())))
   pattern=StringOwner.adopt(run Strings.concat(left.get(),right.get()))
  }
  let mut flagValue=flags.get() if undefined!=0 { flagValue=ValueBits.Undefined }
  let mut status:u32=0
  let result=StringOwner.adopt(run compile(pattern.get(),flagValue,&mut status) |> Effect.catch<RegExpSyntaxError>(diagnostic))
  let mut out=ByteBuffer.make() run out.writeU32(status) run out.writeU32(usize.toU32(Strings.length(result.get())))
  let mut j:usize=0 while j<Strings.length(result.get()) { run out.append(u16.toU8(Strings.codeUnit(result.get(),j))) j=j+1 }
  run Writer.writeAll(out.asSlice()) i=i+1
 }
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | RegExpStackOverflow | WriterError {
 let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
 run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''

def fixtures():
    for length in range(9):
        for flags in itertools.permutations('dgimsuvy', length):
            yield '', ''.join(flags), False, False
    for flag in 'dgimsuvy':
        for position in range(9):
            flags = 'dgimsuvy'
            yield '(', flags[:position] + flag + flags[position:], False, False
        yield 'a', flag * 2, False, False
    for flags in ['', 'u', 'v', 'gimy', 'd', 'x', '\0', 'é', '\ud800', 'uv', 'vu']:
        for pattern in ['', 'a\0b', 'éλ', '\ud800', '\udc00', '\ud83d\ude00', '\ud800A\udc00', '(?<name>a)\\k<name>', '(', '[', '*', '\\', '[z-a]', '[\\q{ab|cd}]']:
            yield pattern, flags, False, False
    yield '', '', True, False
    for flags in ['', 'u', 'v']:
        yield 'a' * 599 + '\ud83d\ude00' + 'b' * 599, flags, False, True

def units(text):
    raw = text.encode('utf-16-le', 'surrogatepass')
    return struct.unpack('<' + 'H' * (len(raw)//2), raw)

def wire(case):
    pattern, flags, undefined, rope = case
    p, f = units(pattern), units(flags)
    values = [int(rope), int(undefined), len(p), *p, len(f), *f]
    return struct.pack('<' + 'I' * len(values), *values)

def records(data, count):
    result, at = [], 0
    for index in range(count):
        if at + 8 > len(data): raise SystemExit(f'truncated record {index}')
        status, size = struct.unpack_from('<II', data, at); at += 8
        if status not in (0, 1) or at + size > len(data): raise SystemExit(f'invalid record {index}')
        result.append((status, data[at:at+size])); at += size
    if at != len(data): raise SystemExit('trailing output')
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve(); validate_pins(upstream)
    cases = list(fixtures()); data = struct.pack('<I', len(cases)) + b''.join(map(wire, cases))
    with tempfile.TemporaryDirectory(prefix='silkjs-regexp-values-') as directory:
        temp = Path(directory).resolve()
        (temp/'oracle.c').write_text(C_SOURCE)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp/'oracle.c'), *(str(upstream/name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp/'oracle')])
        import subprocess
        expected_process = subprocess.run([str(temp/'oracle')], input=data, capture_output=True, timeout=900, check=True)
        expected = records(expected_process.stdout, len(cases))
        shutil.copytree(ROOT/'src', temp/'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp/'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT/'silk.toml').read_text())['package']['silk-version']
        (temp/'silk.toml').write_text(f'[package]\nname="regexp-values-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = records(execute(command, cwd=temp, timeout=900), len(cases))
        failures = [(i, cases[i], e, a) for i, (e, a) in enumerate(zip(expected, actual)) if e != a]
        if failures:
            for item in failures[:20]: print(repr(item))
            raise SystemExit(f'{len(failures)} exact bytecode/error mismatches of {len(cases)}')
        print(f'{len(cases)} exact original-C/native bytecode and error records agree')

if __name__ == '__main__':
    main()
