#!/usr/bin/env python3
"""Engine/native binary objects versus the independently compiled pinned C engine.

The oracle is a separate process, not a binding. Source expressions create the
actual graphs and compiled functions/modules in both Engines. Wire bytes travel
in both directions. SAB address words are relocated explicitly, preserving
pointer-equivalence classes; all other bytes compare exactly. Native truncation
and allocation-failure sweeps always require zero final allocation/byte ledgers.
C reader inputs outside its documented trusted-bytecode precondition are never
executed. Metadata-only module cases still compare the complete serialized bytes.
"""
import argparse
from dataclasses import dataclass, replace
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

from verify_bytecode import SUPPORT, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
COMPILE = 32
MODULE = 1
BYTECODE, BSWAP, SAB, REFERENCE = 1, 2, 4, 8


@dataclass(frozen=True)
class Case:
    name: str
    source: str
    check: str = 'true'
    flags: int = 0
    evaluation: int = 0
    reject: bool = False
    c_read_bug: bool = False


CASES = [
    Case('null', 'null', '__binary === null'),
    Case('undefined', 'void 0', '__binary === undefined'),
    Case('booleans', '[true,false]', '__binary[0] === true && __binary[1] === false'),
    Case('integers', '[0,1,-1,127,128,-128,-129,2147483647,-2147483648]', '__binary.length === 9 && __binary[7] === 2147483647 && __binary[8] === -2147483648'),
    Case('doubles', '[NaN,Infinity,-Infinity,-0,1.5,5e-324,1.7976931348623157e308]', 'Number.isNaN(__binary[0]) && __binary[1] === Infinity && __binary[2] === -Infinity && Object.is(__binary[3],-0) && __binary[5] === 5e-324'),
    Case('strings', "['','ascii','caf\\u00e9','\\u0100','\\ud800','\\udfff','\\ud83d\\ude00','a\\0b']", "__binary.length === 8 && __binary[3].charCodeAt(0) === 256 && __binary[4].charCodeAt(0) === 55296 && __binary[7].length === 3"),
    Case('rope', "'abcdefgh'.repeat(64) + 'xyz'.repeat(64)", '__binary.length === 704 && __binary.slice(-3) === "xyz"'),
    Case('bigints', '[0n,1n,-1n,127n,128n,-128n,-129n,2147483647n,2147483648n,-2147483649n,4294967295n,4294967296n,(1n<<130n)+17n,-(1n<<130n)-17n]', '__binary.length === 14 && __binary[12] === (1n<<130n)+17n && __binary[13] === -(1n<<130n)-17n'),
    Case('ordinary', '({alpha:1,beta:"two",nested:{x:3},"4294967294":4,"4294967295":5})', '__binary.alpha === 1 && __binary.beta === "two" && __binary.nested.x === 3 && __binary[4294967295] === 5'),
    Case('property-filter', '(()=>{let x={a:1};Object.defineProperty(x,"hidden",{value:2});x[Symbol("s")]=3;return x})()', 'Object.keys(__binary).length === 1 && __binary.a === 1'),
    Case('null-prototype', 'Object.assign(Object.create(null),{a:1})', 'Object.getPrototypeOf(__binary) === Object.prototype && __binary.a === 1'),
    Case('array-holes', '(()=>{let x=[,1,,];x.length=6;x.extra=9;return x})()', '__binary.length === 6 && (0 in __binary) && (5 in __binary) && __binary[0] === undefined && __binary.extra === undefined'),
    Case('array-sparse', '(()=>{let x=[];x[3]=42;Object.defineProperty(x,"1",{value:9,enumerable:false});return x})()', '__binary.length === 4 && __binary[1] === undefined && __binary[3] === 42'),
    Case('repeated-copy', '(()=>{let x={a:1};return [x,x]})()', '__binary[0] !== __binary[1] && __binary[0].a === 1'),
    Case('repeated-reference', '(()=>{let x={a:1};return [x,x]})()', '__binary[0] === __binary[1]', REFERENCE),
    Case('cycle', '(()=>{let x={n:42};x.self=x;x.array=[x,x];return x})()', '__binary.self === __binary && __binary.array[0] === __binary && __binary.array[1] === __binary', REFERENCE),
    Case('cycle-rejected', '(()=>{let x={};x.self=x;return x})()', reject=True),
    Case('array-cycle', '(()=>{let x=[];x[0]=x;return x})()', '__binary[0] === __binary', REFERENCE),
    Case('date', 'new Date(1700000000123)', '__binary instanceof Date && __binary.getTime() === 1700000000123'),
    Case('invalid-date', 'new Date(NaN)', 'Number.isNaN(__binary.getTime())'),
    Case('boxed', '[Object(42),Object(-0),Object(true),Object("wide\\u0100"),Object(12345678901234567890n)]', '__binary[0].valueOf() === 42 && Object.is(__binary[1].valueOf(),-0) && __binary[2].valueOf() === true && __binary[4].valueOf() === 12345678901234567890n'),
    Case('array-buffer', '(()=>{let b=new ArrayBuffer(12);let a=new Uint8Array(b);for(let i=0;i<12;i++)a[i]=i*17;return b})()', '__binary.byteLength === 12 && new Uint8Array(__binary)[11] === 187'),
    Case('resizable-buffer', 'new ArrayBuffer(12,{maxByteLength:32})', '__binary.byteLength === 12 && __binary.maxByteLength === 32 && __binary.resizable'),
    Case('views-identity', '(()=>{let b=new ArrayBuffer(24);let a=new Uint16Array(b,2,5);a[0]=1234;return [b,a,new Uint8Array(b,3,9),a]})()', '__binary[1] === __binary[3] && __binary[1].buffer === __binary[0] && __binary[2].buffer === __binary[0] && __binary[1][0] === 1234 && __binary[2].byteOffset === 3', REFERENCE),
    Case('tracking-view', '(()=>{let b=new ArrayBuffer(16,{maxByteLength:32});return new Uint16Array(b,4)})()', '__binary.length === 6 && __binary.byteOffset === 4 && __binary.buffer.resizable'),
    Case('shared-buffer', '(()=>{let b=new SharedArrayBuffer(16);new Uint8Array(b)[3]=71;return [b,new Uint8Array(b,2,6),b]})()', '__binary[0] === __binary[2] && __binary[1].buffer === __binary[0] && __binary[1][1] === 71', SAB | REFERENCE),
    Case('growable-shared', 'new SharedArrayBuffer(12,{maxByteLength:32})', '__binary.byteLength === 12 && __binary.maxByteLength === 32 && __binary.growable', SAB, c_read_bug=True),
    Case('shared-rejected', 'new SharedArrayBuffer(4)', reject=True),
    Case('template', '((x)=>x)`a${1}b`', '!Object.isExtensible(__binary) && __binary[0] === "a" && __binary.raw[1] === "b" && !Object.getOwnPropertyDescriptor(__binary,"0").writable', BYTECODE),
    Case('frozen-array', 'Object.freeze([1,2])', '!Object.isExtensible(__binary) && __binary[1] === 2 && __binary.raw === undefined', BYTECODE),
    Case('compile-constant', '42', '__binary === 42', BYTECODE, COMPILE),
    Case('compile-closure', '(function(a){return function(b){return a+b}})(20)(22)', '__binary === 42', BYTECODE, COMPILE),
    Case('compile-control', '(()=>{let n=0;for(let i=0;i<7;i++){try{if(i===3)throw 2;n+=i}catch(e){n+=e}finally{n++}}return n})()', '__binary === 27', BYTECODE, COMPILE),
    Case('compile-generator', 'function* g(a){yield a;return 42} let it=g(9);it.next();it.next().value', '__binary === 42', BYTECODE, COMPILE),
    Case('compile-class', 'class A{m(){return 20}}class B extends A{m(){return super.m()+22}}new B().m()', '__binary === 42', BYTECODE, COMPILE),
    Case('compile-template', '(function(a){return a.raw[0]})`x`', '__binary === "x"', BYTECODE, COMPILE),
    Case('compile-template-cache', '(function(){function f(a){return a[0].length}return f`abcdefghijklmnopqrstuvwxyz01234567890123456789`})()', '__binary === 46', BYTECODE, COMPILE),
    Case('compile-async-metadata', 'async function f(x){return await x} (function*(){yield 1}); f', '', BYTECODE, COMPILE),
    Case('module-execute', 'export const answer=42; globalThis.__moduleAnswer=answer;', '__moduleAnswer === 42', BYTECODE, COMPILE | MODULE),
    Case('module-import-execute', 'import d from "dep";export const answer=d+1;globalThis.__moduleAnswer=answer;', '__moduleAnswer === 42', BYTECODE, COMPILE | MODULE),
    Case('module-imports', 'import d,{x as y} from "dep";import * as ns from "other";export {y as answer};export {z} from "dep";export * from "other";export default d+ns.q;', '', BYTECODE, COMPILE | MODULE),
    Case('module-attributes', 'import x from "data" with {type:"json"}; export default x;', '', BYTECODE, COMPILE | MODULE),
    Case('module-tla', 'export const answer=await 42;', '', BYTECODE, COMPILE | MODULE),
    Case('bytecode-rejected', '42', flags=0, evaluation=COMPILE, reject=True),
    Case('accessor-rejected', '({get x(){return 1}})', reject=True),
    Case('array-accessor-rejected', 'Object.defineProperty([],"0",{get(){return 1},enumerable:true})', reject=True),
    Case('detached-buffer', '(()=>{let b=new ArrayBuffer(4);b.transfer();return b})()', reject=True),
    Case('writer-stack-limit', '(()=>{let root={},p=root;for(let i=0;i<10000;i++)p=p.next={};return root})()', reject=True),
]
# Source-rejected classes are not replaced by JSON encodings or special cases.
for name, source in [
    ('regexp', '/abc/gi'), ('dataview', 'new DataView(new ArrayBuffer(8))'),
    ('function', '(function(){})'), ('symbol', 'Symbol("x")'), ('symbol-box', 'Object(Symbol("x"))'),
    ('map', 'new Map()'), ('set', 'new Set()'), ('error', 'new Error("x")'),
    ('promise', 'Promise.resolve(1)'), ('proxy', 'new Proxy({}, {})'),
]:
    CASES.append(Case(name + '-rejected', source, reject=True))
