#!/usr/bin/env python3
"""Execute the collection consumer against native Silk and unchanged pinned C.

The C oracle is a separate executable, never a production binding. Baseline
records compare ordered contents, callback traces, live iterator observations,
computed reentry, weak ownership and pending exceptions. Both consumers use real
native callbacks that collect and mutate; constructor and iterator protocols are
exercised through the native-function ABI.

Each engine independently sweeps one-shot and persistent fail-after allocators
until the first attempt with no injected failure. Allocation ordinals and counts
are intentionally NOT compared across engines. Successful injected attempts
preserve baseline contents and callbacks. Pinned map_hash_resize (54413-54426)
silently returns after js_realloc has installed an OOM: insertion succeeds with
that exception pending. Both consumers must independently exercise this state.
All attempts end with a zero owner/byte ledger; allocation-unfaulted endpoints
match the independently compared baseline. C crashes/leaks remain fatal.

No command runs merely by importing this module. Example:
  python3 scripts/verify_collections.py --reference /path/to/pinned/quickjs
"""
import argparse
from collections import Counter
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests' / 'fixtures'
CASES = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (4, 1),
         (6, 0), (6, 1), (6, 2), (6, 3), (7, 0), (7, 3), (8, 0), (9, 0)]
CASES += [(10, 0), (11, 0), (11, 1), (12, 0),
          (13, 0), (13, 1), (13, 2), (13, 3), (14, 0), (15, 0)]
CASES += [(method, mode) for method in range(16, 23) for mode in range(5)]
CASES += [(16, 5), (18, 5)]  # pinned source intentionally ignores normal-close failure
FIELDS = ('success', 'result', 'target', 'callbacks', 'callback_trace', 'closed',
          'next_count', 'error', 'observation_0', 'observation_1', 'observation_2',
          'observation_3', 'injected_failures', 'pending_exception', 'live_owners', 'live_bytes')
BASELINE = 0xffffffff
RECORD = struct.Struct('<20I')


def nonfatal_growth_oom(scenario, record):
    # Only these fixture operations insert a fourth distinct live key. Their
    # callbacks never throw InternalError; 199 is persistent OOM's null fallback.
    return (scenario in (1, 8, 22) and record[0] == 1 and record[12] > 0
            and record[7] in (106, 199) and record[13] == 1)


def decode(data, engine, maximum):
    if not data or len(data) % RECORD.size:
        raise SystemExit(f'{engine}: truncated collection records ({len(data)} bytes)')
    records = {}
    for row in RECORD.iter_unpack(data):
        scenario, mode, hard, cutoff, *record = row
        key = (scenario, mode, hard, cutoff)
        if (scenario, mode) not in CASES or hard not in (0, 1) or key in records:
            raise SystemExit(f'{engine}: unknown or duplicate collection record {key}')
        if cutoff != BASELINE and cutoff >= maximum:
            raise SystemExit(f'{engine}: out-of-range failure ordinal {key}')
        if record[14:] != [0, 0]:
            raise SystemExit(f'{engine}: collection allocation leak {key}: {record[14:]}')
        ignored_close = (scenario in (16, 18) and mode == 5 and record[0] == 1
                         and record[1] == 2 and record[7] == 909 and record[13] == 1)
        ignored_growth = nonfatal_growth_oom(scenario, record)
        if record[0] not in (0, 1) or (record[13] != 1 - record[0] and not ignored_close and not ignored_growth):
            raise SystemExit(f'{engine}: unmaterialized/lost pending exception {key}: {record}')
        if record[0] and record[7] and not ignored_close and not ignored_growth:
            raise SystemExit(f'{engine}: success retained an error {key}: {record}')
        if not record[0] and record[7] not in {*range(100, 109), 199, 707, 909}:
            raise SystemExit(f'{engine}: unexpected exception category {key}: {record[7]}')
        records[key] = tuple(record)
    return records


def semantics(record):
    # Fail-after counter is allocator topology, not JavaScript behavior.
    return record[:12] + record[13:]


