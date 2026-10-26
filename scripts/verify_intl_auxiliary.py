#!/usr/bin/env python3
"""Execute auxiliary Intl through the real Engine, pinned C, and ordinal OOM sweeps."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
from intl_auxiliary_cases import cases, FAULTS
from verify_intl_locale import INTL, TEMPORAL, literal, records
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT=Path(__file__).resolve().parents[1]


def generated(selected,faults):
    lines=[f'pub const COUNT: usize = {len(selected)}',f'pub const FAULT_COUNT: usize = {len(FAULTS)}','pub const FAULTS: bool = '+str(faults).lower()]
    for name,sources in [('source',[row[1] for row in selected]),('faultSource',FAULTS)]:
        lines.append('pub fn '+name+'(index: usize) -> &\'static [u8] { return match index {')
        lines.extend(str(i)+' => '+literal(source) for i,source in enumerate(sources))
        lines.append('_ => Intrinsic.trap("invalid auxiliary fixture case") } }')
    return '\n'.join(lines)+'\n'


def c_literal(source):
    return '"' + ''.join(chr(b) if 32 <= b < 127 and b not in (34,92) else '\\%03o' % b for b in source.encode('utf-8')) + '"'


def c_source(selected):
    return r'''#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *inputs[]={INPUTS};
static void word(unsigned n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
int main(int argc,char **argv){
 setbuf(stdout,NULL);
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt),*other=JS_NewContext(rt);
 if(!ctx||!other||JS_AddIntrinsicIntl(ctx)<0||JS_AddIntrinsicIntl(other)<0||JS_AddIntrinsicTemporal(ctx)<0||JS_AddIntrinsicTemporal(other)<0)return 2;
 JSValue global=JS_GetGlobalObject(ctx);
 const char *expressions[]={"Intl.ListFormat","Intl.DisplayNames","Intl.PluralRules","Intl.RelativeTimeFormat","Intl.DurationFormat","Temporal.Duration","(function(){function T(){};T.prototype=null;return T})()"};
 const char *names[]={"__foreignListFormat","__foreignDisplayNames","__foreignPluralRules","__foreignRelativeTimeFormat","__foreignDurationFormat","__foreignDuration","__foreignTarget"};
 for(int i=0;i<7;i++){JSValue v=JS_Eval(other,expressions[i],strlen(expressions[i]),"aux-foreign.js",0);if(JS_IsException(v))return 8;if(JS_SetPropertyStr(ctx,global,names[i],v)<0)return 9;}
 JS_FreeValue(ctx,global);JS_FreeContext(other);
 unsigned start=0,end=sizeof(inputs)/sizeof(inputs[0]);if(argc>1){start=atoi(argv[1]);end=start+1;}
 for(unsigned i=start;i<end;i++){
  JSValue v=JS_Eval(ctx,inputs[i],strlen(inputs[i]),"intl-auxiliary-case.js",0);
  if(JS_IsException(v)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);fprintf(stderr,"case %u: %s\n",i,s?s:"exception");return 3;}
  size_t n;const char *s=JS_ToCStringLen(ctx,&n,v);if(!s)return 4;word(n);fwrite(s,1,n,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,v);
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''.replace('INPUTS',',\n'.join(c_literal(row[1]) for row in selected))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--upstream',type=Path,required=True)
    p.add_argument('--silk',default=str(toolchain.compiler_path()))
    p.add_argument('--stdlib',type=Path,default=toolchain.stdlib_path())
    p.add_argument('--cc',default=toolchain.clang_path())
    p.add_argument('--cflag',action='append',default=[])
    p.add_argument('--timeout',type=int,default=1800)
    p.add_argument('--build-dir',type=Path,default=ROOT/'build/intl-auxiliary-differential')
    p.add_argument('--case',help='Diagnostic case-name substring selector')
    p.add_argument('--skip-faults',action='store_true',help='Diagnostic only; default sweeps required for acceptance')
    p.add_argument('--source-defects',action='store_true',help='Measure source defects separately using ASan and UBSan')
    a=p.parse_args();reference=a.upstream.resolve();validate_pins(reference)
    selected=[row for row in cases() if not a.case or a.case in row[0]]
    if not selected:raise SystemExit('No cases selected')
    portable=[row for row in selected if row[3]]
    for name,_,contract,is_portable in selected:
        if not is_portable and contract is None:raise SystemExit('Missing independent native expectation: '+name)
    build=a.build_dir.resolve();build.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'src',build/'src',dirs_exist_ok=True);shutil.copyfile(ROOT/'silk.toml',build/'silk.toml')
    (build/'src/js_intl_auxiliary_fixture_cases.silk').write_text(generated(selected,not a.skip_faults))
    (build/'cases.json').write_text(json.dumps([{'name':n,'source':s,'independent':e,'portable':q} for n,s,e,q in selected],indent=2))
    (build/'oracle.c').write_text(c_source(portable))
    support=[reference/name for name in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]+[reference/'intl'/(n+'.c') for n in INTL]+[reference/'temporal'/(n+'.c') for n in TEMPORAL]
    base=[executable_path(a.cc),'-std=gnu11','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*a.cflag,'-I',str(reference)]
    command=base+['-O2',str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')]
    (build/'oracle-command.json').write_text(json.dumps(command));process(command,a.timeout,owner='Pinned auxiliary Intl oracle compilation')
    oracle_run=subprocess.run([str(build/'oracle')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=a.timeout)
    expected=oracle_run.stdout
    (build/'expected.bin').write_bytes(expected);(build/'oracle.stderr').write_bytes(oracle_run.stderr)
    if oracle_run.returncode:raise SystemExit(f'Pinned C oracle exit {oracle_run.returncode}; artifacts={build}\n'+oracle_run.stderr.decode(errors='replace'))
    wanted,trailing=records(expected,len(portable))
    if trailing:raise SystemExit('C oracle emitted trailing bytes')
    oracle=dict(zip((row[0] for row in portable),wanted))
    independent_errors=[{'case':n,'independent':e,'C':oracle[n]} for n,_,e,q in portable if e is not None and oracle[n]!=e]
    (build/'independent-c-differences.json').write_text(json.dumps(independent_errors,indent=2))
    if independent_errors:raise SystemExit('Independent C contracts failed: '+json.dumps(independent_errors[:30],ensure_ascii=True))
    command=[executable_path(a.silk),'build',str(build/'src/js_intl_auxiliary_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(a.stdlib.resolve()),'--optimization','speed','--debug','false']
    (build/'native-command.json').write_text(json.dumps(command));process(command,a.timeout,owner='Actual Engine auxiliary Intl compilation')
    execution=subprocess.run([str(build/'native')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=a.timeout)
    (build/'actual.bin').write_bytes(execution.stdout);(build/'native.stderr').write_bytes(execution.stderr)
    if execution.returncode:raise SystemExit(f'Native Engine exit {execution.returncode}; output={len(execution.stdout)} bytes; artifacts={build}\n'+execution.stderr.decode(errors='replace'))
    actual,trailer=records(execution.stdout,len(selected));differences=[]
    for (name,_,contract,is_portable),value in zip(selected,actual):
        if contract is not None and value!=contract:differences.append({'case':name,'independent':contract,'native':value})
        if is_portable and value!=oracle[name]:differences.append({'case':name,'C':oracle[name],'native':value})
    (build/'differences.json').write_text(json.dumps(differences,ensure_ascii=True,indent=2))
    if differences:raise SystemExit(f'{len(differences)} auxiliary differences: '+json.dumps(differences[:30],ensure_ascii=True))
    if len(trailer)!=12:raise SystemExit(f'Expected complete allocation trailer, got {len(trailer)} bytes')
    operations,attempts,injected=struct.unpack('<III',trailer)
    if not a.skip_faults and (operations!=len(FAULTS)+1 or injected==0 or attempts!=injected+operations):raise SystemExit(f'Incomplete fault sweeps {(operations,attempts,injected)}')
    report={'cases':len(selected),'portable':len(portable),'independent':sum(e is not None for _,_,e,_ in selected),'nativeOnly':len(selected)-len(portable),'faultOperations':operations,'faultAttempts':attempts,'injected':injected,'zeroLedgers':True,'sha256':hashlib.sha256(expected).hexdigest()}
    if a.source_defects:
        from intl_display_plural_cases import DEFECTS
        from intl_list_cases import DEFECTS as LIST_DEFECTS
        probes=list(DEFECTS)+list(LIST_DEFECTS)+[
            ('relative-polish-float-cast-overflow','new Intl.RelativeTimeFormat("pl").format(2147483648,"year")'),
            ('duration-fraction-signed-overflow','new Intl.DurationFormat("en",{microseconds:"short",nanoseconds:"numeric"}).format({microseconds:2**72})'),
        ]
        rows=[(n,'JSON.stringify('+s+')',None,False) for n,s in probes]
        (build/'source-defects.c').write_text(c_source(rows))
        command=base+['-O1','-g','-fno-wrapv','-fsanitize=address,undefined,float-cast-overflow','-fno-omit-frame-pointer',str(build/'source-defects.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'source-defects')]
        (build/'source-defects-command.json').write_text(json.dumps(command));process(command,a.timeout,owner='Separate C source-defect sanitizer compilation')
        report['sourceDefects']=[]
        for i,(name,source) in enumerate(probes):
            probe=subprocess.run([str(build/'source-defects'),str(i)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=a.timeout)
            (build/(name+'.stdout')).write_bytes(probe.stdout);(build/(name+'.stderr')).write_bytes(probe.stderr)
            report['sourceDefects'].append({'name':name,'source':source,'exit':probe.returncode,'asan':b'AddressSanitizer' in probe.stderr,'ubsan':b'runtime error:' in probe.stderr,'diagnostics':[line for line in probe.stderr.decode(errors='replace').splitlines() if 'runtime error:' in line]})
    (build/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2));print('Artifacts:',build)


if __name__=='__main__':main()
