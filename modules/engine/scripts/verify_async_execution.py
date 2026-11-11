#!/usr/bin/env python3
"""Actual-engine async/generator differential and independent allocation sweeps.

The native executable is the integrated engine launcher, not a JavaScript substitute:
  case SOURCE.js CASE       -> 40 little-endian u32 observations + bytes/blocks ledger
  fault SOURCE.js CASE N    -> js_async_execution_consumers.runFault's six u32 fields
Each command creates a fresh engine, evaluates SOURCE via consumers.prepare, then
uses runCase or runFault. The parent integration owns that launcher. Source defects
are recorded separately; neither timeouts nor an empty job queue imply fulfillment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/async_execution_cases.js'
CASES = range(29)
SWEEPS = (0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28)
FIELDS = (['success', 'jobs', 'pending_exception', 'log_length']
          + [f'initial_state_{i}' for i in range(4)]
          + [f'final_state_{i}' for i in range(4)]
          + [f'value_type_{i}' for i in range(4)]
          + [f'value_{i}' for i in range(4)]
          + [f'done_{i}' for i in range(4)]
          + [f'log_{i}' for i in range(16)])
# Independent visible results; these are not computed from either implementation.
EXPECTED = {
    0: ([22, 33, 0, 66], [0, 1, 1, 1], [100, 3, 11]),
    1: ([7, 0, 9, 8], [1, 1, 0, 1], []),
    2: ([11, 22, 77, 33], [0, 0, 0, 1], [8]),
    3: ([5, 0, 0, 0], [0, 1, 0, 0], [1]),
    4: ([11, 22, 33, 11], [0, 0, 0, 0], [1, 0, 3, 22, 2, 33, 44]),
    5: ([1, 11, 21, 22], [0, 0, 1, 0], []),
    6: ([55, 7, 0, 0], [0, 0, 0, 0], [1, 99]),
    7: ([41, 42, 43, 13], [0, 0, 0, 0], [1, 2, 3, 4]),
    8: ([33, 0, 0, 0], [0, 0, 0, 0], [1, 3, 2, 4]),
    9: ([77, 0, 0, 0], [0, 0, 0, 0], [66, 88]),
    10: ([22, 0, 0, 0], [0, 0, 0, 0], [1, 2, 3, 4]),
    11: ([14, 4, 15, 0], [0, 0, 0, 0], []),
    12: ([10, 20, 30, 0], [0, 0, 1, 1], [1, 2, 3]),
    13: ([11, 22, 77, 33], [0, 0, 0, 1], [8]),
    14: ([66, 77, 0, 0], [0, 1, 0, 0], []),
    15: ([7, 0, 0, 0], [1, 0, 0, 0], []),
    16: ([77, 0, 0, 0], [0, 0, 0, 0], [2]),
    17: ([1, 0, 2, 0], [0, 0, 0, 0], []),
    18: ([10, 0, 0, 0], [1, 1, 0, 0], []),
    19: ([11, 22, 0, 0], [0, 1, 0, 0], [1]),
    20: ([11, 22, 33, 0], [0, 0, 1, 0], [0]),
    21: ([77, 0, 0, 0], [0, 0, 0, 0], [1]),
    22: ([7, 1, 0, 0], [0, 1, 0, 0], []),
    23: ([0, 1, 0, 0], [0, 0, 0, 0], []),
    24: ([11, 22, 33, 11], [0, 0, 0, 0], [1, 0, 3, 22, 2, 33, 44]),
    25: ([1, 0, 0, 0], [0, 0, 0, 0], [7]),
    26: ([0, 0, 0, 0], [0, 0, 0, 0], []),
    27: ([0, 0, 0, 0], [0, 0, 0, 0], []),
    28: ([7, 0, 0, 0], [1, 0, 0, 0], [1, 2, 3]),
}
SOURCE_PENDING = {15: (2, 1, 1, 0), 16: (3, 1, 0, 0), 18: (2, 2, 1, 1), 28: (2, 1, 0, 0)}
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes,remaining,fault_count;static int armed;
static int fault(void){if(!armed)return 0;if(!remaining){armed=0;fault_count++;return 1;}remaining--;return 0;}
static void *allocate(JSMallocState*s,size_t n){if(!n||fault())return NULL;Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void release(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *resize(JSMallocState*s,void*p,size_t n){if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fault())return NULL;Header*h=(Header*)p-1;size_t old=h->size;Header*r=realloc(h,sizeof(*h)+n);if(!r)return NULL;r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;}
static size_t usable(const void*p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static void clear_exception(JSContext*ctx){if(JS_HasException(ctx)){JSValue e=JS_GetException(ctx);JS_FreeValue(ctx,e);}}
static unsigned number(JSValue v){if(JS_IsNumber(v))return (unsigned)(JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v));return JS_IsBool(v)?JS_VALUE_GET_BOOL(v):0;}
static unsigned drain(JSContext*ctx){unsigned count=0;while(JS_IsJobPending(ctx->rt)){if(count++>=10000)abort();JSContext*jobctx=NULL;int r=JS_ExecutePendingJob(ctx->rt,&jobctx);if(r<0)clear_exception(ctx);JS_RunGC(ctx->rt);}return count;}
static void observe(JSContext*ctx,JSValue value,uint32_t*rec,int index){
 if(JS_IsNumber(value)){rec[12+index]=2;rec[16+index]=number(value);return;}
 if(JS_IsException(value)){rec[12+index]=5;return;}
 if(JS_IsObject(value)){JSValue done=checked(JS_GetProperty(ctx,value,JS_ATOM_done));int is_result=JS_IsBool(done);rec[20+index]=number(done);JS_FreeValue(ctx,done);
  if(is_result){rec[12+index]=3;JSValue inner=checked(JS_GetProperty(ctx,value,JS_ATOM_value));rec[16+index]=number(inner);JS_FreeValue(ctx,inner);}else rec[12+index]=4;return;}
 if(JS_IsBool(value)){rec[12+index]=1;rec[16+index]=number(value);}
}
static void snapshot(JSContext*ctx,JSValue output,uint32_t*rec){
 rec[0]=1;for(int i=0;i<4;i++){JSValue value=checked(JS_GetPropertyUint32(ctx,output,i));rec[4+i]=JS_PromiseState(ctx,value)+1;JS_FreeValue(ctx,value);}
 JS_RunGC(ctx->rt);rec[1]=drain(ctx);
 for(int i=0;i<4;i++){JSValue value=checked(JS_GetPropertyUint32(ctx,output,i));int state=JS_PromiseState(ctx,value);rec[8+i]=state+1;JSValue result=state<0?JS_DupValue(ctx,value):JS_PromiseResult(ctx,value);observe(ctx,result,rec,i);JS_FreeValue(ctx,result);JS_FreeValue(ctx,value);}
 JSValue log=checked(JS_GetPropertyUint32(ctx,output,4));JSValue length=checked(JS_GetProperty(ctx,log,JS_ATOM_length));rec[3]=number(length);JS_FreeValue(ctx,length);if(rec[3]>16)abort();
 for(unsigned i=0;i<rec[3];i++){JSValue value=checked(JS_GetPropertyUint32(ctx,log,i));rec[24+i]=number(value);JS_FreeValue(ctx,value);}JS_FreeValue(ctx,log);
 if(JS_HasException(ctx)){rec[2]=1;clear_exception(ctx);}
}
static char*load(const char*path,size_t*length){FILE*f=fopen(path,"rb");if(!f)abort();if(fseek(f,0,SEEK_END))abort();long n=ftell(f);if(n<0||fseek(f,0,SEEK_SET))abort();char*s=malloc(n+1);if(!s||fread(s,1,n,f)!=(size_t)n)abort();s[n]=0;fclose(f);*length=n;return s;}
int main(int argc,char**argv){
 if(argc<4)abort();int is_foreign=!strcmp(argv[1],"foreign-case")||!strcmp(argv[1],"foreign-fault");int is_fault=!strcmp(argv[1],"fault")||!strcmp(argv[1],"foreign-fault");if(is_fault&&argc!=5)abort();
 size_t length;char*source=load(argv[2],&length);JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 JSValue function=checked(JS_Eval(ctx,source,length,"async_execution_cases.js",JS_EVAL_TYPE_GLOBAL));free(source);
 JSValue extra=JS_UNDEFINED;
 if(is_foreign){JSContext*other=JS_NewContext(rt);if(!other)abort();const char*setup="globalThis.foreignConstructor=function ForeignDateTarget(){};foreignConstructor.prototype=null;globalThis.foreignDatePrototype=Date.prototype;globalThis";extra=checked(JS_Eval(other,setup,strlen(setup),"<foreign>",JS_EVAL_TYPE_GLOBAL));JS_FreeContext(other);}
 JSValue arguments[2]={JS_NewInt32(ctx,atoi(argv[3])),extra};uint32_t rec[40]={0};
 if(is_fault){remaining=strtoull(argv[4],NULL,10);armed=1;}
 JSValue output=JS_Call(ctx,function,JS_UNDEFINED,is_foreign?2:1,arguments);
 if(is_fault){if(JS_IsException(output)&&!JS_HasException(ctx))abort();rec[2]=drain(ctx);armed=0;rec[0]=fault_count;rec[1]=JS_IsException(output);rec[3]=remaining;}
 else {if(JS_IsException(output)){JSValue e=JS_GetException(ctx);const char*message=JS_ToCString(ctx,e);fprintf(stderr,"uncaught scenario exception: %s\n",message?message:"<unprintable>");JS_FreeCString(ctx,message);JS_FreeValue(ctx,e);abort();}snapshot(ctx,output,rec);}
 JS_FreeValue(ctx,output);JS_FreeValue(ctx,function);JS_FreeValue(ctx,extra);clear_exception(ctx);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(is_fault){rec[4]=live_bytes;rec[5]=live_count;for(int i=0;i<6;i++)word(rec[i]);}
 else {for(int i=0;i<40;i++)word(rec[i]);word(live_bytes);word(live_count);}
 return 0;
}
'''


def words(data, count, owner):
    if len(data) != count * 4:
        raise SystemExit(f'{owner}: expected {count * 4} bytes, received {len(data)}')
    return struct.unpack(f'<{count}I', data)


def assert_behavior(case, record, owner):
    values, done, log = EXPECTED[case]
    if record[0] != 1 or record[2] or list(record[16:20]) != values or list(record[20:24]) != done:
        raise SystemExit(f'{owner} case {case}: independent result oracle failed: {record}')
    if record[3] != len(log) or list(record[24:24 + len(log)]) != log:
        raise SystemExit(f'{owner} case {case}: independent ordering oracle failed: {record}')
    if case in SOURCE_PENDING and tuple(record[8:12]) != SOURCE_PENDING[case]:
        raise SystemExit(f'{owner} case {case}: pinned-source pending-state observation changed: {record[8:12]}')


def run(command, owner):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise SystemExit(f'{owner}: exit {result.returncode}\n{result.stderr.decode(errors="replace")}')
    return result.stdout


def sweep(executable, case, max_cutoff, source, defects):
    failed = 0
    for cutoff in range(max_cutoff):
        command = [str(executable), 'fault', str(SOURCE), str(case), str(cutoff)]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            if not source:
                raise SystemExit(f'native fault case={case} cutoff={cutoff}: exit={result.returncode}\n{result.stderr.decode(errors="replace")}')
            defects.append({'case': case, 'cutoff': cutoff, 'exit': result.returncode,
                            'stderr': result.stderr.decode(errors='replace')})
            failed += 1
            continue
        row = words(result.stdout, 6, f'{"C" if source else "native"} fault {case}/{cutoff}')
        if row[4] or row[5]:
            if not source:
                raise SystemExit(f'native fault case={case} cutoff={cutoff}: nonzero ledger {row}')
            defects.append({'case': case, 'cutoff': cutoff, 'ledger_bytes': row[4], 'ledger_blocks': row[5]})
        if row[0] > 1:
            raise SystemExit(f'fault injector is not single-shot: {row}')
        if row[0]:
            failed += 1
        else:
            if not failed or row[1]:
                raise SystemExit(f'fault sweep lacks independent failure/success coverage: {case}, {row}')
            return cutoff + 1
    raise SystemExit(f'fault sweep never reached a non-injected successful run: case={case}, max={max_cutoff}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', required=True, type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--max-cutoff', type=int, default=2048)
    parser.add_argument('--source-defects', required=True, type=Path,
                        help='write measured C crashes/leaks; any such defect makes this run non-passing')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    native, cc = executable_path(str(args.native)), executable_path(args.cc)
    defects = []
    transcript = bytearray()
    with tempfile.TemporaryDirectory(prefix='silkjs-async-execution-') as directory:
        temp = Path(directory)
        (temp / 'oracle.c').write_text(C_SOURCE)
        oracle = temp / 'oracle'
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(oracle)],
                600, owner='Async execution C consumer compilation')
        for case in CASES:
            expected_bytes = run([str(oracle), 'case', str(SOURCE), str(case)], f'C case {case}')
            actual_bytes = run([native, 'case', str(SOURCE), str(case)], f'native case {case}')
            expected = words(expected_bytes, 42, f'C case {case}')
            actual = words(actual_bytes, 42, f'native case {case}')
            if expected[-2:] != (0, 0) or actual[-2:] != (0, 0):
                raise SystemExit(f'behavior ledger case={case}: C={expected[-2:]} native={actual[-2:]}')
            assert_behavior(case, expected, 'C')
            assert_behavior(case, actual, 'native')
            for field, (left, right) in enumerate(zip(expected[:40], actual[:40])):
                if left != right:
                    raise SystemExit(f'case={case} {FIELDS[field]} C={left} native={right}')
            transcript.extend(actual_bytes)
            if case in SOURCE_PENDING:
                print(f'MEASURED pinned source queue defect case={case}: final states={actual[8:12]} (0 non-Promise, 1 pending, 2 fulfilled, 3 rejected)')
        native_cutoffs = source_cutoffs = 0
        for case in SWEEPS:
            # Separate fresh-runtime sweeps; allocation ordinals never cross engines.
            native_cutoffs += sweep(native, case, args.max_cutoff, False, defects)
            source_cutoffs += sweep(oracle, case, args.max_cutoff, True, defects)
    args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    status = 'PASS' if not defects else 'Native verified; pinned C defects'
    print(f'{status} async execution: {len(CASES)} actual-engine behavioral scenarios; {len(SWEEPS)} independent sweeps '
          f'({native_cutoffs} native, {source_cutoffs} C cutoffs); zero native ledgers; {len(defects)} C fault defects; {pins} pinned files; '
          f'SHA256={hashlib.sha256(transcript).hexdigest()}')
    if defects:
        raise SystemExit(f'Native behavior/zero-ledger sweeps completed, but measured {len(defects)} C fault defects; see {args.source_defects}. No source orphan recovery or semantics repair was applied.')


if __name__ == '__main__':
    main()
