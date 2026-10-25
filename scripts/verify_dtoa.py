#!/usr/bin/env python3
"""Differentially execute native Silk dtoa against an independent pinned C process.

Usage: python3 scripts/verify_dtoa.py /path/to/quickjs
No C code is linked into the Silk executable. All build artifacts are temporary.
"""
import argparse
import hashlib
from pathlib import Path
import random
import shutil
import struct
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]

C_SOURCE = r'''
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "dtoa.h"
static uint64_t mix(uint64_t h, uint32_t v) { return (h ^ v) * UINT64_C(1099511628211); }
static uint64_t initial(void) { return UINT64_C(14695981039346656037); }
static void emit(uint64_t h) { for (int i=0;i<8;i++) putchar((h>>(8*i))&255); }
static uint64_t canonical_bits(double value) {
    uint64_t bits; memcpy(&bits, &value, 8);
    if ((bits & UINT64_C(0x7fffffffffffffff)) > UINT64_C(0x7ff0000000000000)) return UINT64_C(0x7ff8000000000000);
    return bits;
}
static void output(uint64_t bits, int radix, int digits, int flags) {
    double value; memcpy(&value, &bits, 8);
    char buf[2048]; JSDTOATempMem memory;
    int length=js_dtoa(buf, value, radix, digits, flags, &memory);
    /* Upstream's max_len underestimates subnormal fixed/EXP_DISABLED output.
       It is not an oracle for storage safety; the native bound is checked below. */
    if (length < 0 || length >= 2048 || buf[length] != 0) {
        fprintf(stderr, "C format contract: bits=%016llx radix=%d digits=%d flags=%d length=%d bound=%d terminator=%d\n",
                (unsigned long long)bits,radix,digits,flags,length,js_dtoa_max_len(value,radix,digits,flags),buf[length]);
        abort();
    }
    uint64_t h=mix(initial(), length);
    for (int i=0;i<length;i++) h=mix(h,(unsigned char)buf[i]);
    emit(h);
}
static void parse(const char *text, int radix, int flags) {
    const char *end; JSATODTempMem memory;
    double value=js_atod(text, &end, radix, flags, &memory);
    uint64_t bits=canonical_bits(value);
    emit(mix(mix(mix(initial(),bits&UINT32_MAX),bits>>32),end-text));
}
static void integer(uint64_t bits, int radix, int kind) {
    char buf[70]; memset(buf,0x55,sizeof(buf));
    int length;
    switch(kind) {
    case 0: length=u64toa_radix(buf,bits,radix); break;
    case 1: length=i64toa_radix(buf,(int64_t)bits,radix); break;
    case 2: length=u32toa(buf,(uint32_t)bits); break;
    case 3: length=i32toa(buf,(int32_t)bits); break;
    case 4: length=u64toa(buf,bits); break;
    default: length=i64toa(buf,(int64_t)bits); break;
    }
    if (length<0 || length>=70 || buf[length]!=0x55) abort();
    uint64_t h=mix(initial(),length);
    for (int i=0;i<length;i++) h=mix(h,(unsigned char)buf[i]);
    emit(h);
}
static const uint64_t values[] = { VALUES };
static const char *inputs[] = { INPUTS };
int main(void) {
    const int free_flags[]={0,4,8,16,20,24};
    const int digits[]={1,2,6,17,50,100,101};
    for (unsigned i=0;i<sizeof(values)/sizeof(values[0]);i++) {
        for (int radix=2;radix<=36;radix++)
            for (int j=0;j<6;j++) output(values[i],radix,0,free_flags[j]);
        for (int j=0;j<7;j++) {
            for (int exp=0;exp<=8;exp+=4) output(values[i],10,digits[j],1|exp);
            output(values[i],10,digits[j],2);
        }
        output(values[i],10,0,2);
        for (int radix=2;radix<=36;radix++)
            for (int kind=0;kind<2;kind++) integer(values[i],radix,kind);
        for (int kind=2;kind<6;kind++) integer(values[i],10,kind);
    }
    for (unsigned i=0;i<sizeof(inputs)/sizeof(inputs[0]);i++)
        for (int radix=0;radix<=36;radix++) {
            if (radix==1) continue;
            for (int flags=0;flags<16;flags++) parse(inputs[i],radix,flags);
        }
    return ferror(stdout)?1:0;
}
'''

