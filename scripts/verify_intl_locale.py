#!/usr/bin/env python3
"""Run actual native Engine JS against pinned C Intl.Locale/common operations.

C is a separate oracle executable, never a production binding. Covers every
likely-subtag/calendar/time/week/script/timezone table key, public descriptors,
brands, coercion and poisoned proxy/getter ordering. Faults inject one failed
allocation at every call allocation ordinal, tearing down each real realm and
requiring exact zero ownership/byte ledgers. Class-specific formatter/collator
callbacks are intentionally excluded; this is not JS_AddIntrinsicIntl coverage.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
from intl_locale_cases import cases, utilities, FAULTS
from verify_bytecode import executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
INTL = 'intl locale locale-data numberformat collator datetimeformat pluralrules listformat relativetimeformat displaynames segmenter durationformat'.split()
TEMPORAL = 'temporal instant duration plaintime now plaindate plaindatetime plainyearmonth plainmonthday zoneddatetime calendar timezone tzdata_generated'.split()


def literal(source):
    return 'b"' + ''.join(chr(b) if 32 <= b < 127 and b not in (34, 92) else '\\x%02x' % b for b in source.encode()) + '"'


def generated(selected, utility_cases, faults):
    functions = ['pub const COUNT: usize = '+str(len(selected)),
                 'pub const FAULT_COUNT: usize = '+str(len(FAULTS)),
                 'pub const UTILITY_COUNT: usize = '+str(len(utility_cases)),
                 'pub const FAULTS: bool = '+str(faults).lower()]
    functions.append('pub fn utilityKind(index: usize) -> u32 { return match index {' + ' '.join(str(i)+' => '+str(kind) for i,(_,kind,_) in enumerate(utility_cases)) + ' _ => Intrinsic.trap("invalid utility") } }')
    for name, values in [('source', [source for _,source in selected]), ('faultSource', FAULTS), ('utilitySource',[source for _,_,source in utility_cases])]:
        functions.append('pub fn '+name+'(index: usize) -> &\'static [u8] { return match index {')
        functions += [str(i)+' => '+literal(source) for i,source in enumerate(values)]
        functions.append('_ => Intrinsic.trap("invalid Intl fixture case") } }')
    return '\n'.join(functions)+'\n'


def c_source(selected, utility_cases):
    inputs=',\n'.join(json.dumps(source,ensure_ascii=True) for _,source in selected)
    utility_inputs=',\n'.join('{'+str(kind)+','+json.dumps(source,ensure_ascii=True)+'}' for _,kind,source in utility_cases)
    return r'''#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern JSValue js_intl_supportedLocalesOf(JSContext *, JSValueConst, int, JSValueConst *);
extern int js_intl_get_number_option(JSContext *,JSValueConst,const char *,int *,int,int);
extern int js_intl_get_string_option(JSContext *,JSValueConst,const char *,const char **,int,int);
extern int js_intl_options_has_date_fields(JSContext *,JSValueConst);
extern int js_intl_options_has_time_fields(JSContext *,JSValueConst);
extern JSValue js_intl_get_options_object(JSContext *,JSValueConst);
extern char *js_intl_extract_locale(JSContext *,int,JSValueConst *);
extern int js_canonicalizeLocaleList_first(JSContext *,JSValueConst,char **);
static const struct {int kind;const char *source;} utilities[] = { UTILITIES };
static const char *inputs[] = { INPUTS };
static void word(unsigned n){for(int i=0;i<4;i++)putchar((n>>(i*8))&255);}
int main(void){
 JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt);
 if(!ctx || JS_AddIntrinsicIntl(ctx)<0)return 2;
 JSValue global=JS_GetGlobalObject(ctx);
 JS_SetPropertyStr(ctx,global,"__supportedLocalesOf",JS_NewCFunction(ctx,js_intl_supportedLocalesOf,"__supportedLocalesOf",1));
 JS_FreeValue(ctx,global);
 for(unsigned i=0;i<sizeof(inputs)/sizeof(inputs[0]);i++){
   JSValue v=JS_Eval(ctx,inputs[i],strlen(inputs[i]),"intl-locale-case.js",JS_EVAL_TYPE_GLOBAL);
   if(JS_IsException(v)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);fprintf(stderr,"case %u: %s\n",i,s?s:"exception");return 3;}
   size_t n;const char *s=JS_ToCStringLen(ctx,&n,v);if(!s)return 4;
   word(n);fwrite(s,1,n,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,v);
 }
 for(unsigned i=0;i<sizeof(utilities)/sizeof(utilities[0]);i++){
   int kind=utilities[i].kind, failed=0; const char *src=utilities[i].source;
   JSValue input=JS_Eval(ctx,src,strlen(src),"intl-utility-case.js",0),output;
   if(JS_IsException(input))return 5;
   if(kind==0){int number=0,status=js_intl_get_number_option(ctx,input,"value",&number,2,6);failed=status<0;output=status>0?JS_NewInt32(ctx,number):JS_UNDEFINED;}
   else if(kind==1){const char *valid[]={"lookup","best fit"};int n=js_intl_get_string_option(ctx,input,"value",valid,2,1);failed=n<0;output=JS_NewInt32(ctx,n);}
   else if(kind==2||kind==3){int n=kind==2?js_intl_options_has_date_fields(ctx,input):js_intl_options_has_time_fields(ctx,input);failed=n<0;output=JS_NewBool(ctx,n);}
   else if(kind==5){char *s=js_intl_extract_locale(ctx,1,&input);failed=s==NULL;output=s?JS_NewString(ctx,s):JS_UNDEFINED;js_free(ctx,s);}
   else if(kind==6){char *s=NULL;failed=js_canonicalizeLocaleList_first(ctx,input,&s)<0;output=s?JS_NewString(ctx,s):JS_UNDEFINED;js_free(ctx,s);}
   else {output=js_intl_get_options_object(ctx,input);failed=JS_IsException(output);}
   JS_FreeValue(ctx,input);
   if(failed){JS_FreeValue(ctx,output);JSValue error=JS_GetException(ctx);output=JS_GetPropertyStr(ctx,error,"name");JS_FreeValue(ctx,error);}
   global=JS_GetGlobalObject(ctx);JS_SetPropertyStr(ctx,global,"__utilityResult",output);JS_SetPropertyStr(ctx,global,"__utilityError",JS_NewBool(ctx,failed));JS_FreeValue(ctx,global);
   const char *result=kind==4?"JSON.stringify([__utilityError,__utilityError?__utilityResult:[__utilityResult===__utilityInput,Object.getPrototypeOf(__utilityResult)===null],__log])":"JSON.stringify([__utilityError,__utilityResult,__log])";
   JSValue v=JS_Eval(ctx,result,strlen(result),"intl-utility-result.js",0);if(JS_IsException(v))return 6;
   size_t n;const char *s=JS_ToCStringLen(ctx,&n,v);if(!s)return 7;word(n);fwrite(s,1,n,stdout);JS_FreeCString(ctx,s);JS_FreeValue(ctx,v);
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''.replace('INPUTS',inputs).replace('UTILITIES',utility_inputs)


def records(data, count):
    result=[];at=0
    for i in range(count):
        if at+4>len(data): raise ValueError(f'missing record {i}; consumed {at}/{len(data)} bytes')
        size=struct.unpack_from('<I',data,at)[0];at+=4
        if at+size>len(data): raise ValueError(f'truncated record {i}')
        result.append(json.loads(data[at:at+size]));at+=size
    return result,data[at:]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream',type=Path,required=True)
    parser.add_argument('--silk',default=str(ROOT/'build/toolchain-main-dd2e99ab/silk-fixed4'))
    parser.add_argument('--stdlib',type=Path,default=ROOT/'build/toolchain-main-dd2e99ab/stdlib')
    parser.add_argument('--cc',default='/opt/homebrew/opt/llvm/bin/clang')
    parser.add_argument('--cflag',action='append',default=[])
    parser.add_argument('--timeout',type=int,default=1800)
    parser.add_argument('--build-dir',type=Path,default=ROOT/'build/intl-locale-differential')
    parser.add_argument('--case',help='Select case names by substring, retaining the independent C oracle')
    parser.add_argument('--skip-faults',action='store_true',help='Diagnostic only; default acceptance includes allocation sweeps')
    args=parser.parse_args()
    reference=args.upstream.resolve();validate_pins(reference)
    selected=cases(reference); utility_cases=utilities()
    if args.case:
        selected=[item for item in selected if args.case in item[0]]
        utility_cases=[item for item in utility_cases if args.case in item[0]]
    if not selected and not utility_cases: raise SystemExit('No cases selected')
    labels=[name for name,_ in selected]+[name for name,_,_ in utility_cases]
    build=args.build_dir.resolve();build.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'src',build/'src',dirs_exist_ok=True)
    (build/'src/js_intl_locale_cases_generated.silk').write_text(generated(selected,utility_cases,not args.skip_faults))
    shutil.copyfile(ROOT/'silk.toml',build/'silk.toml')
    (build/'oracle.c').write_text(c_source(selected,utility_cases))
    (build/'cases.json').write_text(json.dumps(labels,indent=2))
    support=[reference/name for name in ['quickjs.c','cutils.c','dtoa.c','libregexp.c','libunicode.c']]
    support += [reference/'intl'/(name+'.c') for name in INTL]
    support += [reference/'temporal'/(name+'.c') for name in TEMPORAL]
    command=[executable_path(args.cc),'-std=gnu11','-O2','-fwrapv','-funsigned-char','-U__SIZEOF_INT128__','-D_GNU_SOURCE','-D__SANITIZE_ADDRESS__','-DCONFIG_TEMPORAL_INTL','-DCONFIG_VERSION="2026-06-04"',*args.cflag,'-I',str(reference),str(build/'oracle.c'),*map(str,support),'-lm','-lpthread','-o',str(build/'oracle')]
    process(command,args.timeout,owner='Pinned full Intl C oracle compilation')
    expected=process([str(build/'oracle')],args.timeout,owner='Pinned Intl.Locale/common JS execution')
    (build/'expected.bin').write_bytes(expected)
    command=[executable_path(args.silk),'build',str(build/'src/js_intl_locale_fixture.silk'),'-o',str(build/'native'),'--stdlib',str(args.stdlib.resolve()),'--optimization','speed','--debug','false']
    process(command,args.timeout,owner='Actual native Engine Intl.Locale compilation')
    execution=subprocess.run([str(build/'native')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=args.timeout)
    (build/'actual.bin').write_bytes(execution.stdout)
    if execution.returncode:
        raise SystemExit(f'Native Engine exit {execution.returncode}; output={len(execution.stdout)} bytes; artifacts={build}\n'+execution.stderr.decode(errors='replace'))
    wanted,remaining=records(expected,len(labels))
    if remaining: raise SystemExit('C oracle emitted unexpected trailing bytes')
    actual,trailer=records(execution.stdout,len(labels))
    differences=[]
    for name,a,b in zip(labels,actual,wanted):
        if a!=b: differences.append(f'{name}\n  C: {json.dumps(b,ensure_ascii=False)[:1800]}\n  native: {json.dumps(a,ensure_ascii=False)[:1800]}')
    if differences: raise SystemExit(f'{len(differences)} Intl mismatches:\n'+'\n'.join(differences[:30]))
    if len(trailer)!=12: raise SystemExit(f'Expected complete fault trailer, got {len(trailer)} bytes')
    fault_cases,attempts,injected=struct.unpack('<III',trailer)
    if not args.skip_faults and (fault_cases!=len(FAULTS)+len(utility_cases)+1 or injected==0 or attempts!=injected+fault_cases):
        raise SystemExit(f'Incomplete fault sweep: {(fault_cases,attempts,injected)}')
    print(f'Intl.Locale/common: {len(labels)} actual Engine JS cases match pinned C; sha256={hashlib.sha256(expected).hexdigest()}')
    print(f'Allocation sweeps: {fault_cases} operations, {attempts} attempts, {injected} injected failures; zero live allocations/bytes after every realm teardown')
    print(f'Artifacts: {build}')

if __name__=='__main__':main()
