#!/usr/bin/env python3
"""Compile CLDR time zone names into src/intl_zone_name_data.silk.

The inputs are unpacked npm packages: `cldr-core` (supplemental metaZones.json, which metazone,
such as America_Eastern, each zone uses over time and its golden zone per region, and
primaryZones.json), `cldr-bcp47` (timezone.json, the CLDR spelling of each zone and its aliases),
`cldr-dates-full` (each locale's timeZoneNames.json) and `cldr-localenames-full` (territory names,
for names such as "Germany Time"), plus the tzdata zone.tab that gives each zone its country.

Zones are keyed by CLDR's canonical spelling ("cid"); each name `temporal_timezone_data` knows
maps to one. Each locale's names are compressed with raw DEFLATE and `intl_zone_name` inflates
one when a DateTimeFormat with zone names is made. The formats stay uncompressed. `∅∅∅`, CLDR's
marker for a name that must not be used, counts as missing. Rerun it when CLDR is updated:

    python3 scripts/generate_intl_zone_names.py CORE BCP47 DATES LOCALENAMES ZONE_TAB
"""
import argparse
import calendar
import hashlib
import json
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import timezone_tables  # noqa: E402

KINDS = [('long', 'generic'), ('long', 'standard'), ('long', 'daylight'), ('short', 'generic'), ('short', 'standard'), ('short', 'daylight')]
CITY = 6
NEVER = '∅∅∅'


def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def minutes(text):
    """CLDR's 'yyyy-MM-dd HH:mm' UTC time as minutes since 1970."""
    date, clock = text.split(' ')
    year, month, day = (int(part) for part in date.split('-'))
    hour, minute = (int(part) for part in clock.split(':'))
    return calendar.timegm((year, month, day, hour, minute, 0)) // 60


def names(entry, withCity=False):
    """The mask of KINDS (and with `withCity`, CITY) present in `entry` and their texts."""
    mask = 0
    texts = []
    for bit, (width, kind) in enumerate(KINDS):
        value = entry.get(width, {}).get(kind)
        if value and value != NEVER:
            mask |= 1 << bit
            texts.append(value)
    city = entry.get('exemplarCity') if withCity else None
    if city and city != NEVER:
        mask |= 1 << CITY
        texts.append(city)
    return mask, texts


def strings(texts):
    return b''.join(text.encode() + b'\0' for text in texts)


