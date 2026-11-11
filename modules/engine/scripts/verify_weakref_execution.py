#!/usr/bin/env python3
"""Exercise real JavaScript weak lifetimes, GC jobs, enqueue OOM and shutdown.

Pinned C is a separate oracle. Native fault ordinals 0 and 1 cover its two
allocation boundaries; C uses its single enqueue-allocation boundary for both.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

from verify_bound_functions import ALLOCATOR_SOURCE
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = ALLOCATOR_SOURCE.replace('fault_after=-1;faults++', 'fault_after=0;faults++') + r'''
static JSValue call_case(JSContext *ctx,JSValue fn,unsigned operation) {
 JSValue arg=JS_NewInt32(ctx,operation);
 return checked(JS_Call(ctx,fn,JS_UNDEFINED,1,&arg));
}
static void expect_one(JSContext *ctx,JSValue value,unsigned operation,unsigned phase) {
 int32_t number=0;
 if(!JS_IsNumber(value)||JS_ToInt32(ctx,&number,value)||number!=1) {
  fprintf(stderr,"weak behavioral assertion operation=%u phase=%u\n",operation,phase);abort();
 }
 JS_FreeValue(ctx,value);
}
static void phase(JSContext *ctx,JSValue fn,unsigned operation,unsigned stage) {
 expect_one(ctx,call_case(ctx,fn,stage),operation,stage);
}
static unsigned drain(JSRuntime *rt,unsigned expect_throw) {
 unsigned count=0,thrown=0;JSContext *ctx;
 while(JS_IsJobPending(rt)) {
  if(count>=3)abort();
  int status=JS_ExecutePendingJob(rt,&ctx);
  if(status==0)abort();
  if(status<0) {
   JSValue error=JS_GetException(ctx);int32_t number=0;
   if(!JS_IsNumber(error)||JS_ToInt32(ctx,&number,error)||number!=77)abort();
   JS_FreeValue(ctx,error);thrown++;
  }
  count++;
 }
 if(thrown!=expect_throw)abort();
 return count;
}
int main(int argc,char **argv) {
 if(argc!=3)return 64;
 unsigned operation=strtoul(argv[2],NULL,10);if(operation>18)return 64;
 FILE *f=fopen(argv[1],"rb");if(!f)abort();
 if(fseek(f,0,SEEK_END))abort();long size=ftell(f);if(size<0)abort();rewind(f);
 char *source=malloc((size_t)size+1);if(!source)abort();
 if(fread(source,1,size,f)!=(size_t)size)abort();fclose(f);source[size]=0;
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();
 JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 JSValue cases=checked(JS_Eval(ctx,source,size,"weak-cases.js",JS_EVAL_TYPE_GLOBAL));free(source);
 unsigned first=0,second=0,shutdown=0;
 if(operation<8) {
  expect_one(ctx,call_case(ctx,cases,operation),operation,0);
 } else if(operation<16) {
  JSValue scenario=call_case(ctx,cases,operation);
  phase(ctx,scenario,operation,0);JS_RunGC(rt);phase(ctx,scenario,operation,1);
  first=drain(rt,operation==12);phase(ctx,scenario,operation,2);
  JS_RunGC(rt);second=drain(rt,0);phase(ctx,scenario,operation,3);
  unsigned expected=operation==11?0:operation==14?1:2;
  if(operation==9) {if(first||second!=expected)abort();}
  else if(first!=expected||second)abort();
  JS_FreeValue(ctx,scenario);
 } else if(operation<18) {
  JSValue scenario=call_case(ctx,cases,8);phase(ctx,scenario,operation,0);
  JSValue saved=JS_GetException(ctx);JS_Throw(ctx,JS_NewInt32(ctx,313));
  fault_after=0;gc_remove_weak_objects(rt);fault_after=-1;
  JSValue error=JS_GetException(ctx);int32_t number=0;
  if(!JS_IsNumber(error)||JS_ToInt32(ctx,&number,error)||number!=313)abort();
  JS_FreeValue(ctx,error);JS_Throw(ctx,saved);
  if(faults!=2||JS_IsJobPending(rt))abort();
  gc_remove_weak_objects(rt);if(JS_IsJobPending(rt))abort();
  phase(ctx,scenario,operation,4);JS_FreeValue(ctx,scenario);
 } else {
  JSValue registry=call_case(ctx,cases,16);JS_FreeValue(ctx,registry);shutdown=1;
 }
 JS_FreeValue(ctx,cases);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 word(first);word(second);word(faults);word(shutdown);word(live_count);word(live_bytes);
 if(live_count||live_bytes)return 5;
 return 0;
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cflag', action='append', default=[])
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'build/weakref-execution')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    native = executable_path(str(args.native))
    cc = executable_path(args.cc)
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    oracle_source, oracle = work / 'oracle.c', work / 'oracle'
    oracle_source.write_text(C_SOURCE)
    process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
             '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="weak-execution"',
             *args.cflag, '-I', str(reference), str(oracle_source),
             *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(oracle)],
            600, owner='Independent weak-reference C oracle compilation')
    source = ROOT / 'scripts/weakref_intrinsics_execution_cases.js'
    expected = bytearray()
    actual = bytearray()
    for operation in range(19):
        c = process([str(oracle), str(source), str(operation)], 120,
                    owner=f'C weak execution operation={operation}')
        n = process([native, 'weak-case', str(source), str(operation)], 120,
                    owner=f'Native weak execution operation={operation}')
        if len(c) != 24 or len(n) != 24:
            raise SystemExit(f'weak operation={operation}: invalid record length C={len(c)} native={len(n)}')
        cr, nr = struct.unpack('<6I', c), struct.unpack('<6I', n)
        if cr != nr or nr[-2:] != (0, 0):
            raise SystemExit(f'weak operation={operation}: C={cr}, native={nr}')
        if operation in (16, 17) and nr[2] != 2:
            raise SystemExit(f'weak operation={operation}: both failed enqueues must be consumed')
        expected.extend(c)
        actual.extend(n)
    (work / 'expected.bin').write_bytes(expected)
    (work / 'actual.bin').write_bytes(actual)
    report = {'cases': 19, 'nativeEnqueueFaultBoundaries': 2, 'zeroLedgers': True,
              'pins': pins, 'sha256': hashlib.sha256(actual).hexdigest()}
    (work / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS real WeakRef/FinalizationRegistry execution:', json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