for name in ['Uint8ClampedArray', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
             'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array',
             'Float16Array', 'Float32Array', 'Float64Array']:
    value = '17n' if name.startswith('Big') else '17'
    CASES.append(Case(name, f'new {name}([{value},{value}])', f'__binary instanceof {name} && __binary.length === 2 && __binary[1] === {value}'))
# The declared historical flag is deliberately ignored by this pinned writer.
CASES.append(replace(CASES[8], name='ignored-bswap', flags=BSWAP))
for flags in range(16):
    CASES.append(Case(f'flags-{flags}', '({answer:42})', '__binary.answer === 42', flags))


@dataclass
class Wire:
    data: bytes
    position: int = 0

    def take(self, count):
        if count > len(self.data) - self.position:
            raise ValueError('truncated oracle wire')
        start = self.position
        self.position += count
        return self.data[start:self.position]

    def byte(self):
        return self.take(1)[0]

    def leb(self):
        result = 0
        for shift in range(0, 35, 7):
            byte = self.byte()
            result |= (byte & 127) << shift
            if not byte & 128:
                return result & 0xffffffff
        raise ValueError('invalid oracle LEB')

    def string(self):
        size = self.leb()
        self.take((size >> 1) << (size & 1))

    def value(self, shared, code_ranges):
        tag = self.byte()
        if tag in (1, 2, 3, 4):
            return
        if tag in (5, 19):
            self.leb()
        elif tag == 6:
            self.take(8)
        elif tag == 7:
            self.string()
        elif tag == 8:
            for _ in range(self.leb()):
                self.leb()
                self.value(shared, code_ranges)
        elif tag in (9, 11):
            for _ in range(self.leb()):
                self.value(shared, code_ranges)
            if tag == 11:
                self.value(shared, code_ranges)
        elif tag == 10:
            self.take(self.leb())
        elif tag == 12:
            flags = int.from_bytes(self.take(2), 'little')
            self.byte()
            self.leb()
            counts = [self.leb() for _ in range(8)]
            for _ in range(self.leb()):
                self.leb(); self.leb(); self.leb(); self.byte()
            for _ in range(counts[5]):
                self.leb(); self.leb(); self.take(2)
            code_ranges.append((self.position, counts[7]))
            self.take(counts[7])
            if flags & 1024:
                self.leb(); self.take(self.leb()); self.take(self.leb())
            for _ in range(counts[6]):
                self.value(shared, code_ranges)
        elif tag == 13:
            self.leb()
            for _ in range(self.leb()):
                self.leb(); self.value(shared, code_ranges)
            for _ in range(self.leb()):
                export_type = self.byte(); self.leb()
                if export_type:
                    self.leb()
                self.leb()
            for _ in range(self.leb()):
                self.leb()
            for _ in range(self.leb()):
                self.leb(); self.byte(); self.leb(); self.leb()
            self.byte(); self.value(shared, code_ranges)
        elif tag == 14:
            self.byte(); self.leb(); self.leb(); self.value(shared, code_ranges)
        elif tag in (15, 16):
            size = self.leb(); self.leb()
            if tag == 15:
                self.take(size)
            else:
                offset = self.position
                shared.append((offset, int.from_bytes(self.take(8), 'little')))
        elif tag in (17, 18):
            self.value(shared, code_ranges)
        else:
            raise ValueError(f'unknown oracle tag {tag}')


