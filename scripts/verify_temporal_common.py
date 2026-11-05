#!/usr/bin/env python3
"""Contrast native shared Temporal kernels with independently compiled pinned C.

No production algorithm or expected value is supplied by Python. This driver only
constructs inputs, transports records, and compares exact outputs. C definitions
are extracted verbatim after SHA256 checks; complete original calendar/timezone
sources and tables supply dependencies. Native runners are generated in a temp
project, never in src. Error payloads are compared only when C defines them.

--sanitize-c checks the entire defined corpus, then runs isolated C UB controls.
Division-by-zero, signed overflow and INT64_MIN absolute value are not native
expectations. C parser inputs have 32 trailing zero bytes so speculative character
lookahead remains inside storage; embedded NULs remain part of explicit lengths.
"""
import argparse
from collections import Counter
import hashlib
import os
from pathlib import Path
import random
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib
from verify_bytecode import executable_path, process
import toolchain

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '7d1c13c5d8f8c6b32893786ed35cdcebd88194d2'
PINS = {
 'temporal/temporal.c':'57521d24ebb1e09c98f611c762e1aa89cf0b918adb45682ec61d414b602854ad',
 'temporal/temporal_private.h':'6b5eb6e370f9deb2f7090b1ed07ec10316813702516906945b44523853d2e98e',
 'temporal/calendar.c':'922e1e9c24454b8581ef271701aa55a491f295127aeec53d94514b027ec4f524',
 'temporal/calendar.h':'f286f071538d793798151546aa6fdf3c6b6eaa32c798be47654c255dd972381a',
 'temporal/instant.c':'b35264c02f8e1eca2f59f2195f024331285a2e3bf3b3d993e9da738bfe8e85fe',
 'temporal/plaindate.c':'c71ee6fdb4219a36939f2ef9d5f664ddcb0fbbedf71fd325a4f6256132187906',
 'temporal/timezone.c':'8c076209df4e4e27013113903b6ee984163e42ef3e509ede8206a5197938482b',
 'temporal/timezone.h':'a0aed883c00fcd0ccb82892793c2699789d10b14900ce3ff316c894da690327a',
 'temporal/tzdata_generated.c':'42f37b41d40530a2b42fcc1f0bd8b3499595415a0cb12ec06065fe7b3ccc379b',
 'cutils.c':'b73a403a59da30726257ddbdf5e399298941c1def997782ee0d4d33f796a80a2',
 'cutils.h':'d2da6d06a75b9e6c116c82b7a41df6bcc170c8b1779f374fa953ecf688eda647',
 'quickjs.h':'09d208759171634a5b1e60aa314fd00da5d088ac28621b7ae4682ba2fb103415',
}
MASK = (1 << 64) - 1
MIN64, MAX64 = -(1 << 63), (1 << 63) - 1
FIELDS = ('has_date has_yearmonth has_monthday year month day has_time hour minute second '
          'millisecond microsecond nanosecond has_utc has_tz_offset tz_offset_seconds '
          'tz_offset_nanoseconds tz_offset_has_seconds has_calendar calendar calendar_critical '
          'has_unknown_critical has_tz_annotation').split()
NAMES = ('metadata floor timestamp ns_to_timespec round64 round128 iso_limits date_add date_until '
         'datetime_add datetime_difference balance relative_round date_round iso_parse timezone '
         'calendar_id calendar_parse format_timezone canonical_timezone append_calendar '
         'resolve_fields calendar_adapters constructor_calendar validate_timezone named_timezone '
         'default_timezone initialize host_timezone initialize_iso').split()
EXTRACT = {
 'temporal/plaindate.c': 'pd_is_leap_year pd_days_in_month pd_is_valid_date pd_day_of_year',
 'temporal/instant.c': 'ti_round_to_increment ti_round_to_increment128 ti_round_to_increment_as_if_positive ti_round_to_increment_as_if_positive128',
 'temporal/temporal.c': '''ti_named_tz_is_available ti_is_minus_zero_year ti_is_valid_plain_offset_string
 ti_parse_temporal_timezone_string ti_canonicalize_calendar ti_parse_temporal_calendar_string ti_parse_iso_datetime_string
 ti_string_to_unit ti_unit_to_ns ti_negate_rounding_mode ti_prepared_fields_init ti_resolve_date_from_fields
 ti_iso_calendar_date_until ti_iso_calendar_date_add ti_iso_datetime_add_duration ti_iso_datetime_difference
 ti_balance_time_duration ti_calendar_datetime_difference ti_round_relative_duration_iso ti_is_date_within_iso_limits
 ti_round_iso_date_duration ti_format_canonical_timezone ti_append_calendar_annotation ti_canonicalize_timezone_identifier
 ti_validate_constructor_calendar ti_validate_timezone_identifier is_valid_epoch_timespec''',
}


def extract_function(source, name):
    # Pinned functions use a column-zero closing brace. Fail closed, never adapt
    # source bodies or recreate helper semantics in the oracle.
    pattern = r'^[\w *]+\b' + re.escape(name) + r'\([^;]*?\n\{.*?^\}'
    found = list(re.finditer(pattern, source, re.M | re.S))
    if len(found) != 1:
        raise ValueError(f'Expected one pinned definition: {name}, got {len(found)}')
    return found[0].group()


def extracted_source(reference):
    bodies = []
    for file, names in EXTRACT.items():
        source = (reference/file).read_text()
        for name in names.split():
            body = extract_function(source, name)
            line = source[:source.index(body)].count('\n') + 1
            bodies.append(f'#line {line} "{file}"\n{body}\n')
    source=(reference/'temporal/temporal.c').read_text()
    default=extract_function(source,'ti_get_default_timezone')
    # Same original body, once using real OS observations (host smoke) and once
    # injected at the OS boundary for deterministic branch/capacity contrasts.
    bodies += ['#define ti_get_default_timezone oracle_default_host',default,'#undef ti_get_default_timezone']
    hooks='getenv readlink fopen fgets fclose time localtime_r'.split()
    bodies += [f'#define {name} oracle_{name}' for name in hooks]
    bodies += [default]
    bodies += [f'#undef {name}' for name in hooks]
    return '\n'.join(bodies)