SILK_SOURCE = r'''
import silk.effect { Effect }
import silk.f64
import silk.i32
import silk.i64
import silk.os_writer { StdoutWriter }
import silk.slice { Slice }
import silk.u8
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }
import byte_buffer { readU64 }
import dtoa { Dtoa }

fn mix(h:u64,value:u32)->u64 { return u64.wrappingMultiply(h ^ u32.toU64(value),1099511628211) }
fn initial()->u64 { return 14695981039346656037 }
effect fn emit(h:u64)->() ! WriterError ? &mut Writer {
  let mut bytes:[u8;8]=[0;8]
  let mut i:usize=0
  while i<8 {
    bytes[i]=u64.toU8(u64.shiftRight(h,usize.toU64(i*8)) & 255)
    i=i+1
  }
  run Writer.writeAll(&bytes)
}
fn canonicalBits(value:f64)->u64 {
  let bits=f64.toBits(value)
  if (bits & 0x7fffffffffffffff)>0x7ff0000000000000 { return 0x7ff8000000000000 }
  return bits
}
effect fn output(bits:u64,radix:u32,digits:u32,flags:u32)->() ! WriterError ? &mut Writer {
  let value=f64.fromBits(bits)
  let mut buffer:[u8;2048]=[0x55;2048]
  let length=Dtoa.format(&mut buffer,value,radix,digits,flags)
  if length>=2048 || length>=Dtoa.maxLength(value,radix,digits,flags) || buffer[length]!=0 {
    Intrinsic.trap("QuickJS invariant violated")
  }
  let mut h=mix(initial(),usize.toU32(length))
  let mut i:usize=0
  while i<length { h=mix(h,u8.toU32(buffer[i])) i=i+1 }
  run emit(h)
}
effect fn parse(text:&[u8],radix:u32,flags:u32)->() ! WriterError ? &mut Writer {
  let parsed=Dtoa.parse(text,radix,flags)
  let bits=canonicalBits(parsed.value)
  let h=mix(mix(mix(initial(),u64.toU32(bits & 0xffffffff)),u64.toU32(u64.shiftRight(bits,32))),usize.toU32(parsed.consumed))
  run emit(h)
}
effect fn integer(bits:u64,radix:u32,kind:u32)->() ! WriterError ? &mut Writer {
  let mut buffer:[u8;70]=[0x55;70]
  let mut signed=u64.toI64(bits & 0x7fffffffffffffff)
  if (bits & 0x8000000000000000)!=0 { signed=i64.MIN+signed }
  let mut signed32=u64.toI32(bits & 0x7fffffff)
  if (bits & 0x80000000)!=0 { signed32=i32.MIN+signed32 }
  let length=match kind {
    0 => Dtoa.u64toaRadix(&mut buffer,bits,radix)
    1 => Dtoa.i64toaRadix(&mut buffer,signed,radix)
    2 => Dtoa.u32toa(&mut buffer,u64.toU32(bits & 0xffffffff))
    3 => Dtoa.i32toa(&mut buffer,signed32)
    4 => Dtoa.u64toa(&mut buffer,bits)
    _ => Dtoa.i64toa(&mut buffer,signed)
  }
  if length>=70 || buffer[length]!=0x55 { Intrinsic.trap("QuickJS invariant violated") }
  let mut h=mix(initial(),usize.toU32(length))
  let mut i:usize=0
  while i<length { h=mix(h,u8.toU32(buffer[i])) i=i+1 }
  run emit(h)
}
fn input(index:usize)->&'static[u8] {
  return match index {
    INPUT_CASES
    _ => b""
  }
}
effect fn probe()->() ! WriterError ? &mut Writer {
  let values=VALUES
  let flags:[u32;6]=[0,4,8,16,20,24]
  let digits:[u32;7]=[1,2,6,17,50,100,101]
  let mut i:usize=0
  while i<values.length/8 {
    let bits=readU64(values,i*8)
    let mut radix:u32=2
    while radix<=36 {
      let mut j:usize=0
      while j<6 { run output(bits,radix,0,flags[j]) j=j+1 }
      radix=radix+1
    }
    let mut j:usize=0
    while j<7 {
      let mut exp:u32=0
      while exp<=8 { run output(bits,10,digits[j],1|exp) exp=exp+4 }
      run output(bits,10,digits[j],2)
      j=j+1
    }
    run output(bits,10,0,2)
    radix=2
    while radix<=36 {
      run integer(bits,radix,0)
      run integer(bits,radix,1)
      radix=radix+1
    }
    let mut kind:u32=2
    while kind<6 { run integer(bits,10,kind) kind=kind+1 }
    i=i+1
  }
  i=0
  while i<INPUT_COUNT {
    let mut radix:u32=0
    while radix<=36 {
      if radix!=1 {
        let mut f:u32=0
        while f<16 { run parse(input(i),radix,f) f=f+1 }
      }
      radix=radix+1
    }
    i=i+1
  }
}
pub effect fn main()->i32 ! WriterError {
  let mut out=StdoutWriter.make()
  run probe() |> Effect.provideMut<Writer>(&mut out)
  return 0
}
'''


