#!/usr/bin/env python3
"""Generate or run the complete pinned C/native timezone contrast.

Generate: python3 scripts/temporal_timezone_oracle.py QUICKJS_ROOT OUTPUT.silk
Verify:   python3 scripts/temporal_timezone_oracle.py QUICKJS_ROOT [--silk COMPILER] [--stdlib SDK]

All name/alias assertions and every transition's gap/overlap/subsecond assertions
come from executing unmodified C. Numeric expectations are packed in readonly
records to avoid compiling hundreds of thousands of duplicated assertion bodies.
The verification mode also compares every generated table as logical bytes,
including the full available-name database and NUL-separated region lists.
INT64_MIN with negative nanoseconds is excluded only for next-transition: C reads
before its sentinel array. The native kernel deliberately avoids that undefined
read. No host timezone data or C implementation is linked into native programs.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import tomllib
from generate_temporal_timezone import generate
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]

C_TABLES = r'''
#include <stdio.h>
#include <string.h>
#include "temporal/tzdata_generated.c"
static const size_t region_lengths[] = {REGION_LENGTHS};
static void word(int64_t value) { uint64_t bits=(uint64_t)value;for(int i=0;i<8;i++)putchar((bits>>(i*8))&255); }
static void blob(const char *data,size_t n) { word(n);fwrite(data,1,n,stdout); }
int main(void) {
 if(countof(region_lengths)!=ti_tz_region_count)return 2;
 word(ti_tz_zone_count);word(ti_tz_alias_count);word(ti_tz_name_count);word(ti_tz_region_count);
 for(int i=0;i<ti_tz_zone_count;i++) {
  const TZData *z=&ti_tz_zone_data[i];blob(z->canonical_name,strlen(z->canonical_name));word(z->transition_count);
  for(int j=0;j<z->transition_count;j++) {word(z->transitions[j].start_sec);word(z->transitions[j].offset_sec);}
 }
 for(int i=0;i<ti_tz_alias_count;i++) {blob(ti_tz_aliases[i].alias,strlen(ti_tz_aliases[i].alias));word(ti_tz_aliases[i].canonical_id);}
 for(int i=0;i<ti_tz_name_count;i++)blob(ti_tz_names[i],strlen(ti_tz_names[i]));
 for(int i=0;i<ti_tz_region_count;i++) {blob(ti_tz_region_tab[i].region,strlen(ti_tz_region_tab[i].region));blob(ti_tz_region_tab[i].zones,region_lengths[i]);}
 return 0;
}
'''

SILK_TABLES = r'''
import silk.i32
import silk.i64
import silk.usize
import silk.effect { Effect }
import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import temporal_timezone_data as data
effect fn word(value: i64) -> () ! WriterError ? &mut Writer {
 let mut bytes:[u8;8]=[0;8] let mut i:usize=0
 while i<8 { bytes[i]=i64.toU8(i64.shiftRight(value,usize.toI64(i*8)) & 255) i=i+1 }
 run Writer.writeAll(&bytes)
}
effect fn blob(value: &[u8]) -> () ! WriterError ? &mut Writer {
 run word(usize.toI64(value.length)) run Writer.writeAll(value)
}
effect fn tables() -> () ! WriterError ? &mut Writer {
 run word(i32.toI64(data.ti_tz_zone_count)) run word(i32.toI64(data.ti_tz_alias_count))
 run word(i32.toI64(data.ti_tz_name_count)) run word(i32.toI64(data.ti_tz_region_count))
 let mut i:i32=0
 while i<data.ti_tz_zone_count {
  run blob(data.tzZoneName(i)) let count=data.tzTransitionCount(i) run word(i32.toI64(count))
  let mut j:i32=0 while j<count { run word(data.tzTransitionStart(i,j)) run word(i32.toI64(data.tzTransitionOffset(i,j))) j=j+1 }
  i=i+1
 }
 i=0 while i<data.ti_tz_alias_count { run blob(data.tzAliasName(i)) run word(i32.toI64(data.tzAliasCanonicalId(i))) i=i+1 }
 i=0 while i<data.ti_tz_name_count { run blob(data.tzName(i)) i=i+1 }
 i=0 while i<data.ti_tz_region_count { run blob(data.tzRegionName(i)) run blob(data.tzRegionZones(i)) i=i+1 }
}
pub effect fn main() -> i32 ! WriterError {
 let mut writer=StdoutWriter.make() run tables() |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    parser.add_argument('output', type=Path, nargs='?')
    parser.add_argument('--silk', nargs='?', const=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default=os.environ.get('CC', 'cc'))
    args = parser.parse_args()
    if not args.output and not args.silk:
        args.silk = str(toolchain.compiler_path())
    root = args.reference.resolve()
    pins = validate_pins(root)
    fixture = ROOT / 'tests/fixtures/temporal_timezone_oracle.c'
    sources = [fixture, root / 'temporal/timezone.c', root / 'temporal/tzdata_generated.c']
    generated = generate(root / 'temporal/tzdata_generated.c')
    if generated != (ROOT / 'src/temporal_timezone_data.silk').read_text():
        raise SystemExit('Checked-in timezone tables differ from complete pinned regeneration')
    cc = executable_path(args.cc)
    with tempfile.TemporaryDirectory(prefix='silk-timezone-oracle-') as directory:
        temp = Path(directory)
        executable = temp / 'oracle'
        process([cc, '-O2', '-std=c11', '-D_DEFAULT_SOURCE', '-include', 'strings.h', '-I', str(root), *(str(s) for s in sources), '-o', str(executable)], 600, owner='Timezone C oracle compilation')
        source = process([str(executable)], 600, owner='Timezone independent C oracle').decode()
        if args.output:
            args.output.write_text(source)
        if not args.silk:
            return
        (temp / 'src').mkdir()
        for module in ('temporal_timezone.silk', 'temporal_timezone_data.silk'):
            shutil.copyfile(ROOT / 'src' / module, temp / 'src' / module)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="temporal-timezone-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        (temp / 'src/main.silk').write_text(source)
        process(command, 1800, owner='Native timezone behavioral assertions', cwd=temp)
        counts = re.search(r'// Records: instant=(\d+) local=(\d+) start_of_day=(\d+)', source)
        instant, local, day = map(int, counts.groups())
        names = source.count('assert(tz.ti_tz_find_id(')
        equalities = source.count('assert(tz.ti_timezones_are_equal(')
        numeric = bytes.fromhex(re.search(r'let cases = b"([^"]+)"', source).group(1).replace('\\x', ''))
        if len(numeric) != (instant + local + day) * 72:
            raise SystemExit('Timezone numeric record count differs')
        print(f'PASS timezone behavior: {instant} instant, {local} local/disambiguation, {day} start-of-day records; {names} name/alias probes, {equalities} equality probes; {instant*5+local*3+day+names*3+equalities} C-derived assertions; {pins} pinned sources; numeric SHA256={hashlib.sha256(numeric).hexdigest()}', flush=True)
        # C computes sizeof on the original string literals. Python does not
        # interpret octal escapes or supply the expected region-list contents.
        original = (root / 'temporal/tzdata_generated.c').read_text()
        region_body = re.search(r'const TiTzRegion ti_tz_region_tab\[\] = \{(.*?)\n\};', original, re.S).group(1)
        literals = re.findall(r'\{\s*"[^"]+",\s*("[^"\n]*")\s*\}', region_body)
        table_source = C_TABLES.replace('REGION_LENGTHS', ','.join(f'sizeof({literal})-1' for literal in literals))
        (temp / 'tables.c').write_text(table_source)
        process([cc, '-O2', '-std=c11', '-I', str(root), str(temp / 'tables.c'), '-o', str(temp / 'tables')], 600, owner='Timezone C table compilation')
        expected = process([str(temp / 'tables')], 600, owner='Timezone independent C tables')
        (temp / 'src/main.silk').write_text(SILK_TABLES)
        actual = process(command, 1800, owner='Native timezone logical tables', cwd=temp)
        if expected != actual:
            at = next((i for i, (a, b) in enumerate(zip(expected, actual)) if a != b), min(len(expected), len(actual)))
            raise SystemExit(f'Timezone complete table mismatch at byte {at}: C={len(expected)} bytes Silk={len(actual)} bytes')
        zones, aliases, available, regions = struct.unpack_from('<4q', actual)
        at, transitions = 32, 0
        for _ in range(zones):
            length = struct.unpack_from('<q', actual, at)[0]
            at += 8 + length
            count = struct.unpack_from('<q', actual, at)[0]
            transitions += count
            at += 8 + 16 * count
        print(f'PASS timezone tables: {zones} canonical zones, {transitions} transitions, {aliases} aliases, {available} available names, {regions} regions; {len(actual)} logical bytes; SHA256={hashlib.sha256(actual).hexdigest()}')
        print('UNDEFINED C input excluded: next_transition_at(valid_id, INT64_MIN, negative_nsec); no native out-of-bounds emulation.')


if __name__ == '__main__':
    main()