def inspect(data):
    wire = Wire(data)
    if wire.byte() != 5:
        raise ValueError('oracle wire version is not 5')
    for _ in range(wire.leb()):
        wire.string()
    shared, code = [], []
    wire.value(shared, code)
    if wire.position != len(data):
        raise ValueError('unexpected oracle trailing bytes')
    return shared, code


def normalized(data):
    if not data:
        return data
    fields, _ = inspect(data)
    output = bytearray(data)
    identities = {}
    for offset, address in fields:
        identity = identities.setdefault(address, len(identities) + 1)
        output[offset:offset + 8] = identity.to_bytes(8, 'little')
    return bytes(output)


def pack_blob(data):
    return struct.pack('<I', len(data)) + data


def records(data):
    result = []
    wire = Wire(data)
    while wire.position < len(data):
        first = wire.take(int.from_bytes(wire.take(4), 'little'))
        second = wire.take(int.from_bytes(wire.take(4), 'little'))
        fields = struct.unpack('<10I', wire.take(40))
        result.append((first, second, fields))
    return result


class ProcessFailure(RuntimeError):
    def __init__(self, command, result):
        self.returncode = result.returncode
        super().__init__(f'{command}\nexit={result.returncode}\n{result.stderr.decode(errors="replace")}')


def run(command, *, data=None, cwd=None, env=None, timeout=1200):
    result = subprocess.run([str(x) for x in command], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=env, timeout=timeout)
    if result.returncode:
        raise ProcessFailure(command, result)
    return result.stdout


