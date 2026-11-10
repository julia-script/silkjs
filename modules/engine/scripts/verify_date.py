#!/usr/bin/env python3
"""Compare native Date helpers with original pinned QuickJS helpers.

python3 scripts/verify_date.py QUICKJS

The oracle includes quickjs.c in a standalone C executable; nothing is linked
into Silk. Source hashes (including recursively included headers) are validated
against upstream.toml before compilation. Identical binary fixtures exercise
calendar arithmetic, TimeClip, checked/unchecked MakeDate, field extraction,
all 16 formatting mode/part pairs, both raw grammars and Date.parse UTF16 input.

Timezone scope is explicit: the C oracle calls the ORIGINAL getTimezoneOffset
and the platform C library under POSIX TZ. The native fixture provider models
UTC, fixed west/east half/quarter-hour zones, and the 2020 US DST transitions.
DST cases are restricted to 2020. This tests provider integration and transition
selection, NOT Silk OS timezone acquisition, historical tzdb, clock access,
locale overrides, JS coercion, Date object dispatch, or allocator failures.
The provider never consumes oracle outputs. NaNs alone are canonicalized;
all other floating encodings, grammar fields, and formatted bytes compare exactly.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import random
import shutil
import struct
import subprocess
import tempfile
import tomllib

# Shared process/pin/protocol utilities, not implementation or expected data.
from verify_strings import ROOT, SUPPORT, executable_path, validate_pins, records
import toolchain

ZONES = ('UTC0', 'EST5', 'NPT-5:45', 'NST3:30', 'EST5EDT,M3.2.0/2,M11.1.0/2')
FIELD_NAMES = ('year', 'month', 'date', 'hour', 'minute', 'second', 'ms', 'weekday', 'east')

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
static void die(const char *s) { fprintf(stderr,"Date oracle: %s\n",s); exit(1); }
static unsigned byte(void) { int c=getchar(); if(c==EOF) die("truncated input"); return c; }
static uint32_t word(void) { uint32_t v=0; for(unsigned i=0;i<4;i++) v|=(uint32_t)byte()<<(8*i); return v; }
static uint64_t wide(void) { uint64_t lo=word(); return lo|((uint64_t)word()<<32); }
static double number(void) { union { uint64_t u; double d; } v={.u=wide()}; return v.d; }
static void put32(uint32_t n) { for(unsigned i=0;i<4;i++) putchar((n>>(8*i))&255); }
static void put64(uint64_t n) { put32(n); put32(n>>32); }
static void scalar(double d) { put64(isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d)); }
static void operate(JSContext *ctx) {
    unsigned op=byte();
    if(op==0) {
        unsigned n=word(); uint16_t *units=malloc((n?n:1)*sizeof(*units)); if(!units) die("OOM");
        for(unsigned i=0;i<n;i++) units[i]=word();
        JSValue s=js_new_string16_len(ctx,units,n); free(units);
        if(JS_IsException(s)) die("string allocation");
        JSValue r=js_Date_parse(ctx,JS_UNDEFINED,1,&s); double d;
        if(JS_ToFloat64(ctx,&d,r)) die("Date.parse exception");
        put32(1); scalar(d); JS_FreeValue(ctx,r); JS_FreeValue(ctx,s);
    } else if(op==1) {
        int checked=byte(), local=byte(); double f[7]; for(int i=0;i<7;i++) f[i]=number();
        double d=checked?set_date_fields_checked(f,local):set_date_fields(f,local);
        put32(8); scalar(d); for(int i=0;i<7;i++) scalar(f[i]);
    } else if(op==2) {
        double d=number(); int local=byte(), force=byte(); double f[9]={0};
        JSValue obj=JS_NewDate(ctx,d); if(JS_IsException(obj)) die("date allocation");
        int ok=get_date_fields(ctx,obj,f,local,force); if(ok<0) die("fields exception");
        put32(10); put64(ok); for(int i=0;i<9;i++) scalar(f[i]); JS_FreeValue(ctx,obj);
    } else if(op==3) {
        double d=number(); unsigned fmt=byte(), part=byte();
        JSValue obj=JS_NewDate(ctx,d); if(JS_IsException(obj)) die("date allocation");
        JSValue s=get_date_string(ctx,obj,0,NULL,(fmt<<4)|part); uint8_t out[64]={0}; size_t n=0;
        int invalid=JS_IsException(s);
        if(invalid) { JSValue e=JS_GetException(ctx); JS_FreeValue(ctx,e); if(fmt!=2 || !isnan(d)) die("unexpected format exception"); }
        else { const char *p=JS_ToCStringLen(ctx,&n,s); if(!p || n>=64) die("format conversion"); memcpy(out,p,n); JS_FreeCString(ctx,p); }
        put32(66); put64(invalid); put64(n); for(int i=0;i<64;i++) put64(out[i]);
        JS_FreeValue(ctx,s); JS_FreeValue(ctx,obj);
    } else if(op==4) {
        int64_t d=(int64_t)wide(), y=(int64_t)wide(), day=d; int64_t year=year_from_days(&day);
        put32(4); put64(year); put64(day); put64(days_from_year(y)); put64(days_in_year(y));
    } else if(op==5) {
        uint8_t bytes[512]; unsigned n=word(); if(n>=sizeof(bytes)) die("raw grammar bound");
        for(unsigned i=0;i<n;i++) bytes[i]=byte(); bytes[n]=0;
        put32(22);
        for(int mode=0;mode<2;mode++) {
            int f[9]={0}; BOOL local=FALSE;
            int ok=mode?js_date_parse_otherstring(bytes,f,&local):js_date_parse_isostring(bytes,f,&local);
            put64(ok); put64(ok?local:0); for(int i=0;i<9;i++) put64(ok?(int64_t)f[i]:0);
        }
    } else if(op==6) { put32(1); scalar(time_clip(number())); }
    else if(op==7) {
        unsigned n=word(); JSValue args[9]; if(n>9) die("UTC argument bound");
        for(unsigned i=0;i<n;i++) args[i]=JS_NewFloat64(ctx,number());
        JSValue r=js_Date_UTC(ctx,JS_UNDEFINED,n,args); double d;
        if(JS_ToFloat64(ctx,&d,r)) die("UTC exception"); put32(1); scalar(d);
        JS_FreeValue(ctx,r); for(unsigned i=0;i<n;i++) JS_FreeValue(ctx,args[i]);
    } else die("unknown op");
}
int main(void) {
    tzset(); JSRuntime *rt=JS_NewRuntime(); if(!rt) die("runtime allocation");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context allocation");
    unsigned count=word(); put32(count); for(unsigned i=0;i<count;i++) operate(ctx);
    if(getchar()!=EOF) die("trailing input"); JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.collections.slice { Slice }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.num.u8
import silk.num.u32
import silk.num.u64
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_date as date
import js_date { DateTimezone }
import js_date_parse as parser
import js_date_format as formatter
struct Zone { mode:u32 }
impl DateTimezone for Zone {
  fn offsetMinutesWest(self:&mut Self, ms:i64)->i32 {
    if self.mode==0 { return 0 }
    if self.mode==1 { return 300 }
    if self.mode==2 { return -345 }
    if self.mode==3 { return 210 }
    // The original provider truncates milliseconds toward zero to seconds.
    let seconds=ms/1000
    if seconds>=1583650800 && seconds<1604210400 { return 240 }
    return 300
  }
}
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn byte(self:&mut Self)->u8 { let n=self.data[self.at] self.at=self.at+1 return n }
  fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
  fn wide(self:&mut Self)->u64 { let lo=self.word() let hi=self.word() return u32.toU64(lo)|u64.shiftLeft(u32.toU64(hi),32) }
  fn number(self:&mut Self)->f64 { return f64.fromBits(self.wide()) }
}
fn signed(bits:u64)->i64 { if bits>=0x8000000000000000 { return -1-u64.toI64(bits^0xffffffffffffffff) } return u64.toI64(bits) }
fn flag(b:bool)->u64 { if b { return 1 } return 0 }
fn signedBits(n:i64)->u64 { if n<0 { return i64.toU64(-(n+1))^0xffffffffffffffff } return i64.toU64(n) }
effect fn scalar(out:&mut ByteBuffer,n:f64)->() ! OutOfMemoryError ? &mut Allocator {
  let mut bits=f64.toBits(n) if f64.isNaN(n) { bits=0x7ff8000000000000 } run out.writeU64(bits)
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer,zone:&mut Zone)->() ! OutOfMemoryError ? &mut Allocator {
  let op=input.byte()
  if op==0 {
    let n=u32.toUsize(input.word()) let mut units:[u16;512]=[0;512] let mut i:usize=0
    while i<n { units[i]=u32.toU16(input.word()) i=i+1 }
    run scalar(&mut out,parser.parse(&mut zone,Slice.view<u16>(&units,0,n)))
  } else if op==1 {
    let checked=input.byte()!=0 let local=input.byte()!=0 let mut f:[f64;7]=[0.0;7] let mut i:usize=0
    while i<7 { f[i]=input.number() i=i+1 }
    let mut d:f64=0.0
    if checked { d=date.setDateFieldsChecked(&mut zone,&mut f,local) } else { d=date.setDateFields(&mut zone,&f,local) }
    run scalar(&mut out,d) i=0 while i<7 { run scalar(&mut out,f[i]) i=i+1 }
  } else if op==2 {
    let d=input.number() let local=input.byte()!=0 let force=input.byte()!=0 let mut f:[f64;9]=[0.0;9]
    let ok=date.getDateFields(&mut zone,d,local,force,&mut f)
    run out.writeU64(flag(ok)) let mut i:usize=0 while i<9 { run scalar(&mut out,f[i]) i=i+1 }
  } else if op==3 {
    let d=input.number() let fmt=u8.toU32(input.byte()) let part=u8.toU32(input.byte()) let mut bytes:[u8;64]=[0;64]
    let result=formatter.format(&mut zone,d,fmt,part,&mut bytes)
    run out.writeU64(flag(result.invalidIso)) run out.writeU64(usize.toU64(result.length))
    let mut i:usize=0 while i<64 { run out.writeU64(u8.toU64(bytes[i])) i=i+1 }
  } else if op==4 {
    let d=signed(input.wide()) let y=signed(input.wide()) let year=date.yearFromDays(d)
    run out.writeU64(signedBits(year.year)) run out.writeU64(signedBits(year.day))
    run out.writeU64(signedBits(date.daysFromYear(y))) run out.writeU64(signedBits(date.daysInYear(y)))
  } else if op==5 {
    let n=u32.toUsize(input.word()) let mut bytes:[u8;512]=[0;512] let mut i:usize=0
    while i<n { bytes[i]=input.byte() i=i+1 }
    let mut mode:u32=0 while mode<2 {
      let mut f:[i32;9]=[0;9] let mut local=false let mut ok=false
      if mode==0 { ok=parser.parseIso(&bytes,&mut f,&mut local) } else { ok=parser.parseLegacy(&bytes,&mut f,&mut local) }
      run out.writeU64(flag(ok)) run out.writeU64(flag(ok && local)) i=0
      while i<9 { let mut n:u64=0 if ok { n=signedBits(i32.toI64(f[i])) } run out.writeU64(n) i=i+1 }
      mode=mode+1
    }
  } else if op==6 { run scalar(&mut out,date.timeClip(input.number())) }
  else if op==7 {
    let n=u32.toUsize(input.word()) let mut args:[f64;9]=[0.0;9] let mut i:usize=0
    while i<n { args[i]=input.number() i=i+1 }
    run scalar(&mut out,date.utc(&mut zone,Slice.view<f64>(&args,0,n)))
  }
}
effect fn probe()->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word() let mut zone=Zone { mode:ZONE_MODE }
  let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut size=ByteBuffer.make() let mut i:u32=0
  while i<count {
    out.clear() size.clear() run operate(&mut input,&mut out,&mut zone)
    run size.writeU32(usize.toU32(out.length()/8)) run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
}
pub effect fn main()->i32 ! OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def u32(n):
    return struct.pack('<I', n)


def wide(n):
    return struct.pack('<Q', n & ((1 << 64) - 1))


def double(n):
    return struct.pack('<d', n)


@dataclass
class Case:
    op: int
    label: str
    payload: bytes

    def wire(self):
        return bytes([self.op]) + self.payload

    def fields(self):
        if self.op in (0, 6, 7):
            return ('value.bits',)
        if self.op == 1:
            return ('value.bits', *(f'normalized.{n}.bits' for n in FIELD_NAMES[:7]))
        if self.op == 2:
            return ('valid', *(f'{n}.bits' for n in FIELD_NAMES))
        if self.op == 3:
            return ('invalidIso', 'length', *(f'byte[{i}]' for i in range(64)))
        if self.op == 4:
            return ('year', 'day-in-year', 'days-from-year', 'days-in-year')
        return tuple(f'{mode}.{name}' for mode in ('ISO', 'legacy') for name in ('valid', 'local', *FIELD_NAMES))


def fixtures(zone, seed, random_cases):
    rng = random.Random(seed)
    cases = []

    def parse(s):
        raw = s.encode('utf-16le', errors='surrogatepass')
        units = struct.unpack(f'<{len(raw)//2}H', raw)
        cases.append(Case(0, f'parse {s!r}', u32(len(units)) + b''.join(u32(c) for c in units)))
        if all(ord(c) <= 255 for c in s) and len(s) < 511:
            raw = s.encode('latin1')
            cases.append(Case(5, f'grammars {s!r}', u32(len(raw)) + raw))

    def construct(f, checked=True, local=False):
        cases.append(Case(1, f'MakeDate {f} checked={checked} local={local}', bytes([checked, local]) + b''.join(map(double, f))))

    values = [0.0, -1.0, 1.0, -86400001.0, 951782400000.0, -62167219200000.0,
              -62198755200000.0, 253402300800000.0, -8640000000000000.0, 8640000000000000.0,
              1583650799999.0, 1583650800000.0, 1583650800001.0,
              1604210399999.0, 1604210400000.0, 1604210400001.0, float('nan')]
    if zone == 4:
        values = [v for v in values if 1577836800000 <= v < 1609459200000]
    for value in values:
        for local in (False, True):
            for force in (False, True):
                cases.append(Case(2, f'fields {value} local={local} force={force}', double(value) + bytes([local, force])))
        for fmt in range(4):
            for part in range(4):
                cases.append(Case(3, f'format {value} fmt={fmt} part={part}', double(value) + bytes([fmt, part])))

    texts = [
        '2020', '2020-01', '2020-01-01', '2020-01-01T00:00', '2020-01-01T00:00Z',
        '2020-01-01T00:00:00.123456789Z', '2020-01-01T00:00:00,123456789Z',
        '2020-01-01T00:00:00.1234567890Z', '2020-01-01T00:00:00.Z',
        '2020-01-01T24:00:00.000Z', '2020-01-01T24:00:00.001Z',
        '2020-01-01T24:01Z', '2020-01-01T00:60Z', '2020-01-01T00:00:60Z',
        '2020-01-01T0:00Z', '2020-01-01T00:0Z', '2020-01-01T',
        '2020-00-01', '2020-13-01', '2020-01-00', '2020-01-32', '2020-02-30',
        '2020-01-01T00:00+05:45', '2020-01-01T00:00-0330',
        '2020-01-01T00:00+05', '2020-01-01T00:00+2400', '2020-01-01T00:00+0060',
        '2020-01-01z', '2020-01-01Z', '2020-01-01junk', '2020\x00junk',
        'Wed, 01 Jan 2020 00:00:00 GMT', 'January 1, 2020 12:00 AM',
        'January 1, 2020 12:00 PM', 'January 1, 2020 1:02:03.004 PM',
        '1/2/2020', '2020/1/2', '1.2.2020', 'January 1 2020 (a (b) c)',
        '(a (b)) January 1 2020', 'January 1 2020 (', 'January 1 2020 )',
        'January 1 2020 junk', 'junk January 1 2020', 'Wed\tJan 1 2020',
        '2020-03-08T01:59:59.999', '2020-03-08T02:00:00', '2020-03-08T03:00:00',
        '2020-11-01T01:00:00', '2020-11-01T02:00:00',
    ]
    for name in ('GMT', 'UTC', 'UT', 'Z', 'EDT', 'EST', 'CDT', 'CST', 'MDT', 'MST', 'PDT', 'PST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST'):
        texts.append(f'Jan 1 2020 1:02 {name.lower()}')
    for offset in ('+1', '+01', '+123', '+1234', '+123456', '+12345678', '-00:30', '+24', '+2360'):
        texts.append(f'Jan 1 2020 1:02 {offset}')
    if zone != 4:
        texts += ['', ' ', 'junk', '-000000', '+000000', '\u2212000001', '-000001',
                  '+275760-09-13T00:00:00-01:00', '+275760-09-13T00:00:00.001Z',
                  '-271821-04-20T00:00:00+01:00', '0', '1', '12', '13', '31', '32', '49', '50', '99',
                  'Jan 1 49', 'Jan 1 50', '01/02/03', '1000000000', '000000000000000000001',
                  '\ud8002020', '2020\u0100', '2020\xff', '2020\x00\udfff']
        texts += ['2020' + ' ' * 123 + 'junk', '2020' + ' ' * 122 + 'x',
                  '2020\x00' + 'x' * 150, 'Jan 1 2020 (' + 'x' * 200 + ')']
    for s in texts:
        parse(s)

    for month in (-25, -12, -1, 0, 1, 11, 12, 25):
        for day in (0, 1, 29, 31, 32):
            for local in (False, True):
                if zone != 4 or month in (0, 1, 11) and day in (1, 29):
                    construct([2020, month, day, 24, -1, 61, 1001], local=local)
    if zone != 4:
        for year in (-271822, -271821, -1, -0.9, 0, 1, 49, 99.9, 100, 1900, 2000, 275760, 275761):
            construct([year, 0, 1, 0, 0, 0, 0])
            construct([int(year), 0, 1, 0, 0, 0, 0], checked=False)
        for i in range(7):
            for bad in (float('nan'), float('inf'), -float('inf')):
                f = [99.9, 1.9, 2.9, 3.9, 4.9, 5.9, 6.9]
                f[i] = bad
                construct(f)
        # Cancellation/FMA/order stress, finite intermediate overflow, saturation.
        for f in ([1970, 0, 1, 1e12, -6e13, 0, 1],
                  [1970, 0, 1, 0, 1e14, -6e15, 1],
                  [1970, 0, 1, 1e308, 0, 0, 0],
                  [1970, 0, 1, 3e12, 0, 0, 0],
                  [1970, 0, 1, -3e12, 0, 0, 0],
                  [275760, 8, 13, 0, 0, 0, 0]):
            for local in (False, True):
                construct(f, local=local)
        for args in ([], [0], [99, 0], [2000, 1, 29], [2020, 0, 1, 0, 0, 0, 0, float('nan'), float('inf')]):
            cases.append(Case(7, f'UTC {args}', u32(len(args)) + b''.join(map(double, args))))
        for value in (-0.0, -0.1, -0.9999, 0.9999, -8640000000000000., 8640000000000000.,
                      -8640000000000001., 8640000000000001., float('inf'), -float('inf'), float('nan')):
            cases.append(Case(6, f'TimeClip {value}', double(value)))
        for y in (-271821, -4000, -401, -400, -100, -4, -1, 0, 1, 4, 100, 400, 1600, 1900, 1969, 1970, 2000, 2100, 275760):
            # Day inputs are independent boundaries, not derived by native code.
            for d in (-100000000, -719529, -719528, -1, 0, 365, 10957, 11016, 100000000):
                cases.append(Case(4, f'calendar day={d} year={y}', wide(d) + wide(y)))
    for _ in range(random_cases):
        y = 2020 if zone == 4 else rng.randrange(-271821, 275761)
        month = rng.randrange(12)
        day = rng.randrange(1, 29)
        hour, minute, second = rng.randrange(24), rng.randrange(60), rng.randrange(60)
        construct([y, month, day, hour, minute, second, rng.randrange(1000)], local=True)
        spelling = f'{y:04d}' if 0 <= y <= 9999 else f'{y:+07d}'
        s = f'{spelling}-{month+1:02}-{day:02}T{hour:02}:{minute:02}:{second:02}'
        parse(s)
        # Mutations exercise rejection paths, not just a valid-format generator.
        if zone != 4:
            at = rng.randrange(len(s))
            parse(s[:at] + rng.choice('x /:+-Z.,0129') + s[at+1:])
    return cases


def process(command, timeout, *, cwd=None, data=None, env=None):
    try:
        p = subprocess.run(command, cwd=cwd, input=data, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise SystemExit(f'{command[0]} failed: {e}') from None
    if p.returncode:
        raise SystemExit(f'{command[0]} exited {p.returncode}; stdout={len(p.stdout)} bytes\n{p.stderr.decode(errors="replace")}')
    return p.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('upstream', type=Path)
    ap.add_argument('--silk', default=str(toolchain.compiler_path()))
    ap.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    ap.add_argument('--cc', default='cc')
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--random-cases', type=int, default=96)
    ap.add_argument('--seed', type=lambda n: int(n, 0), default=0xDA7E2020)
    args = ap.parse_args()
    if args.timeout <= 0 or args.random_cases < 0:
        ap.error('timeout must be positive and random-cases nonnegative')
    upstream = args.upstream.expanduser().resolve()
    pin_count = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
    with tempfile.TemporaryDirectory(prefix='silkjs-date-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], args.timeout)
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'silk.toml').write_text(f'[package]\nname="date-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        totals = Counter()
        failures = 0
        for zone, name in enumerate(ZONES):
            cases = fixtures(zone, args.seed, args.random_cases)
            data = u32(len(cases)) + b''.join(case.wire() for case in cases)
            env = dict(os.environ, TZ=name)
            oracle = records(process([str(temp / 'oracle')], args.timeout, data=data, env=env), cases, f'C Date {name}')
            literal = 'b"' + ''.join(f'\\x{b:02x}' for b in data) + '"'
            source = SILK_SOURCE.replace('FIXTURE_DATA', literal).replace('ZONE_MODE', str(zone))
            (temp / 'src/main.silk').write_text(source)
            command = [silk, 'run', '--quiet', '--release']
            if stdlib:
                command += ['--stdlib', str(stdlib)]
            native_bytes = process(command, args.timeout, cwd=temp)
            native = records(native_bytes, cases, f'native Date {name}')
            for i, (case, want, got) in enumerate(zip(cases, oracle, native, strict=True)):
                totals[case.op] += 1
                if want == got:
                    continue
                failures += 1
                if failures <= 20:
                    print(f'MISMATCH zone={name} #{i} {case.label}')
                    for field, expected, actual in zip(case.fields(), want, got, strict=True):
                        if expected != actual:
                            print(f'  {field}: C={expected:#018x} Silk={actual:#018x}')
            print(f'{name}: compared {len(cases)} records; native sha256={hashlib.sha256(native_bytes).hexdigest()}', flush=True)
        if failures:
            raise SystemExit(f'{failures} Date mismatches (first 20 shown)')
        print(f'PASS: {sum(totals.values())} independent Date records; {pin_count} pinned source files; operations={dict(totals)}')
        print('Timezone scope: original C OS offsets versus explicit native fixed/2020-US-DST fixture providers; no native OS/tzdb claim.')


if __name__ == '__main__':
    main()
