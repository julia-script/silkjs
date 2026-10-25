#!/usr/bin/env python3
"""Pin-checked separate-process Uint8Array codec semantics and fault proofs."""
import argparse
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
CASES = [(method, kind) for method in range(6) for kind in range(25)]
FAULT_CASES = [(method, kind) for method in range(6) for kind in (0, 5, 14, 16, 17)]
FIELDS = ('success', 'error_kind', 'result_length', 'result_digest', 'read',
          'written', 'backing_length', 'backing_digest', 'callbacks', 'events',
          'detached', 'pending', 'faults', 'source_reclaimed_bytes', 'allocations', 'bytes')
NATIVE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_typed_array_methods_codecs_oracle as oracle
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_property_names { OwnKeysError }
import js_prototypes { PrototypeError }
struct Case { method: u32, kind: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | OwnKeysError | PrototypeError | JsException | WriterError {
  let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
  CALLS
  let mut writer = StdoutWriter.make()
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def records(data, count, label):
    if len(data) != count * 64:
        raise SystemExit(f'{label}: expected {count * 64} bytes, got {len(data)}')
    rows = list(struct.iter_unpack('<16I', data))
    for i, row in enumerate(rows):
        if row[14:] != (0, 0):
            raise SystemExit(f'{label} row {i}: owner leak {row}')
        if bool(row[0]) == bool(row[11]):
            raise SystemExit(f'{label} row {i}: success/exception mismatch {row}')
    return rows


def native(temp, silk, stdlib, cases, cutoffs=1, armed=False):
    entries = ','.join(f'Case {{ method: {m}, kind: {k} }}' for m, k in cases)
    calls = f'''let cases: [Case; {len(cases)}] = [{entries}]
  let mut i: usize = 0
  while i < cases.length {{
    let mut cutoff: usize = 0
    while cutoff < {cutoffs} {{
      let row = run oracle.isolated(cases[i].method, cases[i].kind, {str(armed).lower()}, cutoff)
      let mut field: usize = 0
      while field < 16 {{ run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
      cutoff = cutoff + 1
    }}
    i = i + 1
  }}'''
    (temp / 'src/main.silk').write_text(NATIVE.replace('CALLS', calls))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command, 1200, owner='codec native consumer', cwd=temp)


def compare(case, expected, actual):
    for i, (want, got) in enumerate(zip(expected, actual)):
        if want != got:
            raise SystemExit(f'codec {case} {FIELDS[i]}: C={want}, native={got}')


def digest(data):
    value = 0
    for byte in data:
        value = (value * 31 + byte) & 65535
    return value


def golden(rows):
    baseline = dict(zip(CASES, rows))
    for case, expected in (((0, 0), b'paWlpaWl'), ((1, 0), b'a5a5a5a5a5a5'),
                           ((4, 0), b'foo'), ((5, 0), b'foo')):
        row = baseline[case]
        if not row[0] or row[2:4] != (len(expected), digest(expected)):
            raise SystemExit(f'codec golden {case}: {row}')
    for case in ((2, 5), (3, 11)):
        prefix = b'foo' if case[0] == 2 else b'\xff\x00'
        row = baseline[case]
        if row[0] or row[1] != 3 or row[7] != digest(prefix + b'\xa5' * (6 - len(prefix))):
            raise SystemExit(f'codec error must preserve committed writes {case}: {row}')
    if baseline[(2, 8)][4:6] != (0, 0):
        raise SystemExit('base64 capacity must not commit a group that needs two bytes')
    if baseline[(2, 4)][4:6] != (4, 3):
        raise SystemExit('stop-before-partial must exclude trailing whitespace and partial characters')
    for method in (0, 2):
        row = baseline[(method, 16)]
        if row[0] or row[1] != 4 or row[8:11] != (2, 46, 1):
            raise SystemExit(f'codec options must run before detached check: {row}')
    return baseline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cutoffs', type=int, default=96)
    args = parser.parse_args()
    if args.cutoffs < 1:
        parser.error('--cutoffs must be positive')
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.resolve() if args.stdlib else None
    with tempfile.TemporaryDirectory(prefix='silkjs-codecs-') as directory:
        temp = Path(directory).resolve()
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="2026-06-04"',
                 '-I', str(reference), str(ROOT / 'tests/fixtures/typed_array_codecs_oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='unchanged pinned codec C compilation')
        expected = records(process([str(temp / 'oracle')], 600, owner='codec C semantics'), len(CASES), 'C semantics')
        golden(expected)
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="codec-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = records(native(temp, silk, stdlib, CASES), len(CASES), 'native semantics')
        baseline = golden(actual)
        for case, c_row, n_row in zip(CASES, expected, actual):
            compare(case, c_row, n_row)
        faults = records(native(temp, silk, stdlib, FAULT_CASES, args.cutoffs, True),
                         len(FAULT_CASES) * args.cutoffs, 'native faults')
        for i, case in enumerate(FAULT_CASES):
            group = faults[i * args.cutoffs:(i + 1) * args.cutoffs]
            clean = [row for row in group if not row[12]]
            if not clean:
                raise SystemExit(f'native {case}: sweep never reached clean execution')
            for row in clean:
                compare(case, baseline[case], row)
        if not any(row[12] for row in faults):
            raise SystemExit('native fault sweep injected no failures')
        # Mutation must remain observable when allocating the read/written result fails.
        index = FAULT_CASES.index((2, 0))
        group = faults[index * args.cutoffs:(index + 1) * args.cutoffs]
        if not any(row[12] and not row[0] and row[7] == digest(b'foo\xa5\xa5\xa5') for row in group):
            raise SystemExit('native fault sweep did not prove writes survive result-object OOM')
        c_failures = 0
        source_owners = source_bytes = 0
        for case in FAULT_CASES:
            clean = False
            for cutoff in range(args.cutoffs):
                command = [str(temp / 'oracle'), *(str(v) for v in case), '1', str(cutoff)]
                probe = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    raise SystemExit(f'C {case} cutoff={cutoff}: {probe.returncode}: {probe.stderr.decode(errors="replace")}')
                row = records(probe.stdout, 1, f'C {case} cutoff={cutoff}')[0]
                c_failures += row[12]
                if row[13]:
                    if case[0] < 2 or case[1] != 14 or cutoff != 0 or not row[12]:
                        raise SystemExit(f'unexpected source owner recovery: {case}, {cutoff}, {row}')
                    source_owners += 1
                    source_bytes += row[13]
                if not row[12]:
                    clean = True
                    compare(case, baseline[case], row)
            if not clean:
                raise SystemExit(f'C {case}: sweep never reached clean execution')
        if not c_failures:
            raise SystemExit('C fault sweep injected no failures')
        if source_owners != 4:
            raise SystemExit(f'expected four measured pinned UTF-8 owner defects, got {source_owners}')
        print(f'PASS codecs: {len(CASES)} semantic cases; {pins} pins; '
              f'{len(FAULT_CASES) * args.cutoffs} fault attempts per engine; native ledgers zero; '
              f'C ledgers zero after measuring/reclaiming {source_owners} source UTF-8 owners ({source_bytes} bytes)')


if __name__ == '__main__':
    main()
