#!/usr/bin/env python3
"""Compile CLDR date and time patterns and calendar names into src/intl_date_skeleton_data.silk.

The inputs are unpacked CLDR 48 npm packages: `cldr-dates-full` for the Gregorian calendar and
one `cldr-cal-<name>-full` per other calendar. For each locale and calendar the table holds a
profile:

- the dateFormats and timeFormats (dateStyle and timeStyle patterns). Times always come from the
  Gregorian calendar, as ICU does;
- the availableFormats skeleton-to-pattern set that `intl_date_skeleton` matches requested
  Intl.DateTimeFormat fields against;
- for calendars other than Gregorian, the format month names (abbreviated, wide, narrow), the
  era names keyed by `temporal_calendar` era, the leap month patterns and the cyclic year names
  of the Chinese and Dangi calendars. Gregorian names come from `intl_locale_data`.

Where CLDR has an `-alt-ascii` form, it is used: it spells the space before AM/PM as U+0020
rather than U+202F, as V8 and Node do for web compatibility. Other alternates, plural (`-count-`)
entries, and skeletons with quarter or week fields are left out: Intl.DateTimeFormat never asks
for them. Japanese eras before Meiji are left out too, because `temporal_calendar` dates them in
the Gregorian era.
Rerun it when CLDR is updated:

    python3 scripts/generate_intl_date_skeletons.py path/to/cldr-dates-full/package \\
        path/to/directory/with/cldr-cal-*-full
"""
import argparse
import hashlib
import json
from pathlib import Path

# Calendar slots, in the order `intl_date_skeleton.slot` maps temporal_calendar values to.
CALENDARS = ['gregorian', 'buddhist', 'chinese', 'coptic', 'dangi', 'ethiopic', 'hebrew', 'indian',
             'islamic', 'japanese', 'persian', 'roc']
# temporal_calendar era values (TI_ERA_*) for each CLDR era key.
ERAS = {
    'buddhist': {'0': 3},
    'coptic': {'1': 4},
    'ethiopic': {'0': 5, '1': 4},
    'hebrew': {'0': 4},
    'indian': {'0': 6},
    'islamic': {'0': 8, '1': 9},
    'japanese': {'232': 12, '233': 13, '234': 14, '235': 15, '236': 16},
    'persian': {'0': 7},
    'roc': {'0': 11, '1': 10},
}
WIDTHS = ['abbreviated', 'wide', 'narrow']
NONE = 0xFFFFFF
NO_TEXT = b'\xff\xff'


def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def u24(value):
    return value.to_bytes(3, 'little')


def plain(pattern):
    # A few locales attach a numbering override: {"_value": pattern, "_numbers": ...}.
    return pattern['_value'] if isinstance(pattern, dict) else pattern


