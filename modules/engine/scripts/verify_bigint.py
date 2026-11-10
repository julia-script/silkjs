#!/usr/bin/env python3
"""Compare native BigInt with a separately compiled, pinned 32-bit QuickJS oracle.

Usage: scripts/verify_bigint.py QUICKJS [--silk COMPILER] [--stdlib SDK]
No oracle code or oracle output is linked into, or used to generate, the native
probe. Both programs receive the same deterministic input records. All generated
sources, package copies and executables are temporary. Python integers generate
inputs only; expected records come exclusively from the independent C process.

The scanner is compared directly with js_atof on its supported integer bases.
For arbitrary bases 2..36 (an extension beyond that C scanner's documented
2/8/10/16 domain), a C adapter accumulates digits using upstream BigInt multiply
and add. Formatting is compared directly with upstream in every base. Strict
string syntax is tested separately through JS_StringToBigInt. Long negative
float comparisons deliberately retain upstream's unequal-exponent quirk; the
oracle calls the actual JS comparison path, including ShortBigInt compaction.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import itertools
from pathlib import Path
import random
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib
import toolchain

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = ('cutils.c', 'dtoa.c', 'libregexp.c', 'libunicode.c')
NAMES = ('add sub mul div rem and or xor neg not inc dec shl shr pow trunc '
         'cmp tofloat fromfloat cmpfloat format scan strict i32 u32 i64 u64 '
         'i128 u128 low64 low128 sat128 fit128 radix').split()
OPS = {name: i for i, name in enumerate(NAMES)}
ERRORS = {0: 'ok', 1: 'too-large', 2: 'division-by-zero', 3: 'negative-exponent',
          4: 'fractional', 5: 'nonfinite', 6: 'invalid-radix', 7: 'invalid-syntax',
          8: 'invalid-limbs', 9: 'does-not-fit-128'}

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || JS_SHORT_BIG_INT_BITS != 32
#error The differential oracle requires 32-bit limbs and ShortBigInts
#endif
static unsigned fixture;
static void die(const char *s) {
    fprintf(stderr, "C oracle record %u: %s\n", fixture, s); exit(1);
}
static uint32_t get32(void) {
    uint32_t v = 0;
    for (unsigned i=0;i<4;i++) { int c=getchar(); if(c==EOF) die("truncated input"); v|=(uint32_t)c<<(i*8); }
    return v;
}
static uint64_t get64(void) { uint64_t lo=get32(); return lo|((uint64_t)get32()<<32); }
static void put32(uint32_t v) { for(unsigned i=0;i<4;i++) putchar((v>>(i*8))&255); }
static void put64(uint64_t v) { put32(v); put32(v>>32); }
static void header(unsigned status, unsigned consumed, unsigned bytes) { put32(status); put32(consumed); put32(bytes); }
static unsigned exception(JSContext *ctx) {
    JSValue e=JS_GetException(ctx);
    const char *s=JS_ToCString(ctx,e);
    unsigned code=0;
    if(s && strstr(s,"too large")) code=1;
    else if(s && strstr(s,"division by zero")) code=2;
    else if(s && strstr(s,"negative exponent")) code=3;
    else if(s && strstr(s,"does not fit in 128")) code=9;
    if(!code) { fprintf(stderr,"unexpected exception: %s\n",s?s:"<unprintable>"); die("unexpected exception"); }
    JS_FreeCString(ctx,s); JS_FreeValue(ctx,e); return code;
}
static JSBigInt *input(JSContext *ctx) {
    unsigned runs=get32(), n=get32(), at=0;
    /* Fixture storage is not an operation: allow the source extension limb. */
    if(!n || n>JS_BIGINT_MAX_SIZE+1) die("bad input limb count");
    JSBigInt *a=js_malloc(ctx,sizeof(*a)+(size_t)n*sizeof(a->tab[0]));
    if(!a) die("input OOM");
    js_rc(a)->ref_count=1; a->len=n;
    for(unsigned i=0;i<runs;i++) {
        unsigned count=get32(); uint32_t word=get32();
        if(count>n-at) die("bad limb run");
        for(unsigned j=0;j<count;j++) a->tab[at++]=word;
    }
    if(at!=n) die("incomplete limb runs");
    return js_bigint_normalize(ctx,a);
}
static void emit_big(JSContext *ctx, JSBigInt *a, unsigned consumed) {
    if(!a) { header(exception(ctx),0,0); return; }
    header(0,consumed,a->len*4);
    for(int i=0;i<a->len;i++) put32(a->tab[i]);
}
static void emit_value(JSContext *ctx, JSValue v, unsigned consumed) {
    if(JS_IsException(v)) { header(exception(ctx),0,0); return; }
    if(JS_VALUE_IS_NAN(v)) { header(7,consumed,0); return; }
    JSBigIntBuf buf;
    emit_big(ctx,JS_ToBigIntBuf(ctx,&buf,v),consumed);
    JS_FreeValue(ctx,v);
}
static JSValue value(JSContext *ctx, JSBigInt *a) {
    /* Ownership transfers; preserve the source's compact ValueBits representation. */
    return JS_CompactBigInt(ctx,a);
}
static JSBigInt *radix_integer(JSContext *ctx,const char *text,unsigned base) {
    JSBigInt *a=js_bigint_new_si(ctx,0), *b=js_bigint_new_si(ctx,base);
    int negative=*text=='-'; if(negative || *text=='+') text++;
    while(*text) {
        unsigned d=to_digit(*text++);
        if(d>=base) die("bad arbitrary-radix fixture");
        JSBigInt *next=js_bigint_mul(ctx,a,b); js_free(ctx,a); a=next;
        if(!a) break;
        JSBigIntBuf buf; next=js_bigint_add(ctx,a,js_bigint_set_si(&buf,d),0);
        js_free(ctx,a); a=next; if(!a) break;
    }
    js_free(ctx,b);
    if(a && negative) { JSBigInt *next=js_bigint_neg(ctx,a); js_free(ctx,a); a=next; }
    return a;
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt) die("runtime OOM");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context OOM");
    unsigned count=get32(); put32(count);
    for(fixture=0;fixture<count;fixture++) {
        unsigned op=get32(); uint64_t x=get64(), y=get64();
        JSBigInt *a=input(ctx), *b=input(ctx), *r=NULL;
        unsigned size=get32(); char *text=malloc((size_t)size+1);
        if(!text || fread(text,1,size,stdin)!=size) die("truncated text"); text[size]=0;
        JSBigIntBuf unit; JSValue av=JS_UNDEFINED;
        switch(op) {
        case 0: r=js_bigint_add(ctx,a,b,0); break;
        case 1: r=js_bigint_add(ctx,a,b,1); break;
        case 2: r=js_bigint_mul(ctx,a,b); break;
        case 3: case 4: r=js_bigint_divrem(ctx,a,b,op==4); break;
        case 5: case 6: case 7: r=js_bigint_logic(ctx,a,b,op==5?OP_and:op==6?OP_or:OP_xor); break;
        case 8: r=js_bigint_neg(ctx,a); break;
        case 9: r=js_bigint_not(ctx,a); break;
        case 10: case 11: r=js_bigint_add(ctx,a,js_bigint_set_si(&unit,1),op==11); break;
        case 12: case 13: {
            /* Source dispatch at quickjs.c js_binary_logic_slow. */
            int32_t shift=js_bigint_get_si_sat(b);
            if(shift < -INT32_MAX) shift=-INT32_MAX;
            if(op==13) shift=-shift;
            r=shift>=0?js_bigint_shl(ctx,a,shift):js_bigint_shr(ctx,a,-shift); break;
        }
        case 14: r=js_bigint_pow(ctx,a,b); break;
        case 15: {
            JSValue args[2]={JS_NewFloat64(ctx,(double)x), value(ctx,a)}; a=NULL;
            av=js_bigint_asUintN(ctx,JS_UNDEFINED,2,args,y!=0);
            JS_FreeValue(ctx,args[1]); emit_value(ctx,av,0); goto done;
        }
        case 16: header(0,0,4); put32(js_bigint_cmp(ctx,a,b)+2); goto done;
        case 17: header(0,0,8); put64(float64_as_uint64(js_bigint_to_float64(ctx,a))); goto done;
        case 18: {
            int status; r=js_bigint_from_float64(ctx,&status,uint64_as_float64(x));
            if(status) { header(status==1?4:5,0,0); goto done; } break;
        }
        case 19:
            /* Raw Float64 path: JS_NewFloat64 would compact exact i32 values. */
            header(0,0,4); put32(js_bigint_float64_cmp(ctx,a,uint64_as_float64(x))+2); goto done;
        case 20: {
            if(x<2 || x>36) { header(6,0,0); goto done; }
            av=value(ctx,a); a=NULL;
            JSValue s=js_bigint_to_string1(ctx,av,x); JS_FreeValue(ctx,av);
            if(JS_IsException(s)) { header(exception(ctx),0,0); goto done; }
            size_t n; const char *p=JS_ToCStringLen(ctx,&n,s); if(!p) die("format OOM");
            header(0,0,n); fwrite(p,1,n,stdout); JS_FreeCString(ctx,p); JS_FreeValue(ctx,s); goto done;
        }
        case 21: {
            if(x!=0 && (x<2 || x>36)) { header(6,0,0); goto done; }
            const char *end; av=js_atof(ctx,text,&end,x,y|ATOD_TYPE_BIG_INT);
            emit_value(ctx,av,(unsigned)(end-text)); goto done;
        }
        case 22: emit_value(ctx,JS_StringToBigInt(ctx,JS_NewStringLen(ctx,text,size)),0); goto done;
        case 23: emit_value(ctx,JS_NewBigInt64(ctx,(int32_t)x),0); goto done;
        case 24: emit_value(ctx,JS_NewBigUint64(ctx,(uint32_t)x),0); goto done;
        case 25: emit_value(ctx,JS_NewBigInt64(ctx,(int64_t)x),0); goto done;
        case 26: emit_value(ctx,JS_NewBigUint64(ctx,x),0); goto done;
        case 27: emit_value(ctx,JS_NewBigInt128(ctx,x,y),0); goto done;
        case 28: {
            JSValue args[2]={JS_NewInt32(ctx,128),JS_NewBigInt128(ctx,x,y)};
            av=js_bigint_asUintN(ctx,JS_UNDEFINED,2,args,0);
            JS_FreeValue(ctx,args[1]); emit_value(ctx,av,0); goto done;
        }
        case 29: {
            int64_t lo; av=value(ctx,a); a=NULL;
            if(JS_ToBigInt64(ctx,&lo,av)) die("low64 conversion");
            JS_FreeValue(ctx,av); header(0,0,8); put64((uint64_t)lo); goto done;
        }
        case 30: {
            /* Public asUintN supplies modulo 2^128 before the signed API. */
            JSValue args[2]={JS_NewInt32(ctx,128),value(ctx,a)}; a=NULL;
            av=js_bigint_asUintN(ctx,JS_UNDEFINED,2,args,1); JS_FreeValue(ctx,args[1]);
            uint64_t lo,hi; if(JS_ToBigInt128(ctx,&lo,&hi,av)) die("low128 conversion");
            JS_FreeValue(ctx,av); header(0,0,16); put64(lo); put64(hi); goto done;
        }
        case 31: case 32: {
            uint64_t lo,hi; av=value(ctx,a); a=NULL;
            int status=op==31?JS_ToBigInt128Sat(ctx,&lo,&hi,av):JS_ToBigInt128(ctx,&lo,&hi,av);
            JS_FreeValue(ctx,av);
            if(status<0) { header(exception(ctx),0,0); goto done; }
            header(0,0,op==31?20:16); put64(lo); put64(hi); if(op==31) put32(status); goto done;
        }
        case 33: r=radix_integer(ctx,text,x); break;
        default: die("unknown operation");
        }
        emit_big(ctx,r,0); if(r) js_free(ctx,r);
    done:
        if(a) js_free(ctx,a); js_free(ctx,b); free(text);
    }
    if(getchar()!=EOF) die("extra input");
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    return ferror(stdout)?1:0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.core.result { Result }
import silk.collections.list { List }
import silk.collections.slice { Slice }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.num.u32
import silk.num.u64
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_bigint { BigInt, BigIntError, Bitwise }
import js_bigint_text { BigIntText, ParsedBigInt }
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
  fn wide(self:&mut Self)->u64 { let low=self.word() let high=self.word() return u32.toU64(low)|u64.shiftLeft(u32.toU64(high),32) }
  effect fn integer(self:&mut Self)->BigInt ! BigIntError | OutOfMemoryError ? &mut Allocator {
    let runs=self.word() let n=self.word()
    let mut words=List<u32>.make()
    run words.reserve(u32.toUsize(n))
    let mut i:u32=0
    while i<runs {
      let count=self.word() let word=self.word() let mut j:u32=0
      while j<count { run words.append(word) j=j+1 }
      i=i+1
    }
    return run BigInt.fromOwnedLimbs(move words)
  }
}
fn signed64(bits:u64)->i64 {
  if bits>=0x8000000000000000 { return -1-u64.toI64(bits^0xffffffffffffffff) }
  return u64.toI64(bits)
}
fn signed32(bits:u64)->i32 {
  let low=u64.toU32(bits & 0xffffffff)
  if low>=0x80000000 { return -1-u32.toI32(low^0xffffffff) }
  return u32.toI32(low)
}
effect fn integerBytes(a:&BigInt)->ByteBuffer ! OutOfMemoryError ? &mut Allocator {
  let mut out=ByteBuffer.make() let mut i:usize=0
  while i<a.length() { run out.writeU32(a.limb(i)) i=i+1 }
  return move out
}
effect fn operate(op:u32,x:u64,y:u64,a:&BigInt,b:&BigInt,text:&[u8],consumed:&mut u32)->ByteBuffer ! BigIntError | OutOfMemoryError ? &mut Allocator {
  let mut out=ByteBuffer.make()
  if op==16 { run out.writeU32(i32.toU32(a.compare(b)+2)) return move out }
  if op==17 { run out.writeU64(f64.toBits(a.toFloat64())) return move out }
  if op==19 { run out.writeU32(i32.toU32(a.compareFloat64(f64.fromBits(x))+2)) return move out }
  if op==20 { return run BigIntText.format(a,u64.toU32(x)) }
  if op==21 {
    let parsed=run BigIntText.parse(text,u64.toU32(x),u64.toU32(y))
    consumed.*=usize.toU32(parsed.consumed)
    return run integerBytes(&parsed.value)
  }
  if op==29 {
    run out.writeU64(a.lowU64())
    // Both signed and unsigned truncation must expose identical raw bits.
    let signed=a.lowI64()
    let mut bits:u64=0
    if signed<0 { bits=i64.toU64(-(signed+1))^0xffffffffffffffff } else { bits=i64.toU64(signed) }
    if bits!=a.lowU64() { fail BigIntError.InvalidLimbs }
    return move out
  }
  if op==30 { let v=a.low128() run out.writeU64(v.low) run out.writeU64(v.high) return move out }
  if op==31 {
    let v=a.saturatingI128() run out.writeU64(v.value.low) run out.writeU64(v.value.high)
    let mut clamped:u32=0 if v.clamped { clamped=1 }
    run out.writeU32(clamped) return move out
  }
  if op==32 { let v=run a.toI128() run out.writeU64(v.low) run out.writeU64(v.high) return move out }
  let result=run calculate(op,x,y,a,b,text)
  return run integerBytes(&result)
}
effect fn calculate(op:u32,x:u64,y:u64,a:&BigInt,b:&BigInt,text:&[u8])->BigInt ! BigIntError | OutOfMemoryError ? &mut Allocator {
  if op==0 { return run a.view().add(&b.view()) }
  if op==1 { return run a.view().subtract(&b.view()) }
  if op==2 { return run a.view().multiply(&b.view()) }
  if op==3 { return run a.view().divide(&b.view()) }
  if op==4 { return run a.view().remainder(&b.view()) }
  if op==5 { return run a.view().bitwise(&b.view(),Bitwise.And) }
  if op==6 { return run a.view().bitwise(&b.view(),Bitwise.Or) }
  if op==7 { return run a.view().bitwise(&b.view(),Bitwise.Xor) }
  if op==8 { return run a.negate() }
  if op==9 { return run a.bitNot() }
  if op==10 { return run a.increment() }
  if op==11 { return run a.decrement() }
  if op==12 || op==13 { return run a.view().shift(&b.view(),op==12) }
  if op==14 { return run a.view().power(&b.view()) }
  if op==15 { return run a.truncateBits(x,y!=0) }
  if op==18 { return run BigInt.fromFloat64(f64.fromBits(x)) }
  if op==22 { return run BigIntText.parseInteger(text) }
  if op==23 { return run BigInt.fromI32(signed32(x)) }
  if op==24 { return run BigInt.fromU32(u64.toU32(x & 0xffffffff)) }
  if op==25 { return run BigInt.fromI64(signed64(x)) }
  if op==26 { return run BigInt.fromU64(x) }
  if op==27 { return run BigInt.fromI128(x,y) }
  if op==28 { return run BigInt.fromU128(x,y) }
  if op==33 {
    let p=run BigIntText.parse(text,u64.toU32(x),1)
    return match move p { ParsedBigInt { value,consumed:_ } => move value }
  }
  fail BigIntError.InvalidLimbs
}
effect fn emit(status:u32,consumed:u32,bytes:&[u8])->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut header=ByteBuffer.make()
  run header.writeU32(status) run header.writeU32(consumed) run header.writeU32(usize.toU32(bytes.length))
  run Writer.writeAll(header.asSlice()) run Writer.writeAll(bytes)
}
effect fn probe()->() ! BigIntError | OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 }
  let count=input.word() let mut header=ByteBuffer.make()
  run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut i:u32=0
  while i<count {
    let op=input.word() let x=input.wide() let y=input.wide()
    let a=run input.integer() let b=run input.integer()
    let n=u32.toUsize(input.word()) let text=Slice.view(input.data,input.at,n) input.at=input.at+n
    let mut consumed:u32=0
    let result=run Effect.result(operate(op,x,y,&a,&b,text,&mut consumed))
    match move result {
      Result<ByteBuffer,BigIntError | OutOfMemoryError>.Success { value } => { run emit(0,consumed,value.asSlice()) }
      Result<ByteBuffer,BigIntError | OutOfMemoryError>.Failure { error } => {
        match move error {
          OutOfMemoryError e => { fail move e }
          BigIntError e => {
            let mut status:u32=0
            match e {
              BigIntError.TooLarge => { status=1 }
              BigIntError.PowerTooLarge => { status=1 }
              BigIntError.DivisionByZero => { status=2 }
              BigIntError.NegativeExponent => { status=3 }
              BigIntError.Fractional => { status=4 }
              BigIntError.NonFinite => { status=5 }
              BigIntError.InvalidRadix => { status=6 }
              BigIntError.InvalidSyntax { consumed:offset } => { status=7 if op==21 { consumed=usize.toU32(offset) } }
              BigIntError.InvalidLimbs => { status=8 }
              BigIntError.DoesNotFit128 => { status=9 }
            }
            run emit(status,consumed,&[])
          }
        }
      }
    }
    i=i+1
  }
}
pub effect fn main()->i32 ! BigIntError | OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def limbs(value):
    """Encode independent Python fixture inputs, never expected results."""
    n = max(1, (value.bit_length() + 32) // 32)
    words = [(value >> (32 * i)) & 0xffffffff for i in range(n)]
    while len(words) > 1 and words[-1] == (0xffffffff if words[-2] >> 31 else 0):
        words.pop()
    return words


def limb_wire(value):
    words = limbs(value) if isinstance(value, int) else value
    runs = [(sum(1 for _ in group), word) for word, group in itertools.groupby(words)]
    return struct.pack('<II', len(runs), len(words)) + b''.join(struct.pack('<II', *run) for run in runs)


@dataclass(frozen=True)
class Case:
    label: str
    op: str
    a: object = 0
    b: object = 0
    x: int = 0
    y: int = 0
    text: bytes = b''

    def wire(self):
        return (struct.pack('<IQQ', OPS[self.op], self.x, self.y) + limb_wire(self.a)
                + limb_wire(self.b) + struct.pack('<I', len(self.text)) + self.text)


def radix_text(n, base):
    sign = '-' if n < 0 else ''
    n = abs(n)
    digits = ''
    while n:
        n, digit = divmod(n, base)
        digits = '0123456789abcdefghijklmnopqrstuvwxyz'[digit] + digits
    return (sign + (digits or '0')).encode()


def fixtures(seed, random_cases):
    cases = []

    def add(op, a=0, b=0, *, x=0, y=0, text=b'', label=''):
        cases.append(Case(label or f'{op}/a={str(a)[:70]}/b={str(b)[:70]}/x={x}/y={y}', op, a, b, x, y, text))

    boundaries = {0, 1, -1, 2, -2, 3, -3}
    for bit in (7, 15, 30, 31, 32, 33, 52, 53, 54, 63, 64, 65, 95, 96, 127, 128, 129, 255, 256, 511, 1023, 1024):
        for delta in (-1, 0, 1):
            boundaries.update(((1 << bit) + delta, -((1 << bit) + delta)))
    boundaries = sorted(boundaries)
    unary = ('neg', 'not', 'inc', 'dec', 'tofloat', 'low64', 'low128', 'sat128', 'fit128')
    for a in boundaries:
        for op in unary:
            add(op, a)
        for width in (0, 1, 7, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255):
            for signed in (0, 1):
                add('trunc', a, x=width, y=signed)
    binary = ('add', 'sub', 'mul', 'div', 'rem', 'and', 'or', 'xor', 'cmp')
    for i, a in enumerate(boundaries):
        for b in (0, 1, -1, boundaries[-1-i], boundaries[(i * 37) % len(boundaries)]):
            for op in binary:
                add(op, a, b)
        for shift in (-257, -65, -33, -32, -31, -1, 0, 1, 31, 32, 33, 65, 257):
            add('shl', a, shift)
            add('shr', a, shift)
    rng = random.Random(seed)
    lengths = (1, 2, 3, 4, 5, 8, 16, 31, 32, 63, 64, 127)
    for i in range(random_cases):
        a = rng.getrandbits(32 * rng.choice(lengths)) * rng.choice((-1, 1))
        b = rng.getrandbits(32 * rng.choice(lengths)) * rng.choice((-1, 1))
        for op in binary + unary:
            add(op, a, b, label=f'random/{i}/{op}/bits={a.bit_length()},{b.bit_length()}')
        for op in ('shl', 'shr'):
            add(op, a, rng.randrange(-4096, 4097), label=f'random/{i}/{op}')
        add('trunc', a, x=rng.randrange(4097), y=i % 2, label=f'random/{i}/truncate')
        base = rng.randrange(2, 37)
        add('format', a, x=base, label=f'random/{i}/format/{base}')
        add('radix', x=base, text=radix_text(a, base), label=f'random/{i}/parse/{base}')
    # Division normalization and quotient-estimate correction with unequal lengths.
    for high in (0x7fffffff, 0x80000000, 0x80000001, 0xfffffffe, 0xffffffff):
        divisor = (high << 64) | 0xffffffff00000001
        for quotient in (1, 0xffffffff, 0x100000001, (1 << 129) - 1):
            for rem in (0, 1, divisor - 1):
                for sign_a, sign_b in itertools.product((-1, 1), repeat=2):
                    a, b = sign_a * (divisor * quotient + rem), sign_b * divisor
                    for op in ('div', 'rem'):
                        add(op, a, b, label=f'division-correction/{high:x}/{quotient:x}/{rem:x}/{sign_a}/{sign_b}/{op}')
    for base in range(2, 37):
        for a in (0, 1, -1, (1 << 32) - 1, -(1 << 63), (1 << 128) + 17, -((1 << 257) - 3)):
            add('format', a, x=base, label=f'all-radices/{base}/format/{a}')
            text = radix_text(a, base)
            add('radix', x=base, text=text, label=f'all-radices/{base}/parse/{a}')
            add('radix', x=base, text=text.upper(), label=f'all-radices/{base}/uppercase/{a}')
    for op in ('format', 'scan'):
        for base in (1, 37, 255):
            add(op, 123, x=base, text=b'123', label=f'{op}/invalid-radix/{base}')
    scanner_texts = (b'', b'+', b'-', b'0', b'-0', b'+12', b'123xyz', b'0x', b'0xg', b'-0x1', b'+0Xff',
                     b'0b101', b'-0b11', b'0o77', b'0123', b'078', b'09n', b'1_000', b'0_1', b'_1', b'1__2',
                     b'1_', b'0x_f', b'0xff_ffn!', b'123n', b'1.0', b'.5', b'1.', b'1e2', b'1e+', b'1e_2',
                     b'1._2', b'1.2_3n', b' 12', b'12\x0034', b'Infinity', b'-Infinity', b'NaN', b'zzzz')
    for base in (0, 2, 8, 10, 16):
        for flags in (0, 1, 4, 5, 16, 17, 32, 33, 64, 65, 100, 101, 1024, 1029, 1125):
            for text in scanner_texts:
                add('scan', x=base, y=flags, text=text, label=f'scanner/radix={base}/flags={flags:#x}/{text!r}')
    for text in ('', ' ', '\t\r\n', '\u00a0\ufeff123\u2028', '\u2003-42\u2029', '+0', '-0', '000123',
                 '0xff', '0XFF', '0b101', '0o777', '-0xff', '+0b1', '1n', '1_000', '1.0', '1e2',
                 'Infinity', 'NaN', '123 junk', '0x', '+', '-', '12\x0034', '\u200b1', '\u00851', '１２'):
        add('strict', text=text.encode(), label=f'strict/{text!r}')
    for a in (-17, -3, -2, -1, 0, 1, 2, 3, 17, 1 << 65):
        for b in (-1, 0, 1, 2, 3, 31, 32, 63, 64, 127):
            add('pow', a, b)
    for a in (-2, -1, 0, 1, 2, 3):
        for b in (1 << 31, (1 << 64) - 1, 1 << 96, (1 << 96) + 1):
            add('pow', a, b, label=f'huge-exponent/{a}/{b}')
            for shift in (b, -b):
                for op in ('shl', 'shr'):
                    add(op, a, shift, label=f'huge-shift/{op}/{a}/{shift}')
    words = (0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, (1 << 63) - 1, 1 << 63, (1 << 64) - 1)
    for x in words:
        for op in ('i32', 'u32', 'i64', 'u64'):
            add(op, x=x)
        for y in words:
            for op in ('i128', 'u128'):
                add(op, x=x, y=y)
    for i in range(random_cases):
        for op in ('i32', 'u32', 'i64', 'u64', 'i128', 'u128'):
            add(op, x=rng.getrandbits(64), y=rng.getrandbits(64), label=f'random-construct/{i}/{op}')
    floats = {0, 1, (1 << 52) - 1, 1 << 52, 0x3fe0000000000000, 0x3ff0000000000000,
              0x3ff0000000000001, 0x4004000000000000, 0x41dfffffffc00000, 0x41e0000000200000,
              0x4330000000000000, 0x4340000000000000, 0x7fefffffffffffff, 0x7ff0000000000000,
              0x7ff0000000000001, 0x7ff8000000000000}
    floats |= {rng.getrandbits(63) for _ in range(random_cases)}
    floats |= {v | (1 << 63) for v in tuple(floats)}
    for bits in sorted(floats):
        add('fromfloat', x=bits, label=f'IEEE/from/{bits:016x}')
        for a in (-((1 << 128) + 1), -(1 << 64), -2147483649, -2147483648, -3, -1, 0, 1, 3, 2147483647, 2147483648, 1 << 64, (1 << 128) + 1):
            add('cmpfloat', a, x=bits, label=f'IEEE/compare/{a}/{bits:016x}')
    for exponent in (53, 54, 63, 64, 95, 127, 255, 511, 1023, 1024):
        ulp = 1 << (exponent - 52)
        for offset in (-ulp, -ulp // 2 - 1, -ulp // 2, -ulp // 2 + 1, -1, 0, 1, ulp // 2 - 1, ulp // 2, ulp // 2 + 1, ulp):
            for sign in (-1, 1):
                add('tofloat', sign * ((1 << exponent) + offset), label=f'IEEE/rounding/{exponent}/{offset}/{sign}')
    # Allocation decisions are observable even when the mathematical result fits.
    # RLE keeps these fixtures compact without reducing the actual operand sizes.
    largest_positive = [0xffffffff] * 32767 + [0x7fffffff]
    largest_negative = [0] * 32767 + [0x80000000]
    extended_positive = [0xffffffff] * 32768 + [0]
    for op, a, b in (('inc', largest_positive, 0), ('dec', largest_negative, 0),
                     ('neg', largest_negative, 0), ('add', largest_positive, 1),
                     ('sub', largest_negative, 1), ('mul', largest_positive, 0),
                     ('div', largest_positive, 1), ('rem', largest_positive, 1),
                     ('add', extended_positive, -1), ('not', extended_positive, 0),
                     ('shr', extended_positive, 32), ('shl', largest_positive, 1)):
        add(op, a, b, label=f'allocation/{op}/limbs={len(a)}')
    for width in (1048575, 1048576, 1048577, (1 << 53) - 1):
        for a in (-1, 0, 1):
            for signed in (0, 1):
                add('trunc', a, x=width, y=signed, label=f'allocation/trunc/{a}/{width}/{signed}')
    for exponent in (1048574, 1048575, 1048576, 1048577):
        for a in (-2, 2):
            add('pow', a, exponent, label=f'allocation/pow/{a}/{exponent}')
            add('shl', a, exponent, label=f'allocation/shift/{a}/{exponent}')
    for digits in (1048543, 1048544, 1048575, 1048576):
        add('scan', x=2, y=1, text=b'1' * digits, label=f'allocation/binary-parser/digits={digits}')
    # Decimal's conservative source estimate rejects before its true bit limit.
    for digits in (310679, 310680, 310689, 310690):
        add('scan', x=10, y=1, text=b'9' * digits, label=f'allocation/decimal-parser/digits={digits}')
    return cases


def validate_pins(upstream):
    pins = tomllib.loads((ROOT / 'upstream.toml').read_text())['source-sha256']
    pending, seen = ['quickjs.c', *SUPPORT], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        if name not in pins:
            raise SystemExit(f'Missing upstream.toml source-sha256 pin: {name}')
        data = (upstream / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != pins[name]:
            raise SystemExit(f'Wrong upstream source {name}:\n  pinned {pins[name]}\n  actual {digest}')
        pending.extend(re.findall(r'^\s*#\s*include\s+"([^"\n]+)"', data.decode(), re.MULTILINE))
    return len(seen)


def records(data, cases, owner):
    at = 0

    def take(n, label):
        nonlocal at
        if at + n > len(data):
            raise SystemExit(f'{owner}: truncated output at record {label}, byte {at}; wanted {n} bytes')
        result = data[at:at+n]
        at += n
        return result

    count, = struct.unpack('<I', take(4, 'count'))
    if count != len(cases):
        raise SystemExit(f'{owner}: record count {count}, expected {len(cases)}')
    output = []
    for i, case in enumerate(cases):
        label = f'{i} [{case.label}]'
        status, consumed, size = struct.unpack('<III', take(12, label))
        if status not in ERRORS or (status and size):
            raise SystemExit(f'{owner}: invalid status/payload header at {label}: {status}/{size}')
        output.append((status, consumed, take(size, label)))
    if at != len(data):
        raise SystemExit(f'{owner}: {len(data)-at} unexpected trailing bytes')
    return output


def summarize(record, case):
    status, consumed, payload = record
    prefix = f'{ERRORS[status]}, consumed={consumed}'
    if status:
        return prefix
    if case.op == 'format':
        return f'{prefix}, text={payload[:160]!r}, bytes={len(payload)}'
    if len(payload) <= 40:
        return f'{prefix}, little-endian bytes={payload.hex()}'
    return f'{prefix}, bytes={len(payload)}, first={payload[:24].hex()}, last={payload[-24:].hex()}, sha256={hashlib.sha256(payload).hexdigest()}'


def executable_path(value):
    candidate = Path(value).expanduser()
    if candidate.exists() or '/' in value:
        return str(candidate.resolve())
    found = shutil.which(value)
    if not found:
        raise SystemExit(f'Executable not found: {value}')
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()), help='native compiler executable (default: pinned installed release)')
    parser.add_argument('--stdlib', type=Path, help='source standard library for the selected compiler', default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc', help='C compiler executable (default: cc)')
    parser.add_argument('--seed', type=lambda value: int(value, 0), default=0x51A7B16)
    parser.add_argument('--random-cases', type=int, default=160)
    parser.add_argument('--timeout', type=int, default=900, help='seconds per compiler/probe process')
    parser.add_argument('--max-mismatches', type=int, default=20)
    args = parser.parse_args()
    if args.random_cases < 0 or args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('random-cases must be nonnegative; timeout/max-mismatches must be positive')
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.resolve() if args.stdlib else None
    cases = fixtures(args.seed, args.random_cases)
    data = struct.pack('<I', len(cases)) + b''.join(case.wire() for case in cases)
    with tempfile.TemporaryDirectory(prefix='silkjs-bigint-') as directory:
        # Compiler source discovery requires canonical /private/var on macOS.
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        subprocess.run([cc, '-O2', '-fwrapv', '-funsigned-char', '-std=gnu11', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                        '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                        *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread',
                        '-o', str(temp / 'oracle')], check=True, timeout=args.timeout)
        print(f'Independent 32-bit C oracle: {len(cases):,} records, {pins} validated source hashes, seed={args.seed:#x}', flush=True)
        oracle = subprocess.run([str(temp / 'oracle')], input=data, stdout=subprocess.PIPE, timeout=args.timeout)
        expected = records(oracle.stdout, cases, 'C oracle')
        if oracle.returncode:
            raise SystemExit(f'C oracle exited with status {oracle.returncode}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="bigint-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if stdlib is not None:
            command.extend(('--stdlib', str(stdlib)))
        print('Building and running native Silk probe (no C linkage)...', flush=True)
        native = subprocess.run(command, cwd=temp, stdout=subprocess.PIPE, timeout=args.timeout)
        actual = records(native.stdout, cases, 'Silk probe')
        if native.returncode:
            raise SystemExit(f'Silk probe exited with status {native.returncode}')
        failures = Counter()
        mismatch_count = 0
        for i, (case, reference, observed) in enumerate(zip(cases, expected, actual, strict=True)):
            if reference == observed:
                continue
            mismatch_count += 1
            failures[case.op] += 1
            if mismatch_count <= args.max_mismatches:
                print(f'MISMATCH #{i} [{case.label}]\n  C:    {summarize(reference, case)}\n  Silk: {summarize(observed, case)}')
        if mismatch_count:
            raise SystemExit(f'{mismatch_count} BigInt mismatches ({dict(failures)}); showing first {min(mismatch_count,args.max_mismatches)}')
        totals = Counter(case.op for case in cases)
        errors = Counter(ERRORS[record[0]] for record in expected)
        print(f'PASS: {len(cases):,} independently compared BigInt records. Operations: {dict(totals)}. Outcomes: {dict(errors)}.')


if __name__ == '__main__':
    main()
