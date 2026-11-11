#!/usr/bin/env python3
"""Pinned-C versus installed-native Array behavior and independent fault sweeps.

The --native executable MUST be the real Engine launcher implementing the existing
js_async_execution_consumers contract (not qjs/node, an echo, or a substitute VM):
  case SOURCE.js CASE       -> 40 u32 observations, then live bytes and blocks
  fault SOURCE.js CASE N    -> failures, exception, jobs, remaining, bytes, blocks
The shared consumer evaluates this script through EvalHooks and calls its function
through js_vm.call; Promise callbacks run through the actual runtime job queue.
This file only PREPARES evidence until explicitly run by the integration owner.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from verify_async_execution import C_SOURCE, FIELDS, words, run
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/array_intrinsics_execution_cases.js'
CASES = range(29)
# These literals are independent expected outcomes/order, not native-derived data.
EXPECTED_LOGS = {
    1: [2, 1, 3, 4, 5, 6, 7],
    3: [1, 2, 10, 20, 11, 21, 12, 22],
    4: [0, 1, 2],
    5: [2, 3, 12, 11],
    6: [0, 13, 12],
    7: [1, 2, 3],
    8: [1, 2, 3, 4, 5],
    9: [2, 1, 0, 9],
    11: [10, 20, 13, 40, 33, 11, 12, 22, 31, 42],
    12: [3],
    17: [1, 2, 10, 11],
    18: [0, 2],
    21: [1, 2, 2, 2, 3],
    24: [1, 2, 3, 4, 5, 6, 7],
    26: [1, 2, 3],
    27: [1, 2, 3],
    28: [1, 2, 3, 4],
}


def assert_behavior(case, record, owner):
    if record[0] != 1 or record[2] or tuple(record[16:20]) != (1, 1, 1, 1):
        raise SystemExit(f'{owner} Array case {case}: independent result oracle failed: {record}')
    if case in EXPECTED_LOGS:
        log = EXPECTED_LOGS[case]
        if record[3] != len(log) or list(record[24:24 + len(log)]) != log:
            raise SystemExit(f'{owner} Array case {case}: independent order oracle failed: {record}')
    if case >= 24:
        promised = 3 if case == 25 else (1 if case == 24 else 2)
        if any(state != 2 for state in record[8:8 + promised]):
            raise SystemExit(f'{owner} Array case {case}: pending/rejected result is not success: {record[8:12]}')


def sweep(executable, case, maximum, is_source, defects):
    injected = 0
    for cutoff in range(maximum):
        command = [str(executable), 'fault', str(SOURCE), str(case), str(cutoff)]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            if not is_source:
                raise SystemExit(f'native Array fault {case}/{cutoff}: exit {result.returncode}\n{result.stderr.decode(errors="replace")}')
            defects.append({'case': case, 'cutoff': cutoff, 'exit': result.returncode,
                            'stderr': result.stderr.decode(errors='replace')})
            injected += 1
            continue
        row = words(result.stdout, 6, f'{"C" if is_source else "native"} Array fault {case}/{cutoff}')
        if row[4] or row[5]:
            if not is_source:
                raise SystemExit(f'native Array fault {case}/{cutoff}: nonzero owner ledger {row}')
            defects.append({'case': case, 'cutoff': cutoff, 'ledger_bytes': row[4], 'ledger_blocks': row[5]})
        if row[0] > 1:
            raise SystemExit(f'Array allocator was not single-shot: {row}')
        if row[0]:
            injected += 1
        else:
            if not injected or row[1]:
                raise SystemExit(f'Array sweep missing independent injection/success: {case}: {row}')
            return cutoff + 1
    raise SystemExit(f'Array sweep never reached clean non-injected execution: case={case}, max={maximum}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', required=True, type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--max-cutoff', type=int, default=4096)
    parser.add_argument('--source-defects', required=True, type=Path)
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    native, cc = executable_path(str(args.native)), executable_path(args.cc)
    defects = []
    transcript = bytearray()
    with tempfile.TemporaryDirectory(prefix='silkjs-array-intrinsics-') as directory:
        temp = Path(directory)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('async_execution_cases.js', 'array_intrinsics_execution_cases.js'))
        oracle = temp / 'oracle'
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(oracle)],
                600, owner='Array intrinsic independent C consumer compilation')
        # A fault-injected result never substitutes for a clean semantic baseline.
        for case in CASES:
            expected_bytes = run([str(oracle), 'case', str(SOURCE), str(case)], f'C Array case {case}')
            actual_bytes = run([native, 'case', str(SOURCE), str(case)], f'native Array case {case}')
            expected = words(expected_bytes, 42, f'C Array case {case}')
            actual = words(actual_bytes, 42, f'native Array case {case}')
            if expected[-2:] != (0, 0) or actual[-2:] != (0, 0):
                raise SystemExit(f'Array baseline owner ledger {case}: C={expected[-2:]} native={actual[-2:]}')
            assert_behavior(case, expected, 'C')
            assert_behavior(case, actual, 'native')
            for field, (left, right) in enumerate(zip(expected[:40], actual[:40])):
                if left != right:
                    raise SystemExit(f'Array case={case} {FIELDS[field]} C={left} native={right}')
            transcript.extend(actual_bytes)
        native_cutoffs = source_cutoffs = 0
        for case in CASES:
            # Independent runtimes and ordinals; neither sweep indexes the other.
            native_cutoffs += sweep(native, case, args.max_cutoff, False, defects)
            source_cutoffs += sweep(oracle, case, args.max_cutoff, True, defects)
    args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    status = 'PASS' if not defects else 'Native verified; pinned C defects'
    print(f'{status} Array intrinsics: {len(CASES)} actual-engine cases; {native_cutoffs} native and {source_cutoffs} independent C fault cutoffs; zero native ledgers; {len(defects)} C fault defects; {pins} pinned files; SHA256={hashlib.sha256(transcript).hexdigest()}')
    if defects:
        raise SystemExit(f'Native Array behavior and owner ledgers completed; {len(defects)} measured pinned-C fault defects are separate non-passing evidence: {args.source_defects}')


if __name__ == '__main__':
    main()