def literal(data, prefix='b'):
    return prefix + '"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream',type=Path)
    args=parser.parse_args()
    upstream=args.upstream.resolve()
    pin=tomllib.loads((ROOT/'upstream.toml').read_text())
    for filename in ['dtoa.c','dtoa.h','cutils.c','cutils.h']:
        if hashlib.sha256((upstream/filename).read_bytes()).hexdigest()!=pin['source-sha256'][filename]:
            raise SystemExit(f'Wrong upstream source: {filename}')
    values=[0,1,2,0x000fffffffffffff,0x0010000000000000,0x0010000000000001,
            0x3fefffffffffffff,0x3ff0000000000000,0x3ff0000000000001,
            0x433fffffffffffff,0x4340000000000000,0x4340000000000001,
            0x7fefffffffffffff,0x7ff0000000000000,0x7ff0000000000001,0x7ff8000000000000]
    values += [bits | (1<<63) for bits in values]
    for value in [0.1,0.5,1.25,2.5,2.55,2.675,1e-7,1e-6,1e20,1e21,1e22,1000000000000000128.0]:
        values.append(struct.unpack('<Q',struct.pack('<d',value))[0])
    rng=random.Random(0x51_1C)
    values += [rng.getrandbits(64) for _ in range(256)]
    texts=['','+','-','0','-0','+0','00','0123','078','0x','0x10','-0x10','0XfF','0o17','0b101',
           '0b102','0x1.8p+4','0x1p-1074','1.2@+10','1e2','1E-2','1e','1e+','1e-','1e_2',
           '.','.5','-.5','1.','1.2.3','Infinity','-Infinity','+Infinity','Infinitytail','inf','NaN',
           'nan',' 1','\t1','1 ','1_2','_1','1_','1__2','0_1','0x1_f','0x_1','0b1_0',
           '1._2','1.2_3','1e1_0','1e+1_0','1e9999999999999999999999','1e-999999999999999999999',
           '2.2250738585072014e-308','2.2250738585072011e-308','4.9406564584124654e-324',
           '2.4703282292062327e-324','2.4703282292062328e-324','1.7976931348623157e308',
           '1.7976931348623159e308','9007199254740993','18446744073709551615','1\0suffix',
           '9'*600,'0.'+'0'*350+'1','1234567890123456789012345678901234567890',
           'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz','1@-1000','1p+10','00000000000000000000.0000']
    texts += [f'{rng.getrandbits(200)}e{rng.randrange(-400,401):+}' for _ in range(64)]
    encoded=[text.encode('ascii') for text in texts]
    labels=[]
    for bits in values:
        for radix in range(2,37):
            for flags in [0,4,8,16,20,24]: labels.append(f'format bits={bits:016x} radix={radix} digits=0 flags={flags}')
        for digits in [1,2,6,17,50,100,101]:
            for exp in [0,4,8]: labels.append(f'format bits={bits:016x} radix=10 digits={digits} flags={1|exp}')
            labels.append(f'format bits={bits:016x} radix=10 digits={digits} flags=2')
        labels.append(f'format bits={bits:016x} radix=10 digits=0 flags=2')
        for radix in range(2,37):
            for kind in range(2): labels.append(f'integer bits={bits:016x} radix={radix} kind={kind}')
        for kind in range(2,6): labels.append(f'integer bits={bits:016x} radix=10 kind={kind}')
    for text in texts:
        for radix in [0,*range(2,37)]:
            for flags in range(16): labels.append(f'parse {text[:80]!r} radix={radix} flags={flags}')
    c=C_SOURCE.replace('VALUES',','.join(f'UINT64_C(0x{v:016x})' for v in values))
    c=c.replace('INPUTS',','.join(literal(text,'') for text in encoded))
    silk=SILK_SOURCE.replace('VALUES',literal(b''.join(struct.pack('<Q',v) for v in values)))
    silk=silk.replace('INPUT_CASES','\n'.join(f'{i} => {literal(text)}' for i,text in enumerate(encoded)))
    silk=silk.replace('INPUT_COUNT',str(len(encoded)))
    with tempfile.TemporaryDirectory(prefix='silkjs-dtoa-') as directory:
        temp=Path(directory)
        (temp/'oracle.c').write_text(c)
        subprocess.run(['cc','-O2','-fwrapv','-funsigned-char','-I',str(upstream),str(temp/'oracle.c'),str(upstream/'dtoa.c'),str(upstream/'cutils.c'),'-lm','-o',str(temp/'oracle')],check=True)
        print('Running independent numeric C oracle...',flush=True)
        expected=subprocess.run([str(temp/'oracle')],stdout=subprocess.PIPE,check=True).stdout
        shutil.copytree(ROOT/'src',temp/'src')
        (temp/'src/main.silk').write_text(silk)
        version=tomllib.loads((ROOT/'silk.toml').read_text())['package']['silk-version']
        (temp/'silk.toml').write_text(f'[package]\nname="dtoa-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        print('Building and running native Silk numeric probe...',flush=True)
        actual=subprocess.run(['silk','run','--quiet','--release'],cwd=temp,stdout=subprocess.PIPE,check=True).stdout
        if len(actual)!=len(labels)*8 or len(expected)!=len(labels)*8:
            raise SystemExit(f'Wrong record count: expected {len(labels)*8} bytes; C={len(expected)}, Silk={len(actual)}')
        mismatches=[]
        for i,label in enumerate(labels):
            if actual[i*8:(i+1)*8]!=expected[i*8:(i+1)*8]: mismatches.append(label)
        if mismatches:
            print('\n'.join(mismatches[:30]))
            raise SystemExit(f'{len(mismatches)} numeric records disagree')
        print(f'PASS: {len(labels):,} independent numeric records; {len(values)} float/integer bitpatterns, all radices 2..36, precision through 101, exponent modes, and {len(texts)} parse inputs across all flag combinations.')


if __name__=='__main__':
    main()
