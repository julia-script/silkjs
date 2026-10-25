#!/usr/bin/env python3
"""Compare native calendar kernels with the pinned, separately compiled C source.

Inputs are checked-in edge cases, not native-derived expectations. No host locale,
ICU, JS adapter, or native implementation participates in the C oracle. The probe
also exercises negative years, finite-table fallbacks, era boundaries, month-code
reference selection, negative balancing and both directions of date differences.
All eight immutable calendar tables are compared in full as length-prefixed
little-endian logical values. Packed input records preserve the entire corpus
without requiring the compiler to lower a large mutable nested-array initializer.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
TABLES = (
    'chinese_calendar_data', 'dangi_calendar_data', 'hebrew_year_lengths',
    'hebrew_year_lengths_epoch', 'hebrew_month_start', 'hebrew_leap_month_start',
    'umalqura_year_lengths', 'umalqura_year_starts',
)


def function(source, name):
    """Extract an original C definition, not an independently reimplemented rule."""
    import re
    match = re.search(r'^(?:int|void)\s+' + re.escape(name) + r'\s*\([^;]*?\)\s*\{', source, re.M)
    if not match:
        raise ValueError(f'Missing upstream definition: {name}')
    depth, at = 1, match.end()
    while depth:
        depth += (source[at] == '{') - (source[at] == '}')
        at += 1
    return source[match.start():at]


def cases(fixture):
    rows = []
    def add(op, *args):
        if len(args) > 15:
            raise ValueError('case exceeds fixed record width')
        rows.append([op, *args, *([0] * (15 - len(args)))])
    for cal in range(16):
        years = sorted(set(fixture['common_years'] + fixture['calendar_years'][str(cal)]))
        for year in years:
            months = [1, 2, 3, 5, 6, 7, 12]
            if cal in (2, 4, 5):
                months += [13]
            for month in months:
                for day in (0, 1, 29, 30, 31):
                    add(0, cal, year, month, day)
                for day in (1, 29, 30):
                    add(1, cal, year, month, day)
                add(4, cal, year, month)
            for month in range(0, 15):
                for leap in (0, 1):
                    add(3, cal, year, month, leap)
        for year, month, day in fixture['iso_dates']:
            add(2, cal, year, month, day)
            # Explicit independent calendar-year inputs expose which era path uses it.
            for cal_year in (-1, 0, 1, 2024):
                add(6, cal, year, month, day, cal_year)
        for month in range(1, 14 if cal in (2, 4, 5) else 13):
            for leap in (0, 1):
                for day in fixture['reference_days']:
                    for overflow_year in fixture['reference_years']:
                        for constrain in (0, 1):
                            add(5, cal, month, leap, day, constrain, overflow_year)
        for era in range(18):
            for era_year in fixture['era_years']:
                add(7, cal, era, era_year)
        for year, month, day in fixture['balance_dates']:
            add(8, cal, year, month, day)
        for values in fixture['until_dates']:
            for unit in (-4, -3, -2, -1):
                add(9, cal, *values, unit)
    for cal, y1, m1, d1, mc1, l1, y2, m2, d2, mc2, l2 in fixture['monthcode_until']:
        for unit in (-4, -3, -2, -1):
            for has1, has2 in ((0, 0), (1, 0), (0, 1), (1, 1)):
                add(10, cal, y1, m1, d1, mc1, has1, l1, y2, m2, d2, mc2, has2, l2, unit)
                add(10, cal, y2, m2, d2, mc2, has2, l2, y1, m1, d1, mc1, has1, l1, unit)
    return rows


C = r'''
#include <stdio.h>
#include "temporal/calendar.c"
DEFINITIONS
static void emit(int64_t value) { uint64_t v = (uint64_t)value; for (int i=0;i<8;i++) putchar((v>>(i*8))&255); }
static void probe(const int *a) {
 int64_t r[8]={0}; int y=0,m=0,d=0,mc=0,l=0; TIEra era=TI_ERA_UNKNOWN;
 switch(a[0]) {
 case 0:
  r[0]=ti_calendar_is_leap_year(a[1],a[2]);r[1]=ti_calendar_days_in_year(a[1],a[2]);
  r[2]=ti_calendar_months_in_year(a[1],a[2]);r[3]=ti_calendar_days_in_month(a[1],a[2],a[3]);
  r[4]=ti_calendar_day_of_year(a[1],a[2],a[3],a[4]);r[5]=ti_chinese_related_year(a[1],a[2],a[3],a[4]);r[6]=ti_calendar_requires_era(a[1]);break;
 case 1:r[0]=ti_calendar_date_to_iso(a[1],a[2],a[3],a[4],&y,&m,&d);r[1]=y;r[2]=m;r[3]=d;break;
 case 2:r[0]=ti_iso_to_calendar_date(a[1],a[2],a[3],a[4],&y,&m,&d);r[1]=y;r[2]=m;r[3]=d;
  r[4]=pdt_to_ordinal_days(a[2],a[3],a[4]);pdt_from_ordinal_days(r[4],&y,&m,&d);r[5]=y;r[6]=m;r[7]=d;break;
 case 3:r[0]=ti_calendar_validate_month_code(a[1],a[3],a[4]);r[1]=ti_calendar_month_code_to_month(a[1],a[2],a[3],a[4]);break;
 case 4:ti_calendar_month_to_month_code(a[1],a[2],a[3],&mc,&l);r[0]=mc;r[1]=l;break;
 case 5:r[0]=ti_calendar_monthday_iso_reference_date(a[1],a[2],a[3],a[4],a[5],a[6],&y,&m,&d);r[1]=y;r[2]=m;r[3]=d;break;
 case 6:ti_calendar_era_and_era_year(a[1],a[2],a[3],a[4],a[5],&era,&y);r[0]=era;r[1]=y;break;
 case 7:r[0]=ti_calendar_era_to_iso_year(a[1],a[2],a[3],&y);r[1]=y;y=0;r[2]=ti_calendar_era_to_calendar_year(a[1],a[2],a[3],&y);r[3]=y;break;
 case 8:y=a[2];m=a[3];d=a[4];pdt_balance_date_calendar(&y,&m,&d,a[1]);r[0]=y;r[1]=m;r[2]=d;y=a[2];m=a[3];pdt_balance_month_calendar(&y,&m,a[1]);r[3]=y;r[4]=m;break;
 case 9:ti_calendar_date_until(a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],&r[0],&r[1],&r[2],&r[3]);break;
 case 10:ti_calendar_date_until_with_monthcode(a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],&r[0],&r[1],&r[2],&r[3]);break;
 }
 for(int i=0;i<8;i++)emit(r[i]);
}
static void name(const char *s) { int64_t r[8]={0};if(s){r[0]=strlen(s);for(int i=0;s[i];i++)r[1+i/8]|=(int64_t)(unsigned char)s[i]<<((i%8)*8);}for(int i=0;i<8;i++)emit(r[i]); }
static const int cases[][16]={CASES};
int main(void){for(size_t i=0;i<sizeof(cases)/sizeof(cases[0]);i++)probe(cases[i]);NAMES TABLES return 0;}
'''

SILK = r'''
import silk.i32
import silk.i64
import silk.u8
import silk.usize
import silk.effect { Effect }
import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import temporal_calendar as cal
import temporal_calendar_data as data
fn probe(a: &[i32]) -> [i64; 8] {
 let mut r: [i64; 8] = [0; 8]
 match a[0] {
  0 => {
   r[0]=i32.toI64(cal.ti_calendar_is_leap_year(a[1],a[2])) r[1]=i32.toI64(cal.ti_calendar_days_in_year(a[1],a[2]))
   r[2]=i32.toI64(cal.ti_calendar_months_in_year(a[1],a[2])) r[3]=i32.toI64(cal.ti_calendar_days_in_month(a[1],a[2],a[3]))
   r[4]=i32.toI64(cal.ti_calendar_day_of_year(a[1],a[2],a[3],a[4])) r[5]=i32.toI64(cal.ti_chinese_related_year(a[1],a[2],a[3],a[4])) r[6]=i32.toI64(cal.ti_calendar_requires_era(a[1]))
  }
  1 => { let d=cal.ti_calendar_date_to_iso(a[1],a[2],a[3],a[4]) r[0]=i32.toI64(d.status) r[1]=i32.toI64(d.year) r[2]=i32.toI64(d.month) r[3]=i32.toI64(d.day) }
  2 => { let d=cal.ti_iso_to_calendar_date(a[1],a[2],a[3],a[4]) r[0]=i32.toI64(d.status) r[1]=i32.toI64(d.year) r[2]=i32.toI64(d.month) r[3]=i32.toI64(d.day)
   r[4]=cal.pdt_to_ordinal_days(a[2],a[3],a[4]) let iso=cal.pdt_from_ordinal_days(r[4]) r[5]=i32.toI64(iso.year) r[6]=i32.toI64(iso.month) r[7]=i32.toI64(iso.day) }
  3 => { r[0]=i32.toI64(cal.ti_calendar_validate_month_code(a[1],a[3],a[4])) r[1]=i32.toI64(cal.ti_calendar_month_code_to_month(a[1],a[2],a[3],a[4])) }
  4 => { let code=cal.ti_calendar_month_to_month_code(a[1],a[2],a[3]) r[0]=i32.toI64(code.month_code) r[1]=i32.toI64(code.has_l) }
  5 => { let d=cal.ti_calendar_monthday_iso_reference_date(a[1],a[2],a[3],a[4],a[5],a[6]) r[0]=i32.toI64(d.status) r[1]=i32.toI64(d.year) r[2]=i32.toI64(d.month) r[3]=i32.toI64(d.day) }
  6 => { let e=cal.ti_calendar_era_and_era_year(a[1],a[2],a[3],a[4],a[5]) r[0]=i32.toI64(e.era) r[1]=i32.toI64(e.year) }
  7 => { let iso=cal.ti_calendar_era_to_iso_year(a[1],a[2],a[3]) let y=cal.ti_calendar_era_to_calendar_year(a[1],a[2],a[3]) r[0]=i32.toI64(iso.status) r[1]=i32.toI64(iso.year) r[2]=i32.toI64(y.status) r[3]=i32.toI64(y.year) }
  8 => { let d=cal.pdt_balance_date_calendar(a[2],a[3],a[4],a[1]) let m=cal.pdt_balance_month_calendar(a[2],a[3],a[1]) r[0]=i32.toI64(d.year) r[1]=i32.toI64(d.month) r[2]=i32.toI64(d.day) r[3]=i32.toI64(m.year) r[4]=i32.toI64(m.month) }
  9 => { let d=cal.ti_calendar_date_until(a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8]) r[0]=d.years r[1]=d.months r[2]=d.weeks r[3]=d.days }
  10 => { let d=cal.ti_calendar_date_until_with_monthcode(a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14]) r[0]=d.years r[1]=d.months r[2]=d.weeks r[3]=d.days }
  _ => { Intrinsic.trap("Unknown calendar oracle operation") }
 }
 return r
}
effect fn emit(value: i64) -> () ! WriterError ? &mut Writer {
 let mut bytes: [u8;8]=[0;8] let mut i:usize=0
 while i<8 { bytes[i]=i64.toU8(i64.shiftRight(value,usize.toI64(i*8)) & 255) i=i+1 }
 run Writer.writeAll(&bytes)
}
effect fn name(s: &[u8]) -> () ! WriterError ? &mut Writer {
 let mut r: [i64;8]=[0;8] r[0]=usize.toI64(s.length) let mut i:usize=0
 while i<s.length { r[1+i/8]=r[1+i/8] | i64.shiftLeft(u8.toI64(s[i]),usize.toI64((i%8)*8)) i=i+1 }
 i=0 while i<8 { run emit(r[i]) i=i+1 }
}
fn readWord(data: &[u8], at: usize) -> i32 {
 let mut value=u8.toI32(data[at+3]) if value>=128 { value=value-256 }
 let mut i:usize=3 while i>0 { i=i-1 value=value*256+u8.toI32(data[at+i]) }
 return value
}
effect fn runCases() -> () ! WriterError ? &mut Writer {
 let cases=b"CASES"
 let mut i:usize=0
 while i<cases.length {
  let mut a:[i32;16]=[0;16] let mut j:usize=0
  while j<16 { a[j]=readWord(cases,i+j*4) j=j+1 }
  let r=probe(&a) j=0 while j<8 { run emit(r[j]) j=j+1 } i=i+64
 }
 NAMES
 TABLES
}
pub effect fn main() -> i32 ! WriterError { let mut out=StdoutWriter.make() run runCases() |> Effect.provideMut<Writer>(&mut out) return 0 }
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    fixture = json.loads((ROOT / 'tests/fixtures/temporal_calendar_cases.json').read_text())
    rows = cases(fixture)
    pd = (reference / 'temporal/plaindate.c').read_text()
    temporal = (reference / 'temporal/temporal.c').read_text()
    definitions = '\n'.join(function(pd, n) for n in ('pd_is_leap_year', 'pd_days_in_month', 'pd_day_of_year'))
    definitions += '\n' + function(temporal, 'ti_iso_calendar_date_until')
    cnames, snames = [], []
    extra_size = 0
    for kind in ('calendar', 'era'):
        parse = 'ti_calendar_string_to_enum' if kind == 'calendar' else 'ti_string_to_era'
        display = 'ti_calendar_enum_to_string' if kind == 'calendar' else 'ti_era_to_string'
        for text in fixture[kind + '_names']:
            literal = json.dumps(text)
            cnames.append(f'emit({parse}({literal}));')
            snames.append(f'run emit(i32.toI64(cal.{parse}(b{literal})))')
            extra_size += 8
        for number in range(-1, 19):
            cnames.append(f'name({display}({number}));')
            snames.append(f'run name(cal.{display}({number}))')
            extra_size += 64
    ctables, stables = [], []
    for table in TABLES:
        if table in ('hebrew_year_lengths', 'hebrew_year_lengths_epoch'):
            count, start = (80, 5730) if table == 'hebrew_year_lengths' else (11, 0)
            ctables.append(f'emit({count});for(int i=0;i<{count};i++)emit(hebrew_days_in_year(i+{start}));')
        elif table in ('chinese_calendar_data', 'dangi_calendar_data'):
            ctables.append(f'emit(countof({table}));for(size_t i=0;i<countof({table});i++)emit({table}[i].data[0] | ({table}[i].data[1]<<8) | ({table}[i].data[2]<<16));')
        elif table in ('hebrew_month_start', 'hebrew_leap_month_start'):
            ctables.append(f'emit(countof({table})*3);for(size_t i=0;i<countof({table});i++)for(int j=0;j<3;j++)emit({table}[i][j]);')
        else:
            ctables.append(f'emit(countof({table}));for(size_t i=0;i<countof({table});i++)emit({table}[i]);')
        stables.append(f'run emit(usize.toI64(data.{table}.length)) i=0 while i<data.{table}.length {{ run emit(i32.toI64(data.{table}[i])) i=i+1 }}')
    with tempfile.TemporaryDirectory(prefix='silkjs-temporal-calendar-') as directory:
        temp = Path(directory)
        source = C.replace('DEFINITIONS', definitions).replace('CASES', ',\n'.join('{' + ','.join(map(str, row)) + '}' for row in rows)).replace('NAMES', '\n'.join(cnames)).replace('TABLES', '\n'.join(ctables))
        (temp / 'oracle.c').write_text(source)
        cc, silk = executable_path(args.cc), executable_path(args.silk)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-D_GNU_SOURCE', '-I', str(reference), str(temp / 'oracle.c'), '-o', str(temp / 'oracle')], 600, owner='Calendar C oracle compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Calendar independent C oracle')
        (temp / 'src').mkdir()
        for module in ('temporal_calendar.silk', 'temporal_calendar_data.silk'):
            shutil.copyfile(ROOT / 'src' / module, temp / 'src' / module)
        packed = b''.join(struct.pack('<16i', *row) for row in rows)
        source = SILK.replace('CASES', ''.join(f'\\x{byte:02x}' for byte in packed)).replace('NAMES', '\n'.join(snames)).replace('TABLES', '\n'.join(stables))
        (temp / 'src/main.silk').write_text(source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="temporal-calendar-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1800, owner='Native calendar oracle', cwd=temp)
        size = len(rows) * 64 + extra_size
        if len(expected) < size or len(actual) != len(expected):
            raise SystemExit(f'Wrong output size: C={len(expected)}, Silk={len(actual)}, behavior prefix={size}')
        for at in range(0, len(rows) * 64, 64):
            if expected[at:at+64] != actual[at:at+64]:
                raise SystemExit(f'Calendar case {rows[at // 64]}: C={struct.unpack_from("<8q", expected, at)} Silk={struct.unpack_from("<8q", actual, at)}')
        if expected[:size] != actual[:size]:
            raise SystemExit('Calendar/era borrowed names or alias parsing differ')
        at, entries = size, 0
        for table in TABLES:
            count = struct.unpack_from('<q', expected, at)[0]
            end = at + (count + 1) * 8
            if expected[at:end] != actual[at:end]:
                raise SystemExit(f'Complete calendar table differs: {table}')
            entries += count
            at = end
        if at != len(expected):
            raise SystemExit('Unexpected trailing calendar table bytes')
        print(f'PASS calendar: {len(rows)} edge records, all 16 calendars and era/name cases; {pins} pinned sources; SHA256={hashlib.sha256(actual[:size]).hexdigest()}')
        print(f'PASS calendar tables: {len(TABLES)} complete tables, {entries} entries, {len(actual)-size} logical bytes; SHA256={hashlib.sha256(actual[size:]).hexdigest()}')


if __name__ == '__main__':
    main()
