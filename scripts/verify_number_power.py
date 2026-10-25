#!/usr/bin/env python3
"""Native power fidelity to pinned, unmodified OpenLibm e_pow.c, not host pow.

python3 scripts/verify_number_power.py
The original C source is fetched into a temporary directory (or supplied with
--fdlibm-source), SHA256 checked, and compiled only into a separate oracle.
No C implementation is linked into the Silk program. Word-access compatibility
headers adapt the original source; sqrt/scalbn remain IEEE hardware/libm helpers.
Both C oracles disable contraction/builtins; the fdlibm source is never rewritten.
ECMAScript's magnitude-one/nonfinite-exponent override is applied outside it.

Platform contrasts are NOT normalized: native must first match original fdlibm
bit-for-bit. Every differing finite platform result then needs an independent
exact rational or directed Decimal interval proof, reported with operand bits,
result bits and individual error bounds. NaN representations require a specified
Number::exponentiate NaN case and are reported separately. Other differences fail.

ECMA-262 Number::exponentiate specifies implementation-approximated results:
https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-exponentiate
This is not a blanket tolerance: original algorithm fidelity is always exact.
For 42**42, exact integer arithmetic gives the platform result 0x4e1646505f35a847
error -2371071777634955768993983487197194374297 / 2**132 ulp, and the observed
native result 0x4e1646505f35a848 error +3073446093100059646420010231711097008999 /
2**132 ulp. Thus the former is nearest; the latter is within one ulp, consistent
with e_pow.c's documented \"nearly rounded\" (not correctly rounded) guarantee.
"""
import argparse
from decimal import Decimal, localcontext, ROUND_FLOOR, ROUND_CEILING
from fractions import Fraction
import hashlib
import math
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib
from urllib.request import urlopen
from verify_bytecode import executable_path, process

ROOT = Path(__file__).resolve().parents[1]
REVISION = '57dd0f905df7b8b49d638b0007a64a08a5d6535e'
SOURCE_SHA256 = '13c580f60a6e2f48ef36ff1e9c46cdd394c9cd9c0fceb18f2526404fcb949ec7'
SOURCE_URL = f'https://raw.githubusercontent.com/JuliaMath/openlibm/{REVISION}/src/e_pow.c'
# The original algorithm's GET/SET words are representation operations, not
# arithmetic. memcpy avoids aliasing and host byte-order assumptions.
WORD_HEADER = r'''
#include <stdint.h>
#include <sys/types.h>
#include <string.h>
#include <math.h>
#define OLM_DLLEXPORT
static inline uint64_t oracle_bits(double x){uint64_t u;memcpy(&u,&x,8);return u;}
static inline double oracle_double(uint64_t u){double x;memcpy(&x,&u,8);return x;}
#define EXTRACT_WORDS(hi,lo,x) do { uint64_t _u=oracle_bits(x); (hi)=(int32_t)(_u>>32); (lo)=(uint32_t)_u; } while(0)
#define GET_HIGH_WORD(hi,x) do { (hi)=(int32_t)(oracle_bits(x)>>32); } while(0)
#define SET_HIGH_WORD(x,hi) do { (x)=oracle_double(((uint64_t)(uint32_t)(hi)<<32)|(oracle_bits(x)&UINT32_MAX)); } while(0)
#define SET_LOW_WORD(x,lo) do { (x)=oracle_double((oracle_bits(x)&UINT64_C(0xffffffff00000000))|(uint32_t)(lo)); } while(0)
#define openlibm_weak_reference(a,b)
'''


def prepare_fdlibm(temp, cc, source=None):
    original = source.read_bytes() if source else urlopen(SOURCE_URL, timeout=60).read()
    digest = hashlib.sha256(original).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f'Unpinned fdlibm source: {digest}; expected {SOURCE_SHA256}')
    directory = temp / 'fdlibm'
    directory.mkdir()
    (directory / 'e_pow.c').write_bytes(original)
    (directory / 'cdefs-compat.h').write_text('/* Standalone oracle: no platform symbol aliases. */\n')
    (directory / 'openlibm_math.h').write_text('#include <math.h>\n')
    (directory / 'math_private.h').write_text(WORD_HEADER)
    obj = directory / 'power.o'
    process([cc, '-O2', '-std=gnu11', '-fwrapv', '-fno-fast-math', '-ffp-contract=off',
             '-fno-builtin', '-D__ieee754_pow=silkjs_fdlibm_pow', '-I', str(directory),
             '-c', str(directory / 'e_pow.c'), '-o', str(obj)], 120, owner='Pinned fdlibm compilation')
    return obj


def bits(number):
    return struct.unpack('<Q', struct.pack('<d', number))[0]


def number(raw):
    return struct.unpack('<d', struct.pack('<Q', raw))[0]