def generate(core, bcp47, dates, localenames, zoneTab):
    version = json.loads((dates / 'package.json').read_text())['version']
    digest = hashlib.sha256()

    def load(path):
        source = path.read_bytes()
        digest.update(source)
        return json.loads(source)

    # CLDR's canonical zones and every alias they have.
    cids = []
    cidOf = {}
    for key, value in sorted(load(bcp47 / 'bcp47/timezone.json')['keyword']['u']['tz'].items()):
        if not isinstance(value, dict) or '_alias' not in value:
            continue
        spellings = value['_alias'].split(' ')
        index = len(cids)
        cids.append(spellings[0])
        for spelling in spellings:
            cidOf.setdefault(spelling.lower(), index)
    tzZones, tzTransitions, tzAliases, tzNames, _ = timezone_tables.tables()
    nameZones = bytearray()
    for name in tzNames:
        cid = cidOf.get(name.lower(), 0xFFFF)
        # V8 names GMT and Etc/GMT as UTC; their other aliases keep the Greenwich names.
        if name.lower() in ('gmt', 'etc/gmt'):
            cid = cidOf['etc/utc']
        nameZones += cid.to_bytes(2, 'little')

    # Countries, from zone.tab, and whether a zone is its country's primary one.
    digest.update(zoneTab.read_bytes())
    countryOf = {}
    for line in zoneTab.read_text().splitlines():
        if line.startswith('#') or not line.strip():
            continue
        fields = line.split('\t')
        cid = cidOf.get(fields[2].lower())
        if cid is not None:
            countryOf[cid] = fields[0]
    countries = sorted(set(countryOf.values()))
    countryIndex = {code: index for index, code in enumerate(countries)}
    perCountry = {}
    for cid, code in countryOf.items():
        perCountry[code] = perCountry.get(code, 0) + 1
    primary = {cidOf[zone.lower()] for zone in load(core / 'supplemental/primaryZones.json')['supplemental']['primaryZones'].values()}

    info = load(core / 'supplemental/metaZones.json')['supplemental']['metaZones']
    metazones = sorted({item['mapZone']['_other'] for item in info['metazones']})
    metazoneIndex = {name: index for index, name in enumerate(metazones)}
    goldens = {}
    for item in info['metazones']:
        zone = item['mapZone']
        goldens.setdefault(metazoneIndex[zone['_other']], []).append((zone['_territory'], cidOf[zone['_type'].lower()]))
    goldenBlob = bytearray()
    goldenTable = bytearray()
    for metazone in range(len(metazones)):
        entries = sorted(goldens.get(metazone, []), key=lambda entry: (entry[0] != '001', entry[0]))
        goldenTable += len(goldenBlob).to_bytes(2, 'little')
        goldenBlob.append(len(entries))
        for territory, cid in entries:
            goldenBlob += territory.encode().ljust(3, b'\0')[:3] + cid.to_bytes(2, 'little')

    usages = {}

    def walk(node, path):
        for key, value in node.items():
            if isinstance(value, list):
                cid = cidOf.get((path + key).lower())
                if cid is not None:
                    usages[cid] = [item['usesMetazone'] for item in value]
            else:
                walk(value, path + key + '/')
    walk(info['metazoneInfo']['timezone'], '')
    usageBlob = bytearray()
    zoneTable = bytearray()
    for cid in range(len(cids)):
        country = countryOf.get(cid)
        flags = 1 if country and (perCountry[country] == 1 or cid in primary) else 0
        zoneTable += bytes([countryIndex[country] if country else 0xFF, flags])
        if cid not in usages:
            zoneTable += (0xFFFF).to_bytes(2, 'little')
            continue
        zoneTable += len(usageBlob).to_bytes(2, 'little')
        usageBlob.append(len(usages[cid]))
        for usage in usages[cid]:
            # ICU's metazone data starts in 1970 where CLDR gives no start.
            start = minutes(usage['_from']) if '_from' in usage else 0
            end = minutes(usage['_to']) if '_to' in usage else (1 << 31) - 1
            usageBlob.append(metazoneIndex[usage['_mzone']])
            usageBlob += start.to_bytes(4, 'little', signed=True) + end.to_bytes(4, 'little', signed=True)

    # A primary zone's generic location name is its country's name, so it needs its city only
    # for a partial location name, such as "CET (Algiers)": when its offset leaves the one of a
    # golden zone of its metazone. Primary zones that never do drop their cities. Countries are
    # named for primary zones and for zones that are a metazone's golden zone for their country.
    zoneIds = {name.lower(): index for index, name in enumerate(tzZones)}
    for alias, target in tzAliases:
        zoneIds.setdefault(alias.lower(), target)

    def offsetAt(cid, sec):
        rows = tzTransitions[zoneIds.get(cids[cid].lower(), 0)]
        offset = rows[0][1]
        for start, value in rows:
            if start > sec:
                break
            offset = value
        return offset

    def keepsGolden(cid):
        for usage in usages.get(cid, []):
            start = minutes(usage['_from']) * 60 if '_from' in usage else 0
            end = min(minutes(usage['_to']) * 60 if '_to' in usage else 1 << 62, calendar.timegm((2037, 12, 31, 0, 0, 0)))
            for _, golden in goldens.get(metazoneIndex[usage['_mzone']], []):
                for sec in range(start, end, 86400 * 14):
                    if offsetAt(golden, sec) != offsetAt(cid, sec):
                        return False
        return True
    cityless = {cid for cid in range(len(cids)) if zoneTable[cid * 4 + 1] & 1 and keepsGolden(cid)}
    namedCountries = {countryOf[cid] for cid in range(len(cids)) if zoneTable[cid * 4 + 1] & 1}
    for metazone, entries in goldens.items():
        for territory, cid in entries:
            if countryOf.get(cid) == territory:
                namedCountries.add(territory)
    main = dates / 'main'
    locales = sorted(path.name for path in main.iterdir() if (path / 'timeZoneNames.json').is_file())
    localeIndex = {name: index for index, name in enumerate(locales)}
    explicitParents = load(core / 'supplemental/parentLocales.json')['supplemental']['parentLocales']['parentLocale']

    def parentOf(locale):
        # Any listed locale works as the parent, since a record lists every value that differs
        # from it; CLDR's own parent keeps the records smallest.
        name = explicitParents.get(locale)
        while name is None or name not in localeIndex:
            if name is None:
                name = locale
            name = name.rsplit('-', 1)[0] if '-' in name else 'und'
            if name == 'root':
                name = 'und'
        return None if locale == 'und' else name

    resolved = {}
    formatsOf = {}
    for locale in locales:
        data = load(main / locale / 'timeZoneNames.json')['main'][locale]['dates']['timeZoneNames']
        territoryFile = localenames / 'main' / locale / 'territories.json'
        territories = load(territoryFile)['main'][locale]['localeDisplayNames']['territories'] if territoryFile.is_file() else {}
        values = {}
        for name, entry in data.get('metazone', {}).items():
            mask, texts = names(entry)
            if mask and name in metazoneIndex:
                values[('m', metazoneIndex[name])] = (mask, tuple(texts))

        def zoneWalk(node, path):
            for key, value in node.items():
                if not isinstance(value, dict):
                    continue
                if any(field in value for field in ('long', 'short', 'exemplarCity')):
                    cid = cidOf.get((path + key).lower())
                    mask, texts = names(value, cid not in cityless)
                    if cid is not None and mask:
                        values[('z', cid)] = (mask, tuple(texts))
                else:
                    zoneWalk(value, path + key + '/')
        zoneWalk(data.get('zone', {}), '')
        for index, code in enumerate(countries):
            if code in namedCountries and territories.get(code):
                values[('t', index)] = territories[code]
        resolved[locale] = values
        formatsOf[locale] = strings([data['gmtFormat'], data['hourFormat'], data['regionFormat'], data['fallbackFormat']])

    records = bytearray()
    recordIndex = {}
    formats = bytearray()
    formatIndex = {}
    table = bytearray()
    raws = 0
    for locale in locales:
        parent = parentOf(locale)
        values = resolved[locale]
        base = resolved[parent] if parent else {}
        changed = {key: value for key, value in values.items() if base.get(key) != value}
        for key in base:
            if key not in values:
                changed[key] = '' if key[0] == 't' else (0, ())
        metazoneEntries = sorted((key[1], value) for key, value in changed.items() if key[0] == 'm')
        zoneEntries = sorted((key[1], value) for key, value in changed.items() if key[0] == 'z')
        countryEntries = sorted((key[1], value) for key, value in changed.items() if key[0] == 't')
        raw = bytearray((localeIndex[parent] if parent else 0xFFFF).to_bytes(2, 'little'))
        raw.append(len(metazoneEntries))
        for metazone, (mask, texts) in metazoneEntries:
            raw += bytes([metazone, mask]) + strings(texts)
        raw += len(zoneEntries).to_bytes(2, 'little')
        for cid, (mask, texts) in zoneEntries:
            raw += cid.to_bytes(2, 'little') + bytes([mask]) + strings(texts)
        raw.append(len(countryEntries))
        for index, name in countryEntries:
            raw += bytes([index]) + strings([name])
        raw = bytes(raw)
        raws += len(raw)
        if raw not in recordIndex:
            packer = zlib.compressobj(9, zlib.DEFLATED, -15)
            packed = packer.compress(raw) + packer.flush()
            recordIndex[raw] = len(records)
            records += len(raw).to_bytes(3, 'little') + len(packed).to_bytes(2, 'little') + packed
        text = formatsOf[locale]
        if text not in formatIndex:
            formatIndex[text] = len(formats)
            formats += text
        table += recordIndex[raw].to_bytes(3, 'little') + formatIndex[text].to_bytes(2, 'little')
    if len(formats) >= 0xFFFF or len(usageBlob) >= 0xFFFF or len(goldenBlob) >= 0xFFFF or len(records) >= 1 << 24 or len(countries) >= 0xFF:
        raise ValueError('zone name tables outgrew their offsets')
    lines = [
        '// Generated by scripts/generate_intl_zone_names.py; do not edit.',
        f'// CLDR {version} (cldr-core metaZones.json and primaryZones.json, cldr-bcp47 timezone.json,',
        '// cldr-dates-full timeZoneNames.json, cldr-localenames-full territories.json) and tzdata zone.tab.',
        f'// Source SHA-256 (in that order, locales sorted): {digest.hexdigest()}',
        '// CLDR data: Unicode License V3, https://www.unicode.org/license.txt',
        '//! Tables read by `intl_zone_name`. Offsets are little-endian. A cid is a zone in CLDR spelling.',
        '',
        f'pub const METAZONE_COUNT: usize = {len(metazones)}',
        f'pub const COUNTRY_COUNT: usize = {len(countries)}',
        '/// The cid of Etc/GMT, whose names the offset zone +00:00 takes.',
        f"pub const GREENWICH: usize = {cidOf['etc/gmt']}",
        '/// Per `temporal_timezone_data` name index, the u16 cid of that zone, 0xffff for none.',
        "pub fn nameZones() -> &'static [u8] {",
        '  return ' + literal(nameZones),
        '}',
        '/// The cids, NUL-separated.',
        "pub fn zoneNames() -> &'static [u8] {",
        '  return ' + literal(strings(cids)),
        '}',
        '/// Per cid: its country index (0xff for none), flags (bit 0: the primary zone of its',
        '/// country) and the u16 offset of its metazone uses in `usages()`, 0xffff for none.',
        "pub fn zones() -> &'static [u8] {",
        '  return ' + literal(zoneTable),
        '}',
        '/// The two-letter country codes, sorted.',
        "pub fn countries() -> &'static [u8] {",
        '  return ' + literal(''.join(countries).encode()),
        '}',
        '/// Per zone: a use count, then per use the metazone index and the i32 UTC minutes since',
        '/// 1970 it starts at and ends before.',
        "pub fn usages() -> &'static [u8] {",
        '  return ' + literal(usageBlob),
        '}',
        '/// Per metazone, the u16 offset of its golden zones in `goldens()`.',
        "pub fn goldenTable() -> &'static [u8] {",
        '  return ' + literal(goldenTable),
        '}',
        '/// Per metazone: a count, then per territory its 3-byte code (NUL-padded, 001 first) and cid.',
        "pub fn goldens() -> &'static [u8] {",
        '  return ' + literal(goldenBlob),
        '}',
        '/// Locale identifiers in CLDR spelling, sorted, NUL-separated; und is the root.',
        "pub fn locales() -> &'static [u8] {",
        '  return ' + literal('\0'.join(locales).encode()),
        '}',
        '/// Per locale: the u24 offset of its names in `records()` and the u16 offset of its',
        '/// formats in `formats()`.',
        "pub fn table() -> &'static [u8] {",
        '  return ' + literal(table),
        '}',
        '/// Per record: its u24 inflated and u16 deflated lengths, then raw DEFLATE data. Inflated, a',
        '/// record holds only what differs from its parent: the u16 parent locale index (0xffff for',
        '/// none), a metazone count, then per metazone its index, a mask of the names it has (bits 0',
        '/// to 5: long generic, standard, daylight, then short) and those names, each NUL-terminated;',
        '/// then a u16 zone count and per zone its cid, a mask (bit 6 adds the exemplar city) and',
        '/// names, which win over the metazone ones; then a country count and per country its index',
        '/// and name. An entry replaces the whole entry of the parent; an empty one removes it.',
        "pub fn records() -> &'static [u8] {",
        '  return ' + literal(records),
        '}',
        '/// Per locale: the gmtFormat, hourFormat, regionFormat and fallbackFormat, NUL-terminated.',
        "pub fn formats() -> &'static [u8] {",
        '  return ' + literal(formats),
        '}',
        '',
    ]
    print(f'records {len(records)} raw {raws} distinct {len(recordIndex)}', file=sys.stderr)
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('core', type=Path, help='the cldr-core npm package directory')
    parser.add_argument('bcp47', type=Path, help='the cldr-bcp47 npm package directory')
    parser.add_argument('dates', type=Path, help='the cldr-dates-full npm package directory')
    parser.add_argument('localenames', type=Path, help='the cldr-localenames-full npm package directory')
    parser.add_argument('zonetab', type=Path, help="tzdata's zone.tab")
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'src/intl_zone_name_data.silk')
    args = parser.parse_args()
    args.output.write_text(generate(args.core, args.bcp47, args.dates, args.localenames, args.zonetab))