def generate(gregorianPackage, calendarRoot):
    version = json.loads((gregorianPackage / 'package.json').read_text())['version']
    roots = {'gregorian': gregorianPackage}
    for name in CALENDARS[1:]:
        roots[name] = calendarRoot / name
    locales = sorted(path.name for path in (gregorianPackage / 'main').iterdir() if (path / 'ca-gregorian.json').is_file())
    digest = hashlib.sha256()
    pool = bytearray()
    strings = {}

    offsets = bytearray()

    def text(value):
        # Two-byte string ids keep the many skeleton and name references small.
        if value not in strings:
            strings[value] = len(strings)
            offsets.extend(u24(len(pool)))
            pool.extend(value.encode() + b'\0')
        return strings[value].to_bytes(2, 'little')

    blobs = {'styles': bytearray(), 'sets': bytearray(), 'names': bytearray()}
    seen = {key: {} for key in blobs}

    def store(kind, data):
        data = bytes(data)
        if data not in seen[kind]:
            seen[kind][data] = len(blobs[kind])
            blobs[kind].extend(data)
        return seen[kind][data]

    profiles = bytearray()
    profileIndex = {}
    table = bytearray()
    for locale in locales:
        times = None
        for name in CALENDARS:
            path = roots[name] / 'main' / locale / f'ca-{name}.json'
            if not path.is_file():
                table += (0xFFFF).to_bytes(2, 'little')
                continue
            source = path.read_bytes()
            digest.update(source)
            calendar = json.loads(source)['main'][locale]['dates']['calendars'][name]
            if name == 'gregorian':
                times = calendar['timeFormats']
            styles = bytearray()
            numbers = bytearray()
            for kind, formats in [('date', calendar['dateFormats']), ('time', times)]:
                for length in ['full', 'long', 'medium', 'short']:
                    pattern = formats.get(length + '-alt-ascii', formats[length])
                    styles += text(plain(pattern))
                    if kind == 'date':
                        numbers += text(pattern['_numbers']) if isinstance(pattern, dict) else NO_TEXT
            styles += numbers
            formats = calendar['dateTimeFormats']['availableFormats']
            entries = sorted((skeleton, plain(formats.get(skeleton + '-alt-ascii', pattern))) for skeleton, pattern in formats.items()
                             if '-' not in skeleton and not set(skeleton) & set('QwW'))
            entry = bytearray(len(entries).to_bytes(2, 'little'))
            for skeleton, pattern in entries:
                entry += text(skeleton) + text(pattern)
            names = NONE
            if name != 'gregorian':
                months = calendar['months']['format']
                keys = sorted((key for key in months['wide'] if '-' not in key), key=int)
                if name == 'hebrew':
                    keys.append('7-yeartype-leap')
                record = bytearray([len(keys)])
                for width in WIDTHS:
                    for key in keys:
                        record += text(months[width][key])
                eras = [(era, key) for key, era in ERAS.get(name, {}).items() if key in calendar.get('eras', {}).get('eraAbbr', {})]
                record.append(len(eras))
                for era, key in eras:
                    record.append(era)
                    for width in ['eraAbbr', 'eraNames', 'eraNarrow']:
                        record += text(calendar['eras'][width][key])
                if name in ('chinese', 'dangi'):
                    leap = calendar['monthPatterns']['format']
                    for width in WIDTHS:
                        record += text(leap[width]['leap'])
                    years = calendar['cyclicNameSets']['years']['format']['abbreviated']
                    for key in range(1, 61):
                        record += text(years[str(key)])
                names = store('names', record)
            profile = u24(store('styles', styles)) + u24(store('sets', entry)) + u24(names)
            if profile not in profileIndex:
                profileIndex[profile] = len(profiles) // 9
                profiles += profile
            table += profileIndex[profile].to_bytes(2, 'little')
    if len(strings) > 0xFFFF or len(pool) >= NONE or max(len(blob) for blob in blobs.values()) >= NONE or len(profileIndex) >= 0xFFFF:
        raise ValueError('calendar tables outgrew their offsets')
    lines = [
        '// Generated by scripts/generate_intl_date_skeletons.py; do not edit.',
        f'// CLDR {version} (cldr-dates-full and cldr-cal-*-full npm packages): main/*/ca-*.json.',
        f'// Source SHA-256 (files concatenated in locale, then calendar order): {digest.hexdigest()}',
        '// CLDR data: Unicode License V3, https://www.unicode.org/license.txt',
        '//! Tables read by `intl_date_skeleton`. Offsets are little-endian u24 and string ids',
        '//! little-endian u16 indices into `stringOffsets()`.',
        '',
        f'pub const CLDR_VERSION: string = "{version}"',
        f'pub const LOCALE_COUNT: usize = {len(locales)}',
        f'pub const CALENDAR_COUNT: usize = {len(CALENDARS)}',
        '/// Locale identifiers in CLDR spelling, sorted, NUL-separated.',
        "pub fn locales() -> &'static [u8] {",
        '  return ' + literal('\0'.join(locales).encode()),
        '}',
        '/// Per locale, one little-endian u16 index into `profiles()` per calendar slot, 0xffff',
        '/// where CLDR has no data.',
        "pub fn table() -> &'static [u8] {",
        '  return ' + literal(table),
        '}',
        '/// Per profile: the offsets of its record in `styles()`, its set in `sets()`, and its',
        '/// names in `names()` (0xffffff for the Gregorian calendar).',
        "pub fn profiles() -> &'static [u8] {",
        '  return ' + literal(profiles),
        '}',
        '/// Twelve string ids per record: the full, long, medium and short date patterns, the',
        '/// time patterns, then the CLDR numbering override of each date pattern (such as',
        '/// `d=hanidays`), 0xffff where it has none.',
        "pub fn styles() -> &'static [u8] {",
        '  return ' + literal(blobs['styles']),
        '}',
        '/// Per set: a u16 entry count, then per entry the string ids of the skeleton and its pattern.',
        "pub fn sets() -> &'static [u8] {",
        '  return ' + literal(blobs['sets']),
        '}',
        '/// Per record, as string ids: a month count n, then n abbreviated, n wide and n narrow month names (the',
        '/// Hebrew leap Adar II last); an era count, then per era its temporal_calendar value and',
        '/// its abbreviated, wide and narrow names; for Chinese and Dangi, the abbreviated, wide and',
        '/// narrow leap month patterns and the 60 cyclic year names.',
        "pub fn names() -> &'static [u8] {",
        '  return ' + literal(blobs['names']),
        '}',
        '/// The offset in `strings()` of each string id.',
        "pub fn stringOffsets() -> &'static [u8] {",
        '  return ' + literal(offsets),
        '}',
        '/// UTF-8 texts, NUL-terminated.',
        "pub fn strings() -> &'static [u8] {",
        '  return ' + literal(pool),
        '}',
        '',
    ]
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('package', type=Path, help='the cldr-dates-full npm package directory')
    parser.add_argument('calendars', type=Path, help='a directory with one unpacked cldr-cal-<name>-full package per calendar, named <name>')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'src/intl_date_skeleton_data.silk')
    args = parser.parse_args()
    args.output.write_text(generate(args.package, args.calendars))
