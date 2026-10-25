#!/usr/bin/env python3
"""Compare native Silk Unicode modules with the pinned upstream C executable.

Usage: python3 scripts/verify_unicode.py /path/to/quickjs
C is compiled ONLY as an independent reference process in a temporary directory.
The Silk probe links no QuickJS C code. Product sources are never modified.
"""
import argparse
import ast
import hashlib
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib
from pathlib import Path
import toolchain
from verify_bytecode import executable_path

ROOT = Path(__file__).resolve().parents[1]
BLOCK = 1024
LIMIT = 0x110000

C_SOURCE = r'''
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "cutils.h"
#include "libunicode.h"
static uint64_t mix(uint64_t h, uint32_t value) { return (h ^ value) * UINT64_C(1099511628211); }
static uint64_t initial(void) { return UINT64_C(14695981039346656037); }
static void emit(uint64_t h) {
    for (int i = 0; i < 8; i++) putchar((h >> (8*i)) & 255);
}
static void *allocate(void *opaque, void *ptr, size_t size) { (void)opaque; return realloc(ptr, size); }
static void sequence(void *opaque, const uint32_t *points, int length) {
    uint64_t *h = opaque;
    *h = mix(*h, length);
    for (int i = 0; i < length; i++) *h = mix(*h, points[i]);
}
static void property(const char *name, int kind, int extensions) {
    CharRange range;
    cr_init(&range, NULL, allocate);
    int ret = kind == 0 ? unicode_general_category(&range, name) :
              kind == 1 ? unicode_script(&range, name, extensions) : unicode_prop(&range, name);
    if (ret == -1) abort();
    uint64_t h = mix(initial(), ret);
    if (ret == 0) {
        /* Compare character sets, not whether a producer split adjacent runs.
           Silk CharRange maintains a canonical representation on insertion. */
        if (cr_op1(&range, NULL, 0, CR_OP_UNION)) abort();
        h = mix(h, range.len);
        for (int i = 0; i < range.len; i++) h = mix(h, range.points[i]);
    }
    emit(h);
    if (ret == 0) {
        for (int mode = 0; mode < 2; mode++) {
            CharRange canon;
            cr_init(&canon, NULL, allocate);
            if (cr_copy(&canon, &range) || cr_regexp_canonicalize(&canon, mode)) abort();
            h = mix(initial(), canon.len);
            for (int i = 0; i < canon.len; i++) h = mix(h, canon.points[i]);
            emit(h);
            cr_free(&canon);
        }
    } else { emit(0); emit(0); }
    cr_free(&range);
}
static void sequences(const char *name) {
    CharRange range;
    cr_init(&range, NULL, allocate);
    uint64_t h = initial();
    int ret = unicode_sequence_prop(name, sequence, &h, &range);
    if (ret == -1) abort();
    emit(mix(h, ret));
    cr_free(&range);
}
int main(void) {
    for (uint32_t base = 0; base < 0x110000; base += 1024) {
        uint64_t h = initial();
        for (uint32_t c = base; c < base + 1024; c++) {
            uint32_t out[3];
            for (int mode = 0; mode < 3; mode++) {
                int n = lre_case_conv(out, c, mode);
                h = mix(h, n);
                for (int i = 0; i < n; i++) h = mix(h, out[i]);
            }
            h = mix(h, lre_canonicalize(c, 0));
            h = mix(h, lre_canonicalize(c, 1));
            h = mix(h, !!lre_is_cased(c));
            h = mix(h, !!lre_is_case_ignorable(c));
            h = mix(h, !!lre_is_soft_dotted(c));
            h = mix(h, !!lre_is_id_start(c));
            h = mix(h, !!lre_is_id_continue(c));
            h = mix(h, !!lre_is_space(c));
            h = mix(h, !!lre_js_is_ident_first(c));
            h = mix(h, !!lre_js_is_ident_next(c));
            h = mix(h, unicode_get_cc(c));
            uint8_t bytes[6];
            int n = unicode_to_utf8(bytes, c);
            h = mix(h, n);
            for (int i = 0; i < n; i++) h = mix(h, bytes[i]);
            const uint8_t *end = bytes;
            h = mix(h, unicode_from_utf8(bytes, n, &end));
            h = mix(h, end - bytes);
        }
        emit(h);
    }
    for (uint32_t base = 0; base < 65536; base += 1024) {
        uint64_t h = initial();
        for (uint32_t v = base; v < base + 1024; v++) {
            uint8_t bytes[2] = { v >> 8, v & 255 };
            const uint8_t *end = bytes;
            h = mix(h, unicode_from_utf8(bytes, 2, &end));
            h = mix(h, end - bytes);
        }
        emit(h);
    }
    for (int mode = 0; mode < 4; mode++) {
        for (uint32_t base = 0; base < 0x110000; base += 1024) {
            uint64_t h = initial();
            for (uint32_t c = base; c < base + 1024; c++) {
                uint32_t *out;
                int n = unicode_normalize(&out, &c, 1, mode, NULL, allocate);
                if (n < 0) abort();
                h = mix(h, n);
                for (int i = 0; i < n; i++) h = mix(h, out[i]);
                free(out);
            }
            emit(h);
        }
        uint32_t seed = 123456789;
        uint64_t h = initial();
        for (int row = 0; row < 4096; row++) {
            uint32_t input[16], *out;
            for (int i = 0; i < 16; i++) {
                seed = seed * 1664525U + 1013904223U;
                input[i] = i % 3 == 0 ? seed % 0x110000 : 0x300 + seed % 0x70;
            }
            int n = unicode_normalize(&out, input, 16, mode, NULL, allocate);
            if (n < 0) abort();
            h = mix(h, n);
            for (int i = 0; i < n; i++) h = mix(h, out[i]);
            free(out);
        }
        emit(h);
    }
    /* PROPERTY_CALLS */
    return ferror(stdout) ? 1 : 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.list { List }
import silk.option { Option }
import silk.result { Result }
import silk.os_writer { StdoutWriter }
import silk.slice { Slice }
import silk.u8
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }
import unicode_case { UnicodeCase }
import unicode_normalization { UnicodeNormalization, Normalization }
import unicode_properties { UnicodeProperties, UnknownProperty }
import unicode_ranges { CharRange }
import utf8 { Utf8, Decoded }

fn mix(h: u64, value: u32) -> u64 {
  return u64.wrappingMultiply(h ^ u32.toU64(value), 1099511628211)
}
fn initial() -> u64 { return 14695981039346656037 }
fn flag(value: bool) -> u32 {
  if value { return 1 }
  return 0
}
effect fn emit(h: u64) -> () ! WriterError ? &mut Writer {
  let mut bytes: [u8; 8] = [0; 8]
  let mut i: usize = 0
  while i < 8 {
    bytes[i] = u64.toU8(u64.shiftRight(h, usize.toU64(i * 8)) & 255)
    i = i + 1
  }
  run Writer.writeAll(&bytes)
}
fn digestNormalized(h: u64, points: &[u32]) -> u64 {
  let mut hash = mix(h, usize.toU32(points.length))
  let mut i: usize = 0
  while i < points.length {
    hash = mix(hash, points[i])
    i = i + 1
  }
  return hash
}
effect fn lookupProperty(name: string, kind: u32, extensions: bool) -> CharRange
  ! OutOfMemoryError | UnknownProperty ? &mut Allocator {
  if kind == 0 { return run UnicodeProperties.generalCategory(name) }
  if kind == 1 { return run UnicodeProperties.script(name, extensions) }
  return run UnicodeProperties.property(name)
}
effect fn property(name: string, kind: u32, extensions: bool) -> ()
  ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let result = run Effect.result(lookupProperty(name, kind, extensions))
  match move result {
    Result<CharRange, OutOfMemoryError | UnknownProperty>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        UnknownProperty e => {
          run emit(mix(initial(), 0xfffffffe))
          run emit(0)
          run emit(0)
        }
      }
    }
    Result<CharRange, OutOfMemoryError | UnknownProperty>.Success { value } => {
      run emit(digestNormalized(mix(initial(), 0), CharRange.points(&value)))
      let mut mode: u32 = 0
      while mode < 2 {
        let mut canon = run CharRange.copy(&value)
        run CharRange.canonicalize(&mut canon, mode != 0)
        run emit(digestNormalized(initial(), CharRange.points(&canon)))
        mode = mode + 1
      }
    }
  }
}
effect fn digestSequence(points: &[u32], hash: &mut u64) -> () {
  hash.* = digestNormalized(hash.*, points)
}
effect fn sequences(name: string) -> ()
  ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut hash = initial()
  let result = run Effect.result(UnicodeProperties.sequences(name, digestSequence(&mut hash)))
  match move result {
    Result<(), OutOfMemoryError | UnknownProperty>.Success { value } => { run emit(mix(hash, 0)) }
    Result<(), OutOfMemoryError | UnknownProperty>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        UnknownProperty e => { run emit(mix(hash, 0xfffffffe)) }
      }
    }
  }
}
effect fn probe() -> () ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut base: u32 = 0
  while base < 0x110000 {
    let mut h = initial()
    let mut c = base
    while c < base + 1024 {
      let mut mode: u32 = 0
      while mode < 3 {
        let converted = UnicodeCase.convert(c, mode)
        h = mix(h, usize.toU32(converted.length))
        let mut i: usize = 0
        while i < converted.length {
          h = mix(h, converted.points[i])
          i = i + 1
        }
        mode = mode + 1
      }
      h = mix(h, UnicodeCase.canonicalize(c, false))
      h = mix(h, UnicodeCase.canonicalize(c, true))
      h = mix(h, flag(UnicodeCase.isCased(c)))
      h = mix(h, flag(UnicodeCase.isCaseIgnorable(c)))
      h = mix(h, flag(UnicodeCase.isSoftDotted(c)))
      h = mix(h, flag(UnicodeCase.isIdStart(c)))
      h = mix(h, flag(UnicodeCase.isIdContinue(c)))
      h = mix(h, flag(UnicodeCase.isSpace(c)))
      h = mix(h, flag(UnicodeCase.isIdentifierStart(c)))
      h = mix(h, flag(UnicodeCase.isIdentifierContinue(c)))
      h = mix(h, UnicodeNormalization.combiningClass(c))
      let mut bytes: [u8; 6] = [0; 6]
      let n = Utf8.encode(c, &mut bytes)
      h = mix(h, usize.toU32(n))
      let mut i: usize = 0
      while i < n {
        h = mix(h, u8.toU32(bytes[i]))
        i = i + 1
      }
      let decoded = Utf8.decode(Slice.view(&bytes, 0, n))
      match move decoded {
        Option<Decoded>.Some { value } => {
          h = mix(h, value.codePoint)
          h = mix(h, usize.toU32(value.length))
        }
        Option<Decoded>.None => { h = mix(mix(h, 0xffffffff), 0) }
      }
      c = c + 1
    }
    run emit(h)
    base = base + 1024
  }
  base = 0
  while base < 65536 {
    let mut h = initial()
    let mut v = base
    while v < base + 1024 {
      let bytes: [u8; 2] = [u32.toU8(u32.shiftRight(v, 8)), u32.toU8(v & 255)]
      let decoded = Utf8.decode(&bytes)
      match move decoded {
        Option<Decoded>.Some { value } => {
          h = mix(h, value.codePoint)
          h = mix(h, usize.toU32(value.length))
        }
        Option<Decoded>.None => { h = mix(mix(h, 0xffffffff), 0) }
      }
      v = v + 1
    }
    run emit(h)
    base = base + 1024
  }
  let forms = [Normalization.Nfc, Normalization.Nfd, Normalization.Nfkc, Normalization.Nfkd]
  let mut form: usize = 0
  while form < 4 {
    base = 0
    while base < 0x110000 {
      let mut h = initial()
      let mut c = base
      while c < base + 1024 {
        let source = [c]
        let normalized = run UnicodeNormalization.normalize(&source, forms[form])
        h = digestNormalized(h, List<u32>.asSlice(&normalized))
        c = c + 1
      }
      run emit(h)
      base = base + 1024
    }
    let mut seed: u32 = 123456789
    let mut h = initial()
    let mut row: usize = 0
    while row < 4096 {
      let mut source: [u32; 16] = [0; 16]
      let mut i: usize = 0
      while i < 16 {
        seed = u32.wrappingAdd(u32.wrappingMultiply(seed, 1664525), 1013904223)
        if i % 3 == 0 { source[i] = seed % 0x110000 }
        else { source[i] = 0x300 + seed % 0x70 }
        i = i + 1
      }
      let normalized = run UnicodeNormalization.normalize(&source, forms[form])
      h = digestNormalized(h, List<u32>.asSlice(&normalized))
      row = row + 1
    }
    run emit(h)
    form = form + 1
  }
  // PROPERTY_CALLS
}
pub effect fn main() -> i32 ! OutOfMemoryError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut out = StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut out)
  return 0
}
'''