def oracle(executable, case, mode=0, wire=b'', cutoff=0, relocations=None):
    fields = relocations if relocations is not None else (inspect(wire)[0] if wire and mode != 2 else [])
    packet = b''.join(pack_blob(x) for x in (case.source.encode(), case.check.encode(), wire))
    packet += struct.pack('<5I', case.evaluation, case.flags, mode, cutoff, len(fields))
    packet += b''.join(struct.pack('<2I', offset, index) for index, (offset, _) in enumerate(fields))
    output = records(run([executable], data=packet, timeout=90))
    if len(output) != 1:
        raise AssertionError('C record framing')
    return output[0]


@dataclass
class Job:
    case: Case
    mode: int
    wire: bytes = b''
    cutoff: int = 0
    expected: tuple | None = None
    label: str = ''
    shared_addresses: tuple | None = None


def native(temp, args, jobs):
    binary = temp / 'binary-objects-native'
    if not binary.exists():
        main = temp / 'src/js_binary_object_fixture_main.silk'
        command = [args.silk, 'build', main, '-o', binary, '--stdlib', args.stdlib,
                   '--optimization', 'speed', '--debug', 'false']
        environment = os.environ.copy()
        environment.setdefault('SILK_CLANG', args.cc)
        environment.setdefault('SILK_VERIFY_MIR', '1')
        if '-isysroot' in args.cflag:
            environment['SDKROOT'] = args.cflag[args.cflag.index('-isysroot') + 1]
        run(command, cwd=temp, env=environment, timeout=3600)
    packet = bytearray(struct.pack('<I', len(jobs)))
    for job in jobs:
        packet += b''.join(pack_blob(value) for value in
                           (job.case.source.encode(), job.case.check.encode(), job.wire))
        if job.shared_addresses is not None:
            addresses = job.shared_addresses
        else:
            addresses = [address for _, address in inspect(job.wire)[0]] if job.wire and job.mode != 2 else []
        packet += struct.pack('<5I', job.case.evaluation, job.case.flags, job.mode, job.cutoff, len(addresses))
        packet += b''.join(struct.pack('<Q', address) for address in addresses)
    output = records(run([binary], data=packet, cwd=temp, timeout=3600))
    if len(output) != len(jobs):
        raise AssertionError(f'native: {len(output)} records, expected {len(jobs)}')
    return output