def wide(n):
    return [n & MASK, (n >> 64) & MASK]


def duration(years=0, months=0, weeks=0, days=0, hours=0, minutes=0, seconds=0, milliseconds=0, microseconds=0, nanoseconds=0):
    return [years, months, weeks, days, hours, minutes, seconds, milliseconds, *wide(microseconds), *wide(nanoseconds)]


def date(y, m, d, h=0, minute=0, sec=0, ms=0, us=0, ns=0):
    return [y, m, d, h, minute, sec, ms, us, ns]


def corpus(reference):
    rows = []
    rng = random.Random(0x54454D504F52414C)
    def add(op, args=(), text=b'', label=''):
        if isinstance(text, str): text = text.encode()
        if len(args) > 32: raise ValueError('Too many arguments')
        rows.append((op, list(args) + [0] * (32-len(args)), text, label))
    for unit in [-2147483648, -102, -100, *range(-6, 9), 2147483647]:
        for mode in range(-1, 11):
            for cal in range(-1, 17): add(0, [unit, mode, cal])
    # Entire integer width, quotients on both sides of zero and exact multiples.
    integers = [MIN64, MIN64+1, MIN64+255, -(1<<53)-1, -(1<<32), -86400000000000,
                -1001, -1000, -999, -2, -1, 0, 1, 2, 999, 1000, 1001, 1<<32, (1<<53)+1, MAX64-255, MAX64-1, MAX64]
    divisors = [1, 2, 3, 4, 7, 12, 60, 400, 1000, 86400, 146097, 1<<31, (1<<31)+1, (1<<32)-1, 1<<32, 10**9, MAX64, 1<<63, (1<<63)+1, MASK]
    for a in integers + [rng.randrange(MIN64, MAX64+1) for _ in range(512)]:
        for b in divisors:
            bi=b if b<=MAX64 else b-(1<<64)
            if a==MIN64 and bi==-1: continue
            q=(abs(a)//abs(bi))*(-1 if (a<0)!=(bi<0) else 1)
            rem=a-q*bi
            if rem<0 and not MIN64<=rem+bi<=MAX64: continue
            unsafe = a<0 and (not MIN64<=a-bi<=MAX64 or not MIN64<=a-bi+1<=MAX64)
            narrow = -(1<<31)<=a<=(1<<31)-1 and b<(1<<32)
            if narrow:
                b32=b if b<(1<<31) else b-(1<<32)
                narrow = b32!=0 and not (a==-(1<<31) and b32==-1)
                narrow = narrow and (a>=0 or (-(1<<31)<=a-b32<=(1<<31)-1 and -(1<<31)<=a-b32+1<=(1<<31)-1))
            add(1, [a, b, int(unsafe), int(narrow)])
    for secs in integers + [-8640000000001, -8640000000000, 8640000000000, 8640000000001]:
        for ns in [0, 1, 999999999, 1000000000, (1<<32)-1]: add(2, [secs, ns])
    for secs in integers:
        for ns in [0, 1, 999999999]: add(3, wide(secs*10**9+ns))
    for _ in range(512): add(3, wide(rng.randrange(MIN64*10**9, MAX64*10**9+10**9)))
    for width, op in [(64, 4), (128, 5)]:
        lo, hi = -(1 << (width-1)), (1 << (width-1))-1
        incs = [1, 2, 3, 7, 10, 60, 1000, 10**9, 3600000000000, 86400000000000, hi]
        if width == 128: incs += [(1<<64)+1, 10**24, 1<<100, 1<<126]
        for inc in incs:
            values = {lo, lo+1, hi, hi-1, -1, 0, 1}
            for q in [-1001, -3, -2, -1, 0, 1, 2, 3, 1001]:
                for rem in [0, 1, inc//2-1, inc//2, inc//2+1, inc-1]: values.add(q*inc+rem)
            values.update(rng.randrange(lo, hi+1) for _ in range(32))
            for x in sorted(values):
                if not lo <= x <= hi: continue
                # Both potential rounded endpoints must be representable. This
                # restriction excludes C overflow, not awkward defined results.
                floor = (x//inc)*inc; ceil = -((-x)//inc)*inc
                if not lo <= floor <= hi or not lo <= ceil <= hi: continue
                for mode in range(-1, 10): add(op, [x, inc, mode] if width==64 else [*wide(x), *wide(inc), mode])
    dates = [(-271822,12,31),(-271821,4,18),(-271821,4,19),(-271821,4,20),(-400,2,29),(-1,12,31),
             (0,1,1),(0,2,29),(1,1,1),(100,2,28),(400,2,29),(1900,2,28),(1969,12,31),(1970,1,1),
             (1999,12,31),(2000,2,29),(2023,1,31),(2024,2,29),(2024,12,31),(275760,9,12),(275760,9,13),(275760,9,14),(275761,1,1)]
    for y in [-2147483648,-271822,-271821,-1,0,1,275760,275761,2147483647]:
        for m in [0,1,4,9,12,13]:
            for d in [0,1,18,19,20,28,29,30,31,32]: add(6,[y,m,d])
    deltas = [(0,0,0,0),(1,0,0,0),(-1,0,0,0),(0,1,0,0),(0,-1,0,0),(0,13,0,0),
              (0,-13,0,0),(0,0,1,0),(0,0,-1,0),(0,0,0,1),(0,0,0,-1),
              (400,0,0,0),(-400,0,0,0),(0,0,0,100000001),(0,0,0,-100000001),
              (1<<32,0,0,0),(-(1<<32),0,0,0),(0,0,MAX64,0),(0,0,MIN64,0)]
    for d in dates:
        for delta in deltas: add(7,[*d,*delta])
        for other in dates:
            for unit in range(-4,0): add(8,[*d,*other,unit])
    for _ in range(512):
        d=[rng.randint(-271821,275760),rng.randint(1,12),rng.randint(1,28)]
        add(7,[*d,rng.randint(-500000,500000),rng.randint(-120000,120000),rng.randint(-10000,10000),rng.randint(-100000000,100000000)])
    for ordinal in [MIN64,MIN64+1,MIN64+146097,MAX64-146097,MAX64-1,MAX64]:
        add(7,[1,1,1,0,0,0,ordinal],label='full-i64-ordinal / C final int32 narrowing')
    times = [(0,0,0,0,0,0),(23,59,59,999,999,999),(12,30,30,500,500,500)]
    ds = [duration(), duration(nanoseconds=1), duration(nanoseconds=-1), duration(hours=25),duration(hours=-25),
          duration(years=1,months=13,weeks=2,days=3,hours=4,minutes=5,seconds=6,milliseconds=7,microseconds=8,nanoseconds=9),
          duration(years=-1,months=-13,weeks=-2,days=-3,hours=-4,minutes=-5,seconds=-6,milliseconds=-7,microseconds=-8,nanoseconds=-9),
          duration(microseconds=(1<<64)+1),duration(nanoseconds=-((1<<64)+1))]
    for d in dates:
        for t in times:
            for delta in ds: add(9,[*d,*t,*delta])
    # Endpoint, sign-disagreement and subsecond differences; not a roundtrip oracle.
    for i, d in enumerate(dates):
        for other in [dates[(i+1)%len(dates)],dates[-1-i],d]:
            for t in times:
                for u in times:
                    for largest in range(-4,6): add(10,[*d,*t,*other,*u,largest,-1])
    for cal in range(16):
        # Valid month/day in all calendars; year choices hit table-backed and
        # arithmetic fallbacks without introducing dependency overflow.
        for y in [1, 100, 1399, 1445, 1800, 1900, 2024, 2100, 5784]:
            for a,b in [(date(y,1,1,23,59,59,999,999,999),date(y+1,2,28)),
                        (date(y+1,2,28),date(y,1,1,23,59,59,999,999,999))]:
                for largest in range(-4,6): add(10,[*a,*b,largest,cal])
    balance_inputs=ds + [duration(days=2,hours=-48),duration(hours=MAX64),duration(hours=MIN64),
                        duration(milliseconds=MAX64),duration(microseconds=1<<90),duration(nanoseconds=-(1<<110)),
                        duration(nanoseconds=(1<<127)-1),duration(nanoseconds=-(1<<127)+1),
                        duration(microseconds=((1<<127)-1)//1000)]
    for delta in balance_inputs:
        def signed_wide(lo,hi):
            n=lo+(hi<<64)
            return n-(1<<128) if n>>127 else n
        total=delta[4]*3600000000000+delta[5]*60000000000+delta[6]*10**9+delta[7]*10**6+signed_wide(*delta[8:10])*1000+signed_wide(*delta[10:12])
        for largest in range(-4,6):
            # Signed narrowing followed by sign multiplication can overflow for
            # negative INT64_MIN; retain only representable balanced i64 fields.
            span=abs(total+(delta[3]*86400000000000 if largest>-1 else 0))
            divisors_by_unit={-1:86400000000000,0:3600000000000,1:60000000000,2:10**9,3:10**6}
            if largest<=3 and span//divisors_by_unit[max(-1,largest)]>MAX64: continue
            add(11,[*delta,largest])
    rels = [date(2020,2,29,12),date(2023,1,31),date(2024,12,31,23,59,59,999,999,999),date(-271821,4,19),date(275760,9,13)]
    for rel in rels:
        for delta in ds[:7]:
            for largest in [-4,-3,-2,-1,0,2,5]:
                for smallest in range(largest,6):
                    for mode in range(9):
                        for tz in [0,1]: add(12,[*rel,*delta,largest,smallest,1,mode,tz])
    for origin,dest in [(date(2020,2,29),date(2021,2,28)),(date(2024,1,1),date(2024,1,16)),
                        (date(2024,1,16),date(2024,1,1)),(date(2024,1,1),date(2024,1,1)),
                        (date(275760,9,12),date(275760,9,13)),(date(-271821,4,20),date(-271821,4,19))]:
        for smallest in range(-4,1):
            for increment in [1,2,3,7]:
                for mode in range(9):
                    for bubble in [0,1]:
                        for tz in [0,1]:
                            add(13,[*origin,*dest,0,0,0,0,0,43200000000000,-4,smallest,increment,mode,bubble,tz])
    # Grammar cross-products and deterministic byte-level corruptions.
    strings = {b'', b'\0', b'\xff', b'\xc2\xa0', b' ', b'Z', b'z', b'T', b'UTC', b'utc',b'America/New_York',b'Etc/GMT+1',b'Unknown/Nowhere'}
    date_strings=['2024-02-29','2023-02-29','0000-01-01','-000001-12-31','+275760-09-13','-271821-04-19',
                  '-000000-01-01','+000000-01-01','20240229','202402','2024-02','--02-29','02-29','0229',
                  '-0000011231','+00202402','2024-00-00','2024-13-32','+999999-12-31']
    time_strings=['','T00','t00:00',' 23:59:60','T23:59:59.123456789','T235959,1','T24:00','T12:60','T12:30:61',
                  'T12:30.1','T12:30:30.','T12:30:30.1234567890','T1:30','T1','T123','T12345']
    offsets=['','Z','z','+00','-00:00','+2359','-23:59:59.999999999','+24:00','+01:60','+01:02:60','+01.5','+01:02,5']
    annotations=['','[UTC]','[!UTC]','[America/New_York]','[+01:00]','[+01:00:01]',
                 '[u-ca=iso8601]','[u-ca=GREGORY]','[!u-ca=hebrew]','[u-ca=unknown]',
                 '[u-ca=iso8601][u-ca=hebrew]','[!u-ca=iso8601][u-ca=hebrew]',
                 '[foo=bar]','[!foo=bar]','[=x]','[X=x]','[_=x]','[]','[','[UTC][UTC]',
                 '[u-ca=]','[u-ca='+('a'*64)+']','['+('a'*63)+']','['+('a'*64)+']']
    for d in date_strings:
        for t in time_strings:
            for offset in offsets: strings.add((d+t+offset).encode())
        for annotation in annotations: strings.add((d+'T12:30:30'+annotation).encode())
    for t in ['00','12','1230','123030','1','1:30','12:30','12:30:30','02-29','202401']:
        for offset in offsets:
            for annotation in ['', '[UTC]', '[u-ca=iso8601]']: strings.add((t+offset+annotation).encode())
    seeds=[b'2024-02-29T23:59:59.123456789+01:30[u-ca=iso8601]',b'--02-29',b'T12:34:56',b'-000000']
    for seed in seeds:
        for i in range(len(seed)+1):
            strings.add(seed[:i]);strings.add(seed[:i]+b'\0'+seed[i:]);strings.add(seed[:i]+b'\xff'+seed[i:])
        for i in range(len(seed)):
            for byte in [0,32,43,45,46,48,57,58,61,84,90,91,93,127,128,255]: strings.add(seed[:i]+bytes([byte])+seed[i+1:])
    for _ in range(384): strings.add(bytes(rng.choice(b'0123456789TtZz+-:.,[]!=_abc\0\xff') for _ in range(rng.randrange(1,80))))
    for text in sorted(strings):
        for flags in [0,1,2,3]: add(14,[flags],text)
    calendars='buddhist chinese coptic dangi ethioaa ethiopic gregory hebrew indian islamic-civil islamic-tbla islamic-umalqura iso8601 japanese persian roc ethiopic-amete-alem islamicc auto invalid'.split()
    extra = {s.encode() for s in calendars + [s.upper() for s in calendars] + 'year years month months week weeks day days hour hours minute minutes second seconds millisecond milliseconds microsecond microseconds nanosecond nanoseconds'.split()}
    for s in list(extra): extra.update([s+b'\0',s+b'\0junk',b'\0'+s,s+b'[u-ca=iso8601]'])
    # Enumerate every name in the pinned C table (inputs only; matching is C).
    source=(reference/'temporal/tzdata_generated.c').read_text()
    names=re.search(r'const char \*\s*(?:const\s+)?ti_tz_names\[\]\s*=\s*\{(.*?)\n\};',source,re.S)
    if not names: raise ValueError('Pinned timezone names declaration not found')
    for name in re.findall(r'"([^"\\]*)"',names.group(1)):
        extra.add(name.encode());extra.add(name.swapcase().encode());extra.add(('2024-01-01T00:00['+name+']').encode())
    for sign in ['+','-']:
        for hour in [0,1,23,24,99]:
            for minute in [0,1,59,60,99]:
                for separator in ['',':']:
                    extra.add(f'{sign}{hour:02}{separator}{minute:02}'.encode())
    for n in [0,1,2,3,63,64,127,128,129,255]: extra.add(b'A'*n);extra.add(b'UTC\0'+b'X'*n)
    for text in sorted(strings|extra):
        add(15, text=text)
        for op in [16,17,23,24,25]: add(op,text=text)
    for offset in [MIN64+1,-86400000000000,-3600000000001,-1,0,1,59999999999,3600000000000,86399999999999,MAX64]:
        for utc in [0,1]:
            for capacity in [0,1,2,3,4,5,6,7,8,16,64,128]: add(18,[offset,utc,capacity])
    for text in [b'',b'UTC',b'utc',b'Z',b'z',b'America/New_York',b'Unknown/name',b'a b',b'T[utc]',b'T[u]',b'T[UTC]',b'T[+01:00]',b'T[]',b'T[UTC]x',b'UTC\0tail']:
        for offset in [-3600000000000,0,3600000000000]:
            for capacity in [1,2,3,4,6,7,16,64,128]: add(19,[offset,capacity],text)
    for cal in range(-1,17):
        for mode in range(-1,5):
            for capacity in [1,2,8,11,16,32,64,128]:
                for prefix in [b'',b'2024-02-29']: add(20,[cal,mode,capacity],prefix)
    for cal in range(16):
        for y in [1,1445,2024,5784]:
            for month in [-1,1,2,12,13,14]:
                for mask in [0,1,3,7,9,11,13,15,8192|16384|10,1|8192|10,1|16384|10]:
                    for constrain in [0,1]:
                        for required in [0,1]: add(21,[cal,y,month,32,month,0,1,y,mask,constrain,required,17])
        for mc in range(0,15):
            for leap in [0,1]: add(21,[cal,2024,mc,29,mc,leap,1,2024,15,0,1,17])
        for era in range(-1,10):
            for year in [-1,0,1,2024]: add(21,[cal,year,1,1,1,0,era,year,8192|16384|10,1,1,17])
        for y,m,d in [(1,1,1),(1900,1,1),(2024,2,29),(2100,12,31)]: add(22,[cal,y,m,d])
    for env,link,line in [(b'Custom/Zone',b'/zoneinfo/ignored',b'ignored\n'),
                          (b'',b'/usr/share/zoneinfo/Europe/Paris',b'ignored\n'),
                          (b'',b'/usr/share/zoneinfo/',b'ignored\n'),
                          (b'',b'not-zoneinfo',b'Asia/Tokyo\nsecond line'),
                          (b'UTC\0ignored',b'',b''),
                          (b'',b'/zoneinfo/UTC\0ignored',b''),
                          (b'',b'',b'UTC\0ignored\n'),
                          (b'',b'',b'Europe/London'),
                          (b'',b'',b'A'*300),
                          (b'',b'X'*510+b'/zoneinfo/UTC',b''),
                          (b'',b'',b'')]:
        for offset in [-1439,-345,-60,0,60,330,1439]:
            for cap in [0,1,2,3,4,5,6,7,8,11,16,32,64,128]:
                add(26,[len(env),len(link),len(line),offset,cap],env+b'\0'+link+b'\0'+line)
    add(28)
    add(29)
    add(27)
    return rows


def pack_corpus(rows):
    result=bytearray(struct.pack('<Q',len(rows)))
    for op,args,text,_ in rows:
        count=len(args)
        while count and args[count-1]==0: count-=1
        result += struct.pack('<3Q',op,count,len(text))
        result += struct.pack(f'<{count}Q',*(n & MASK for n in args[:count])) + text
    return bytes(result)


SILK = r'''
import silk.num.i32
import silk.num.i64
import silk.num.u8
import silk.num.u32
import silk.num.u64
import silk.num.usize
import silk.num.f64
import silk.collections.slice { Slice }
import silk.core.effect { Effect }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import js_bigint { Int128 }
import temporal_common as api
import temporal_parse as parse
import temporal_calendar as cal
fn bits(x:i64)->u64 { if x<0 { return 0xffffffffffffffff-i64.toU64(-(x+1)) } return i64.toU64(x) }
fn signed(x:u64)->i64 { if x>0x7fffffffffffffff { return -1-u64.toI64(x^0xffffffffffffffff) } return u64.toI64(x) }
fn small(x:u64)->i32 { return i64.toI32(signed(x)) }
fn word32(x:i32)->u64 { return bits(i32.toI64(x)) }
fn flag(x:bool)->u64 { if x { return 1 } return 0 }
fn readWord(data:&[u8],at:&mut usize)->u64 {
 let mut result:u64=0 let mut j:u64=0
 while j<8 { result=result|u64.shiftLeft(u8.toU64(data[at.*]),j*8) at.*=at.*+1 j=j+1 } return result
}
fn wide(a:&[u64],at:usize)->Int128 { return Int128 {low:a[at],high:a[at+1]} }
fn wideOut(r:&mut[u64],at:usize,x:Int128)->() { r[at]=x.low r[at+1]=x.high }
fn datetime(a:&[u64],at:usize)->api.DateTime {
 return api.DateTime {status:0,year:small(a[at]),month:small(a[at+1]),day:small(a[at+2]),hour:small(a[at+3]),minute:small(a[at+4]),second:small(a[at+5]),millisecond:small(a[at+6]),microsecond:small(a[at+7]),nanosecond:small(a[at+8])}
}
fn duration(a:&[u64],at:usize)->api.Duration {
 return api.Duration {years:signed(a[at]),months:signed(a[at+1]),weeks:signed(a[at+2]),days:signed(a[at+3]),hours:signed(a[at+4]),minutes:signed(a[at+5]),seconds:signed(a[at+6]),milliseconds:signed(a[at+7]),microseconds:wide(a,at+8),nanoseconds:wide(a,at+10)}
}
fn durationOut(r:&mut[u64],at:usize,d:&api.Duration)->() {
 r[at]=bits(d.years) r[at+1]=bits(d.months) r[at+2]=bits(d.weeks) r[at+3]=bits(d.days)
 r[at+4]=bits(d.hours) r[at+5]=bits(d.minutes) r[at+6]=bits(d.seconds) r[at+7]=bits(d.milliseconds)
 wideOut(&mut r,at+8,d.microseconds) wideOut(&mut r,at+10,d.nanoseconds)
}
fn bytesOut(r:&mut[u64],at:usize,bytes:&[u8])->() {
 let mut i:usize=0 while i<bytes.length { let shift=usize.toU64(i%8)*8 let mask=u64.shiftLeft(255,shift) r[at+i/8]=(r[at+i/8]&(mask^0xffffffffffffffff))|u64.shiftLeft(u8.toU64(bytes[i]),shift) i=i+1 }
}
fn parserOut(r:&mut[u64],p:&parse.TISODateTimeParseResult)->() {
 PARSER_FIELDS
 bytesOut(&mut r,24,&p.tz_annotation)
}
BUFFER_HELPERS
effect fn exercise(op:u64,a:&[u64],text:&[u8])->[u64;40] {
 let mut r:[u64;40]=[0;40]
 match op {
 0 => { r[0]=bits(api.ti_unit_to_ns(small(a[0]))) r[1]=word32(api.ti_precision_from_smallest_unit(small(a[0]))) r[2]=word32(api.ti_negate_rounding_mode(small(a[1]))) r[3]=word32(api.ti_calendar_enforces_month_monthcode_agreement(small(a[2]))) }
 1 => { if a[2]==0 { r[0]=bits(api.floor_div64(signed(a[0]),a[1])) } let v=api.floor_divrem64(signed(a[0]),a[1]) r[1]=bits(v.quotient) r[2]=bits(v.remainder) if a[3]!=0 { r[3]=word32(api.floor_div32(small(a[0]),u64.toU32(a[1]))) } }
 2 => { let t=api.TimeSpec {secs:signed(a[0]),nsecs:u64.toU32(a[1])} wideOut(&mut r,0,api.ti_sec_nsec_to_ns(t.secs,t.nsecs)) wideOut(&mut r,2,api.ti_timespec_to_ns(&t)) r[4]=word32(api.is_valid_epoch_timespec(&t)) r[5]=f64.toBits(api.timespec_to_ms(&t)) }
 3 => { let t=api.ti_ns_to_timespec(wide(a,0)) r[0]=bits(t.secs) r[1]=u32.toU64(t.nsecs) }
 4 => { r[0]=bits(api.ti_round_to_increment(signed(a[0]),signed(a[1]),small(a[2]))) r[1]=bits(api.ti_round_to_increment_as_if_positive(signed(a[0]),signed(a[1]),small(a[2]))) }
 5 => { wideOut(&mut r,0,api.ti_round_to_increment128(wide(a,0),wide(a,2),small(a[4]))) wideOut(&mut r,2,api.ti_round_to_increment_as_if_positive128(wide(a,0),wide(a,2),small(a[4]))) }
 6 => { r[0]=word32(api.ti_is_date_within_iso_limits(small(a[0]),small(a[1]),small(a[2]))) }
 7 => { let d=api.ti_iso_calendar_date_add(small(a[0]),small(a[1]),small(a[2]),signed(a[3]),signed(a[4]),signed(a[5]),signed(a[6])) r[0]=word32(d.status) if d.status==0 { r[1]=word32(d.year) r[2]=word32(d.month) r[3]=word32(d.day) } }
 8 => { let d=cal.ti_iso_calendar_date_until(small(a[0]),small(a[1]),small(a[2]),small(a[3]),small(a[4]),small(a[5]),small(a[6])) r[0]=bits(d.years) r[1]=bits(d.months) r[2]=bits(d.weeks) r[3]=bits(d.days) }
 9 => { let base=datetime(a,0) let delta=duration(a,9) let d=api.ti_iso_datetime_add_duration(&base,&delta) r[0]=word32(d.status) if d.status==0 { r[1]=word32(d.year) r[2]=word32(d.month) r[3]=word32(d.day) r[4]=word32(d.hour) r[5]=word32(d.minute) r[6]=word32(d.second) r[7]=word32(d.millisecond) r[8]=word32(d.microsecond) r[9]=word32(d.nanosecond) } }
 10 => { let left=datetime(a,0) let right=datetime(a,9) if signed(a[19])<0 { let d=api.ti_iso_datetime_difference(&left,&right,small(a[18])) durationOut(&mut r,0,&d) } else { let d=api.ti_calendar_datetime_difference(small(a[19]),&left,&right,small(a[18])) durationOut(&mut r,0,&d) } }
 11 => { let mut d=duration(a,0) wideOut(&mut r,12,api.ti_duration_time_fields_to_ns(&d)) api.ti_balance_time_duration(&mut d,small(a[12])) durationOut(&mut r,0,&d) }
 12 => { let rel=datetime(a,0) let delta=duration(a,9) let d=api.ti_round_relative_duration_iso(&rel,&delta,small(a[21]),small(a[22]),signed(a[23]),small(a[24]),a[25]!=0) r[0]=word32(d.status) if d.status==0 { durationOut(&mut r,1,&d.value) } }
 13 => { let origin=datetime(a,0) let dest=datetime(a,9) let zero:[u64;12]=[0;12] let mut delta=duration(&zero,0) delta.years=signed(a[18]) delta.months=signed(a[19]) delta.weeks=signed(a[20]) delta.days=signed(a[21]) let d=api.ti_round_iso_date_duration(&origin,&dest,signed(a[22]),signed(a[23]),&delta,small(a[24]),small(a[25]),signed(a[26]),small(a[27]),a[28]!=0,a[29]!=0) r[0]=word32(d.status) if d.status==0 { r[1]=bits(d.value.years) r[2]=bits(d.value.months) r[3]=bits(d.value.weeks) r[4]=bits(d.value.days) } }
 14 => { let mut p=parse.zeroIsoResult() let status=parse.ti_parse_iso_datetime_string(text,&mut p,small(a[0])) r[0]=word32(status) if status==0 { parserOut(&mut r,&p) } }
 15 => { let mut offset:i64=0 let status=parse.ti_parse_temporal_timezone_string(text,&mut offset) r[0]=word32(status) if status==0 { r[1]=bits(offset) } r[2]=word32(parse.ti_is_minus_zero_year(text)) r[3]=word32(parse.ti_is_valid_plain_offset_string(text)) r[4]=word32(api.ti_string_to_unit(text)) r[5]=word32(api.ti_calendar_string_to_enum_with_aliases(text)) }
 16 => { let mut calendar:i32=77 let status=parse.ti_canonicalize_calendar(text,&mut calendar) r[0]=word32(status) if status==0 { r[1]=word32(calendar) } }
 17 => { let mut calendar:i32=77 let status=parse.ti_parse_temporal_calendar_string(text,&mut calendar) r[0]=word32(status) if status==0 { r[1]=word32(calendar) } }
 18 => { bufferProbe(op,a,text,&mut r) }
 19 => { bufferProbe(op,a,text,&mut r) }
 20 => { bufferProbe(op,a,text,&mut r) }
 EXTRA_ARMS
 _ => { return move r }
 }
 return move r
}
effect fn execute(data:&[u8])->() !WriterError ?&mut Writer {
 let mut at:usize=0 let count=readWord(data,&mut at) let mut case:u64=0
 while case<count {
  let op=readWord(data,&mut at) let argc=u64.toUsize(readWord(data,&mut at)) let n=u64.toUsize(readWord(data,&mut at))
  let mut a:[u64;32]=[0;32] let mut i:usize=0
  while i<argc { a[i]=readWord(data,&mut at) i=i+1 }
  let text=Slice.view<u8>(data,at,n) at=at+n
  let r=run exercise(op,&a,text) let mut bytes:[u8;320]=[0;320] i=0
  while i<320 { bytes[i]=u64.toU8(u64.shiftRight(r[i/8],usize.toU64(i%8)*8)&255) i=i+1 }
  run Writer.writeAll(&bytes) case=case+1
 }
}
pub effect fn main()->i32 !WriterError {
 let mut writer=StdoutWriter.make()
 CHUNKS
 return 0
}
'''


def buffer_helpers():
    # The standard library has shared subviews only. Statically sized stack
    # buffers exercise actual short capacities without unsafe slice fabrication.
    arms=[]
    for cap in [0,1,2,3,4,5,6,7,8,11,16,32,64,128]:
        arms.append(f'{cap} => {{ let mut buffer:[u8;{cap}]=[90;{cap}] bufferCall(op,a,text,&mut buffer,&mut r) bytesOut(&mut r,1,&buffer) }}')
    return r'''
fn bufferCall(op:u64,a:&[u64],text:&[u8],buffer:&mut[u8],r:&mut[u64])->() {
 if op==18 { parse.ti_format_canonical_timezone(signed(a[0]),small(a[1]),&mut buffer) }
 else if op==19 { r[0]=word32(parse.ti_canonicalize_timezone_identifier(text,signed(a[0]),&mut buffer)) }
 else if op==20 {
  let mut i:usize=0
  while i+1<buffer.length && i<text.length && text[i]!=0 { buffer[i]=text[i] i=i+1 }
  if buffer.length>0 { buffer[i]=0 }
  parse.ti_append_calendar_annotation(&mut buffer,small(a[0]),small(a[1]))
 } else {
  let envLen=u64.toUsize(a[0]) let linkLen=u64.toUsize(a[1]) let lineLen=u64.toUsize(a[2])
  parse.ti_get_default_timezone(Slice.view<u8>(text,0,envLen),Slice.view<u8>(text,envLen+1,linkLen),Slice.view<u8>(text,envLen+linkLen+2,lineLen),small(a[3]),&mut buffer)
 }
}
fn bufferProbe(op:u64,a:&[u64],text:&[u8],r:&mut[u64])->() {
 let mut i:usize=1 while i<17 { r[i]=0x5a5a5a5a5a5a5a5a i=i+1 }
 let mut cap=a[2] if op==19 { cap=a[1] } else if op==26 { cap=a[4] }
 match cap {
''' + '\n'.join(arms) + '''
 _ => { return () }
 }
}
'''


def silk_source(rows):
    # Separate readonly blobs avoid a single compiler literal-size bottleneck.
    calls=[]
    for start in range(0,len(rows),1024):
        data=pack_corpus(rows[start:start+1024])
        literal=''.join(f'\\x{b:02x}' for b in data)
        calls.append(f'run execute(b"{literal}") |> Effect.provideMut<Writer>(&mut writer)')
    return SILK.replace('PARSER_FIELDS','\n'.join(f'r[{i+1}]=word32(p.{field})' for i,field in enumerate(FIELDS))).replace('CHUNKS','\n'.join(calls)).replace('EXTRA_ARMS',EXTRA_ARMS).replace('BUFFER_HELPERS',buffer_helpers())


EXTRA_ARMS = r'''
 21 => {
  let mut f=api.ti_prepared_fields_init()
  f.calendar=small(a[0]) f.year=signed(a[1]) f.month=small(a[2]) f.day=small(a[3]) f.month_from_code=small(a[4]) f.month_code_has_l=small(a[5]) f.era=small(a[6]) f.era_year=signed(a[7]) f.present_mask=u64.toU32(a[8])
  let d=api.ti_resolve_date_from_fields(&f,a[9]!=0,a[10]!=0,small(a[11]))
  r[0]=word32(d.status) if d.status==0 { r[1]=word32(d.year) r[2]=word32(d.month) r[3]=word32(d.day) }
 }
 22 => {
  let d=api.pmd_get_calendar_date(small(a[0]),small(a[1]),small(a[2]),small(a[3])) r[0]=word32(d.year) r[1]=word32(d.month) r[2]=word32(d.day)
  let e=api.pym_get_calendar_date(small(a[0]),small(a[1]),small(a[2]),small(a[3])) r[3]=word32(e.year) r[4]=word32(e.month) r[5]=word32(e.day)
 }
 23 => { let mut calendar:i32=77 let status=parse.ti_validate_constructor_calendar(text,&mut calendar) r[0]=word32(status) if status==0 { r[1]=word32(calendar) } }
 24 => { let mut value:&[u8]=text let status=parse.ti_validate_timezone_identifier(text,&mut value) r[0]=word32(status) if status==1 { r[1]=usize.toU64(value.length) let mut i:usize=0 while i<value.length { r[2]=u64.wrappingAdd(u64.wrappingMultiply(r[2],31),u8.toU64(value[i])) i=i+1 } } }
 25 => { r[0]=flag(parse.ti_named_tz_is_available(text)) }
 26 => { bufferProbe(op,a,text,&mut r) }
 27 => {
  let f=api.ti_prepared_fields_init()
  r[0]=word32(f.calendar) r[1]=bits(f.year) r[2]=word32(f.month) r[3]=word32(f.day) r[4]=word32(f.hour) r[5]=word32(f.minute) r[6]=word32(f.second)
  r[7]=word32(f.millisecond) r[8]=word32(f.microsecond) r[9]=word32(f.nanosecond) r[10]=bits(f.era_year)
  r[11]=word32(f.month_from_code) r[12]=word32(f.month_code_has_l) r[13]=bits(f.offset_ns) r[14]=word32(f.era) r[15]=u32.toU64(f.present_mask)
  bytesOut(&mut r,16,&f.time_zone)
 }
 28 => { let mut buffer:[u8;128]=[90;128] run parse.ti_get_default_timezone_host(&mut buffer) bytesOut(&mut r,1,&buffer) }
 29 => { let p=parse.zeroIsoResult() parserOut(&mut r,&p) }
'''




def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--upstream','--reference',dest='upstream',required=True,type=Path)
    p.add_argument('--silk',default=str(toolchain.compiler_path()));p.add_argument('--stdlib',type=Path, default=toolchain.stdlib_path())
    p.add_argument('--cc',default=os.environ.get('CC','cc'));p.add_argument('--timeout',type=int,default=1800)
    p.add_argument('--sanitize-c',action='store_true')
    p.add_argument('--cflag',action='append',default=[])
    args=p.parse_args();reference=args.upstream.resolve()
    # Exercise the actual host wrapper through the real environment boundary.
    # Pure injected observations cover every non-environment selection branch.
    os.environ['TZ']='Temporal/IndependentHostProbe'
    for file,wanted in PINS.items():
        actual=hashlib.sha256((reference/file).read_bytes()).hexdigest()
        if actual!=wanted: raise SystemExit(f'Pin mismatch {file}: {actual}, expected {wanted} at {COMMIT}')
    rows=corpus(reference);data=pack_corpus(rows);native=silk_source(rows)
    with tempfile.TemporaryDirectory(prefix='silkjs-temporal-common-') as directory:
        tmp=Path(directory)
        (tmp/'temporal_common_extracted.h').write_text(extracted_source(reference))
        (tmp/'cases.bin').write_bytes(data)
        flags=['-fsanitize=address,undefined','-fno-sanitize-recover=all','-fno-omit-frame-pointer'] if args.sanitize_c else []
        compile_c=[executable_path(args.cc),'-std=gnu11','-O2','-D_DEFAULT_SOURCE','-include','strings.h',*flags,*args.cflag,
                   '-I',str(tmp),'-I',str(reference),str(ROOT/'tests/fixtures/temporal_common_oracle.c'),
                   *(str(reference/file) for file in ['temporal/calendar.c','temporal/timezone.c','temporal/tzdata_generated.c','cutils.c']),'-lm','-o',str(tmp/'oracle')]
        process(compile_c,args.timeout,owner='Shared Temporal C oracle compilation')
        expected=process([str(tmp/'oracle'),str(tmp/'cases.bin')],args.timeout,owner='Pinned shared Temporal C oracle')
        if len(expected)!=320*len(rows): raise SystemExit(f'C record count: {len(expected)} bytes, expected {320*len(rows)}')
        if args.sanitize_c:
            for control in [0,1,2,3,5]:
                result=subprocess.run([str(tmp/'oracle'),'--undefined',str(control)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
                diagnostic=result.stderr.decode(errors='replace')
                if result.returncode==0 or 'runtime error:' not in diagnostic:
                    raise SystemExit(f'C undefined control {control} did not trigger UBSan:\n{diagnostic}')
                print(f'ISOLATED C UB control {control}: {diagnostic.splitlines()[0]}')
            # llabs(INT64_MIN) is C UB but a libc call is not necessarily UBSan
            # instrumented; never claim a sanitizer proof from its numeric value.
        shutil.copytree(ROOT/'src',tmp/'src')
        (tmp/'src/main.silk').write_text(native)
        version=tomllib.loads((ROOT/'silk.toml').read_text())['package']['silk-version']
        (tmp/'silk.toml').write_text(f'[package]\nname="temporal-common-contrast"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command=[executable_path(args.silk),'run','--quiet','--release']
        if args.stdlib: command+=['--stdlib',str(args.stdlib.resolve())]
        actual=process(command,args.timeout,owner='Native shared Temporal contrast',cwd=tmp)
        if actual!=expected:
            at=next((i for i,(a,b) in enumerate(zip(actual,expected)) if a!=b),min(len(actual),len(expected)))
            index=at//320;field=at%320//8
            if index<len(rows):
                op,values,text,label=rows[index]
                c=expected[index*320:(index+1)*320];s=actual[index*320:(index+1)*320]
                raise SystemExit(f'Temporal mismatch case={index} op={NAMES[op]} field={field} args={values} text={text!r} {label}\nC={c.hex()}\nSilk={s.hex()}')
            raise SystemExit(f'Temporal output length mismatch C={len(expected)} Silk={len(actual)}')
        counts=Counter(NAMES[row[0]] for row in rows)
        print(f'PASS shared Temporal: {len(rows)} independent exact records; {len(actual)} bytes; SHA256={hashlib.sha256(actual).hexdigest()}')
        print('Cases: '+', '.join(f'{name}={count}' for name,count in sorted(counts.items())))
        print(f'Inputs SHA256={hashlib.sha256(data).hexdigest()}; {len(PINS)} pinned C sources/headers; commit={COMMIT}')
        print('Excluded C UB: zero divisors/MIN/-1; signed floor subtraction, datetime int64 accumulation, date year/month additions, signed128 sums/multiplication/absolute value, rounding-result overflow; llabs(INT64_MIN); ns-to-seconds overflow; empty successful fgets double-fclose. Nonpositive rounding increments are outside contract.')
        print('C lookahead storage padded by 32 NUL bytes; explicit input lengths/NULs retained. Failed payloads ignored; status compared, with observed C TypeError mapped to -2 for field resolution. JS objects/coercion/exception text are excluded. Platform selector uses injected OS observations; host wrapper uses real TZ.')
        if args.sanitize_c: print('Defined C corpus passed ASan/UBSan; five isolated arithmetic UB controls rejected independently.')


if __name__=='__main__':
    main()