def mathematical_interval(x, y):
    """Enclose real x**y without calling any binary floating power/log/exp."""
    if not math.isfinite(x) or not math.isfinite(y) or x == 0 or (x < 0 and not y.is_integer()):
        raise ValueError('special/domain cases require bit-exact agreement')
    if y.is_integer() and abs(y) <= 4096:
        exact = Fraction.from_float(x) ** int(y)
        return exact, exact, 'exact-rational'
    # Decimal.ln/exp are correctly rounded ROUND_HALF_EVEN, independently of
    # context rounding. Adjacent decimal values therefore enclose each result.
    # Multiplication is explicitly directed. Conversion from binary64 is exact.
    with localcontext() as ctx:
        ctx.prec = 180
        logarithm = Decimal.from_float(abs(x)).ln()
        lo, hi = logarithm.next_minus(), logarithm.next_plus()
        exponent = Decimal.from_float(y)
        if y < 0:
            lo, hi = hi, lo
        ctx.rounding = ROUND_FLOOR
        lo = lo * exponent
        ctx.rounding = ROUND_CEILING
        hi = hi * exponent
        # Avoid expensive/unbounded Decimal exponents for impossible finite
        # contrasts. The accepted range covers every finite nonzero binary64.
        if lo < -800 or hi > 800:
            raise ValueError('finite-result proof outside bounded logarithm range')
        lo, hi = lo.exp().next_minus(), hi.exp().next_plus()
        if x < 0 and int(y) % 2:
            lo, hi = hi.copy_negate(), lo.copy_negate()
        return Fraction(lo), Fraction(hi), 'directed-decimal-180'


def bounded_contrast(xbits, ybits, original, platform):
    """Require independent finite-error bounds or the specified ECMAScript NaN."""
    x, y = number(xbits), number(ybits)
    a, b = number(original), number(platform)
    if math.isnan(a) and math.isnan(b):
        expected_nan = (math.isnan(y) or (math.isnan(x) and y != 0)
                        or (abs(x) == 1 and not math.isfinite(y))
                        or (math.isfinite(x) and x < 0 and math.isfinite(y) and not y.is_integer()))
        if not expected_nan:
            raise ValueError('NaN contrast outside a Number::exponentiate NaN case')
        # ECMA-262 6.1.6.1 has one NaN Number value; IEEE sign/payload choices are
        # implementation-defined. Preserve and report both representations.
        return (f'pow-platform/nan-representation x=0x{xbits:016x} y=0x{ybits:016x} '
                f'fdlibm=0x{original:016x} platform=0x{platform:016x}')
    if not math.isfinite(a) or not math.isfinite(b) or a == 0 or b == 0 or (a < 0) != (b < 0):
        raise ValueError('nonfinite, zero, or sign contrasts are not permitted')
    lo, hi, method = mathematical_interval(x, y)
    # Cubic/quartic fdlibm fast paths deliberately perform two rounded
    # multiplications; other split-log/exp contrasts must be within one ulp.
    bound = 2 if y in (3.0, 4.0) else 1
    errors = []
    for value in (a, b):
        unit = Fraction.from_float(math.ulp(value))
        error = max(abs(Fraction.from_float(value) - lo), abs(Fraction.from_float(value) - hi)) / unit
        with localcontext() as ctx:
            ctx.prec = 20
            ctx.rounding = ROUND_CEILING
            upper = Decimal(error.numerator) / Decimal(error.denominator)
        if error > bound:
            raise ValueError(f'{method} error <= {upper} ulp exceeds {bound} ulp')
        errors.append(upper)
    return (f'pow-platform/{method} x=0x{xbits:016x} y=0x{ybits:016x} '
            f'fdlibm=0x{original:016x} platform=0x{platform:016x} '
            f'absolute-error-ulp<={errors[0]},{errors[1]} bound={bound}')


def corpus():
    values = [0, 1, 0x000fffffffffffff, 0x0010000000000000, 0x3fe0000000000000,
              0x3fefffffffffffff, 0x3ff0000000000000, 0x3ff0000000000001,
              0x3ff3988e00000000, 0x3ffbb67a00000000, 0x7fefffffffffffff,
              0x7ff0000000000000, 0x7ff8000000000000, 0x7ff8000000000042,
              0x7ff0000000000042]
    values += [bits(v) for v in (1.5, 2., 3., 4., 42., 2.**31, 2.**53, 2.**64)]
    values += [v | (1 << 63) for v in values[:]]
    exponents = [bits(v) for v in (0., -0., .5, -.5, 1., -1., 2., -2., 3., -3., 4., -4.,
                                  42., 1023., 1024., -1022., -1074., -1075.,
                                  2147483647., 2147483648., 2147483649.,
                                  2.**53 - 1., 2.**53, 2.**64, math.inf, -math.inf, math.nan)]
    exponents += [bits(math.nextafter(v, direction)) for v in (0.5, 1., 2.**31, 2.**64)
                  for direction in (-math.inf, math.inf)]
    cases = [(x, y) for x in values for y in exponents]
    # Adjacent interval thresholds and normal/subnormal/overflow transitions.
    for x in (0x3ff3988e00000000, 0x3ffbb67a00000000, bits(2.), bits(.5)):
        for delta in (-1, 0, 1):
            cases += [(x + delta, y) for y in exponents]
    rng = random.Random(0xFD11B)
    for _ in range(1024):
        x = rng.getrandbits(64)
        cases.append((x, rng.choice(exponents)))
        cases.append((x, rng.getrandbits(64)))
    return list(dict.fromkeys(cases))