def assert_clean(record, label):
    row = record[2]
    if row[7:] != (0, 0, 0):
        raise AssertionError(f'{label}: shared/allocation/byte ledger={row[7:]}')
    if not row[1] and row[2] == 100:
        raise AssertionError(f'{label}: failure without exception, stage={row[0]}')


def compare(job, actual):
    label = job.label or f'{job.case.name}/mode{job.mode}/{job.cutoff}'
    assert_clean(actual, label)
    expected = job.expected
    row = actual[2]
    if expected is None:
        if row[1]:
            raise AssertionError(f'{label}: malformed/truncated input accepted')
        return
    if row[1] != expected[2][1]:
        raise AssertionError(f'{label}: outcome C={expected[2]} native={row}')
    if not row[1]:
        if row[:3] != expected[2][:3]:
            raise AssertionError(f'{label}: exception stage/category C={expected[2][:3]} native={row[:3]}')
        if normalized(actual[0]) != normalized(expected[0]) or row[5] != expected[2][5]:
            raise AssertionError(f'{label}: rejected read lost writer bytes or shared side-table identity')
        return
    if job.mode != 2 and row[3] != 1:
        raise AssertionError(f'{label}: real Engine semantic/identity/execution check failed: {row}')
    for name, left, right in [('write', expected[0], actual[0]), ('rewrite', expected[1], actual[1])]:
        if normalized(left) != normalized(right):
            a, b = normalized(left), normalized(right)
            at = next((i for i, pair in enumerate(zip(a, b)) if pair[0] != pair[1]), min(len(a), len(b)))
            raise AssertionError(f'{label}: {name} bytes differ at {at}; C({len(a)})={a[max(0,at-12):at+24].hex()} native({len(b)})={b[max(0,at-12):at+24].hex()}')
    if row[5] != expected[2][5]:
        raise AssertionError(f'{label}: shared side-table count C={expected[2][5]} native={row[5]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', type=Path, default=toolchain.compiler_path())
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default=toolchain.clang_path())
    parser.add_argument('--cflag', action='append', default=[])
    parser.add_argument('--cutoffs', type=int, default=512)
    parser.add_argument('--case', action='append', help='Diagnostic subset; default runs every case')
    args = parser.parse_args()
    if args.cutoffs < 1:
        parser.error('--cutoffs must be positive')
    args.reference = args.reference.resolve()
    args.silk = args.silk.resolve()
    args.stdlib = args.stdlib.resolve()
    validate_pins(args.reference)
    selected = [case for case in CASES if not args.case or case.name in args.case]
    if not selected:
        parser.error('no selected cases')
    with tempfile.TemporaryDirectory(prefix='silkjs-binary-objects-') as directory:
        temp = Path(directory).resolve()
        shutil.copytree(ROOT / 'src', temp / 'src')
        shutil.copy2(ROOT / 'silk.toml', temp / 'silk.toml')
        executable = temp / 'binary-objects-c'
        run([args.cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
             '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="binary-object-oracle"',
             *args.cflag, '-I', args.reference, ROOT / 'scripts/fixtures/binary_objects_oracle.c',
             *(args.reference / name for name in SUPPORT), '-lm', '-lpthread', '-o', executable])
        jobs, golden = [], {}
        for case in selected:
            result = oracle(executable, case)
            assert_clean(result, 'C/' + case.name)
            if case.c_read_bug:
                if result[2][:3] != (3, 0, 6):
                    raise AssertionError(f'C/{case.name}: expected pinned external-GSAB guard, got {result[2]}')
                print('PINNED-C READER LIMITATION: growable SAB writer output is rejected by external-buffer guard at quickjs.c:60220')
            elif result[2][1] == case.reject:
                raise AssertionError(f'C/{case.name}: unexpected source acceptance/rejection {result[2]}')
            if result[2][1] and result[2][3] != 1:
                raise AssertionError(f'C/{case.name}: independent semantic check is false')
            golden[case.name] = result
            jobs.append(Job(case, 0, expected=result))
            if not case.reject:
                read = oracle(executable, case, 1, result[0])
                assert_clean(read, 'C/read/' + case.name)
                jobs.append(Job(case, 1, result[0], expected=read))
                if case.flags & SAB and case.name in ('shared-buffer', 'growable-shared'):
                    jobs.append(Job(case, 6, expected=result, label=case.name + '/trusted-native-callbacks'))
        actual = native(temp, args, jobs)
        for job, result in zip(jobs, actual):
            compare(job, result)
            if job.mode == 0 and result[0]:
                cross = oracle(executable, job.case, 1, result[0])
                assert_clean(cross, 'C/native-crossread/' + job.case.name)
                if job.case.c_read_bug:
                    if cross[2][:3] != (3, 0, 6):
                        raise AssertionError(f'C/{job.case.name}: GSAB source rejection changed')
                    continue
                if cross[2][1] != 1 or cross[2][3] != 1:
                    raise AssertionError(f'C/{job.case.name}: native wire decode/execution failed {cross[2]}')
                if normalized(cross[1]) != normalized(result[0]):
                    raise AssertionError(f'C/{job.case.name}: native wire reserialization differs')
        print(f'Engine cross-read/write: {len(jobs)} records; every ledger zero; all address-independent bytes exact')
        print('Golden SHA256:', hashlib.sha256(b''.join(normalized(golden[c.name][0]) for c in selected)).hexdigest())

        # Every proper prefix of every successful C stream must fail natively.
        # Do not execute arbitrary malformed bytecode in C: its reader is trusted.
        boundary_jobs = []
        for case in selected:
            if case.reject:
                continue
            data = golden[case.name][0]
            shared_fields, _ = inspect(data)
            addresses = tuple(address for _, address in shared_fields)
            for length in range(len(data)):
                boundary_jobs.append(Job(replace(case, flags=case.flags & ~BSWAP, check=''), 2, data[:length], label=f'{case.name}/prefix{length}', shared_addresses=addresses))
                if case.name in ('compile-constant', 'compile-closure'):
                    boundary_jobs.append(Job(replace(case, flags=case.flags | BSWAP, check=''), 5, data[:length], label=f'{case.name}/ROM-prefix{length}', shared_addresses=()))
            for suffix in (b'\x00', b'\xff\xff'):
                trailing_case = replace(case, flags=case.flags & ~BSWAP, check='')
                expected = oracle(executable, trailing_case, 2, data + suffix, relocations=shared_fields)
                boundary_jobs.append(Job(trailing_case, 2, data + suffix, expected=expected, label=f'{case.name}/trailing{suffix.hex()}', shared_addresses=addresses))
        invalid = [b'', b'\x04\x00\x01', b'\x06\x00\x01', b'\x05\x00\x00', b'\x05\x00\xff',
                   b'\x05\x00\x13\x00', b'\x05\x00\x0e\xff', b'\x05\x00\x11\x07\x00',
                   b'\x05\x01\x02x\x08\x01\x04\x01',
                   b'\x05\x00\x0f\x02\x01ab', b'\x05\x00\x05\x80\x80\x80\x80\x80']
        for index, data in enumerate(invalid):
            case = Case('invalid-' + str(index), '', '', REFERENCE)
            boundary_jobs.append(Job(case, 2, data))
        # Admission gates: bytecode/module and references cannot cross disabled flags.
        for case in selected:
            if not case.reject and case.flags & BYTECODE and case.evaluation & COMPILE:
                boundary_jobs.append(Job(replace(case, flags=0, check=''), 2, golden[case.name][0], label=case.name + '/no-bytecode-flag'))
            if case.name == 'cycle':
                boundary_jobs.append(Job(replace(case, flags=0, check=''), 2, golden[case.name][0], label='references-disabled'))
            if case.name == 'shared-buffer':
                boundary_jobs.append(Job(replace(case, flags=REFERENCE, check=''), 2, golden[case.name][0], label='shared-disabled'))
            if case.name == 'compile-constant':
                boundary_jobs.append(Job(replace(case, flags=BYTECODE | BSWAP, check=''), 2, golden[case.name][0], label='copied-api-rejects-ROM'))
        boundary_jobs.append(Job(Case('reader-stack-limit', '', ''), 2, b'\x05\x00' + b'\x09\x01' * 10000 + b'\x01'))
        # Bounded process batches isolate failures without rebuilding the native driver.
        for at in range(0, len(boundary_jobs), 128):
            batch = boundary_jobs[at:at + 128]
            for job, result in zip(batch, native(temp, args, batch)):
                compare(job, result)
        print(f'Native malformed/truncation boundaries: {len(boundary_jobs)}, zero ledgers')

        rom_jobs = []
        for case in selected:
            if case.name in ('compile-constant', 'compile-closure'):
                rom = replace(case, flags=case.flags | BSWAP)
                expected = oracle(executable, rom, 5, golden[case.name][0])
                rom_jobs.append(Job(rom, 5, golden[case.name][0], expected=expected))
        for job, result in zip(rom_jobs, native(temp, args, rom_jobs) if rom_jobs else []):
            compare(job, result)
            if result[2][6] != job.expected[2][6]:
                raise AssertionError(f'{job.case.name}: ROM borrowing/fallback differs C={job.expected[2][6]} native={result[2][6]}')
        print(f'ROM lifetime/atom relocation: {len(rom_jobs)} immutable-buffer decoded executions')

        fault_names = {'ordinary', 'bigints', 'cycle', 'views-identity', 'shared-buffer',
                       'compile-closure', 'module-execute', 'module-imports', 'template'}
        native_faults = c_faults = 0
        for case in selected:
            if case.name not in fault_names:
                continue
            for mode in (3, 4):
                reached = False
                for start in range(0, args.cutoffs, 32):
                    batch = [Job(case, mode, golden[case.name][0] if mode == 4 else b'', cutoff)
                             for cutoff in range(start, min(start + 32, args.cutoffs))]
                    for job, result in zip(batch, native(temp, args, batch)):
                        assert_clean(result, f'native/{case.name}/fault{mode}/{job.cutoff}')
                        row = result[2]
                        native_faults += row[4]
                        if row[1] and row[3] != 1:
                            raise AssertionError(f'{case.name}: native fault swallowed a semantic failure {row}')
                        if row[4] == 0:
                            if not row[1]:
                                raise AssertionError(f'{case.name}: non-injected failure in fault sweep {row}')
                            reached = True
                    if reached:
                        break
                if not reached:
                    raise AssertionError(f'{case.name}/mode{mode}: allocation sweep did not reach a non-injected success; increase --cutoffs')
                # C ordinals intentionally differ. Its original failure bugs are
                # reported explicitly, never used as permission for native leaks.
                c_reached = False
                for cutoff in range(args.cutoffs):
                    try:
                        record = oracle(executable, case, mode, golden[case.name][0] if mode == 4 else b'', cutoff)
                    except ProcessFailure as error:
                        if error.returncode >= 0:
                            raise
                        print(f'PINNED-C FAILURE BUG: {case.name}/mode{mode}/cutoff{cutoff} terminated by signal {-error.returncode}')
                        continue
                    row = record[2]
                    c_faults += row[4]
                    if row[7:] != (0, 0, 0):
                        print(f'PINNED-C FAILURE BUG: {case.name}/mode{mode}/cutoff{cutoff} ledger={row[7:]}')
                    elif row[1] and row[3] != 1:
                        if not row[4]:
                            raise AssertionError(f'{case.name}: uninjected C semantic failure {row}')
                        print(f'PINNED-C FAILURE BUG: {case.name}/mode{mode}/cutoff{cutoff} successful return lost graph semantics')
                    if row[4] == 0:
                        c_reached = True
                        break
                if not c_reached:
                    raise AssertionError(f'C/{case.name}/mode{mode}: sweep incomplete')
        print(f'Independent allocation failures: native={native_faults}, C={c_faults}; native zero ledgers throughout')


if __name__ == '__main__':
    main()
