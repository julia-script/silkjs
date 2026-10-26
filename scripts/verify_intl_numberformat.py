#!/usr/bin/env python3
"""Compare actual native Engine NumberFormat with a separate pinned-C process.

Default execution includes per-allocation ordinal failure injection and complete
realm teardown. JSON records preserve exact UTF-16 strings. Source-defect probes
run independently and do not normalize failed oracle cases into passing results.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
from intl_numberformat_cases import cases, native_boundaries, FAULTS, INDEPENDENT
from verify_intl_locale import literal, records, INTL, TEMPORAL
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
DEFECTS = [
    ('fraction-underwrite', "new Intl.NumberFormat('en',{maximumFractionDigits:0,roundingMode:'ceil'}).format(0.0001)"),
    ('group-array-overflow', "new Intl.NumberFormat('en').format('1'+'0'.repeat(100))"),
    ('engineering-overread', "new Intl.NumberFormat('en',{notation:'engineering'}).format(100)"),
]


def generated(selected, faults):
    lines=['pub const COUNT: usize = '+str(len(selected)),
           'pub const FAULT_COUNT: usize = '+str(len(FAULTS)),
           'pub const FAULTS: bool = '+str(faults).lower()]
    for name,values in [('source',[source for _,source in selected]),('faultSource',FAULTS)]:
        lines.append("pub fn "+name+"(index: usize) -> &'static [u8] { return match index {")
        lines += [str(i)+' => '+literal(source) for i,source in enumerate(values)]
        lines.append('_ => Intrinsic.trap("invalid NumberFormat fixture index") } }')
    return '\n'.join(lines)+'\n'


def c_source(selected):
    return r'''#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *inputs[] = { INPUTS };
static void word(unsigned n){for(int i=0;i<4;i++)putchar((n>>(i*8))&255);}
int main(int argc,char **argv){
 JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt),*other=JS_NewContext(rt);
 if(!ctx||!other||JS_AddIntrinsicIntl(ctx)<0||JS_AddIntrinsicIntl(other)<0)return 2;
 JSValue global=JS_GetGlobalObject(ctx),otherglobal=JS_GetGlobalObject(other);
 JSValue intl=JS_GetPropertyStr(other,otherglobal,"Intl"),ctor=JS_GetPropertyStr(other,intl,"NumberFormat");
 JS_SetPropertyStr(ctx,global,"__otherNumberFormat",ctor);
 JS_FreeValue(other,intl);JS_FreeValue(other,otherglobal);JS_FreeValue(ctx,global);JS_FreeContext(other);
 unsigned start=0,end=sizeof(inputs)/sizeof(inputs[0]);if(argc>1){start=atoi(argv[1]);end=start+1;}
 for(unsigned i=start;i<end;i++){
  JSValue v=JS_Eval(ctx,inputs[i],strlen(inputs[i]),"intl-numberformat-case.js",JS_EVAL_TYPE_GLOBAL);
  if(JS_IsException(v)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);fprintf(stderr,"case %u: %s\n",i,s?s:"exception");return 3;}
  size_t n;const char *s=JS_ToCStringLen(ctx,&n,v);if(!s)return 4;
  word(n);fwrite(s,1,n,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,v);
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''.replace('INPUTS',',\n'.join(json.dumps(source,ensure_ascii=True) for _,source in selected))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream',type=Path,required=True)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default=toolchain.clang_path())
    parser.add_argument('--cflag',action='append',default=[])
    parser.add_argument('--timeout',type=int,default=1800)
    parser.add_argument('--build-dir',type=Path,default=ROOT/'build/intl-numberformat-differential')
    parser.add_argument('--case',help='Diagnostic case-name substring selector')
    parser.add_argument('--skip-faults',action='store_true',help='Diagnostic only; acceptance requires the default sweeps')
    parser.add_argument('--source-defects',action='store_true',help='Separately execute source UB probes under AddressSanitizer')
    args=parser.parse_args()
    reference=args.upstream.resolve();validate_pins(reference)
    selected=cases(); boundaries=native_boundaries()
    if args.case:
        selected=[item for item in selected if args.case in item[0]]
        boundaries=[item for item in boundaries if args.case in item[0]]
    if not selected and not boundaries: raise SystemExit('No cases selected')
    native_selected=selected+[(name,source) for name,source,_ in boundaries]
    labels=[name for name,_ in native_selected]
    build=args.build_dir.resolve();build.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'src',build/'src',dirs_exist_ok=True)
    (build/'src/js_intl_number_cases_generated.silk').write_text(generated(native_selected,not args.skip_faults))
    shutil.copyfile(ROOT/'silk.toml',build/'silk.toml')
    (build/'oracle.c').write_text(c_source(selected))
    (build/'cases.json').write_text(json.dumps(native_selected,indent=2))
    support=[reference/name for name in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]
    support += [reference/'intl'/(name+'.c') for name in INTL]
    support += [reference/'temporal'/(name+'.c') for name in TEMPORAL]
    command=[executable_path(args.cc),'-std=gnu11','-O2','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*args.cflag,'-I',str(reference),str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')]
    (build/'oracle-command.json').write_text(json.dumps(command))
    process(command,args.timeout,owner='Pinned NumberFormat oracle compilation')
    expected=process([str(build/'oracle')],args.timeout,owner='Pinned NumberFormat JavaScript execution')
    (build/'expected.bin').write_bytes(expected)
    wanted,remaining=records(expected,len(selected))
    if remaining: raise SystemExit('C oracle emitted unexpected trailing bytes')
    for name,value in zip(labels,wanted):
        if name in INDEPENDENT and value!=INDEPENDENT[name]:
            raise SystemExit('Pinned C contradicts independent expectation '+name+': '+repr(value))
    wanted += [expected_value for _,_,expected_value in boundaries]
    command=[executable_path(args.silk),'build',str(build/'src/js_intl_number_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(args.stdlib.resolve()),'--optimization','speed','--debug','false']
    (build/'native-command.json').write_text(json.dumps(command))
    process(command,args.timeout,owner='Actual native Engine NumberFormat compilation')
    execution=subprocess.run([str(build/'native')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
    (build/'actual.bin').write_bytes(execution.stdout);(build/'native.stderr').write_bytes(execution.stderr)
    if execution.returncode: raise SystemExit(f'Native Engine exit {execution.returncode}; output={len(execution.stdout)} bytes; artifacts={build}\n'+execution.stderr.decode(errors='replace'))
    actual,trailer=records(execution.stdout,len(labels))
    differences=[]
    for name,a,b in zip(labels,actual,wanted):
        if a!=b: differences.append({'case':name,'C':b,'native':a})
    (build/'differences.json').write_text(json.dumps(differences,ensure_ascii=True,indent=2))
    if differences: raise SystemExit(f'{len(differences)} NumberFormat mismatches; '+json.dumps(differences[:20],ensure_ascii=True,indent=2))
    if len(trailer)!=12: raise SystemExit(f'Expected complete fault trailer, got {len(trailer)} bytes')
    fault_cases,attempts,injected=struct.unpack('<III',trailer)
    if not args.skip_faults and (fault_cases!=len(FAULTS)+1 or injected==0 or attempts!=injected+fault_cases): raise SystemExit(f'Incomplete fault sweep: {(fault_cases,attempts,injected)}')
    report={'cases':len(selected),'independentNativeBoundaries':len(boundaries),'sha256':hashlib.sha256(expected).hexdigest(),'faultOperations':fault_cases,'faultAttempts':attempts,'injected':injected,'zeroLedgers':True}
    if args.source_defects:
        (build/'source-defects.c').write_text(c_source([(name,'JSON.stringify('+source+')') for name,source in DEFECTS]))
        defect_command=[executable_path(args.cc),'-std=gnu11','-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*args.cflag,'-I',str(reference),str(build/'source-defects.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'source-defects')]
        (build/'source-defects-command.json').write_text(json.dumps(defect_command))
        process(defect_command,args.timeout,owner='Separate AddressSanitizer C defect oracle compilation')
        report['sourceDefects']=[]
        for i,(name,source) in enumerate(DEFECTS):
            probe=subprocess.run([str(build/'source-defects'),str(i)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
            (build/(name+'.stdout')).write_bytes(probe.stdout);(build/(name+'.stderr')).write_bytes(probe.stderr)
            report['sourceDefects'].append({'name':name,'source':source,'exit':probe.returncode,'asan':b'AddressSanitizer' in probe.stderr})
    (build/'report.json').write_text(json.dumps(report,indent=2))
    print(f'Intl.NumberFormat: {len(selected)} actual Engine cases match pinned C; {len(boundaries)} independent undefined-C boundary cases; sha256={report["sha256"]}')
    print(f'Allocation sweeps: {fault_cases} operations, {attempts} attempts, {injected} failures; zero allocations/bytes after every teardown')
    print(f'Artifacts: {build}')

if __name__=='__main__':main()