C_PROBE = r'''
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
extern double silkjs_fdlibm_pow(double,double);
static double from_bits(uint64_t u){double x;memcpy(&x,&u,8);return x;}
static void emit(double x){uint64_t u;memcpy(&u,&x,8);for(int i=0;i<8;i++)putchar((u>>(i*8))&255);}
int main(void){const uint64_t cases[][2]={@CASES@};
for(unsigned i=0;i<sizeof(cases)/sizeof(*cases);i++){
 double x=from_bits(cases[i][0]),y=from_bits(cases[i][1]);
 // QuickJS js_pow's ECMAScript override, outside the original e_pow.c.
 if(!isfinite(y)&&(x==1||x==-1)){emit(NAN);emit(NAN);}
 else {emit(silkjs_fdlibm_pow(x,y));emit(pow(x,y));}
}return 0;}
'''
SILK_PROBE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import silk.f64
import silk.u64
import byte_buffer { ByteBuffer }
import js_number_power as power
struct Case { x: u64, y: u64 }
effect fn probe() -> () ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let cases: [Case; @COUNT@] = [@CASES@]
  let mut output = ByteBuffer.make() let mut i: usize = 0
  while i < @COUNT@ {
    let result = f64.toBits(power.power(f64.fromBits(cases[i].x), f64.fromBits(cases[i].y)))
    run output.writeU32(u64.toU32(result & 0xffffffff))
    run output.writeU32(u64.toU32(u64.shiftRight(result, 32)))
    i = i + 1
  }
  run Writer.writeAll(output.asSlice())
}
pub effect fn main() -> i32 ! OutOfMemoryError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut writer = StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--fdlibm-source', type=Path)
    args = parser.parse_args()
    cc, silk = executable_path(args.cc), executable_path(args.silk)
    cases = corpus()
    with tempfile.TemporaryDirectory(prefix='silkjs-power-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        obj = prepare_fdlibm(temp, cc, args.fdlibm_source)
        (temp / 'oracle.c').write_text(C_PROBE.replace('@CASES@', ','.join(
            f'{{UINT64_C({x}),UINT64_C({y})}}' for x, y in cases)))
        process([cc, '-O2', '-fno-fast-math', '-ffp-contract=off', '-fno-builtin',
                 str(temp / 'oracle.c'), str(obj), '-lm', '-o', str(temp / 'oracle')],
                120, owner='Power C oracle compilation')
        reference = process([str(temp / 'oracle')], 120, owner='Power C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_PROBE.replace('@COUNT@', str(len(cases))).replace(
            '@CASES@', ','.join(f'Case {{ x: {x}, y: {y} }}' for x, y in cases)))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="number-power-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native power oracle', cwd=temp)
        if len(reference) != len(cases) * 16 or len(actual) != len(cases) * 8:
            raise SystemExit('Invalid power oracle output size')
        contrasts = []
        for index, (x, y) in enumerate(cases):
            original, platform = struct.unpack_from('<QQ', reference, index * 16)
            native, = struct.unpack_from('<Q', actual, index * 8)
            if native != original:
                raise SystemExit(f'Power fidelity mismatch {index}: x={x:#018x} y={y:#018x} '
                                 f'fdlibm={original:#018x} native={native:#018x}')
            if platform != original:
                try:
                    contrasts.append(bounded_contrast(x, y, original, platform))
                except (ValueError, ArithmeticError) as error:
                    raise SystemExit(f'Unexplained power platform mismatch {index}: {error}') from error
        for contrast in contrasts:
            print(contrast)
        nan_count = sum('pow-platform/nan-representation' in entry for entry in contrasts)
        print(f'PASS power: {len(cases)} exact native/fdlibm matches; '
              f'{len(cases) - len(contrasts)} exact platform matches; '
              f'{len(contrasts) - nan_count} bounded finite contrasts; {nan_count} NaN representation contrasts; '
              f'OpenLibm={REVISION} source-SHA256={SOURCE_SHA256}; native-SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
