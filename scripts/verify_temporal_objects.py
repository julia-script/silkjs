#!/usr/bin/env python3
"""Verify native Engine Temporal against pinned C, independent boundaries, and OOM teardown."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
from temporal_objects_cases import cases, native_boundaries, FAULTS, INDEPENDENT
from verify_intl_locale import literal, records, INTL, TEMPORAL
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]


def generated(selected, faults):
    lines = [f'pub const COUNT: usize = {len(selected)}', f'pub const FAULT_COUNT: usize = {len(FAULTS)}', 'pub const FAULTS: bool = '+str(faults).lower()]
    for name, sources in [('source', [source for _, source in selected]), ('faultSource', FAULTS)]:
        lines.append("pub fn "+name+"(index: usize) -> &'static [u8] { return match index {")
        lines += [str(index)+' => '+literal(source) for index,source in enumerate(sources)]
        lines.append('_ => Intrinsic.trap("invalid Temporal case index") } }')
    clock_indices = [index for index,(name,_) in enumerate(selected) if name.startswith('independent/now-') or name in ['now/default-zone','now/default-zone-id']]
    lines.append('pub fn clockCase(index: usize) -> bool { return '+(' || '.join('index == '+str(index) for index in clock_indices) or 'false')+' }')
    return '\n'.join(lines)+'\n'


def c_source(selected, reinstall=False):
    return r'''#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *inputs[]={INPUTS};
static void word(unsigned n){for(int i=0;i<4;i++)putchar((n>>(i*8))&255);}
int main(int argc,char **argv){
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt),*other=JS_NewContext(rt);
 if(!ctx||!other||JS_AddIntrinsicIntl(ctx)<0||JS_AddIntrinsicIntl(other)<0||JS_AddIntrinsicTemporal(ctx)<0||JS_AddIntrinsicTemporal(other)<0)return 2;
 JSValue global=JS_GetGlobalObject(ctx),otherglobal=JS_GetGlobalObject(other);
 JS_SetPropertyStr(ctx,global,"__previousTemporal",JS_GetPropertyStr(ctx,global,"Temporal"));
 if(REINSTALL && JS_AddIntrinsicTemporal(ctx)<0)return 2;
 JSValue temporal=JS_GetPropertyStr(other,otherglobal,"Temporal");
 JS_SetPropertyStr(ctx,global,"__otherTemporal",temporal);
 JS_FreeValue(other,otherglobal);JS_FreeValue(ctx,global);JS_FreeContext(other);
 unsigned start=0,end=sizeof(inputs)/sizeof(inputs[0]);if(argc>1){start=atoi(argv[1]);end=start+1;}
 for(unsigned i=start;i<end;i++){
  JSValue v=JS_Eval(ctx,inputs[i],strlen(inputs[i]),"temporal-objects-case.js",JS_EVAL_TYPE_GLOBAL);
  if(JS_IsException(v)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);fprintf(stderr,"case %u: %s\n",i,s?s:"exception");return 3;}
  size_t n;const char *s=JS_ToCStringLen(ctx,&n,v);if(!s)return 4;
  word(n);fwrite(s,1,n,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,v);
 }
 fflush(stdout);JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''.replace('INPUTS', ',\n'.join(json.dumps(source, ensure_ascii=True) for _,source in selected)).replace('REINSTALL', '1' if reinstall else '0')

def oracle_values(execution, count, label, allow_teardown_defect=False):
    values, trailing = records(execution.stdout, count)
    if trailing:
        raise SystemExit(label+' emitted trailing bytes')
    # The pinned reinstaller leaks GC objects at runtime teardown. Only its exact
    # assertion after a complete record stream is classified as this source defect.
    if execution.returncode and not (allow_teardown_defect and execution.returncode == -6 and b'list_empty(&rt->gc_obj_list)' in execution.stderr):
        raise SystemExit(f'{label} exit {execution.returncode}: {execution.stderr!r}')
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default=toolchain.clang_path())
    parser.add_argument('--cflag', action='append', default=[])
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--build-dir', type=Path, default=ROOT/'build/temporal-objects-differential')
    parser.add_argument('--case', help='Diagnostic case-name substring; complete acceptance runs all cases')
    parser.add_argument('--skip-faults', action='store_true', help='Diagnostic only; acceptance requires fault sweeps')
    parser.add_argument('--source-defects', action='store_true', help='Separately record source implementation-defined/undefined boundary results')
    args = parser.parse_args()
    reference = args.upstream.resolve(); validate_pins(reference)
    selected = cases(); boundaries = native_boundaries()
    if args.case:
        selected = [item for item in selected if args.case in item[0]]
        boundaries = [item for item in boundaries if args.case in item[0]]
    if not selected and not boundaries:
        raise SystemExit('No cases selected')
    clean_cases = [item for item in selected if not item[0].startswith('reinstall/')]
    reinstall_cases = [item for item in selected if item[0].startswith('reinstall/')]
    native_selected = selected+[(name,source) for name,source,_ in boundaries]
    labels = [name for name,_ in native_selected]
    build = args.build_dir.resolve(); build.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT/'src', build/'src', dirs_exist_ok=True)
    shutil.copyfile(ROOT/'silk.toml', build/'silk.toml')
    (build/'src/js_temporal_objects_cases_generated.silk').write_text(generated(native_selected, not args.skip_faults))
    (build/'cases.json').write_text(json.dumps(native_selected, ensure_ascii=True, indent=2))
    (build/'oracle.c').write_text(c_source(clean_cases))
    support = [reference/name for name in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]
    support += [reference/'intl'/(name+'.c') for name in INTL]
    support += [reference/'temporal'/(name+'.c') for name in TEMPORAL]
    base = [executable_path(args.cc),'-std=gnu11','-O2','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*args.cflag,'-I',str(reference)]
    command = base+[str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')]
    (build/'oracle-command.json').write_text(json.dumps(command))
    process(command,args.timeout,owner='Pinned Temporal C oracle compilation')
    oracle_execution = subprocess.run([str(build/'oracle')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
    expected = oracle_execution.stdout
    (build/'expected.bin').write_bytes(expected)
    (build/'oracle.stderr').write_bytes(oracle_execution.stderr)
    clean_values = oracle_values(oracle_execution,len(clean_cases),'Pinned Temporal JavaScript execution')
    by_name = dict(zip((name for name,_ in clean_cases),clean_values))
    oracle_teardown = {'cleanExit':oracle_execution.returncode,'reinstallationExit':None,'gcObjectLeak':False}
    if reinstall_cases:
        (build/'reinstall-oracle.c').write_text(c_source(reinstall_cases,reinstall=True))
        reinstall_command = base+[str(build/'reinstall-oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'reinstall-oracle')]
        process(reinstall_command,args.timeout,owner='Isolated pinned Temporal reinstallation oracle compilation')
        reinstall_execution = subprocess.run([str(build/'reinstall-oracle')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
        (build/'reinstall-expected.bin').write_bytes(reinstall_execution.stdout)
        (build/'reinstall-oracle.stderr').write_bytes(reinstall_execution.stderr)
        reinstall_values = oracle_values(reinstall_execution,len(reinstall_cases),'Isolated pinned Temporal reinstallation',allow_teardown_defect=True)
        by_name.update(zip((name for name,_ in reinstall_cases),reinstall_values))
        expected += reinstall_execution.stdout
        oracle_teardown['reinstallationExit'] = reinstall_execution.returncode
        oracle_teardown['gcObjectLeak'] = reinstall_execution.returncode == -6
    wanted = [by_name[name] for name,_ in selected]
    (build/'source-runtime-defect.json').write_text(json.dumps(oracle_teardown,indent=2))
    independent_differences = []
    for (name,_),value in zip(selected,wanted):
        if name in INDEPENDENT and value != INDEPENDENT[name]:
            independent_differences.append({'case':name,'C':value,'independent':INDEPENDENT[name]})
    (build/'independent-c-differences.json').write_text(json.dumps(independent_differences,indent=2))
    if independent_differences:
        raise SystemExit('Pinned C contradicts independent expectations: '+json.dumps(independent_differences,ensure_ascii=True))
    wanted += [value for _,_,value in boundaries]
    command = [executable_path(args.silk),'build',str(build/'src/js_temporal_objects_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(args.stdlib.resolve()),'--optimization','speed','--debug','false']
    (build/'native-command.json').write_text(json.dumps(command))
    process(command,args.timeout,owner='Actual native Engine Temporal compilation')
    execution = subprocess.run([str(build/'native')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=args.timeout)
    (build/'actual.bin').write_bytes(execution.stdout); (build/'native.stderr').write_bytes(execution.stderr)
    if execution.returncode:
        raise SystemExit(f'Native Engine exit {execution.returncode}; output={len(execution.stdout)} bytes; artifacts={build}\n'+execution.stderr.decode(errors='replace'))
    actual,trailer = records(execution.stdout,len(labels))
    differences = [{'case':name,'expected':right,'native':left} for name,left,right in zip(labels,actual,wanted) if left != right]
    (build/'differences.json').write_text(json.dumps(differences,ensure_ascii=True,indent=2))
    if differences:
        raise SystemExit(f'{len(differences)} Temporal mismatches; '+json.dumps(differences[:30],ensure_ascii=True,indent=2))
    if len(trailer)!=12:
        raise SystemExit(f'Expected complete allocation trailer, got {len(trailer)} bytes')
    fault_cases,attempts,injected = struct.unpack('<III',trailer)
    if not args.skip_faults and (fault_cases!=len(FAULTS)+2 or injected==0 or attempts!=injected+fault_cases):
        raise SystemExit(f'Incomplete allocation sweep: {(fault_cases,attempts,injected)}')
    report = {'cases':len(selected),'independentExpectations':sum(name in INDEPENDENT for name,_ in selected),'nativeBoundaries':len(boundaries),'sha256':hashlib.sha256(expected).hexdigest(),'faultOperations':fault_cases,'faultAttempts':attempts,'injected':injected,'zeroLedgers':True}
    report['oracleTeardown'] = oracle_teardown
    if not args.case:
        # Default timezone is real OS state, not fixed host-clock data. All cases
        # execute again in a genuinely different process environment; deterministic
        # cases are not compared across zones, only source/native pairwise.
        report['systemZones'] = []
        for zone in ['UTC','America/New_York','Asia/Kathmandu']:
            environment = dict(os.environ,TZ=zone,SILK_TEMPORAL_CLOCK_ONLY='1')
            checks = [(i,name) for i,(name,_) in enumerate(clean_cases) if name.startswith('independent/now-') or name in ['now/default-zone','now/default-zone-id']]
            clock_expected = []
            for index,name in checks:
                oracle = subprocess.run([str(build/'oracle'),str(index)],env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
                values = oracle_values(oracle,1,'Pinned clock/zone '+zone)
                independent = zone if name == 'now/default-zone-id' else INDEPENDENT[name]
                if values != [independent]:
                    raise SystemExit(f'Source real-clock/zone invariant failed in {zone}: {values!r}')
                clock_expected += values
            native_clock = subprocess.run([str(build/'native')],env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
            artifact_name = zone.replace('/','_')
            (build/f'clock-{artifact_name}.stdout').write_bytes(native_clock.stdout)
            (build/f'clock-{artifact_name}.stderr').write_bytes(native_clock.stderr)
            if native_clock.returncode:
                raise SystemExit(f'Native clock/zone check exit {native_clock.returncode} in {zone}: {native_clock.stderr!r}')
            clock_actual,clock_trailer = records(native_clock.stdout,len(checks))
            if clock_actual != clock_expected or clock_trailer != bytes(12):
                raise SystemExit(f'Native real-clock/zone invariant failed in {zone}: {clock_actual!r}, expected {clock_expected!r}')
            report['systemZones'].append(zone)
    if args.source_defects:
        (build/'source-defects.c').write_text(c_source([(name,source) for name,source,_ in native_boundaries()]))
        defect_command = base+[str(build/'source-defects.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'source-defects')]
        process(defect_command,args.timeout,owner='Separate Temporal source boundary oracle compilation')
        report['sourceDefects'] = []
        for index,(name,source,independent) in enumerate(native_boundaries()):
            probe = subprocess.run([str(build/'source-defects'),str(index)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
            (build/f'source-boundary-{index}.stdout').write_bytes(probe.stdout)
            (build/f'source-boundary-{index}.stderr').write_bytes(probe.stderr)
            source_value = None
            if probe.returncode == 0:
                source_values = oracle_values(probe,1,'Pinned source boundary '+name); source_value=source_values[0]
            report['sourceDefects'].append({'case':name,'exit':probe.returncode,'C':source_value,'independent':independent})
    (build/'report.json').write_text(json.dumps(report,indent=2))
    print(f'Temporal: {len(selected)} actual Engine cases match pinned C; {len(boundaries)} independent native boundaries; sha256={report["sha256"]}')
    print(f'Allocation sweeps: {fault_cases} operations, {attempts} attempts, {injected} failures; zero allocations/bytes after every teardown')
    print(f'Artifacts: {build}')
    if oracle_teardown['gcObjectLeak']:
        print('Pinned C reinstallation teardown: FAILED (GC-object leak assertion); isolated source defect, not a native pass.')


if __name__=='__main__':
    main()
