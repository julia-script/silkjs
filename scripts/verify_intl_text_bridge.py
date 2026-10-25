#!/usr/bin/env python3
"""Verify real Engine Collator/Segmenter adapters against pinned standalone C.

Word inputs above U+00FF violate the C isalnum precondition: execute those only
natively and assert separate independent expectations, never normalize a C crash.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
from intl_text_bridge_cases import cases, FAULTS
from verify_intl_locale import INTL, TEMPORAL, literal, records, c_source
from verify_bytecode import executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]


def generated(selected, faults):
    lines = [f'pub const COUNT: usize = {len(selected)}',
             f'pub const FAULT_COUNT: usize = {len(FAULTS)}',
             'pub const FAULTS: bool = '+str(faults).lower()]
    for name, sources in [('source',[item[1] for item in selected]), ('faultSource',FAULTS)]:
        lines.append('pub fn '+name+'(index: usize) -> &\'static [u8] { return match index {')
        lines.extend(str(i)+' => '+literal(source) for i, source in enumerate(sources))
        lines.append('_ => Intrinsic.trap("invalid text fixture case") } }')
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--upstream',type=Path,required=True)
    p.add_argument('--silk',default=str(ROOT/'build/toolchain-main-dd2e99ab/silk-fixed4'))
    p.add_argument('--stdlib',type=Path,default=ROOT/'build/toolchain-main-dd2e99ab/stdlib')
    p.add_argument('--cc',default='/opt/homebrew/opt/llvm/bin/clang')
    p.add_argument('--cflag',action='append',default=[])
    p.add_argument('--timeout',type=int,default=1800)
    p.add_argument('--build-dir',type=Path,default=ROOT/'build/intl-text-bridge')
    p.add_argument('--case')
    p.add_argument('--skip-faults',action='store_true')
    a=p.parse_args()
    reference=a.upstream.resolve();validate_pins(reference)
    selected=[item for item in cases() if not a.case or a.case in item[0]]
    if not selected: raise SystemExit('No cases selected')
    portable=[item for item in selected if item[3]]
    build=a.build_dir.resolve();build.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'src',build/'src',dirs_exist_ok=True)
    shutil.copyfile(ROOT/'silk.toml',build/'silk.toml')
    (build/'src/js_intl_text_fixture_cases.silk').write_text(generated(selected,not a.skip_faults))
    oracle_source=c_source([(name,source) for name,source,_,_ in portable],[])
    foreign_setup=r'''
 JSContext *foreign=JS_NewContext(rt);
 if(!foreign || JS_AddIntrinsicIntl(foreign)<0)return 8;
 const char *expressions[]={"Intl.Collator","Intl.Segmenter","(function(){function T(){};T.prototype=null;return T})()"};
 const char *names[]={"__foreignCollator","__foreignSegmenter","__foreignTarget"};
 for(int i=0;i<3;i++){
   JSValue v=JS_Eval(foreign,expressions[i],strlen(expressions[i]),"intl-text-foreign.js",0);
   if(JS_IsException(v))return 9;
   if(JS_SetPropertyStr(ctx,global,names[i],v)<0)return 10;
 }
 JS_FreeContext(foreign);
'''
    oracle_source=oracle_source.replace(' JS_FreeValue(ctx,global);\n for(unsigned i=0;',foreign_setup+' JS_FreeValue(ctx,global);\n for(unsigned i=0;',1)
    (build/'oracle.c').write_text(oracle_source)
    (build/'cases.json').write_text(json.dumps([{'name':name,'independent':expected,'portable':is_portable} for name,_,expected,is_portable in selected],indent=2))
    support=[reference/name for name in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]
    support += [reference/'intl'/(name+'.c') for name in INTL]
    support += [reference/'temporal'/(name+'.c') for name in TEMPORAL]
    command=[executable_path(a.cc),'-std=gnu11','-O2','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*a.cflag,'-I',str(reference),str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')]
    process(command,a.timeout,owner='Pinned full Intl C oracle compilation')
    expected=process([str(build/'oracle')],a.timeout,owner='Pinned Collator/Segmenter JS execution')
    (build/'expected.bin').write_bytes(expected)
    wanted,trailing=records(expected,len(portable))
    if trailing: raise SystemExit('C oracle emitted trailing bytes')
    oracle=dict(zip((item[0] for item in portable),wanted))
    independent_errors=[]
    for name,_,contract,is_portable in portable:
        if contract is not None and oracle[name]!=contract:
            independent_errors.append(f'{name}: expected {contract!r}, C returned {oracle[name]!r}')
    if independent_errors: raise SystemExit('Independent C contract failures:\n'+'\n'.join(independent_errors))
    command=[executable_path(a.silk),'build',str(build/'src/js_intl_text_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(a.stdlib.resolve()),'--optimization','speed','--debug','false']
    process(command,a.timeout,owner='Actual Engine text bridge compilation')
    execution=subprocess.run([str(build/'native')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=a.timeout)
    (build/'actual.bin').write_bytes(execution.stdout)
    if execution.returncode: raise SystemExit(f'Native Engine exit {execution.returncode}; output={len(execution.stdout)} bytes; artifacts={build}\n'+execution.stderr.decode(errors='replace'))
    actual,trailer=records(execution.stdout,len(selected))
    differences=[]
    independent=0
    for (name,_,contract,is_portable),value in zip(selected,actual):
        if contract is not None:
            independent+=1
            if value!=contract: differences.append(f'{name}: independent {contract!r}; native {value!r}')
        if is_portable and value!=oracle[name]: differences.append(f'{name}: C {oracle[name]!r}; native {value!r}')
    if differences: raise SystemExit(f'{len(differences)} differences:\n'+'\n'.join(differences[:40]))
    if len(trailer)!=12: raise SystemExit(f'Expected complete allocation trailer, got {len(trailer)} bytes')
    operations,attempts,injected=struct.unpack('<III',trailer)
    if not a.skip_faults and (operations!=len(FAULTS)+1 or injected==0 or attempts!=injected+operations): raise SystemExit(f'Incomplete fault sweep {(operations,attempts,injected)}')
    print(f'Intl text: {len(selected)} real Engine JS cases; {len(portable)} portable pinned C comparisons; {independent} independent contracts')
    print(f'C word-classification precondition: {len(selected)-len(portable)} nonportable inputs isolated from C oracle')
    print(f'Allocation sweeps: {operations} operations, {attempts} attempts, {injected} failures; zero allocation/byte ledgers after each realm')
    print(f'Oracle sha256={hashlib.sha256(expected).hexdigest()}; artifacts={build}')


if __name__=='__main__':main()
