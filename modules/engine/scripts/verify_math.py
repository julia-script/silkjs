#!/usr/bin/env python3
"""Compare standalone native Math kernels with original pinned QuickJS functions.

python3 scripts/verify_math.py QUICKJS

The original quickjs.c/cutils.h run in a separate C process, never linked into
Silk. Both receive identical deterministic fixtures, not each other's outputs.
NaNs alone are canonicalized; finite bits, infinities, signed zero, integer wrap,
and every PRNG state/output compare exactly. Independent explicit pins also
check both implementations, rather than blessing a shared adapter mistake.

Repeated-renormalization stress includes negative largest-finite inputs, even
when the original fixed accumulator may disagree with mathematical summation.
Those cases carry a separate independent mathematical answer: discrepancies are
reported explicitly, never normalized away or used to replace original output.
A reported upstream mathematical discrepancy is not a native/C mismatch.

The C clock adapter supplies deterministic microseconds to ORIGINAL
js_random_init; it does not reimplement seed normalization. No OS clock,
coercion of objects, iterator consumption, Math installation, transcendental
wrappers, or full Math builtin integration is claimed.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib

from verify_strings import ROOT, SUPPORT, executable_path, validate_pins, records, process
import toolchain

SIGN = 0x8000000000000000
INF = 0x7ff0000000000000
NAN = 0x7ff8000000000000
MAX = 0x7fefffffffffffff
ONE = 0x3ff0000000000000
OPS = ('unary', 'min/max', 'imul', 'sum', 'random')
UNARY = ('sign.bits', 'round.bits', 'fround.bits', 'f16round.bits', 'clz32')

C_SOURCE = r'''
#include <stdint.h>
#include <sys/time.h>
static int64_t supplied_microseconds;
static int fixture_gettimeofday(struct timeval *tv, void *zone) {
    (void)zone;
    tv->tv_sec=supplied_microseconds/1000000;
    tv->tv_usec=supplied_microseconds%1000000;
    return 0;
}
#define gettimeofday fixture_gettimeofday
#include "quickjs.c"
#undef gettimeofday
#undef malloc
#undef free
#undef realloc
static unsigned fixture;
static void die(const char *s) { fprintf(stderr,"Math oracle fixture %u: %s\n",fixture,s); exit(1); }
static unsigned byte(void) { int c=getchar(); if(c==EOF) die("truncated input"); return c; }
static uint32_t word(void) { uint32_t v=0; for(unsigned i=0;i<4;i++) v|=(uint32_t)byte()<<(8*i); return v; }
static uint64_t wide(void) { uint64_t lo=word(); return lo|((uint64_t)word()<<32); }
static double number(void) { return uint64_as_float64(wide()); }
static void put32(uint32_t v) { for(unsigned i=0;i<4;i++) putchar((v>>(8*i))&255); }
static void put64(uint64_t v) { put32(v); put32(v>>32); }
static void scalar(double d) { put64(isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d)); }
static double number_result(JSContext *ctx,JSValue value) {
    double d;
    if(JS_ToFloat64(ctx,&d,value)) die("unexpected numeric exception");
    JS_FreeValue(ctx,value); return d;
}
static void operate(JSContext *ctx) {
    unsigned op=byte();
    if(op==0) {
        double d=number(); JSValue argument=__JS_NewFloat64(ctx,d);
        put32(5); scalar(js_math_sign(d)); scalar(js_math_round(d));
        scalar(js_math_fround(d)); scalar(js_math_f16round(d));
        put64((int64_t)number_result(ctx,js_math_clz32(ctx,JS_UNDEFINED,1,&argument)));
        JS_FreeValue(ctx,argument);
    } else if(op==1) {
        double a=number(),b=number(); if(isnan(a)||isnan(b)) die("min/max precondition");
        put32(2); scalar(js_fmin(a,b)); scalar(js_fmax(a,b));
    } else if(op==2) {
        JSValue arguments[2]; arguments[0]=__JS_NewFloat64(ctx,number()); arguments[1]=__JS_NewFloat64(ctx,number());
        put32(1); put64((int64_t)number_result(ctx,js_math_imul(ctx,JS_UNDEFINED,2,arguments)));
        JS_FreeValue(ctx,arguments[0]); JS_FreeValue(ctx,arguments[1]);
    } else if(op==3) {
        SumPreciseState accumulator; sum_precise_init(&accumulator);
        unsigned n=word(); for(unsigned i=0;i<n;i++) sum_precise_add(&accumulator,number());
        put32(1); scalar(sum_precise_get_result(&accumulator));
    } else if(op==4) {
        uint64_t time_bits=wide(); memcpy(&supplied_microseconds,&time_bits,sizeof(time_bits));
        unsigned n=word(); js_random_init(ctx); uint64_t state=ctx->random_state;
        put32(1+4*n); put64(state);
        for(unsigned i=0;i<n;i++) {
            put64(xorshift64star(&state)); put64(state);
            scalar(number_result(ctx,js_math_random(ctx,JS_UNDEFINED,0,NULL))); put64(ctx->random_state);
        }
    } else die("unknown operation");
}
int main(void) {
    JSRuntime *runtime=JS_NewRuntime(); if(!runtime) die("runtime allocation");
    JSContext *ctx=JS_NewContext(runtime); if(!ctx) die("context allocation");
    unsigned count=word(); put32(count);
    for(fixture=0;fixture<count;fixture++) { operate(ctx); if(fflush(stdout)) die("stdout failure"); }
    if(getchar()!=EOF) die("trailing input");
    JS_FreeContext(ctx); JS_FreeRuntime(runtime); return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.num.u32
import silk.num.u64
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_math as math
import js_math { SumPreciseState }
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn byte(self:&mut Self)->u8 { let v=self.data[self.at] self.at=self.at+1 return v }
  fn word(self:&mut Self)->u32 { let v=readU32(self.data,self.at) self.at=self.at+4 return v }
  fn wide(self:&mut Self)->u64 { let lo=self.word() let hi=self.word() return u32.toU64(lo)|u64.shiftLeft(u32.toU64(hi),32) }
  fn number(self:&mut Self)->f64 { return f64.fromBits(self.wide()) }
}
fn signedBits(value:i32)->u64 {
  let wide=i32.toI64(value)
  if wide<0 { return i64.toU64(-(wide+1))^0xffffffffffffffff }
  return i64.toU64(wide)
}
effect fn scalar(out:&mut ByteBuffer,value:f64)->() ! OutOfMemoryError ? &mut Allocator {
  let mut bits=f64.toBits(value)
  if f64.isNaN(value) { bits=0x7ff8000000000000 }
  run out.writeU64(bits)
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer)->() ! OutOfMemoryError ? &mut Allocator {
  let op=input.byte()
  if op==0 {
    let value=input.number()
    run scalar(&mut out,math.sign(value)) run scalar(&mut out,math.round(value))
    run scalar(&mut out,math.fround(value)) run scalar(&mut out,math.f16round(value))
    run out.writeU64(signedBits(math.clz32(value)))
  } else if op==1 {
    let left=input.number() let right=input.number()
    run scalar(&mut out,math.min(left,right)) run scalar(&mut out,math.max(left,right))
  } else if op==2 {
    let left=input.number() let right=input.number()
    run out.writeU64(signedBits(math.imul(left,right)))
  } else if op==3 {
    let count=input.word() let mut accumulator=SumPreciseState.make() let mut i:u32=0
    while i<count { accumulator.add(input.number()) i=i+1 }
    run scalar(&mut out,accumulator.finish())
  } else if op==4 {
    let seed=math.randomSeed(input.wide()) let count=input.word()
    let mut rawState=seed let mut randomState=seed let mut i:u32=0
    run out.writeU64(seed)
    while i<count {
      run out.writeU64(math.xorshift64star(&mut rawState)) run out.writeU64(rawState)
      run scalar(&mut out,math.random(&mut randomState)) run out.writeU64(randomState)
      i=i+1
    }
  }
}
effect fn probe()->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word()
  let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut size=ByteBuffer.make() let mut i:u32=0
  while i<count {
    out.clear() size.clear() run operate(&mut input,&mut out)
    run size.writeU32(usize.toU32(out.length()/8))
    run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
}
pub effect fn main()->i32 ! OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def wide(value):
    return struct.pack('<Q', value & 0xffffffffffffffff)


def word(value):
    return struct.pack('<I', value)


def bits(value):
    return struct.unpack('<Q', struct.pack('<d', value))[0]


@dataclass(frozen=True)
class Case:
    op: int
    label: str
    data: bytes
    expected: tuple | None = None
    mathematical: int | None = None
    steps: int = 0

    def wire(self):
        return bytes([self.op]) + self.data

    def fields(self):
        if self.op == 0:
            return UNARY
        if self.op == 1:
            return ('min.bits', 'max.bits')
        if self.op == 2:
            return ('imul.signed',)
        if self.op == 3:
            return ('sum.bits',)
        return ('seed.state',) + tuple(f'{i}.{field}' for i in range(self.steps)
                                      for field in ('xorshift.output', 'xorshift.state', 'random.bits', 'random.state'))


def fixtures(seed, random_cases):
    cases = []
    rng = random.Random(seed)

    def unary(value, expected=None):
        cases.append(Case(0, f'number {value:016x}', wide(value), expected))

    def pair(a, b, expected=None):
        cases.append(Case(1, f'min/max {a:016x} {b:016x}', wide(a) + wide(b), expected))

    def multiply(a, b, expected=None):
        pin = None if expected is None else (expected & 0xffffffffffffffff,)
        cases.append(Case(2, f'imul {a:016x} {b:016x}', wide(a) + wide(b), pin))

    def summation(label, values, expected=None, mathematical=None):
        cases.append(Case(3, label, word(len(values)) + b''.join(map(wide, values)),
                          None if expected is None else (expected,), mathematical))

    def random_sequence(value, steps, expected=None):
        cases.append(Case(4, f'PRNG seed={value:016x} steps={steps}', wide(value) + word(steps),
                          expected=expected, steps=steps))

    # Explicit pins are independent numeric facts, not outputs of either port.
    unary(0, (0, 0, 0, 0, 32))
    unary(SIGN, (SIGN, SIGN, SIGN, SIGN, 32))
    unary(bits(-0.5), (bits(-1.0), SIGN, bits(-0.5), bits(-0.5), 32))
    unary(bits(0.5), (ONE, ONE, bits(0.5), bits(0.5), 32))
    unary(1, (ONE, 0, 0, 0, 32))
    unary(SIGN | 1, (SIGN | ONE, SIGN, SIGN, SIGN, 32))
    unary(INF, (ONE, INF, INF, INF, 32))
    unary(SIGN | INF, (SIGN | ONE, SIGN | INF, SIGN | INF, SIGN | INF, 32))
    unary(NAN | 1, (NAN, NAN, NAN, NAN, 32))
    unary(0x3ff0020000000001, (ONE, ONE, 0x3ff0020000000000, 0x3ff0040000000000, 31))
    unary(0x3ff0000010000001, (ONE, ONE, 0x3ff0000020000000, ONE, 31))
    for a, b, expected in ((0, SIGN, (SIGN, 0)), (SIGN, 0, (SIGN, 0)),
                           (SIGN, SIGN, (SIGN, SIGN)), (0, 0, (0, 0)),
                           (SIGN | INF, INF, (SIGN | INF, INF))):
        pair(a, b, expected)
    multiply(bits(4294967295.0), bits(5.0), -5)
    multiply(bits(2147483648.0), bits(2.0), 0)
    multiply(bits(4294967297.75), bits(-3.75), -3)
    multiply(INF, bits(-1.0), 0)

    # Every binary64 exponent field, signs, extreme mantissas, signaling/quiet NaN.
    for exponent in range(2048):
        for sign in (0, SIGN):
            for mantissa in (0, 1, 0xfffffffffffff):
                unary(sign | (exponent << 52) | mantissa)
    # Direct rounding around half/float subnormal, normal, overflow and midpoint
    # boundaries. Adjacent binary64 values catch accidental intermediate f32.
    boundaries = [0.5, 1.5, 2.5, 4503599627370495.5, 65520.0,
                  math.ldexp(1.0, -25), math.ldexp(1.0, -14),
                  math.ldexp(1.0, -150), math.ldexp(1.0, -126)]
    for precision, lower, upper in ((10, -24, 15), (23, -149, 127)):
        for exponent in range(lower, upper + 1):
            base = math.ldexp(1.0, exponent)
            spacing = math.ldexp(1.0, max(exponent - precision, lower))
            boundaries.extend((base, base + spacing * 0.5, base + spacing * 1.5))
    for value in boundaries:
        raw = bits(value)
        for delta in (-1, 0, 1):
            unary(raw + delta)
            unary(SIGN | (raw + delta))
    non_nan = [0, SIGN, 1, SIGN | 1, ONE, SIGN | ONE, MAX, SIGN | MAX, INF, SIGN | INF]
    for a in non_nan:
        for b in non_nan:
            pair(a, b)
    integers = [0, SIGN, bits(1.0), bits(-1.0), bits(2147483647.0), bits(2147483648.0),
                bits(4294967295.0), bits(4294967296.0), bits(4294967297.75),
                bits(9007199254740992.0), MAX, INF, NAN]
    for a in integers:
        for b in integers:
            multiply(a, b)

    half_ulp = 0x3ca0000000000000
    overflow_half = 0x7c90000000000000
    large_integer = bits(9007199254740992.0)
    for label, values, expected in (
        ('empty', [], SIGN), ('negative zeros', [SIGN] * 4, SIGN),
        ('positive zero seen', [SIGN, 0, SIGN], 0), ('finite zero cancellation', [ONE, SIGN | ONE], 0),
        ('lost unit', [large_integer, ONE, SIGN | large_integer], ONE),
        ('smallest normal carry', [0xfffffffffffff, 1], 0x0010000000000000),
        ('normal cancels to subnormal', [0x0010000000000000, SIGN | 0xfffffffffffff], 1),
        ('even tie', [ONE, half_ulp], ONE), ('odd tie', [ONE + 1, half_ulp], ONE + 2),
        ('remote sticky tie', [ONE, half_ulp, 1], ONE + 1),
        ('remote negative sticky tie', [SIGN | ONE, SIGN | half_ulp, SIGN | 1], SIGN | (ONE + 1)),
        ('overflow tie', [MAX, overflow_half], INF),
        ('below overflow tie', [MAX, overflow_half, SIGN | 1], MAX),
        ('negative overflow tie', [SIGN | MAX, SIGN | overflow_half], SIGN | INF),
        ('intermediate overflow cancellation', [MAX, MAX, SIGN | MAX, SIGN | MAX, bits(3.0)], bits(3.0)),
        ('infinity remains', [INF, SIGN | MAX, INF], INF),
        ('negative infinity remains', [SIGN | INF, MAX, SIGN | INF], SIGN | INF),
        ('opposite infinities sticky', [INF, SIGN | INF, INF], NAN),
        ('NaN sticky', [NAN, INF, SIGN | INF], NAN),
    ):
        summation(label, values, expected)

    for count in (249, 250, 251, 749, 1001):
        summation(f'positive max cancellation n={count}', [MAX] * count + [1] + [SIGN | MAX] * count, 1)
        summation(f'negative integer cancellation n={count}',
                  [SIGN | large_integer] * count + [SIGN | 1] + [large_integer] * count, SIGN | 1)
        summation(f'positive subnormals n={count}', [1] * count, count)
        summation(f'negative subnormals n={count}', [SIGN | 1] * count, SIGN | count)
        # Preserve adversarial source behavior. These independent mathematical
        # answers are reported separately, never used as C-oracle substitutes.
        summation(f'adversarial negative max cancellation n={count}',
                  [SIGN | MAX] * count + [SIGN | 1] + [MAX] * count, mathematical=SIGN | 1)
        summation(f'adversarial negative max overflow n={count}', [SIGN | MAX] * count,
                  mathematical=SIGN | INF)
        summation(f'adversarial alternating maxima n={count}', [MAX, SIGN | MAX] * count,
                  mathematical=0)
        summation(f'adversarial reverse alternating maxima n={count}', [SIGN | MAX, MAX] * count,
                  mathematical=0)
    summation('adversarial deep negative subnormal renormalization', [SIGN | 1] * 10001,
              mathematical=SIGN | 10001)
    summation('adversarial negative integer long cancellation',
              [SIGN | large_integer] * 5001 + [SIGN | 1] + [large_integer] * 5001,
              mathematical=SIGN | 1)

    # Fixed xorshift64* seed-one vector, including unmultiplied states and
    # independently encoded high-52-bit Math.random results. Seed zero uses the
    # same vector only because original initialization maps exactly zero to one.
    vector = (1, 0x47e4ce4b896cdd1d, 0x0000000002000001,
              0x3fd1f93392e25b34, 0x0000000002000001,
              0xabcfa6a8e079651d, 0x0004004000802801,
              0x3fe579f4d51c0f2c, 0x0004004000802801)
    random_sequence(1, 2, vector)
    random_sequence(0, 2, vector)
    for value in (0, 1, SIGN, 0xffffffffffffffff, 0x5555555555555555, 0xaaaaaaaaaaaaaaaa):
        random_sequence(value, 64)
    for bit in range(64):
        random_sequence(1 << bit, 16)

    for index in range(random_cases):
        a, b = rng.getrandbits(64), rng.getrandbits(64)
        unary(a)
        multiply(a, b)
        if (a & INF) != INF and (b & INF) != INF:
            pair(a, b)
        random_sequence(rng.getrandbits(64), 32)
        values = [rng.getrandbits(64) for _ in range(rng.randrange(2, 128))]
        summation(f'seeded arbitrary sum {index}', values)
        # Random exact opposite pairs force cancellation across many exponent
        # positions, without deriving any expected result from the native code.
        finite = [rng.getrandbits(64) & ~INF | rng.randrange(2047) << 52
                  for _ in range(rng.randrange(2, 96))]
        cancellation = finite + [value ^ SIGN for value in finite] + [1]
        rng.shuffle(cancellation)
        summation(f'seeded cancellation {index}', cancellation, 1)
        if index % 8 == 0:
            summation(f'seeded repeated renormalization {index}',
                      [rng.getrandbits(64) & ~INF | rng.randrange(2047) << 52 for _ in range(1251)])
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--timeout', type=int, default=900)
    parser.add_argument('--random-cases', type=int, default=96)
    parser.add_argument('--seed', type=lambda value: int(value, 0), default=0x4d415448)
    args = parser.parse_args()
    if args.timeout <= 0 or args.random_cases < 0:
        parser.error('timeout must be positive and random-cases nonnegative')
    upstream = args.upstream.expanduser().resolve()
    pin_count = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    cases = fixtures(args.seed, args.random_cases)
    data = word(len(cases)) + b''.join(case.wire() for case in cases)
    version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
    with tempfile.TemporaryDirectory(prefix='silkjs-math-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], args.timeout, owner='C Math compilation')
        c_output = process([str(temp / 'oracle')], args.timeout, owner='C Math', data=data, cases=cases)
        oracle = records(c_output, cases, 'C Math')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'silk.toml').write_text(f'[package]\nname="math-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        command = [silk, 'run', '--quiet', '--release']
        if stdlib:
            command += ['--stdlib', str(stdlib)]
        native_output = process(command, args.timeout, owner='native Math', cwd=temp, cases=cases)
        native = records(native_output, cases, 'native Math')
        failures = 0
        mathematical_differences = 0
        pinned = 0
        totals = Counter()
        for index, (case, expected, actual) in enumerate(zip(cases, oracle, native, strict=True)):
            totals[OPS[case.op]] += 1
            if case.expected is not None:
                pinned += 1
                for owner, result in (('C', expected), ('Silk', actual)):
                    if result != case.expected:
                        failures += 1
                        print(f'INDEPENDENT PIN FAILURE {owner} #{index} {case.label}')
                        for field, want, got in zip(case.fields(), case.expected, result, strict=True):
                            if want != got:
                                print(f'  {field}: pin={want:#018x} actual={got:#018x}')
            if case.mathematical is not None and expected[0] != case.mathematical:
                mathematical_differences += 1
                print(f'UPSTREAM MATHEMATICAL DIVERGENCE #{index} {case.label}: '
                      f'exact={case.mathematical:#018x} C={expected[0]:#018x} Silk={actual[0]:#018x}')
            if actual != expected:
                failures += 1
                if failures <= 30:
                    print(f'MISMATCH #{index} {case.label}')
                    for field, want, got in zip(case.fields(), expected, actual, strict=True):
                        if want != got:
                            print(f'  {field}: C={want:#018x} Silk={got:#018x}')
        if failures:
            raise SystemExit(f'{failures} Math comparison/pin failures; upstream mathematical divergences={mathematical_differences}')
        print(f'PASS: {len(cases)} independent Math records; {pinned} explicit pins; '
              f'{pin_count} pinned source files; operations={dict(totals)}')
        print(f'Native SHA256={hashlib.sha256(native_output).hexdigest()}; '
              f'upstream mathematical divergences={mathematical_differences}')
        print('Standalone kernels only: no Math object/coercion/iterator/OS-clock integration claim.')


if __name__ == '__main__':
    main()