def names(header, table):
    body = re.search(r'static const char\s+' + table + r'\[\]\s*=\s*(.*?);', header, re.S)[1]
    text = ''.join(ast.literal_eval(s) for s in re.findall(r'"(?:[^"\\]|\\.)*"', body))
    return [alias for entry in text.split('\x00') if entry for alias in entry.split(',')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pin = tomllib.loads((ROOT / 'upstream.toml').read_text())
    for filename, expected in pin['source-sha256'].items():
        actual = hashlib.sha256((upstream / filename).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f'Wrong upstream source: {filename}')
    header = (upstream / 'libunicode-table.h').read_text()
    c_calls, silk_calls = [], []
    labels = [f'scalar U+{base:06X}..U+{base+BLOCK-1:06X}' for base in range(0, LIMIT, BLOCK)]
    labels += [f'two-byte input {base:04X}..{base+BLOCK-1:04X}' for base in range(0, 65536, BLOCK)]
    for form in ['NFC', 'NFD', 'NFKC', 'NFKD']:
        labels += [f'{form} singleton U+{base:06X}..U+{base+BLOCK-1:06X}' for base in range(0, LIMIT, BLOCK)]
        labels.append(f'{form} 4096 mixed combining sequences')
    for kind, table in enumerate(['unicode_gc_name_table', 'unicode_script_name_table', 'unicode_prop_name_table']):
        for name in names(header, table) + ['Invalid_Property_Name', '']:
            for extensions in ([False, True] if kind == 1 else [False]):
                c_calls.append(f'property("{name}", {kind}, {int(extensions)});')
                silk_calls.append(f'run property("{name}", {kind}, {str(extensions).lower()})')
                label = f'{table}: {name!r} extensions={extensions}'
                labels.extend([label, label + ' legacy canonicalization', label + ' Unicode canonicalization'])
    for name in names(header, 'unicode_sequence_prop_name_table') + ['Invalid_Property_Name', '']:
        c_calls.append(f'sequences("{name}");')
        silk_calls.append(f'run sequences("{name}")')
        labels.append(f'sequences: {name!r}')
    with tempfile.TemporaryDirectory(prefix='silkjs-unicode-') as directory:
        temp = Path(directory)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('/* PROPERTY_CALLS */', '\n'.join(c_calls)))
        subprocess.run(['cc', '-O2', '-fwrapv', '-funsigned-char', '-I', str(upstream), str(temp / 'oracle.c'),
                        str(upstream / 'libunicode.c'), str(upstream / 'cutils.c'), '-o', str(temp / 'oracle')], check=True)
        print('Running independent upstream reference...', flush=True)
        expected = subprocess.run([str(temp / 'oracle')], check=True, capture_output=True).stdout
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('// PROPERTY_CALLS', '\n'.join(silk_calls)))
        manifest = tomllib.loads((ROOT / 'silk.toml').read_text())
        version = manifest['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname = "unicode-differential"\nversion = "0.0.0"\nsilk-version = "{version}"\n')
        print('Building and running independent native Silk probe...', flush=True)
        actual = subprocess.run([executable_path(args.silk), 'run', '--quiet', '--release', '--stdlib', str(args.stdlib.resolve())], cwd=temp, stdout=subprocess.PIPE, check=True).stdout
        size = len(labels) * 8
        if len(actual) != size or len(expected) != size:
            raise SystemExit(f'Wrong record count: expected {size} bytes, C {len(expected)}, Silk {len(actual)}')
        differences = []
        for index, label in enumerate(labels):
            a, b = actual[index*8:(index+1)*8], expected[index*8:(index+1)*8]
            if a != b:
                differences.append(f'{label}: Silk {struct.unpack("<Q", a)[0]:016x}, C {struct.unpack("<Q", b)[0]:016x}')
        if differences:
            print('\n'.join(differences[:30]))
            raise SystemExit(f'{len(differences)} differential blocks disagree')
        print(f'PASS: {len(labels)} differential digest records; all {LIMIT:,} Unicode code points, '
              'all 65,536 two-byte inputs, all four normalization forms, 16,384 mixed normalization sequences, '
              'all upstream category/script/property aliases and emoji sequences.')


if __name__ == '__main__':
    main()
