#!/usr/bin/env python3
"""Differential process acceptance for the pinned, source-built Test262 runner.

Nothing is built unless --build-reference is given. Native differential mode
requires a supplied executable, never generated or substituted. --reference-only
captures source evidence without claiming native verification. Raw process
transcripts and generated reports are retained under --output, including failures.
Only measured timings and implementation-dependent memory tables are normalized.
The pinned runner's surprising semantics (raw includes its harness, negative phase
is ignored, failures without -v can exit zero) are tested explicitly, not repaired
by this verifier. Native CLI aliases use a separately executed canonical oracle.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PINNED_SOURCE = Path('/private/tmp/silkjs-quickjs-reference-20261023/run-test262.c')
LEDGER = re.compile(rb'^Native runner ledger: threads=(\d+) runtimes=(\d+) live=(\d+) bytes=(\d+)\n', re.M)
SUMMARY = re.compile(rb'^Result: (\d+)/(\d+) errors?(?:, [^\n]+)?\n', re.M)
MEMORY_HEADING = re.compile(rb'^(?:Mininum|Maximum) memory statistics for [^\n]+:\n|^Average memory statistics for \d+ tests:\n', re.M)


def require(condition, message):
    # Assertions remain active when the verifier is launched with python -O.
    if not condition:
        raise AssertionError(message)


def put(root, name, text):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')


def modern(body=';', flags='', includes='', features='', negative=''):
    fields = ['description: deterministic runner acceptance']
    if flags:
        fields.append('flags: [' + flags + ']')
    if includes:
        fields.append('includes: [' + includes + ']')
    if features:
        fields.append('features: [' + features + ']')
    if negative:
        fields.append('negative:\n  phase: runtime\n  type: ' + negative)
    return '/*---\n' + '\n'.join(fields) + '\n---*/\n' + body + '\n'


def fixtures(root):
    # These are actual harness scripts, not emulations of runner decisions. Their
    # observable order and failures exercise the native parser/VM public boundary.
    put(root, 'harness/sta.js', "var harnessOrder = 'S';\nfunction $ERROR(x) { throw new Error(x); }\nfunction $INCLUDE(x) {}\nfunction runTestCase(f) { if (f() !== true) throw new Error('old test returned false'); }\n")
    put(root, 'harness/assert.js', "harnessOrder += 'A';\nfunction assert(v, m) { if (!v) throw new Error(m || 'assertion'); }\nassert.sameValue = function(a,b) { if (!Object.is(a,b)) throw new Error('sameValue'); };\n")
    put(root, 'harness/first.js', "if (harnessOrder !== 'SA') throw new Error('first order'); harnessOrder += '1';\n")
    put(root, 'harness/second.js', "if (harnessOrder !== 'SA1') throw new Error('second order'); harnessOrder += '2';\n")
    put(root, 'harness/old.js', "if (harnessOrder !== 'S') throw new Error('old order'); harnessOrder += 'O';\n")
    put(root, 'harness/doneprintHandle.js', "harnessOrder += 'D';\nfunction $DONE(error) { if (error) print('Test262:AsyncTestFailure: ' + error); else print('Test262:AsyncTestComplete'); }\n")
    put(root, 'harness/blocked.js', "throw 'excluded harness executed';\n")
    put(root, 'harness/broken.js', "throw 'harness failure sentinel';\n")
    base = '[config]\nstyle=new\nharnessdir=../harness\n'
    put(root, 'config/base.conf', base)
    put(root, 'config/old.conf', base.replace('style=new', 'style=old'))
    for mode in ('default', 'default-nostrict', 'default-strict', 'nostrict', 'strict', 'all', 'both'):
        put(root, 'config/' + mode + '.conf', base + 'mode=' + mode + '\n')
    put(root, 'config/skip.conf', base + 'async=no\nmodule=no\nharnessexclude=blocked.js\nskip-features=disabled\nfeatures=enabled\n[features]\nsection-enabled=yes\nsection-disabled=no\n')
    put(root, 'config/invalid-mode.conf', base + 'mode=invalid\n')
    put(root, 'config/syntax.conf', base + 'not-an-assignment\n[unknown]\nignored=value\n')
    for n in (10, 2, 1):
        put(root, f'test/order/case{n}.js', modern(f"print('case{n}');"))
    put(root, 'test/order/ignored_FIXTURE.js', "throw 'fixture must not be enumerated';\n")
    put(root, 'test/order/ignored.txt', "throw 'non-JS must not be enumerated';\n")
    put(root, 'test/order/excluded/never.js', modern("throw 'excluded directory executed';"))
    put(root, 'lists/order.lst', '# relative to list, not cwd\n; another comment\n\n../test/order/case10.js\n../test/order/case2.js\n../test/order/case1.js\n../test/order/case2.js\n')
    put(root, 'lists/exclude.lst', '../test/order/case2.js\n../test/order/case2.js\n')
    put(root, 'config/discovery.conf', base + 'testdir=../test/order\nreportfile=../generated/report.txt\nerrorfile=../generated/errors.txt\nexcludefile=../lists/exclude.lst\n[exclude]\n../test/order/excluded/\n[tests]\n../test/order/case10.js\n')
    # Keep equivalent path spellings consistent within each exclusion case: the C
    # runner deliberately does not canonicalize ../ components.
    put(root, 'config/exclude.conf', base + '[exclude]\n../test/order/excluded/\n../test/order/case2.js\n[tests]\n../test/order/case10.js\n../test/order/case2.js\n../test/order/case1.js\n../test/order/excluded/never.js\n')
    put(root, 'generated/errors.txt', '')
    tests = {
        'plain': modern("assert.sameValue(harnessOrder, 'SA'); print((function(){ return this === undefined; })() ? 'strict' : 'sloppy');"),
        'strict': modern("assert((function(){ return this === undefined; })());", 'onlyStrict'),
        'sloppy': modern("assert(!(function(){ return this === undefined; })());", 'noStrict'),
        'raw': modern("if (harnessOrder !== 'SA') throw 'pinned raw harness changed'; if ((function(){return this === undefined;})()) throw 'raw strict';", 'raw'),
        'order': modern("assert.sameValue(harnessOrder, 'SA12');", includes='first.js, second.js'),
        'multiline': '/*---\nflags:\n  - onlyStrict\nincludes:\n  - first.js\n  - second.js\n---*/\nassert.sameValue(harnessOrder, "SA12"); assert((function(){return this === undefined;})());\n',
        'negative-type': modern("throw new TypeError('negative sentinel');", negative='TypeError'),
        'negative-range': modern("throw new RangeError('range sentinel');", negative='RangeError'),
        'negative-parse': modern('var = ;', negative='SyntaxError').replace('phase: runtime', 'phase: parse'),
        'phase-ignored': modern("throw new TypeError('phase ignored by pinned runner');", negative='TypeError').replace('phase: runtime', 'phase: parse'),
        'wrong-type': modern("throw new RangeError('wrong type sentinel');", negative='TypeError'),
        'missing-error': modern(';', negative='TypeError'),
        'primitive-negative': modern("throw 'primitive negative';", negative='TypeError'),
        'failure': modern("throw 'failure sentinel';"),
        'async-once': modern("assert.sameValue(harnessOrder, 'SAD'); Promise.resolve().then(function(){ $DONE(); });", 'async'),
        'async-zero': modern(';', 'async'),
        'async-twice': modern('$DONE(); $DONE();', 'async'),
        'async-failure': modern("$DONE('intentional');", 'async'),
        'async-job-error': modern("Promise.resolve().then(function(){ throw new Error('job sentinel'); });", 'async'),
        'feature-enabled': modern("assert(true);", features='enabled, section-enabled'),
        'feature-disabled': modern("throw 'disabled feature executed';", features='disabled'),
        'feature-section-disabled': modern("throw 'disabled section feature executed';", features='section-disabled'),
        'feature-unknown': modern("throw 'unknown feature executed';", features='not-listed'),
        'harness-excluded': modern("throw 'excluded harness test executed';", includes='blocked.js'),
        'harness-broken': modern(';', includes='broken.js'),
        'harness-missing': modern(';', includes='missing.js'),
        'module': modern("import {answer} from './dep_FIXTURE.js'; assert.sameValue(answer,42);", 'module'),
        'module-json': modern("import data from './data.json' with {type:'json'}; assert.sameValue(data.answer,42);", 'module'),
        'module-bare': modern("import {answer} from 'dep_FIXTURE.js'; assert.sameValue(answer,42);", 'module'),
        'module-dynamic': modern("const m=await import('dep_FIXTURE.js'); assert.sameValue(m.answer,42);", 'module'),
        'module-reject': modern("throw new TypeError('module rejection');", 'module', negative='TypeError'),
        'module-pending': modern('await new Promise(function(){});', 'module'),
        'module-missing': modern("import './absent_FIXTURE.js';", 'module', negative='ReferenceError'),
        'dynamic-script': modern("import('dep_FIXTURE.js').then(function(m){ assert.sameValue(m.answer,42); $DONE(); });", 'async'),
        'module-json-invalid': modern("import data from './invalid.json' with {type:'json'};", 'module', negative='SyntaxError'),
        'module-json-bare': modern("import data from 'data.json' with {type:'json'}; assert.sameValue(data.answer,42);", 'module'),
        'module-async': modern("await Promise.resolve(); $DONE();", 'module, async'),
        'module-nested-bare': modern("import {answer} from './nested/outer_FIXTURE.js'; assert.sameValue(answer,42);", 'module'),
        'can-block-false': modern("try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,0); throw 'wait did not throw'; } catch(e) { assert(e instanceof TypeError); }", 'CanBlockIsFalse'),
        'unmarked': "if (harnessOrder !== 'SA') throw 'missing default harness';\n",
    }
    for name, text in tests.items():
        put(root, 'test/semantics/' + name + '.js', text)
    put(root, 'test/semantics/dep_FIXTURE.js', 'export const answer=42;\n')
    put(root, 'test/semantics/data.json', '{"answer":42}\n')
    put(root, 'test/semantics/invalid.json', '{"answer":}\n')
    put(root, 'test/semantics/nested/outer_FIXTURE.js', "export {answer} from 'dep_FIXTURE.js';\n")
    put(root, 'test/old/plain.js', '/** old harness */\n$INCLUDE("old.js");\nrunTestCase(function(){return harnessOrder === "SO";});\n')
    put(root, 'test/old/strict.js', '/** @onlyStrict */\nif (!(function(){return this === undefined;})()) throw "old strict";\n')
    put(root, 'test/old/sloppy.js', '/** @noStrict */\nif ((function(){return this === undefined;})()) throw "old sloppy";\n')
    put(root, 'test/old/negative.js', '/** @negative */\nthrow "old expected error";\n')
    put(root, 'test/old/failure.js', '/** old failure */\nthrow "old unexpected error";\n')
    put(root, 'prepared/plain.js', "if (typeof harnessOrder !== 'undefined') throw 'unexpected injected harness';\nprint('prepared', typeof $262.evalScript);\nPromise.resolve().then(function(){print('job drained');});\n")
    put(root, 'prepared/error.js', "throw 'prepared error';\n")
    put(root, 'prepared/module.js', "import {answer} from './dep_FIXTURE.js'; import data from './data.json' with {type:'json'}; await Promise.resolve(); print(answer, data.answer);\n")
    put(root, 'prepared/dep_FIXTURE.js', 'export const answer=42;\n')
    put(root, 'prepared/data.json', '{"answer":42}\n')
    put(root, 'prepared/no-block.js', "try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,0); throw 'wait did not throw'; } catch(e) { if (!(e instanceof TypeError)) throw e; print('can-block false'); }\n")
    for n in range(8):
        put(root, f'test/workers/case{n}.js', modern("assert(typeof workerIsolation === 'undefined'); var workerIsolation=1; var values=[]; for(var i=0;i<64;i++) values.push({value:i}); assert.sameValue(values[63].value,63);"))
    put(root, 'test/memory/small.js', modern('globalThis.retained=[{value:1}];'))
    put(root, 'test/memory/large.js', modern('globalThis.retained=[]; for(var i=0;i<2048;i++) retained.push({value:i, text:"retained-"+i});'))
    put(root, 'test/errors/case1.js', modern("throw 'original error';"))
    put(root, 'test/errors/case2.js', modern("throw 'second error';"))
    for name in ('case21.js', 'case0021.js', 'case23.js', 'case0023.js', 'case08.js', 'case0008.js'):
        put(root, 'test/identity/' + name, modern("print('identity:" + name + "');"))


@dataclass
class Result:
    code: int | None
    stdout: bytes
    stderr: bytes
    files: dict[str, bytes | None]
    timeout: bool = False


def timed(data):
    data = re.sub(rb'(?m)^Total user time: [0-9]+\.[0-9]+s \(nthreads=(\d+)\)$', rb'Total user time: <time>s (nthreads=\1)', data)
    # Slow-test annotations are conditional on elapsed time; removing the entire
    # annotation, rather than inventing it on faster executions, is intentional.
    data = re.sub(rb'(?m)^ time: \d+ ms\n', b'', data)
    data = re.sub(rb'(?m)^\n[^\n]+\.js \(\d+ ms\)\n', b'', data)
    return data


def memory_tables(data):
    headings = list(MEMORY_HEADING.finditer(data))
    require(headings, 'missing memory statistics headings')
    tables = []
    normalized = data[:headings[0].start()]
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(data)
        table = data[heading.end():end]
        values = re.findall(rb'^memory allocated\s+(\d+)\s+(\d+)(?:\s+[^\n]*)?$', table, re.M)
        require(len(values) == 1, ('missing or duplicated allocation row', table))
        count, size = map(int, values[0])
        require(count > 0 and size > 0, ('nonpositive live memory ledger', table))
        require(re.search(rb'^memory used\s+\d+\s+\d+', table, re.M), ('missing heap walk row', table))
        tables.append((count, size))
        normalized += heading.group() + b'<implementation memory layout>\n'
    return normalized, tables


class Suite:
    def __init__(self, reference, native, template, work, output, timeout):
        self.reference, self.native = reference, native
        self.template, self.work, self.output = template, work, output
        self.timeout = timeout
        self.failures = []
        self.records = []
        self.env = dict(os.environ, LC_ALL='C', LANG='C', TZ='America/Los_Angeles')
        self.env.pop('SILK_TEST262_LEDGER', None)

    def invoke(self, name, side, argv, files=(), ledger=False):
        if self.work.exists():
            shutil.rmtree(self.work)
        shutil.copytree(self.template, self.work)
        env = dict(self.env)
        if ledger:
            env['SILK_TEST262_LEDGER'] = '1'
        binary = self.reference if side == 'reference' else self.native
        command = [str(binary), *map(str, argv)]
        try:
            proc = subprocess.run(command, cwd=self.work, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=self.timeout)
            result = Result(proc.returncode, proc.stdout, proc.stderr, {})
        except subprocess.TimeoutExpired as error:
            result = Result(None, error.stdout or b'', error.stderr or b'', {}, True)
        result.files = {p: (self.work / p).read_bytes() if (self.work / p).is_file() else None for p in files}
        directory = self.output / name / side
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'stdout.bin').write_bytes(result.stdout)
        (directory / 'stderr.bin').write_bytes(result.stderr)
        (directory / 'process.json').write_text(json.dumps({
            'argv': command, 'cwd': str(self.work), 'returncode': result.code,
            'timed_out': result.timeout, 'ledger_enabled': ledger,
            'files_base64': {p: None if b is None else base64.b64encode(b).decode() for p, b in result.files.items()},
        }, indent=2) + '\n')
        return result

    def check(self, name, argv, *, native_argv=None, files=(), status=0, counts=None,
              contains=(), file_contains=(), ledger=None, memory=False, note=''):
        reference = self.invoke(name, 'reference', argv, files)
        native = None if self.native is None else self.invoke(name, 'native', native_argv or argv, files, ledger is not None)
        record = {'name': name, 'note': note, 'reference_status': reference.code,
                  'native_status': None if native is None else native.code,
                  'source_only': native is None, 'passed': False}
        self.records.append(record)
        try:
            require(not reference.timeout, 'SOURCE BASELINE DEFECT: reference timed out')
            require(reference.code is not None and reference.code >= 0, 'SOURCE BASELINE DEFECT: reference terminated by signal')
            if status is not None:
                require(reference.code == status, ('SOURCE BASELINE DEFECT: unexpected reference exit', status, reference.code, reference.stderr))
            if counts is not None:
                summary = SUMMARY.search(reference.stderr)
                require(summary is not None and tuple(map(int, summary.groups())) == counts,
                        ('SOURCE BASELINE DEFECT: wrong executed/failed count', counts, reference.stderr))
            for token in contains:
                require(token in reference.stdout + reference.stderr, ('SOURCE BASELINE DEFECT: missing evidence', token))
            for path, token in file_contains:
                require(reference.files[path] is not None and token in reference.files[path], ('SOURCE BASELINE DEFECT: missing file evidence', path, token))
            if native is None:
                if memory:
                    memory_tables(reference.stdout)
                record['passed'] = True
                return reference, None
            require(not native.timeout, 'native timed out')
            native_err = native.stderr
            if ledger is not None:
                markers = list(LEDGER.finditer(native_err))
                require(len(markers) == 1, ('missing/duplicate native allocation ledger', native_err))
                observed = tuple(map(int, markers[0].groups()))
                require(observed == (ledger[0], ledger[1], 0, 0), ('native workers/runtime teardown ledger mismatch', observed, ledger))
                native_err = LEDGER.sub(b'', native_err)
            ref_out, native_out = reference.stdout, native.stdout
            if memory:
                ref_out, _ = memory_tables(ref_out)
                native_out, _ = memory_tables(native_out)
            require(native.code == reference.code, ('native/reference status mismatch', native.code, reference.code))
            for stream, expected, actual in [('stdout', ref_out, native_out), ('stderr', reference.stderr, native_err)]:
                expected, actual = timed(expected), timed(actual)
                if expected != actual:
                    diff = ''.join(difflib.unified_diff(expected.decode(errors='backslashreplace').splitlines(True), actual.decode(errors='backslashreplace').splitlines(True), fromfile='reference/' + stream, tofile='native/' + stream))
                    raise AssertionError(diff or (stream, expected, actual))
            for path in files:
                expected, actual = reference.files[path], native.files[path]
                require((None if expected is None else timed(expected)) == (None if actual is None else timed(actual)), ('artifact mismatch', path, expected, actual))
            record['passed'] = True
        except AssertionError as error:
            record['failure'] = str(error)
            self.failures.append((name, str(error)))
        return reference, native

    def source_spelling(self, name, argv):
        # Unsupported source spellings are recorded, not used as native semantic
        # baselines for explicitly requested extensions.
        result = self.invoke(name, 'reference', argv)
        passed = not result.timeout and result.code == 1 and b'unknown option:' in result.stderr
        self.records.append({'name': name, 'passed': passed, 'source_only': True,
                             'note': 'Pinned source does not support this native extension spelling.'})
        if not passed:
            self.failures.append((name, 'SOURCE BASELINE DEFECT: expected explicit unknown-option rejection'))

    def numeric_identity(self, argv):
        name = 'numeric-order-exact-path-identity'
        reference = self.invoke(name, 'reference', argv)
        native = None if self.native is None else self.invoke(name, 'native', argv, ledger=True)
        record = {'name': name, 'passed': False, 'source_only': native is None,
                  'note': 'Explicit source defect correction: numeric equality must not discard distinct physical files.',
                  'reference_status': reference.code, 'native_status': None if native is None else native.code}
        self.records.append(record)
        try:
            require(not reference.timeout and reference.code == 0, 'source collision baseline did not complete')
            source_summary = SUMMARY.search(reference.stderr)
            require(source_summary is not None and tuple(map(int, source_summary.groups())) == (0, 3),
                    ('source no longer reproduces three numeric-identity omissions', reference.stderr))
            source_names = re.findall(rb'^identity:([^\n]+)\n', reference.stdout, re.M)
            pairs = ({b'case0008.js', b'case08.js'}, {b'case0021.js', b'case21.js'}, {b'case0023.js', b'case23.js'})
            require(len(source_names) == 3 and all(len(set(source_names) & pair) == 1 for pair in pairs),
                    ('unexpected source collision survivors', source_names))
            record['source_executed_paths'] = [p.decode() for p in source_names]
            record['source_omitted_paths'] = sorted(p.decode() for pair in pairs for p in pair if p not in source_names)
            if native is not None:
                require(not native.timeout and native.code == 0, 'native exact-identity run did not complete')
                summary = SUMMARY.search(native.stderr)
                require(summary is not None and tuple(map(int, summary.groups())) == (0, 6),
                        ('native silently omitted distinct files', native.stderr))
                names = re.findall(rb'^identity:([^\n]+)\n', native.stdout, re.M)
                require(names == [b'case0008.js', b'case08.js', b'case0021.js', b'case21.js', b'case0023.js', b'case23.js'],
                        ('native natural order/exact-byte tie-break mismatch', names))
                ledgers = list(LEDGER.finditer(native.stderr))
                require(len(ledgers) == 1 and tuple(map(int, ledgers[0].groups())) == (1, 6, 0, 0),
                        ('native identity variants were not independently executed and released', native.stderr))
                record['native_executed_paths'] = [p.decode() for p in names]
            record['passed'] = True
        except AssertionError as error:
            record['failure'] = str(error)
            self.failures.append((name, str(error)))


def run_suite(s):
    base = ['-q', '-T', '1', '-v', '-c', 'config/base.conf']
    single = lambda name: ['-f', 'test/semantics/' + name + '.js']
    s.numeric_identity(base + ['-d', 'test/identity', '-r', '-'])
    s.check('help', ['-h'], status=1, contains=(b'usage: run-test262', b'-T threads', b'-N'))
    s.check('no-arguments', [], status=1, contains=(b'usage: run-test262',))
    for option in ('--unknown', '--help'):
        s.check('unknown-' + option.lstrip('-'), [option], status=1, contains=(b'unknown option:',))
    for option in ('-c', '-d', '-e', '-r', '-x', '-D', '-T'):
        s.check('missing-' + option[1:], [option], status=2, contains=(b'missing argument for option',))
    s.check('missing-config', ['-c', 'absent.conf'], status=1)
    s.check('missing-single-file', ['-f'], status=1, contains=(b'usage: run-test262',))
    s.check('missing-prepared-file', ['-N'], status=1, contains=(b'usage: run-test262',))
    s.check('invalid-mode', ['-c', 'config/invalid-mode.conf'], status=2, contains=(b'unknown test mode:',))
    s.check('config-syntax-warning', ['-q', '-T', '1', '-v', '-c', 'config/syntax.conf', *single('plain')], contains=(b'syntax error', b'sloppy'))
    s.check('natural-sort-deduplicate', base + ['-r', '-', 'lists/order.lst'], counts=(0, 3), contains=(b'0: lists/../test/order/case1.js\ncase1\n1: lists/../test/order/case2.js\ncase2\n2: lists/../test/order/case10.js\ncase10\n',))
    s.check('inclusive-range', base + ['-r', '-', 'lists/order.lst', '1', '1'], counts=(0, 1), contains=(b'1: lists/../test/order/case2.js', b'2 skipped'))
    s.check('range-beyond-end', base + ['lists/order.lst', '10', '20'], counts=(0, 0), contains=(b'3 skipped',))
    s.check('exclude-list-relative', base + ['-x', 'lists/exclude.lst', 'lists/order.lst'], counts=(0, 2), contains=(b'1 excluded',))
    s.check('exclude-file-directory', ['-q', '-T', '1', '-v', '-c', 'config/exclude.conf', '-r', '-'], counts=(0, 2), contains=(b'2 excluded', b'case1', b'case10'))
    s.check('relative-config-paths', ['-q', '-T', '1', '-v', '-c', 'config/discovery.conf'], counts=(0, 3), files=('generated/report.txt',), file_contains=(('generated/report.txt', b'case1'), ('generated/report.txt', b'case2'), ('generated/report.txt', b'case10')),
            note='excludefile entries retain config/../lists/../ versus config/../ spelling, as pinned C does; directory exclusion still applies.')
    s.check('explicit-directory-overrides-config', ['-q', '-T', '1', '-v', '-c', 'config/discovery.conf', '-d', 'test/workers'], counts=(0, 9), files=('generated/report.txt',), contains=(b'ignoring testdir=',),
            note='-d suppresses config testdir, not explicit [tests] entries.')
    s.check('directory-fixtures-filter', base + ['-d', 'test/workers', '-r', '-'], counts=(0, 8))
    s.check('report-none', base + ['-r', 'none', '-d', 'test/workers'], counts=(0, 8), files=('none',))
    s.check('enumeration-fixture-suffix', base + ['-d', 'test/order', '-r', '-'], status=1, counts=(1, 4), contains=(b'excluded directory executed',))
    for name in ('plain', 'strict', 'sloppy', 'raw', 'order', 'multiline', 'negative-type', 'negative-range', 'negative-parse', 'phase-ignored', 'async-once', 'module', 'module-json', 'module-bare', 'module-dynamic', 'module-reject', 'module-missing', 'dynamic-script', 'module-json-invalid', 'module-json-bare', 'module-async', 'module-nested-bare', 'can-block-false', 'unmarked'):
        s.check('modern-' + name, base + single(name), note='Pinned source compatibility, including raw harness and ignored negative phase.' if name in ('raw', 'phase-ignored') else '')
    for name in ('wrong-type', 'missing-error', 'primitive-negative', 'failure', 'async-zero', 'async-twice', 'async-failure', 'async-job-error', 'module-pending'):
        s.check('modern-reject-' + name, base + single(name), status=1)
    for name in ('harness-broken', 'harness-missing'):
        s.check(name, base + single(name), status=1)
    for mode in ('default', 'default-nostrict', 'default-strict', 'nostrict', 'strict', 'all', 'both'):
        s.check('mode-' + mode, ['-q', '-T', '1', '-v', '-c', 'config/' + mode + '.conf', '-f', 'test/semantics/plain.js', 'test/semantics/strict.js', 'test/semantics/sloppy.js'])
    s.check('cli-all-variants', base + ['-a', *single('plain')], contains=(b'sloppy\nstrict\n',), ledger=(1, 2))
    s.check('cli-strict-skips-sloppy', base + ['-s', *single('sloppy')], ledger=(1, 0))
    s.check('new-style-cli', ['-q', '-T', '1', '-v', '-c', 'config/old.conf', '-n', *single('order')])
    for name in ('plain', 'strict', 'sloppy', 'negative'):
        s.check('old-' + name, ['-q', '-T', '1', '-v', '-c', 'config/old.conf', '-a', '-f', 'test/old/' + name + '.js'])
    s.check('old-failure', ['-q', '-T', '1', '-v', '-c', 'config/old.conf', '-f', 'test/old/failure.js'], status=1)
    skip = ['-q', '-T', '1', '-v', '-c', 'config/skip.conf']
    for name in ('async-once', 'module', 'feature-disabled', 'feature-section-disabled', 'feature-unknown', 'harness-excluded'):
        s.check('skip-' + name, skip + single(name), ledger=(1, 0))
    s.check('feature-enabled', skip + single('feature-enabled'), ledger=(1, 1))
    s.check('count-skipped-features', skip + ['--count_skipped_features', '-f', 'test/semantics/feature-disabled.js', 'test/semantics/feature-section-disabled.js'], contains=(b'SKIPPED FEATURE', b'disabled', b'section-disabled'))
    s.check('source-status-without-verbose', ['-q', '-T', '1', '-c', 'config/base.conf', '-d', 'test/errors'], counts=(2, 2), status=0,
            note='Known source defect: failed test count does not affect exit without verbose error accounting. Exact baseline retained; all semantic acceptance cases use -v.')
    for name, args, code in [('script', ['prepared/plain.js'], 0), ('error', ['prepared/error.js'], 1), ('module', ['--module', 'prepared/module.js'], 0), ('no-block', ['--no-can-block', 'prepared/no-block.js'], 0)]:
        s.check('prepared-' + name, ['-N', *args], status=code)
    s.source_spelling('source-long-harness-rejected', ['--test262-harness', 'prepared/plain.js'])
    s.source_spelling('source-j-rejected', ['-j', '2', '-h'])
    s.check('native-long-harness-alias', ['-N', 'prepared/plain.js'], native_argv=['--test262-harness', 'prepared/plain.js'])
    workers = ['-q', '-T', '2', '-v', '-c', 'config/base.conf', '-d', 'test/workers', '-r', 'generated/parallel-report.txt']
    s.check('two-native-workers', workers, counts=(0, 8), ledger=(2, 8), files=('generated/parallel-report.txt',))
    s.check('two-workers-all-variants', workers + ['-a'], counts=(0, 8), ledger=(2, 16))
    s.check('native-j-alias', workers, native_argv=['-q', '-j', '2', *workers[3:]], counts=(0, 8), ledger=(2, 8))
    s.check('timings', base + ['-t', '-D', '1', '-d', 'test/workers'], counts=(0, 8), contains=(b'Total user time:',))
    # Disable progress after enabling it so the option precedence is deterministic;
    # progress sampling frequencies are not masked as semantic differences.
    s.check('compact-then-quiet', base + ['-C', '-q', '-d', 'test/workers'], counts=(0, 8))
    memory_results = []
    for name in ('small', 'large'):
        memory_results.append(s.check('memory-' + name, base + ['-m', '-f', 'test/memory/' + name + '.js'], ledger=(1, 1), memory=True))
    try:
        for side in ((0,) if s.native is None else (0, 1)):
            _, small = memory_tables(memory_results[0][side].stdout)
            _, large = memory_tables(memory_results[1][side].stdout)
            require(large[0][0] > small[0][0] and large[0][1] > small[0][1], ('retained allocations did not grow measured ledger', side, small, large))
        s.records.append({'name': 'memory-ledger-growth', 'passed': True})
    except AssertionError as error:
        s.failures.append(('memory-ledger-growth', str(error)))
        s.records.append({'name': 'memory-ledger-growth', 'passed': False, 'failure': str(error)})
    s.check('memory-min-max-average', base + ['-m', '-m', '-f', 'test/memory/small.js', 'test/memory/large.js'], ledger=(1, 2), memory=True,
            contains=(b'Mininum memory statistics', b'Maximum memory statistics', b'Average memory statistics for 2 tests:'))
    errors = base + ['-e', 'generated/errors.txt', '-d', 'test/errors']
    reference, _ = s.check('errors-update', errors + ['-u', '-r', 'generated/report.txt'], counts=(2, 2), files=('generated/errors.txt', 'generated/report.txt'),
                           file_contains=(('generated/errors.txt', b'original error'), ('generated/errors.txt', b'second error'), ('generated/report.txt', b'FAILED')))
    baseline = reference.files['generated/errors.txt']
    if baseline is None:
        s.failures.append(('errors-lifecycle', 'SOURCE BASELINE DEFECT: no error file generated'))
        return
    (s.template / 'generated/errors.txt').write_bytes(baseline)
    s.check('errors-recheck', errors, counts=(2, 2), files=('generated/errors.txt',))
    s.check('errors-only', base + ['-e', 'generated/errors.txt', '-E', '-d', 'test/workers'], counts=(2, 2))
    put(s.template, 'test/errors/case3.js', modern("throw 'new error';"))
    s.check('errors-new', errors, status=1, counts=(3, 3), contains=(b'new error', b'1 new'))
    (s.template / 'test/errors/case3.js').unlink()
    put(s.template, 'test/errors/case1.js', modern(';'))
    s.check('errors-fixed', errors, status=1, counts=(1, 2), contains=(b'OK, fixed error:', b'1 fixed'))
    put(s.template, 'test/errors/case1.js', modern("throw 'changed error';"))
    s.check('errors-changed', errors, status=1, counts=(2, 2), contains=(b'previous error:', b'1 changed'))
    updated, _ = s.check('errors-update-changed', errors + ['-u'], counts=(2, 2), files=('generated/errors.txt',), file_contains=(('generated/errors.txt', b'changed error'),))
    if updated.files['generated/errors.txt'] is not None:
        (s.template / 'generated/errors.txt').write_bytes(updated.files['generated/errors.txt'])
        s.check('errors-recheck-changed', errors, counts=(2, 2))
    put(s.template, 'test/errors/case1.js', modern(';'))
    put(s.template, 'test/errors/case2.js', modern(';'))
    cleared, _ = s.check('errors-update-clears-fixed', errors + ['-u'], counts=(0, 2), files=('generated/errors.txt',))
    if cleared.files['generated/errors.txt'] == b'':
        (s.template / 'generated/errors.txt').write_bytes(b'')
        s.check('errors-recheck-empty', errors, counts=(0, 2))
    else:
        s.failures.append(('errors-update-clears-fixed', 'SOURCE BASELINE DEFECT: fixed error file was not empty'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_reference(source, destination, output):
    # A separate source tree prevents touching the pinned oracle or accidentally
    # linking a preexisting object. This is only reached by explicit opt-in.
    with tempfile.TemporaryDirectory(prefix='silkjs-test262-reference-build-') as temporary:
        tree = Path(temporary) / 'source'
        shutil.copytree(source.parent, tree, ignore=shutil.ignore_patterns('.git', '.obj', '*.o', '*.a', '*.dSYM', 'run-test262', 'run-test262-debug', 'qjs', 'qjsc'))
        compiler = os.environ.get('CC', os.environ.get('SILK_CLANG', 'clang'))
        if os.environ.get('SDKROOT'):
            compiler += ' -isysroot ' + shlex.quote(os.environ['SDKROOT'])
        command = ['make', '-j2', 'run-test262', 'CC=' + compiler]
        (output / 'reference-build-command.json').write_text(json.dumps(command) + '\n')
        result = subprocess.run(command, cwd=tree,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        (output / 'reference-build.stdout.bin').write_bytes(result.stdout)
        (output / 'reference-build.stderr.bin').write_bytes(result.stderr)
        require(result.returncode == 0, ('reference build failed; see output transcripts', result.returncode))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tree / 'run-test262', destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path, help='real source-built run-test262 executable (build destination with --build-reference)')
    parser.add_argument('--native', type=Path, help='native Silk runner executable; required unless --reference-only')
    parser.add_argument('--reference-only', action='store_true', help='capture and check actual source baselines without making any native verification claim')
    parser.add_argument('--source', type=Path, default=PINNED_SOURCE, help='pinned run-test262.c or its containing directory')
    parser.add_argument('--build-reference', action='store_true', help='explicitly build an isolated copy of the source tree using make')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/test262-runner-verification', help='persistent raw transcripts and result manifest')
    parser.add_argument('--timeout', type=float, default=90, help='per-process deadline in seconds')
    args = parser.parse_args()
    source = args.source.resolve()
    if source.is_dir():
        source /= 'run-test262.c'
    require(source.is_file(), ('missing pinned source', source))
    require(args.timeout > 0, '--timeout must be positive')
    reference = args.reference.resolve()
    require(args.reference_only or args.native is not None, '--native is required unless --reference-only')
    native = None if args.reference_only else args.native.resolve()
    if native is not None:
        require(reference != native, 'reference and native must be distinct executables')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.build_reference:
        require(reference != source.parent / 'run-test262', 'choose a separate --reference destination; do not overwrite the pinned source-tree binary')
        build_reference(source, reference, output)
    for path in ((reference,) if native is None else (reference, native)):
        require(path.is_file() and os.access(path, os.X_OK), ('missing/non-executable runner', path))
    if native is not None:
        require(not os.path.samefile(reference, native), 'reference and native cannot alias the same file')
        require(digest(reference) != digest(native), 'reference and native cannot be byte-identical copies')
    manifest = {'source': str(source), 'source_sha256': digest(source),
                'reference': str(reference), 'reference_sha256': digest(reference),
                'native': None if native is None else str(native),
                'native_sha256': None if native is None else digest(native),
                'source_only': native is None,
                'normalization': ['measured CPU/slow-test timing annotations', 'validated implementation-dependent memory tables'],
                'reference_built_this_run': args.build_reference}
    with tempfile.TemporaryDirectory(prefix='silkjs-test262-verifier-') as temporary:
        root = Path(temporary).resolve()
        template = root / 'template'
        template.mkdir()
        fixtures(template)
        suite = Suite(reference, native, template, root / 'work', output, args.timeout)
        try:
            run_suite(suite)
        finally:
            manifest['cases'] = suite.records
            manifest['failures'] = suite.failures
            (output / 'results.json').write_text(json.dumps(manifest, indent=2) + '\n')
        for name, failure in suite.failures:
            print('FAIL ' + name + ': ' + failure)
        phase = 'source baseline' if native is None else 'native differential'
        print(f'Test262 runner {phase} scenarios: {len(suite.records)}; failed: {len(suite.failures)}; evidence: {output}')
        return 1 if suite.failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
