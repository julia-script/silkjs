#!/usr/bin/env python3
"""Compile IANA time zone data into src/temporal_timezone_data.silk.

The input is the unpacked `tzdata` Python wheel (its `tzdata/` directory), which ships the IANA
database as compiled TZif files with `zoneinfo/tzdata.zi` naming every zone and link. Each zone
keeps every UTC offset change from its first transition through 2037: the transitions the TZif
file lists, then the ones its POSIX footer rule implies. Rerun it when IANA publishes a release:

    python3 scripts/generate_timezones.py path/to/tzdata
"""
import argparse
import calendar
import hashlib
import re
import struct
import time
from pathlib import Path

LAST_YEAR = 2037
INT64_MIN = -(1 << 63)
# ECMA-402 and Temporal name these zones by their short links.
RENAMED = {'Etc/UTC': 'UTC', 'Etc/GMT': 'GMT'}


def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def compact(data):
    """A byte literal that keeps ASCII letters and digits as they are, to shrink the source."""
    return 'b"' + ''.join(chr(byte) if chr(byte).isascii() and chr(byte).isalnum() else f'\\x{byte:02x}' for byte in data) + '"'


# Transition starts are 40-bit signed seconds; the smallest value stands for INT64_MIN, the
# sentinel before a zone's first transition.
START_BYTES = 5
START_SENTINEL = -(1 << (8 * START_BYTES - 1))


def tzif(data):
    """Returns the initial offset, the (time, offset) transitions and the POSIX footer."""
    if data[:4] != b'TZif' or data[4] < ord('2'):
        raise ValueError('expected a TZif version 2 or later file')

    def counts(at):
        return struct.unpack_from('>6l', data, at + 20)

    isut, isstd, leap, time, types, chars = counts(0)
    at = 44 + time * 5 + types * 6 + chars + leap * 8 + isstd + isut
    isut, isstd, leap, time, types, chars = counts(at)
    at += 44
    times = struct.unpack_from(f'>{time}q', data, at)
    at += time * 8
    indices = data[at:at + time]
    at += time
    offsets = [struct.unpack_from('>lBB', data, at + 6 * index)[0] for index in range(types)]
    at += types * 6 + chars + leap * 12 + isstd + isut
    footer = data[at:].strip(b'\n').decode()
    return offsets[0], [(t, offsets[i]) for t, i in zip(times, indices)], footer


def seconds(text):
    """[+-]hh[:mm[:ss]] as seconds."""
    sign = -1 if text.startswith('-') else 1
    parts = [int(part) for part in text.lstrip('+-').split(':')]
    parts += [0] * (3 - len(parts))
    return sign * (parts[0] * 3600 + parts[1] * 60 + parts[2])


NAME = r'(?:<[^>]+>|[A-Za-z]{3,})'
OFFSET = r'[+-]?\d{1,3}(?::\d{2}){0,2}'
RULE = r'M(\d+)\.(\d)\.(\d)(?:/(' + OFFSET + r'))?'
POSIX = re.compile(rf'{NAME}({OFFSET})(?:{NAME}({OFFSET})?,{RULE},{RULE})?')


def day(year, month, week, weekday):
    """Day of month of the `week`th (5 = last) `weekday` of `month`."""
    first = (calendar.weekday(year, month, 1) + 1) % 7
    date = 1 + (weekday - first) % 7 + (week - 1) * 7
    while date > calendar.monthrange(year, month)[1]:
        date -= 7
    return date


def footer(text, start, end):
    """The (time, offset) transitions the POSIX rule `text` implies in years `start` to `end`."""
    match = POSIX.fullmatch(text)
    if not match:
        raise ValueError(f'unsupported POSIX TZ footer: {text!r}')
    standard = -seconds(match[1])
    if match[3] is None:
        return []
    daylight = -seconds(match[2]) if match[2] else standard + 3600
    rules = [(match[3], match[4], match[5], match[6], standard, daylight), (match[7], match[8], match[9], match[10], daylight, standard)]
    out = []
    for year in range(start, end + 1):
        for month, week, weekday, time, before, after in rules:
            date = day(year, int(month), int(week), int(weekday))
            local = calendar.timegm((year, int(month), date, 0, 0, 0)) + seconds(time or '2')
            out.append((local - before, after))
    return sorted(out)


def transitions(data):
    initial, listed, rule = tzif(data)
    last = listed[-1][0] if listed else calendar.timegm((1970, 1, 1, 0, 0, 0))
    year = time.gmtime(last).tm_year
    implied = [item for item in footer(rule, year, LAST_YEAR) if item[0] > last]
    out = [(INT64_MIN, initial)]
    for at, offset in listed + implied:
        if at > calendar.timegm((LAST_YEAR, 12, 31, 23, 59, 59)):
            break
        if offset != out[-1][1]:
            out.append((at, offset))
    return out


def strings(out, name, entries):
    data = bytearray()
    offsets = [0]
    for value in entries:
        data.extend(value.encode('ascii'))
        offsets.append(len(data))
    if len(data) >= 65536:
        raise ValueError(f'{name} outgrew 16-bit offsets')
    out += [f"pub fn {name}(index: i32) -> &'static [u8] {{",
            '  let offsets = ' + literal(b''.join(struct.pack('<H', n) for n in offsets)),
            '  let data = ' + literal(data),
            '  let at = i32.toUsize(index) * 2',
            '  let start = read16(offsets, at)',
            '  return Slice.view<u8>(data, start, read16(offsets, at + 2) - start)', '}', '']