def validate_sweeps(records, engine, maximum):
    expected = set()
    stats = Counter()
    growth_cases = set()
    for scenario, mode in CASES:
        baseline_key = scenario, mode, 0, BASELINE
        expected.add(baseline_key)
        baseline = records.get(baseline_key)
        if baseline is None or baseline[12]:
            raise SystemExit(f'{engine}: missing or faulted baseline {baseline_key}')
        for hard in (0, 1):
            finished = False
            for cutoff in range(maximum):
                key = scenario, mode, hard, cutoff
                expected.add(key)
                record = records.get(key)
                if record is None:
                    raise SystemExit(f'{engine}: incomplete independent fail-after sweep {key}')
                comparison = record
                if nonfatal_growth_oom(scenario, record):
                    growth_cases.add(scenario)
                    stats['nonfatal_growth_oom'] += 1
                    # Preserve every content/callback observation; only the
                    # separately required pending OOM differs from baseline.
                    adjusted = list(record)
                    adjusted[7], adjusted[13] = baseline[7], baseline[13]
                    comparison = tuple(adjusted)
                if record[0] or record[12] == 0:
                    if semantics(comparison) != semantics(baseline):
                        raise SystemExit(f'{engine}: changed successful/no-failure semantics at {key}: '
                                         f'baseline={baseline}, observed={record}')
                if record[12] == 0:
                    finished = True
                    break
                stats['persistent' if hard else 'one_shot'] += 1
                stats[f'error_{record[7]}' if not record[0] else 'recovered_success'] += 1
            if not finished:
                raise SystemExit(f'{engine}: fail-after sweep exhausted {maximum} attempts: '
                                 f'{scenario=}, {mode=}, {hard=}; increase --max-failures')
    if set(records) != expected:
        raise SystemExit(f'{engine}: unexpected extra sweep records: {set(records) - expected}')
    if not {1, 8}.issubset(growth_cases):
        raise SystemExit(f'{engine}: missing successful insertion with pending hash-growth OOM: '
                         f'{sorted({1, 8} - growth_cases)}')
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--max-failures', type=int, default=2048,
                        help='independent sweep guard; exhausting it is an error, never a pass')
    args = parser.parse_args()
    if args.max_failures < 1:
        parser.error('--max-failures must be positive')
    reference = args.reference.expanduser().resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = []
    for scenario, mode in CASES:
        c_calls.append(f'word({scenario});word({mode});word(0);word(UINT32_MAX);run_case({scenario},{mode},-1,0);')
        c_calls.append(f'''for (unsigned hard=0;hard<2;hard++) {{
          int finished=0;
          for (unsigned cutoff=0;cutoff<{args.max_failures};cutoff++) {{
            word({scenario});word({mode});word(hard);word(cutoff);
            run_case({scenario},{mode},cutoff,hard);
            if (!rec[12]) {{finished=1;break;}}
          }}
          if (!finished) {{fprintf(stderr,"collection C sweep exhausted: scenario={scenario} mode={mode} hard=%u\\n",hard);return 2;}}
        }}''')
    native_source = (FIXTURES / 'collection_native.silk').read_text()
    native_source = native_source.replace('COLLECTION_CASE_COUNT', str(len(CASES)))
    native_source = native_source.replace('COLLECTION_CASES', ',\n'.join(
        f'Case {{ scenario: {scenario}, mode: {mode} }}' for scenario, mode in CASES))
    native_source = native_source.replace('COLLECTION_MAX_FAILURES', str(args.max_failures))
    c_source = (FIXTURES / 'collection_oracle.c').read_text().replace('/* COLLECTION_CALLS */', '\n'.join(c_calls))
    with tempfile.TemporaryDirectory(prefix='silkjs-collection-proof-') as directory:
        temp = Path(directory).resolve()
        oracle = temp / 'collection-oracle'
        (temp / 'collection-oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__',
                 '-DCONFIG_VERSION="collection-differential"', '-I', str(reference),
                 str(temp / 'collection-oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(oracle)], 600, owner='Collection pinned-C compilation')
        expected_bytes = process([str(oracle)], 1800, owner='Collection pinned-C semantic/OOM consumer')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src' / 'main.silk').write_text(native_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(
            f'[package]\nname="collection-proof"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual_bytes = process(command, 1800, owner='Collection native semantic/OOM consumer', cwd=temp)
    expected = decode(expected_bytes, 'C', args.max_failures)
    actual = decode(actual_bytes, 'Silk', args.max_failures)
    c_stats = validate_sweeps(expected, 'C', args.max_failures)
    native_stats = validate_sweeps(actual, 'Silk', args.max_failures)
    for scenario, mode in CASES:
        key = scenario, mode, 0, BASELINE
        c_record, native_record = expected[key], actual[key]
        if c_record != native_record:
            difference = '; '.join(f'{field}: C={c}, Silk={s}' for field, c, s in
                                   zip(FIELDS, c_record, native_record) if c != s)
            raise SystemExit(f'Collection semantic mismatch scenario={scenario}, mode={mode}: {difference}')
    if not c_stats['one_shot'] or not native_stats['one_shot'] or not c_stats['persistent'] or not native_stats['persistent']:
        raise SystemExit('Collection allocator proof did not actually inject failures in both engines/modes')
    print(f'PASS collections: {len(CASES)} semantic cases; {pins} pinned files; '
          f'C attempts={len(expected)}, Silk attempts={len(actual)}; independent sweeps, all owner/byte ledgers zero')
    print(f'C failure outcomes: {dict(sorted(c_stats.items()))}')
    print(f'Silk failure outcomes: {dict(sorted(native_stats.items()))}')
    print(f'Native trace SHA256={hashlib.sha256(actual_bytes).hexdigest()}')


if __name__ == '__main__':
    main()
