#!/usr/bin/env python3
"""Native/C borrowed and consuming array construction; real owners and OOM cleanup."""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE

ROOT = Path(__file__).resolve().parents[1]
CASES = [(count, consume) for count in (0, 1, 2, 3, 9, 33) for consume in (0, 1)]
FAULTS = [(count, consume) for count in (0, 9, 33) for consume in (0, 1)]
CUTOFFS = 48
C_SOURCE = ALLOCATOR_SOURCE + r'''
static JSClassID watch_class;
static uint32_t finalized, with_pending;
static void finalize_watch(JSRuntime *rt, JSValue value) {
    finalized++;
    if (!JS_IsUninitialized(rt->current_exception)) with_pending++;
}
static void isolated(int count, int consume, int armed, size_t cutoff) {
    uint32_t row[13] = {0}; JSValue values[35];
    JSRuntime *rt = JS_NewRuntime2(&allocator, NULL); if (!rt) abort();
    JSContext *ctx = JS_NewContext(rt); if (!ctx) abort();
    if (!watch_class) JS_NewClassID(&watch_class);
    JSClassDef definition = {"Watched", finalize_watch, NULL, NULL, NULL};
    if (JS_NewClass(rt, watch_class, &definition)) abort();
    for (int i=0; i<35; i++) values[i]=JS_UNDEFINED;
    values[0]=checked(JS_NewString(ctx,"prefix"));
    values[count+1]=checked(JS_NewString(ctx,"suffix"));
    for (int i=0; i<count; i++) {
        if (i%3==0) {
            if (!i) { values[i+1]=checked(JS_NewObjectClass(ctx,watch_class)); JS_SetOpaque(values[i+1],(void *)(uintptr_t)1); }
            else values[i+1]=JS_DupValue(ctx,values[1]);
        } else if (i%3==1) values[i+1]=checked(JS_NewString(ctx,"heap"));
        else values[i+1]=JS_NewInt32(ctx,i);
    }
    JS_RunGC(rt); finalized=with_pending=0;
    unsigned before=faults; fault_after=armed?(long)cutoff:-1;
    JSValue result=consume?js_create_array_free(ctx,count,values+1):js_create_array(ctx,count,values+1);
    fault_after=-1;
    row[5]=finalized; row[6]=JS_HasException(ctx); row[9]=with_pending; row[10]=faults-before;
    row[7]=js_rc(JS_VALUE_GET_STRING(values[0]))->ref_count;
    row[8]=js_rc(JS_VALUE_GET_STRING(values[count+1]))->ref_count;
    if (!JS_IsException(result)) {
        JSObject *p=JS_VALUE_GET_OBJ(result); row[0]=1; row[1]=p->u.array.count; row[2]=JS_VALUE_GET_INT(p->prop[0].u.value);
        for (int i=0; i<count; i++) {
            JSValue item=p->u.array.u.values[i]; uint32_t word=0;
            if (JS_IsObject(item)) {
                word=3000+(uintptr_t)JS_GetOpaque(item,watch_class)-1;
                if (!i) row[4]=js_rc(JS_VALUE_GET_OBJ(item))->ref_count;
            } else if (JS_IsString(item)) {
                JSString *s=JS_VALUE_GET_STRING(item); word=2000;
                for (int j=0; j<s->len; j++) word=(word*31+(s->is_wide_char?s->u.str16[j]:s->u.str8[j]))&65535;
            } else { uint32_t number; if (JS_ToUint32(ctx,&number,item)<0) abort(); word=number; }
            row[3]=(row[3]*31+word)&65535;
        }
        JS_FreeValue(ctx,result);
    } else { JSValue error=JS_GetException(ctx); JS_FreeValue(ctx,error); }
    if (!consume) for (int i=0; i<count; i++) JS_FreeValue(ctx,values[i+1]);
    JS_FreeValue(ctx,values[0]); JS_FreeValue(ctx,values[count+1]);
    JS_RunGC(rt); JS_FreeContext(ctx); JS_FreeRuntime(rt);
    row[11]=live_count; row[12]=live_bytes;
    for (int i=0; i<13; i++) word(row[i]);
}
int main(void) { CALLS return 0; }
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import js_string_types { StringLengthError }
import js_array_construction_test_support as fixture
import byte_buffer { ByteBuffer }
struct Case { count: usize, consume: bool, armed: bool, cutoff: usize }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let cases: [Case; COUNT] = [CASES]
  let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
  let mut index: usize = 0
  while index < cases.length {
    let item = &cases[index]
    let row = run fixture.isolated(item.count, item.consume, item.armed, item.cutoff)
    let mut field: usize = 0
    while field < 13 { run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
    index = index + 1
  }
  let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def records(data, cases, owner):
    if len(data) != 52 * len(cases):
        raise SystemExit(f'{owner}: wrong record length {len(data)}')
    rows = list(struct.iter_unpack('<13I', data))
    for case, row in zip(cases, rows):
        count, consume, armed, cutoff = case
        if row[11:] != (0, 0) or row[7:9] != (1, 1):
            raise SystemExit(f'{owner} {case}: owner/ledger failure {row}')
        if row[0]:
            copies = (count + 2) // 3
            if row[1:3] != (count, count) or row[4] != copies * (1 if consume else 2) or row[5:7] != (0, 0):
                raise SystemExit(f'{owner} {case}: constructed storage/retention failure {row}')
        elif not row[6] or row[5] != int(bool(count and consume)) or row[9] != row[5]:
            raise SystemExit(f'{owner} {case}: failure consumption/pending order {row}')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    cases = [(count, consume, 0, 0) for count, consume in CASES]
    cases += [(count, consume, 1, cutoff) for count, consume in FAULTS for cutoff in range(CUTOFFS)]
    with tempfile.TemporaryDirectory(prefix='silkjs-array-construction-') as directory:
        temp = Path(directory).resolve()
        calls = ''.join(f'isolated({count},{consume},{armed},{cutoff});' for count, consume, armed, cutoff in cases)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', calls))
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Array construction C compilation')
        expected = process([str(temp / 'oracle')], 120, owner='Array construction C consumer')
        c_rows = records(expected, cases, 'C')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="array-construction-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        entries = ','.join(f'Case {{ count: {count}, consume: {str(bool(consume)).lower()}, armed: {str(bool(armed)).lower()}, cutoff: {cutoff} }}'
                           for count, consume, armed, cutoff in cases)
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('COUNT', str(len(cases))).replace('CASES', entries))
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Array construction native consumer', cwd=temp)
        native_rows = records(actual, cases, 'native')
        if c_rows[:len(CASES)] != native_rows[:len(CASES)]:
            raise SystemExit(f'Array construction semantic mismatch: C={c_rows[:len(CASES)]}; native={native_rows[:len(CASES)]}')
        for owner, rows in [('C', c_rows), ('native', native_rows)]:
            for index, case in enumerate(FAULTS):
                group = rows[len(CASES) + index*CUTOFFS:len(CASES) + (index+1)*CUTOFFS]
                if not any(row[10] for row in group) or not any(not row[10] for row in group):
                    raise SystemExit(f'{owner} {case}: sweep did not cross failures and clean execution')
        print(f'PASS array construction: {len(CASES)} semantic records, {len(FAULTS)*CUTOFFS} independent allocation attempts/engine; '
              f'C failures={sum(row[10] for row in c_rows)}, native failures={sum(row[10] for row in native_rows)}; '
              f'all ledgers zero; {pins} pins; SHA256={hashlib.sha256(actual[:52*len(CASES)]).hexdigest()}')


if __name__ == '__main__':
    main()