def generate(package):
    zoneinfo = package / 'zoneinfo'
    sources = ['zoneinfo/tzdata.zi', 'zoneinfo/zone.tab', 'zones']
    digest = hashlib.sha256(b''.join((package / name).read_bytes() for name in sources))
    database = (zoneinfo / 'tzdata.zi').read_text()
    version = re.match(r'# version (\S+)', database)[1]
    zoneNames = sorted(line.split()[1] for line in database.splitlines() if line.startswith('Z '))
    links = [line.split()[1:3] for line in database.splitlines() if line.startswith('L ')]
    zones = sorted(RENAMED.get(name, name) for name in zoneNames)
    index = {name: zones.index(RENAMED.get(name, name)) for name in zoneNames}
    aliases = sorted([(alias, index[target]) for target, alias in links if alias not in zones] + [(old, index[old]) for old in RENAMED])
    names = sorted((package / 'zones').read_text().split())
    regions = {}
    for line in (zoneinfo / 'zone.tab').read_text().splitlines():
        if line and not line.startswith('#'):
            fields = line.split('\t')
            regions.setdefault(fields[0], []).append(fields[2])

    blob = bytearray()
    starts = []
    counts = []
    for name in zoneNames:
        table = transitions((zoneinfo / name).read_bytes())
        counts.append((zones.index(RENAMED.get(name, name)), table))
    counts.sort()
    tables = [table for _, table in counts]
    offsetList = sorted({offset for table in tables for _, offset in table})
    offsetIndex = {offset: at for at, offset in enumerate(offsetList)}
    total = 0
    for table in tables:
        starts.append(total)
        total += len(table)
    if total >= 65536 or len(offsetList) >= 65536:
        raise ValueError('time zone data outgrew 16-bit indices')
    for table in tables:
        for at, _ in table:
            blob += (START_SENTINEL if at == INT64_MIN else at).to_bytes(START_BYTES, 'little', signed=True)
    for table in tables:
        for _, offset in table:
            blob += struct.pack('<H', offsetIndex[offset])
    for offset in offsetList:
        blob += struct.pack('<l', offset)

    out = ['// Generated by scripts/generate_timezones.py; do not edit.',
           f'// IANA tzdata {version} (tzdata Python wheel): {", ".join(sources)}.',
           f'// Source SHA-256 (files concatenated in that order): {digest.hexdigest()}',
           f'// Every UTC offset change through {LAST_YEAR}; the last offset holds after it.',
           '// IANA time zone data is in the public domain.',
           '//! Tables read by `temporal_timezone` and `js_intl_locale_info`.',
           'import silk.collections.slice { Slice }', 'import silk.num.u8', 'import silk.num.i32', 'import silk.num.i64', '']
    for name, count in [('zone', len(zones)), ('alias', len(aliases)), ('name', len(names)), ('region', len(regions))]:
        out.append(f'pub const ti_tz_{name}_count: i32 = {count}')
    out += [f'const TRANSITION_COUNT: usize = {total}', f'const OFFSET_COUNT: usize = {len(offsetList)}', '',
            f'/// Transition starts (i{8 * START_BYTES}, {START_SENTINEL} for the first), then their offset indices',
            '/// (u16), then the offsets (i32), little-endian.',
            "fn transitions() -> &'static [u8] {", '  return ' + compact(blob), '}',
            'fn read16(data: &[u8], at: usize) -> usize {',
            '  return u8.toUsize(data[at]) + u8.toUsize(data[at + 1]) * 256', '}',
            'fn readSigned(data: &[u8], at: usize, size: usize) -> i64 {',
            '  let mut high = u8.toI64(data[at + size - 1])',
            '  if high >= 128 { high = high - 256 }',
            '  let mut value = high', '  let mut i: usize = size - 1',
            '  while i > 0 { i = i - 1 value = value * 256 + u8.toI64(data[at + i]) }',
            '  return value', '}', '']
    strings(out, 'tzZoneName', zones)
    strings(out, 'tzAliasName', [alias for alias, _ in aliases])
    strings(out, 'tzName', names)
    regionNames = sorted(regions)
    strings(out, 'tzRegionName', regionNames)
    strings(out, 'tzRegionZones', ['\0'.join(sorted(regions[name])) for name in regionNames])

    def ints(name, entries):
        out.extend([f'pub fn {name}(index: i32) -> i32 {{',
                    '  let data = ' + literal(b''.join(struct.pack('<H', n) for n in entries)),
                    '  let at = i32.toUsize(index) * 2',
                    '  return u8.toI32(data[at]) + u8.toI32(data[at + 1]) * 256', '}', ''])
    ints('tzAliasCanonicalId', [target for _, target in aliases])
    ints('tzTransitionCount', [len(table) for table in tables])
    ints('transitionBase', starts)
    out += ['pub fn tzTransitionStart(id: i32, index: i32) -> i64 {',
            f'  let start = readSigned(transitions(), i32.toUsize(transitionBase(id) + index) * {START_BYTES}, {START_BYTES})',
            f'  if start == {START_SENTINEL} {{ return -9223372036854775807 - 1 }}', '  return start', '}',
            'pub fn tzTransitionOffset(id: i32, index: i32) -> i32 {',
            '  let data = transitions()',
            '  let slot = read16(data, TRANSITION_COUNT * ' + str(START_BYTES) + ' + i32.toUsize(transitionBase(id) + index) * 2)',
            '  return i64.toI32(readSigned(data, TRANSITION_COUNT * ' + str(START_BYTES + 2) + ' + slot * 4, 4))', '}', '']
    return '\n'.join(out)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('package', type=Path, help='the tzdata wheel package directory')
    root = Path(__file__).resolve().parents[1]
    args = parser.parse_args()
    (root / 'src/temporal_timezone_data.silk').write_text(generate(args.package))
