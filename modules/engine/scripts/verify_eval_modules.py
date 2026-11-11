#!/usr/bin/env python3
"""Real Session scripts/modules and independent pinned-C allocation cutpoints.

The native entry is js_eval_module_fixture.silk, not engine_execution_driver.
Fixture inputs are extracted verbatim from the existing Silk consumers, written
under a private cwd, and loaded by each engine's production filesystem loader.
C defect rows/crashes remain separate evidence; they never excuse native failures.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile

from verify_async_execution import C_SOURCE as ASYNC_C
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_std import PIN as LIBC_PIN

ROOT = Path(__file__).resolve().parents[1]
LITERAL = r'b"(?:[^"\\]|\\.)*"'


def inputs():
    script = (ROOT / 'src/js_eval_execution_consumer.silk').read_text()
    module = (ROOT / 'src/js_module_execution_consumer.silk').read_text()
    integers = [(ast.literal_eval(source).decode(), int(expected)) for source, expected in
                re.findall(r'unsafe integer\(&mut hooks, memory, context, (' + LITERAL + r'), (\d+)\)', script)]
    fixtures = [(ast.literal_eval(name).decode(), ast.literal_eval(source)) for name, source in
                re.findall(r'if equal\(name, (' + LITERAL + r')\).*?some\((' + LITERAL + r')\)', module)]
    evaluations = [(ast.literal_eval(source).decode(), ast.literal_eval(name).decode()) for source, name in
                   re.findall(r'evaluation.evaluate\(&mut hooks, memory, context,\s*(' + LITERAL + r'),\s*(' + LITERAL + r')', module)]
    if len(fixtures) != 8 or len(evaluations) != 10 or len(integers) != 24:
        raise SystemExit(f'fixture inventory changed: scripts={len(integers)}, files={len(fixtures)}, modules={len(evaluations)}')
    return integers, fixtures, evaluations


C_PREFIX = ASYNC_C[:ASYNC_C.index('static unsigned drain')]
C_BODY = r'''
#include "quickjs-libc.h"
static unsigned defects;
static void require(int ok,const char*label){if(!ok){fprintf(stderr,"contract: %s\n",label);exit(4);}}
static JSValue eval(JSContext*c,const char*s,const char*n,int f){return JS_Eval(c,s,strlen(s),n,f);}
static void integer(JSContext*c,const char*s,int expected){JSValue v=eval(c,s,"eval-consumer.js",0);if(JS_IsException(v)){js_std_dump_error(c);require(0,s);}int32_t n=0;require(JS_IsNumber(v)&&!JS_ToInt32(c,&n,v)&&n==expected,s);JS_FreeValue(c,v);}
static int drain(JSContext*c){int ok=1;unsigned n=0;while(JS_IsJobPending(c->rt)){require(n++<1000,"finite jobs");JSContext*j=NULL;if(JS_ExecutePendingJob(c->rt,&j)<0){ok=0;clear_exception(j?j:c);}}return ok;}
static void promise(JSContext*c,JSValue p,int rejected,int n,int undef){require(!JS_IsException(p),"module/import evaluation");require(drain(c),"module/import jobs");require(JS_PromiseState(c,p)==(rejected?JS_PROMISE_REJECTED:JS_PROMISE_FULFILLED),"settled promise");JSValue v=JS_PromiseResult(c,p);int32_t actual=0;require(undef?JS_IsUndefined(v):(JS_IsNumber(v)&&!JS_ToInt32(c,&actual,v)&&actual==n),"promise result");JS_FreeValue(c,v);JS_FreeValue(c,p);}
static void scripts(JSContext*c){
/*SCRIPT_CASES*/
}
static void modules(JSContext*c){
integer(c,"globalThis.evalModuleLog='';globalThis.evalCycle='';0",0);
JSValue p=eval(c,EM0,EN0,JS_EVAL_TYPE_MODULE);require(JS_PromiseState(c,p)==JS_PROMISE_PENDING,"initial TLA pending");promise(c,p,0,0,1);
integer(c,"evalModuleResult===10&&evalModuleLog==='dbAr'?1:0",1);
promise(c,eval(c,EM1,EN1,1),0,0,1);integer(c,"evalCycle==='ba'&&evalCycleSum===3?1:0",1);
promise(c,eval(c,EM2,EN2,1),1,91,0);
JSValue bad=eval(c,EM3,EN3,JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY);require(JS_IsException(bad)&&JS_HasException(c),"broken dependency");clear_exception(c);
p=eval(c,EM4,EN4,0);integer(c,"evalImportEvents==='swt'?1:0",1);promise(c,p,0,42,0);integer(c,"evalImportEvents==='swtn'?1:0",1);
p=eval(c,EM5,EN5,0);integer(c,"evalOptionsTouched",0);promise(c,p,0,73,0);
promise(c,eval(c,EM6,EN6,0),0,1,0);promise(c,eval(c,EM7,EN7,0),0,1,0);promise(c,eval(c,EM8,EN8,0),0,1,0);promise(c,eval(c,EM9,EN9,0),0,42,0);
}
static int sample(JSContext*c,int mode,size_t cutoff){
 const char*s="(function(a){let x=2;return eval('()=>a+x')})(40)()";
 const char*n="eval/fault.js";int f=JS_EVAL_FLAG_COMPILE_ONLY;
 if(mode==4){s="import {answer} from './namespace.mjs';await 0;if(answer!==42)throw 17;";n="eval/fault.mjs";f=JS_EVAL_TYPE_MODULE;}
 if(mode==5)s="import('./namespace.mjs').then(ns=>ns.answer)";
 JSValue compiled=JS_UNDEFINED;if(mode==3||mode==5)compiled=checked(eval(c,s,n,JS_EVAL_FLAG_COMPILE_ONLY));
 JSStackFrame*before=c->rt->current_stack_frame;remaining=cutoff;armed=1;
 JSValue v=(mode==3||mode==5)?JS_EvalFunction(c,compiled):eval(c,s,n,f);
 int threw=JS_IsException(v),pending=JS_HasException(c);if(threw&&!pending)defects|=1;if(!threw&&pending)defects|=2;clear_exception(c);
 int jobs=drain(c);armed=0;
 int clean=!threw&&!pending&&jobs;
 if(mode>=4&&!threw){int state=JS_PromiseState(c,v);if(state==JS_PROMISE_PENDING)defects|=4;clean=clean&&state==JS_PROMISE_FULFILLED;if(mode==5&&state==JS_PROMISE_FULFILLED){JSValue r=JS_PromiseResult(c,v);clean=clean&&JS_IsNumber(r)&&number(r)==42;JS_FreeValue(c,r);}}
 if(mode==3&&!threw)clean=clean&&JS_IsNumber(v)&&number(v)==42;
 JS_FreeValue(c,v);clear_exception(c);if(c->rt->current_stack_frame!=before)defects|=8;
 integer(c,"(function(x){return eval('x+1')})(41)",42);
 return clean;
}
int main(int argc,char**argv){
 require(argc==3,"MODE CUTOFF");int mode=atoi(argv[1]);JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);require(rt!=NULL,"runtime");js_std_init_handlers(rt);JSContext*c=JS_NewContext(rt);require(c!=NULL,"context");JS_SetModuleLoaderFunc2(rt,NULL,js_module_loader,js_module_check_attributes,NULL);
 int clean=1;if(mode==0)scripts(c);else if(mode==1)modules(c);else clean=sample(c,mode,strtoull(argv[2],NULL,10));
 clear_exception(c);js_std_free_handlers(rt);JS_FreeContext(c);JS_FreeRuntime(rt);
 word(clean);word(fault_count);word(live_bytes);word(live_count);word(0);word(0);word(defects);return 0;
}
'''


def oracle_source(integers, evaluations):
    checks = []
    compiled = False
    for source, expected in integers:
        if source == '21*2':
            continue  # Keep the recovery assertion after the syntax-failure probe.
        # The existing consumer brackets execute-compiled with count=0/count=1.
        if source == 'globalThis.evalExecutionCount' and expected == 0:
            checks.append('JSValue compiled=checked(eval(c,"++globalThis.evalExecutionCount;77","compile-only.js",JS_EVAL_FLAG_COMPILE_ONLY));')
            compiled = True
        checks.append(f'integer(c,{json.dumps(source)},{expected});')
        if source == 'globalThis.evalExecutionCount' and expected == 0:
            checks.append('JSValue value=checked(JS_EvalFunction(c,compiled));require(JS_IsNumber(value)&&number(value)==77,"execute compiled");JS_FreeValue(c,value);')
    if not compiled:
        raise SystemExit('missing compile-only contract')
    checks.append('JSValue strict=checked(eval(c,"try{evalStrictFlagMissing=1;0}catch(e){e instanceof ReferenceError?1:0}","strict-flag.js",JS_EVAL_FLAG_STRICT));require(number(strict)==1,"embedding strict flag");JS_FreeValue(c,strict);')
    checks.append('JSStackFrame*before=c->rt->current_stack_frame;JSValue bad=eval(c,"function broken( {","broken.js",JS_EVAL_FLAG_COMPILE_ONLY|JS_EVAL_FLAG_BACKTRACE_BARRIER);require(JS_IsException(bad),"syntax failure");clear_exception(c);require(c->rt->current_stack_frame==before,"frame restored");integer(c,"21*2",42);')
    definitions = '\n'.join(f'#define EM{i} {json.dumps(source)}\n#define EN{i} {json.dumps(name)}' for i, (source, name) in enumerate(evaluations))
    return C_PREFIX + definitions + '\n' + C_BODY.replace('/*SCRIPT_CASES*/', '\n'.join(checks))


def invoke(executable, mode, cutoff, cwd):
    command = [str(executable), str(mode), str(cutoff)]
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        return {'command': command, 'timeout': 120, 'stderr': (error.stderr or b'').decode(errors='replace')}, None
    evidence = {'command': command, 'exit': result.returncode, 'stderr': result.stderr.decode(errors='replace'), 'stdout_hex': result.stdout.hex()}
    count = 7 if Path(executable).name == 'oracle' else 6
    row = struct.unpack(f'<{count}I', result.stdout) if len(result.stdout) == count * 4 else None
    return evidence, row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', type=Path)
    parser.add_argument('--owner', action='append', choices=('C', 'native'), help='Diagnostic engine selection; default both')
    parser.add_argument('--mode', action='append', type=int, choices=range(6), help='Diagnostic mode selection; default all')
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cflag', action='append', default=[])
    parser.add_argument('--max-cutoff', type=int, default=8192)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--source-defects', required=True, type=Path)
    parser.add_argument('--skip-faults', action='store_true', help='Diagnostic baseline only, not acceptance')
    parser.add_argument('--persistent', choices=('enqueue', 'startup'), help='Native persistent-allocation failure regression')
    args = parser.parse_args()
    if args.max_cutoff < 1:
        parser.error('--max-cutoff must be positive')
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    libc_digest = hashlib.sha256((reference / 'quickjs-libc.c').read_bytes()).hexdigest()
    if libc_digest != LIBC_PIN:
        raise SystemExit(f'Wrong pinned quickjs-libc.c: expected={LIBC_PIN}, actual={libc_digest}')
    owners = args.owner or ['C', 'native']
    modes = args.mode or list(range(6))
    if ('native' in owners or args.persistent) and args.native is None:
        parser.error('--native is required for native execution')
    native = executable_path(str(args.native)) if args.native else None
    integers, fixtures, evaluations = inputs()
    report = {'pins': pins, 'script_integer_checks': len(integers), 'module_evaluations': len(evaluations), 'module_files': len(fixtures), 'runs': [], 'cutoffs': {}, 'verified': False}
    report['fixtures'] = {name: content.decode() for name, content in fixtures}
    report['owners'] = owners
    report['modes'] = modes
    report['source_defect_bits'] = {'1': 'throw without pending exception', '2': 'success with pending exception', '4': 'stranded pending Promise', '8': 'current frame not restored'}
    report['libc_sha256'] = libc_digest
    defects = []
    try:
        with tempfile.TemporaryDirectory(prefix='silkjs-eval-modules-') as temporary:
            cwd = Path(temporary)
            for name, content in fixtures:
                target = cwd / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            # Direct/indirect eval's <input> basename resolves in cwd, like C.
            (cwd / 'namespace.mjs').write_bytes(b'export const answer=42;')
            if args.persistent:
                mode = 6 if args.persistent == 'enqueue' else 7
                for cutoff in range(1 if mode == 6 else args.max_cutoff):
                    evidence, row = invoke(native, mode, cutoff, cwd)
                    report['runs'].append(evidence)
                    if evidence.get('exit') != 0 or row is None or row[0] != 1 or any(row[2:6]):
                        raise SystemExit(f'native persistent {args.persistent} failure at cutoff={cutoff}: {evidence}, row={row}')
                    if mode == 6 or not row[1]:
                        report['persistent'] = {'mode': args.persistent, 'attempts': cutoff + 1}
                        print(f'PASS native persistent {args.persistent} allocation recovery through cutoff={cutoff}')
                        return
                raise SystemExit('native persistent fault sweep exhausted; see report')
            source = cwd / 'oracle.c'
            source.write_text(oracle_source(integers, evaluations))
            args.source_defects.with_suffix('.oracle.c').write_text(source.read_text())
            oracle = cwd / 'oracle'
            if 'C' in owners:
                command = [executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="eval-module-acceptance"', *args.cflag, '-I', str(reference), str(source), str(reference / 'quickjs-libc.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-ldl', '-o', str(oracle)]
                report['oracle_build'] = command
                process(command, 600, owner='Eval/module independent C oracle compilation')
            transcript = bytearray()
            for owner, executable in [('C', oracle), ('native', native)]:
                if owner not in owners:
                    continue
                for mode in (0, 1):
                    if mode not in modes:
                        continue
                    evidence, row = invoke(executable, mode, 0, cwd)
                    report['runs'].append(dict(owner=owner, mode=mode, **evidence))
                    if evidence.get('exit') != 0 or row is None or row[:6] != (1, 0, 0, 0, 0, 0):
                        raise SystemExit(f'{owner} baseline mode={mode}: {evidence}, row={row}')
                    transcript.extend(struct.pack('<6I', *row[:6]))
            if not args.skip_faults:
                for owner, executable in [('native', native), ('C', oracle)]:
                    if owner not in owners:
                        continue
                    for mode in (2, 3, 4, 5):
                        if mode not in modes:
                            continue
                        injected = 0
                        for cutoff in range(args.max_cutoff):
                            evidence, row = invoke(executable, mode, cutoff, cwd)
                            broken = evidence.get('exit') != 0 or row is None or any(row[2:6]) or (owner == 'C' and row[6])
                            if broken:
                                record = dict(owner=owner, mode=mode, cutoff=cutoff, row=row, **evidence)
                                if owner == 'native':
                                    report['runs'].append(record)
                                    raise SystemExit(f'native allocation contract failed: {record}')
                                defects.append(record)
                            if row is not None and row[1] > 1:
                                raise SystemExit(f'non-single-shot allocator: {owner}/{mode}/{cutoff}: {row}')
                            if row is not None and not row[1]:
                                if broken or not injected or not row[0]:
                                    raise SystemExit(f'no clean non-injected success: {owner}/{mode}/{cutoff}: {row}')
                                report['cutoffs'][f'{owner}/{mode}'] = cutoff + 1
                                break
                            injected += 1
                        else:
                            raise SystemExit(f'sweep exhausted {owner}/{mode}: {args.max_cutoff}')
            report['sha256'] = hashlib.sha256(transcript).hexdigest()
            report['verified'] = not args.skip_faults and set(owners) == {'C', 'native'} and set(modes) == set(range(6))
            print(f'{"Native verified" if report["verified"] else "DIAGNOSTIC"} eval/modules: owners={owners}, modes={modes}, {len(integers)} script integer assertions, {len(evaluations)} module evaluations, {len(fixtures)} real files; cutoffs={report["cutoffs"]}; {len(defects)} independent C defects; SHA256={report["sha256"]}')
    finally:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    if defects:
        raise SystemExit(f'Pinned-C source defects retained separately: {args.source_defects}')


if __name__ == '__main__':
    main()
