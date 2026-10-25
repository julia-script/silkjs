#!/usr/bin/env python3
"""Run the unmodified pinned Test262 corpus through real C and Silk runners.

The config, feature/exclusion policy, known errors and harness are never patched.
A per-run test262 symlink preserves the exact source known-error path spelling.
Both serial reports and threaded error inventories are required. Source defects
(including warnings, crashes and timeouts) are evidence, never native passes.
No executable is built here. --reference-only does not claim native acceptance;
--reference-results reuses hash-checked source evidence after the native gate.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
CORPUS_REVISION = 'd53ebc8b1931d9f1541e43d59650776e4b766248'
SOURCE_REVISION = '7d1c13c5d8f8c6b32893786ed35cdcebd88194d2'
SOURCE = Path('/private/tmp/silkjs-quickjs-reference-20261023')
SUMMARY = re.compile(r'^Result: (\d+)/(\d+) errors?(.*)$', re.M)
LEDGER = re.compile(r'^Native runner ledger: threads=(\d+) runtimes=(\d+) live=(\d+) bytes=(\d+)$', re.M)
ERROR = re.compile(r'^(test262/test/[^\n]+?\.js):(\d+): (strict mode: )?(.*)$', re.M)
HEADER = re.compile(r'^(\d+): (test262/test/[^\n]+?\.js)([^\n]*)$', re.M)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], timeout=60)


def pin_inputs(corpus, source):
    require(git(corpus, 'rev-parse', 'HEAD').decode().strip() == CORPUS_REVISION,
            'corpus revision does not match the pinned acceptance revision')
    require(not git(corpus, 'status', '--porcelain', '--untracked-files=all'),
            'corpus is modified; unmodified tests and harness are required')
    require(git(source, 'rev-parse', 'HEAD').decode().strip() == SOURCE_REVISION,
            'QuickJS source revision does not match the pinned oracle')
    hashes = {}
    for name in ('test262.conf', 'test262_errors.txt', 'run-test262.c'):
        data = (source / name).read_bytes()
        require(data == git(source, 'show', SOURCE_REVISION + ':' + name),
                'pinned source input is modified: ' + name)
        hashes[name] = hashlib.sha256(data).hexdigest()
    return {'corpus_revision': CORPUS_REVISION, 'source_revision': SOURCE_REVISION,
            'source_inputs_sha256': hashes, 'harness_modified': False,
            'config_modified': False}


def inventory(corpus, config):
    # The independent filesystem inventory detects a runner that silently drops
    # files; feature skips remain visible in the real serial report.
    section = ''
    excluded = []
    settings = {}
    for raw in config.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('['):
            section = line.strip('[]')
        elif section == 'exclude':
            excluded.append(line)
        elif section == 'config':
            key, value = line.split('=', 1)
            settings[key] = value
    require(settings.get('mode') == 'default', 'pinned config mode changed')
    require(settings.get('harnessdir') == 'test262/harness' and
            settings.get('testdir') == 'test262/test' and
            settings.get('errorfile') == 'test262_errors.txt' and
            settings.get('reportfile') == 'test262_report.txt',
            'pinned config path contract changed')
    all_tests = {'test262/' + p.relative_to(corpus).as_posix()
                 for p in (corpus / 'test').rglob('*.js')
                 if not p.name.endswith('_FIXTURE.js')}
    excluded_tests = {p for p in all_tests if any(
        p.startswith(e) if e.endswith('/') else p == e for e in excluded)}
    return all_tests - excluded_tests, excluded_tests


def errors_from(text):
    records = []
    matches = list(ERROR.finditer(text))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        message = text[match.start(4):end].rstrip('\n')
        records.append({'path': match[1], 'line': int(match[2]),
                        'mode': 'strict' if match[3] else 'default', 'message': message})
    if text.strip() and (not matches or text[:matches[0].start()].strip()):
        raise ValueError('unparsed content in error inventory')
    keys = [(e['path'], e['mode']) for e in records]
    require(len(keys) == len(set(keys)), 'duplicate path/mode in error inventory')
    return sorted(records, key=lambda e: (e['path'], e['mode']))


def report_from(text):
    records = []
    headers = list(HEADER.finditer(text))
    for index, match in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        flags = match[3]
        body = text[match.end():end]
        status = 'skipped' if 'SKIPPED' in flags else 'failed' if '\n  FAILED\n' in body else 'passed'
        mode = 'module' if ' module' in flags else 'strict' if '@onlyStrict' in flags else 'sloppy'
        records.append({'index': int(match[1]), 'path': match[2], 'mode': mode,
                        'status': status, 'flags': flags.strip()})
    return records


def record_delta(expected, actual, keys):
    before = {tuple(r[k] for k in keys): r for r in expected}
    after = {tuple(r[k] for k in keys): r for r in actual}
    return {'missing': [before[k] for k in sorted(before.keys() - after.keys())],
            'extra': [after[k] for k in sorted(after.keys() - before.keys())],
            'changed': [{'expected': before[k], 'actual': after[k]}
                        for k in sorted(before.keys() & after.keys()) if before[k] != after[k]]}


def differs(delta):
    return any(delta.values())


def execute(binary, side, threads, output, corpus, source, timeout, selected=None):
    suffix = '-omitted-' + hashlib.sha256('\n'.join(sorted(selected)).encode()).hexdigest()[:12] if selected else ''
    work = output / (f'{side}-t{threads}' + suffix)
    work.mkdir(parents=True, exist_ok=False)
    (work / 'test262').symlink_to(corpus, target_is_directory=True)
    for name in ('test262.conf', 'test262_errors.txt'):
        (work / name).write_bytes((source / name).read_bytes())
    # -u deliberately ignores the known-error suppression and writes EVERY
    # observed failure. The untouched known errors are compared independently.
    command = [str(binary), '-c', 'test262.conf', '-q', '-v', '-T', str(threads), '-u']
    error_file = 'test262_errors.txt'
    if selected:
        # Source numeric-name deduplication can omit distinct corpus files.
        # -E selects these exact paths; -u ignores selection text as expected
        # failures. The original full run remains defective, never waived.
        error_file = 'selected-errors.txt'
        (work / error_file).write_text(''.join(path + ':\n' for path in sorted(selected)))
        command.extend(['-e', error_file, '-E'])
    env = dict(os.environ, LC_ALL='C', LANG='C', TZ='America/Los_Angeles')
    env.pop('SILK_TEST262_LEDGER', None)
    if side == 'native':
        env['SILK_TEST262_LEDGER'] = '1'
    result = {'argv': command, 'cwd': str(work), 'threads': threads, 'side': side,
              'timeout_seconds': timeout, 'environment': {k: env.get(k) for k in
              ('LC_ALL', 'LANG', 'TZ', 'SILK_TEST262_LEDGER')}, 'timed_out': False,
              'error_file': error_file, 'selected_paths': sorted(selected) if selected else None}
    save(work / 'process.json', result)
    start = time.monotonic()
    with (work / 'stdout.bin').open('wb') as stdout, (work / 'stderr.bin').open('wb') as stderr:
        process = subprocess.Popen(command, cwd=work, env=env, stdout=stdout, stderr=stderr,
                                   start_new_session=True)
        try:
            result['returncode'] = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            result['timed_out'] = True
            # Kill agent/worker descendants too; a hung testcase cannot escape
            # the finite real execution deadline or corrupt a later run.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            result['returncode'] = process.wait()
    result['elapsed_seconds'] = time.monotonic() - start
    result['artifacts_sha256'] = {name: digest(work / name) for name in
        ('stdout.bin', 'stderr.bin', 'test262.conf', 'test262_errors.txt', 'selected-errors.txt', 'test262_report.txt')
        if (work / name).is_file()}
    save(work / 'process.json', result)
    return work, result


def analyze(work, process, expected_paths, excluded_paths, known_errors):
    defects = []
    result = dict(process)
    stdout = (work / 'stdout.bin').read_text(errors='backslashreplace')
    stderr = (work / 'stderr.bin').read_text(errors='backslashreplace')
    summary = list(SUMMARY.finditer(stderr))
    result['summary'] = None
    if process['timed_out']:
        defects.append('execution deadline exceeded; incomplete corpus')
    if process['returncode'] != 0:
        defects.append('runner exited with status ' + str(process['returncode']))
    if len(summary) != 1:
        defects.append('missing or duplicate final result summary')
    else:
        result['summary'] = {'failed': int(summary[0][1]), 'executed': int(summary[0][2]),
                             **{k: int(v) for v, k in re.findall(r', (\d+) (\w+)', summary[0][3])}}
        counts = result['summary']
        if counts['executed'] + counts.get('skipped', 0) != len(expected_paths):
            defects.append('final count does not cover independent complete corpus inventory')
        if counts.get('excluded', 0) != len(excluded_paths):
            defects.append('excluded count disagrees with pinned exclusion policy')
        if counts['executed'] == 0:
            defects.append('no tests executed')
    # Unknown-feature messages are warnings emitted without a warning prefix.
    warnings = sorted(line for line in (stdout + '\n' + stderr).splitlines()
                      if 'unknown feature:' in line or re.search(r'\bwarning\b', line, re.I))
    result['warnings'] = warnings
    if warnings:
        defects.append(f'{len(warnings)} runner warnings (not waived)')
    unexpected_stderr = LEDGER.sub('', SUMMARY.sub('', stderr)).strip()
    if unexpected_stderr:
        defects.append('unexpected stderr diagnostics; see raw transcript')
        result['stderr_diagnostics'] = unexpected_stderr
    result['error_inventory_complete'] = (
        process['returncode'] == 0 and not process['timed_out'] and result['summary'] is not None)
    result['errors'] = []
    if result['error_inventory_complete']:
        try:
            result['errors'] = errors_from((work / process.get('error_file', 'test262_errors.txt')).read_text())
        except ValueError as error:
            defects.append(str(error))
        if len(result['errors']) != result['summary']['failed']:
            defects.append('per-file/mode failure inventory does not account for all failed tests')
        result['known_error_delta'] = record_delta(known_errors, result['errors'], ('path', 'mode'))
        if differs(result['known_error_delta']):
            defects.append('observed failures differ from pinned source known errors')
    else:
        # -u writes only at normal shutdown. On a trap this file still contains
        # the INPUT known-error/selection list, not observed native failures.
        result['known_error_delta'] = None
        defects.append('error inventory was not finalized; input error file is not execution evidence')
    result['report'] = []
    report_path = work / 'test262_report.txt'
    if process['threads'] == 1:
        if not report_path.is_file():
            defects.append('missing serial per-file report')
        else:
            report_text = report_path.read_text(errors='backslashreplace')
            result['report'] = report_from(report_text)
            if not result['error_inventory_complete']:
                result['report_tail_fragment'] = report_text.rsplit('\n', 1)[-1]
                if result['report'] and result['report'][-1]['status'] == 'passed':
                    result['report'][-1]['status'] = 'unconfirmed'
            observed = [r['path'] for r in result['report']]
            if len(observed) != len(set(observed)) or set(observed) != expected_paths:
                defects.append('serial report omits or duplicates configured corpus paths')
            if result['summary']:
                statuses = Counter(r['status'] for r in result['report'])
                if (statuses['failed'] != result['summary']['failed'] or
                    statuses['passed'] + statuses['failed'] != result['summary']['executed'] or
                    statuses['skipped'] != result['summary'].get('skipped', 0)):
                    defects.append('serial report statuses disagree with final counters')
                if {r['path'] for r in result['report'] if r['status'] == 'failed'} != {r['path'] for r in result['errors']}:
                    defects.append('serial report failures disagree with error inventory')
            if process['timed_out'] or process['returncode'] < 0:
                result['last_reported_test'] = result['report'][-1] if result['report'] else None
    elif report_path.exists():
        defects.append('threaded runner produced report disabled by source contract')
    result['ownership_clean'] = None
    if process['side'] == 'native':
        ledgers = list(LEDGER.finditer(stderr))
        result['ownership_clean'] = False
        if len(ledgers) == 1 and result['summary']:
            observed = tuple(map(int, ledgers[0].groups()))
            expected = (process['threads'], result['summary']['executed'], 0, 0)
            result['ownership_clean'] = observed == expected
            result['ownership_ledger'] = observed
        if not result['ownership_clean']:
            defects.append('missing, nonzero or incomplete native runtime teardown ledger')
    result['defects'] = defects
    save(work / 'analysis.json', result)
    return result


def compare_runs(expected, actual):
    # Report indices are ordering artifacts, not testcase identities. Native
    # exact-path discovery intentionally repairs the C numeric-dedup omission,
    # so its later indices differ even though each path/mode result agrees.
    expected_report = [{k: v for k, v in r.items() if k != 'index'} for r in expected['report']]
    actual_report = [{k: v for k, v in r.items() if k != 'index'} for r in actual['report']]
    delta = {'errors': record_delta(expected['errors'], actual['errors'], ('path', 'mode')),
             'report': record_delta(expected_report, actual_report, ('path', 'mode')),
             'summary_equal': expected['summary'] == actual['summary'],
             'warnings_equal': expected['warnings'] == actual['warnings']}
    delta['matched'] = (not differs(delta['errors']) and not differs(delta['report']) and
                        delta['summary_equal'] and delta['warnings_equal'] and
                        not expected['timed_out'] and not actual['timed_out'] and
                        expected['returncode'] == actual['returncode'] == 0)
    return delta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', type=Path)
    parser.add_argument('--reference-only', action='store_true')
    parser.add_argument('--reference-results', type=Path,
                        help='reuse a prior reference-only output directory, with artifact hashes checked')
    parser.add_argument('--corpus', type=Path, default=ROOT / 'build/test262-upstream')
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/test262-full-verification')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--timeout', type=float, default=1800, help='deadline per full-corpus process, in seconds')
    args = parser.parse_args()
    require(args.threads > 1, 'threaded acceptance requires --threads > 1')
    require(0 < args.timeout < float('inf'), 'timeout must be finite and positive')
    require(args.reference_only != (args.native is not None), 'supply exactly one of --reference-only or --native')
    corpus, source, output = args.corpus.resolve(), args.source.resolve(), args.output.resolve()
    identity = pin_inputs(corpus, source)
    reference = args.reference.resolve()
    native = args.native.resolve() if args.native else None
    for binary in (reference,) if native is None else (reference, native):
        require(binary.is_file() and os.access(binary, os.X_OK), 'runner is missing or not executable: ' + str(binary))
    if native is not None:
        require(not os.path.samefile(reference, native) and digest(reference) != digest(native),
                'native and reference must be genuinely distinct executables')
    identity['reference_sha256'] = digest(reference)
    expected_paths, excluded_paths = inventory(corpus, (source / 'test262.conf').read_text())
    known = errors_from((source / 'test262_errors.txt').read_text())
    output.mkdir(parents=True, exist_ok=True)
    require(not (output / 'results.json').exists(), 'choose a fresh output directory; prior evidence is immutable')
    manifest = {'identity': identity, 'corpus': str(corpus), 'source': str(source),
                'reference': str(reference), 'native': str(native) if native else None,
                'native_sha256': digest(native) if native else None,
                'source_only': native is None, 'full_configured_test_files': len(expected_paths),
                'excluded_test_files': len(excluded_paths), 'known_errors': known,
                'runs': {}, 'comparisons': {}, 'accepted': False}
    save(output / 'results.json', manifest)
    saved = None
    if args.reference_results:
        saved = json.loads((args.reference_results / 'results.json').read_text())
        require(saved['identity'] == identity, 'cached source evidence identity differs')
    try:
        for threads in (1, args.threads):
            key = f'reference-t{threads}'
            if saved is None:
                work, process = execute(reference, 'reference', threads, output, corpus, source, args.timeout)
                result = analyze(work, process, expected_paths, excluded_paths, known)
            else:
                result = saved['runs'][key]
                work = Path(result['cwd'])
                for name, expected in result['artifacts_sha256'].items():
                    require(digest(work / name) == expected, 'cached source artifact changed: ' + str(work / name))
                result = analyze(work, result, expected_paths, excluded_paths, known)
            manifest['runs'][key] = result
            save(output / 'results.json', manifest)
            if native is not None:
                work, process = execute(native, 'native', threads, output, corpus, source, args.timeout)
                result = analyze(work, process, expected_paths, excluded_paths, known)
                manifest['runs'][f'native-t{threads}'] = result
                save(output / 'results.json', manifest)
        for side in ('reference',) if native is None else ('reference', 'native'):
            serial = dict(manifest['runs'][f'{side}-t1'], report=[])
            threaded = manifest['runs'][f'{side}-t{args.threads}']
            manifest['comparisons'][f'{side}-thread-determinism'] = compare_runs(serial, threaded)
        # Keep source enumeration defects explicit, while independently running
        # the otherwise omitted physical files without editing the corpus.
        source_serial = manifest['runs']['reference-t1']
        omitted = expected_paths - {r['path'] for r in source_serial['report']}
        manifest['source_omitted_paths'] = sorted(omitted)
        if native is not None:
            native_serial = manifest['runs']['native-t1']
            native_omitted = expected_paths - {r['path'] for r in native_serial['report']}
            manifest['native_omitted_paths'] = sorted(native_omitted)
        if omitted and not source_serial['timed_out'] and source_serial['returncode'] == 0:
            # Native MUST execute these directly in its full run. Supplemental
            # source executions establish the missing oracle, not a native
            # coverage waiver. One file per selection avoids another collision.
            for path in sorted(omitted):
                selected = {path}
                suffix = '-omitted-' + hashlib.sha256(path.encode()).hexdigest()[:12]
                selected_known = [r for r in known if r['path'] == path]
                for threads in (1, args.threads):
                    key = f'reference-t{threads}' + suffix
                    if saved and key in saved['runs']:
                        process = saved['runs'][key]
                        require(process['selected_paths'] == [path], 'cached supplemental selection changed')
                        work = Path(process['cwd'])
                        for name, expected in process['artifacts_sha256'].items():
                            require(digest(work / name) == expected, 'cached supplemental artifact changed: ' + str(work / name))
                    else:
                        work, process = execute(reference, 'reference', threads, output, corpus, source, args.timeout, selected)
                    manifest['runs'][key] = analyze(work, process, selected, set(), selected_known)
                    save(output / 'results.json', manifest)
                manifest['comparisons']['reference-thread-determinism' + suffix] = compare_runs(
                    dict(manifest['runs']['reference-t1' + suffix], report=[]),
                    manifest['runs'][f'reference-t{args.threads}' + suffix])
        manifest['full_physical_corpus_covered'] = {}
        for side in ('reference',) if native is None else ('reference', 'native'):
            serial_runs = [r for k, r in manifest['runs'].items() if k.startswith(side + '-') and r['threads'] == 1]
            covered = {row['path'] for r in serial_runs for row in r['report']}
            manifest['full_physical_corpus_covered'][side] = (
                covered == expected_paths and all(not r['timed_out'] and r['returncode'] == 0 for r in serial_runs))
        # Aggregate actual source executions, never synthesize testcase passes.
        # The raw C full-run defects stay visible independently of this oracle.
        manifest['completed_source_oracle'] = {}
        for threads in (1, args.threads):
            runs = [r for k, r in manifest['runs'].items() if k.startswith('reference-') and r['threads'] == threads]
            summaries = [r['summary'] for r in runs]
            complete = all(summary is not None for summary in summaries)
            oracle = {
                'summary': {key: sum(s.get(key, 0) for s in summaries) for key in set().union(*summaries)} if complete else None,
                'errors': sorted([e for r in runs for e in r['errors']], key=lambda e: (e['path'], e['mode'])),
                'report': [row for r in runs for row in r['report']],
                'warnings': sorted(w for r in runs for w in r['warnings']),
                'timed_out': any(r['timed_out'] for r in runs),
                'returncode': next((r['returncode'] for r in runs if r['returncode'] != 0), 0),
            }
            manifest['completed_source_oracle'][f't{threads}'] = oracle
            if native is not None:
                manifest['comparisons'][f'differential-t{threads}'] = compare_runs(oracle, manifest['runs'][f'native-t{threads}'])
        enumeration_defects = {
            'final count does not cover independent complete corpus inventory',
            'serial report omits or duplicates configured corpus paths',
        }
        manifest['source_oracle_complete'] = (
            manifest['full_physical_corpus_covered']['reference'] and
            all(not (set(r['defects']) - (enumeration_defects if not r.get('selected_paths') else set()))
                for key, r in manifest['runs'].items() if key.startswith('reference-')))
        source_clean = all(not run['defects'] for key, run in manifest['runs'].items() if key.startswith('reference-'))
        matched = all(c['matched'] for c in manifest['comparisons'].values())
        manifest['source_baseline_clean'] = source_clean
        manifest['differential_matched'] = matched if native is not None else None
        manifest['accepted'] = (native is not None and manifest['source_oracle_complete'] and matched and
                                all(not r['defects'] and r['ownership_clean'] for key, r in manifest['runs'].items() if key.startswith('native-')))
        manifest['corpus_still_unmodified'] = not git(corpus, 'status', '--porcelain', '--untracked-files=all')
        if not manifest['corpus_still_unmodified']:
            manifest['accepted'] = False
        succeeded = manifest['accepted'] if native is not None else source_clean and matched and manifest['corpus_still_unmodified']
        print(json.dumps({'source_only': native is None, 'accepted': manifest['accepted'],
                          'source_oracle_complete': manifest['source_oracle_complete'],
                          'source_baseline_clean': source_clean, 'differential_matched': manifest['differential_matched'],
                          'defects': {k: r['defects'] for k, r in manifest['runs'].items()}, 'evidence': str(output)}, indent=2))
        return 0 if succeeded else 1
    finally:
        save(output / 'results.json', manifest)


if __name__ == '__main__':
    raise SystemExit(main())
