#!/usr/bin/env python3
"""Run the remaining intrinsic scenarios in real Silk and pinned C engines.

The JavaScript scenarios contain independent behavioral assertions. All40 observer
fields and independent teardown ledgers are compared; Date's real clock readings
are instead checked against OS samples surrounding each process. Foreign cases
receive a global object from a second actual realm in the same runtime.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time

from verify_async_execution import C_SOURCE, FIELDS, words
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = {
    'function-error': ('function_error_intrinsics_execution_cases.js', 20, {19}),
    'scalar': ('scalar_intrinsics_execution_cases.js', 20, {19}),
    'date': ('date_intrinsics_execution_cases.js', 28, {26}),
    'json': ('json_intrinsics_execution_cases.js', 22, set()),
    'iterator': ('iterator_intrinsics_execution_cases.js', 11, set()),
    'disposable': ('disposable_stack_execution_cases.js', 27, {26}),
    'global': ('global_intrinsics_execution_cases.js', 8, set()),
    'reflect': ('reflect_intrinsics_execution_cases.js', 19, set()),
}
CLOCK_FIELDS = (16, 17, 18, 24, 25, 26)


def environment(family, case):
    result = os.environ.copy()
    result['TZ'] = 'UTC'
    if family == 'date':
        if case == 21:
            result['TZ'] = 'Asia/Kathmandu'
        elif case in (22, 23, 24):
            result['TZ'] = 'America/New_York'
    return result


def invoke(executable, source, case, foreign, fault, env):
    mode = 'foreign-' if foreign else ''
    mode += 'fault' if fault is not None else 'case'
    command = [str(executable), mode, str(source), str(case)]
    if fault is not None:
        command.append(str(fault))
    before = time.time_ns() // 1_000_000
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=120)
    after = time.time_ns() // 1_000_000
    return result, before, after


def observation(result, family, case, owner, before, after):
    label = f'{owner}/{family}/{case}'
    if result.returncode:
        raise SystemExit(f'{label}: exit={result.returncode}\n{result.stderr.decode(errors="replace")}')
    row = words(result.stdout, 42, label)
    if row[0] != 1 or row[2] or row[-2:] != (0, 0):
        raise SystemExit(f'{label}: execution/exception/owner contract failed: {row}')
    if any(state not in (0, 2) for state in row[8:12]):
        raise SystemExit(f'{label}: pending/rejected Promise is not successful execution: {row[8:12]}')
    if family == 'date' and case == 25:
        if row[3] != 3 or row[19] != 1:
            raise SystemExit(f'{label}: invalid real-clock observation: {row}')
        samples = [row[16 + index] | (row[24 + index] << 32) for index in range(3)]
        if not (before <= samples[0] <= after and before <= samples[1] <= after
                and before - 999 <= samples[2] <= after):
            raise SystemExit(f'{label}: Date clocks {samples} outside independent OS bracket [{before},{after}]')
    elif row[16:20] != (1, 1, 1, 1):
        raise SystemExit(f'{label}: independent JavaScript behavioral assertion failed: {row}')
    return row


def sweep(executable, source, family, case, foreign, maximum, source_engine, defects):
    injected = 0
    env = environment(family, case)
    for cutoff in range(maximum):
        result, _, _ = invoke(executable, source, case, foreign, cutoff, env)
        label = f'{"C" if source_engine else "native"}/{family}/{case}/fault{cutoff}'
        if result.returncode:
            if not source_engine:
                raise SystemExit(f'{label}: exit={result.returncode}\n{result.stderr.decode(errors="replace")}')
            defects.append({'family': family, 'case': case, 'cutoff': cutoff,
                            'exit': result.returncode, 'stderr': result.stderr.decode(errors='replace')})
            injected += 1
            continue
        row = words(result.stdout, 6, label)
        if row[4] or row[5]:
            if not source_engine:
                raise SystemExit(f'{label}: nonzero owner ledgers {row}')
            defects.append({'family': family, 'case': case, 'cutoff': cutoff,
                            'ledger_bytes': row[4], 'ledger_blocks': row[5]})
        if row[0] > 1:
            raise SystemExit(f'{label}: allocator was not single-shot {row}')
        if row[0]:
            injected += 1
        else:
            if not injected or row[1]:
                raise SystemExit(f'{label}: sweep lacks independent injected failure and clean success {row}')
            return cutoff + 1
    raise SystemExit(f'{family}/{case}: no clean non-injected success within {maximum} cutoffs')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', required=True, type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cflag', action='append', default=[])
    parser.add_argument('--family', action='append', choices=FAMILIES)
    parser.add_argument('--case', action='append', type=int, help='Diagnostic case subset')
    parser.add_argument('--skip-faults', action='store_true', help='Diagnostic baselines only; not full verification')
    parser.add_argument('--max-cutoff', type=int, default=4096)
    parser.add_argument('--source-defects', required=True, type=Path)
    args = parser.parse_args()
    if args.max_cutoff < 1:
        parser.error('--max-cutoff must be positive')
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    native, cc = executable_path(str(args.native)), executable_path(args.cc)
    defects = []
    with tempfile.TemporaryDirectory(prefix='silkjs-intrinsic-execution-') as directory:
        temporary = Path(directory).resolve()
        oracle_source, oracle = temporary / 'oracle.c', temporary / 'oracle'
        oracle_source.write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="intrinsic-execution"',
                 *args.cflag, '-I', str(reference), str(oracle_source),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(oracle)],
                600, owner='Intrinsic execution independent C consumer compilation')
        for family in args.family or FAMILIES:
            name, count, foreign_cases = FAMILIES[family]
            source = ROOT / 'scripts' / name
            if family in ('iterator', 'global'):
                original = source.read_text()
                source = temporary / name
                if family == 'iterator':
                    body = 'return [f(operation),true,true,true,[]];'
                else:
                    body = 'const result=f(operation);result.push([]);return result;'
                source.write_text('(function(f){return function(operation){' + body + '};})(' + original + ')')
            cases = [case for case in range(count) if args.case is None or case in args.case]
            if not cases:
                parser.error(f'no selected cases for {family}')
            transcript = bytearray()
            family_defects = len(defects)
            for case in cases:
                env, foreign = environment(family, case), case in foreign_cases
                result, before, after = invoke(oracle, source, case, foreign, None, env)
                expected = observation(result, family, case, 'C', before, after)
                result, before, after = invoke(native, source, case, foreign, None, env)
                actual = observation(result, family, case, 'native', before, after)
                ignored = CLOCK_FIELDS if family == 'date' and case == 25 else ()
                for field, (left, right) in enumerate(zip(expected[:40], actual[:40])):
                    if field not in ignored and left != right:
                        raise SystemExit(f'{family}/{case}: {FIELDS[field]} C={left}, native={right}')
                normalized = list(actual)
                for field in ignored:
                    normalized[field] = 0
                transcript.extend(struct.pack('<42I', *normalized))
            native_cutoffs = source_cutoffs = 0
            if not args.skip_faults:
                for case in cases:
                    foreign = case in foreign_cases
                    native_cutoffs += sweep(native, source, family, case, foreign, args.max_cutoff, False, defects)
                    source_cutoffs += sweep(oracle, source, family, case, foreign, args.max_cutoff, True, defects)
            status = 'DIAGNOSTIC baselines' if args.skip_faults else 'Native verified'
            print(f'{status} {family}: {len(cases)} actual-engine cases; {native_cutoffs} native and '
                  f'{source_cutoffs} independent C cutoffs; zero native ledgers; '
                  f'{len(defects) - family_defects} C defects; {pins} pins; '
                  f'SHA256(clock fields normalized)={hashlib.sha256(transcript).hexdigest()}', flush=True)
            args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    if defects:
        raise SystemExit(f'{len(defects)} measured pinned-C allocator defects: {args.source_defects}; this run is non-passing')
    if not args.skip_faults:
        print('PASS selected intrinsic families: independent behavior and zero-ledger allocation sweeps')


if __name__ == '__main__':
    main()
