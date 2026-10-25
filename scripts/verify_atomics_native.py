#!/usr/bin/env python3
"""Native Atomics vs separately compiled, pinned unchanged QuickJS CONFIG_ATOMICS.

The native consumer uses real buffer owners, reentrant callbacks, SDK atomics and
POSIX OS threads. C is an oracle executable only; it is never linked into Silk.
Independent allocation fault ordinals are not compared across representations.
Every completed fault case must release all allocations, even on exceptions.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE

ROOT = Path(__file__).resolve().parents[1]
CASES = [(shared, kind, method) for shared in (0, 1) for kind in range(8) for method in range(9)]
CASES += [(scenario, kind, 0) for scenario in (2, 3) for kind in range(8)]
CASES += [(scenario, 0, 0) for scenario in range(4, 16)]
CASES += [(16, kind, 0) for kind in range(13)]
CASES += [(17, kind, 0) for kind in range(11)]
CASES += [(18, kind, 0) for kind in range(6)] + [(19, 0, 0)]
CASES += [(13, 6, 0), (14, 6, 0), (20, 0, 0), (21, 0, 0)]
FAULT_CASES = [(0, 7, 7), (1, 7, 0), (3, 7, 0), (4, 0, 0), (5, 0, 0),
               (6, 0, 0), (7, 0, 0), (8, 0, 0), (12, 0, 0), (13, 0, 0),
               (14, 0, 0), (16, 7, 0), (19, 0, 0), (20, 0, 0), (21, 0, 0)]
FIELDS = ('success', 'error_kind', 'result_kind', 'low', 'high', 'byte_digest',
          'callbacks', 'pending', 'faults', 'detached', 'byte_length', 'count',
          'final_allocations', 'final_bytes')
C_SOURCE = ALLOCATOR_SOURCE + r'''
_Static_assert(sizeof(pthread_mutex_t)<=64 && _Alignof(pthread_mutex_t)<=8,"Silk mutex ABI envelope");
_Static_assert(sizeof(pthread_cond_t)<=64 && _Alignof(pthread_cond_t)<=8,"Silk condition ABI envelope");
_Static_assert(sizeof(struct timespec)==16 && sizeof(time_t)==8,"Silk clock ABI envelope");
_Static_assert(CLOCK_REALTIME==0,"Silk realtime clock selector");
static JSValue buffer,object,callback_value,callback_big_value;
static unsigned scenario,kind,calls;
static unsigned error_kind(JSContext *ctx,JSValue e){
 if(!JS_IsObject(e)||JS_VALUE_GET_OBJ(e)->class_id!=JS_CLASS_ERROR)return 99;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 calls++;
 if(scenario==4||scenario==6||scenario==8||scenario==20||scenario==21)JS_DetachArrayBuffer(ctx,buffer);
 if(scenario==5||scenario==7||scenario==9||scenario==19){
  JSValue size=JS_NewInt32(ctx,scenario==19?128:6);
  JSValue r=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);
  if(JS_IsException(r))return r;JS_FreeValue(ctx,r);
 }
 if(scenario==20)return JS_NewBigInt64(ctx,7);
 if(scenario==21)return JS_DupValue(ctx,callback_big_value);
 return JS_NewInt32(ctx,scenario==19?16:7);
}
static JSValue pause_input(JSContext *ctx,unsigned k){
 switch(k){case 0:return JS_UNDEFINED;case 1:return JS_NewInt32(ctx,-1);
 case 2:return __JS_NewFloat64(ctx,-0.0);case 3:return __JS_NewFloat64(ctx,1.5);
 case 4:return __JS_NewFloat64(ctx,NAN);case 5:return __JS_NewFloat64(ctx,INFINITY);
 case 6:return JS_TRUE;case 7:return callback_value;case 9:return JS_NewInt32(ctx,123);
 case 10:return __JS_NewFloat64(ctx,3.0);case 11:return __JS_NewFloat64(ctx,-3.0);
 case 12:return __JS_NewFloat64(ctx,1.0e100);default:return JS_NewBigInt64(ctx,0);}
}
static JSValue lock_input(JSContext *ctx,unsigned k){
 static int sizes[]={-1,0,1,2,4,8,3};if(k<7)return JS_NewInt32(ctx,sizes[k]);
 if(k==7)return __JS_NewFloat64(ctx,1.9);if(k==8)return __JS_NewFloat64(ctx,INFINITY);
 if(k==9)return __JS_NewFloat64(ctx,NAN);return callback_value;
}
static JSValue invoke(JSContext *ctx,unsigned method,JSValue *args){
 if(method<8)return js_atomics_op(ctx,JS_UNDEFINED,4,args,method);
 switch(method){case 8:return js_atomics_store(ctx,JS_UNDEFINED,4,args);
 case 9:return js_atomics_isLockFree(ctx,JS_UNDEFINED,4,args);
 case 10:return js_atomics_pause(ctx,JS_UNDEFINED,4,args);
 case 11:return js_atomics_wait(ctx,JS_UNDEFINED,4,args);
 case 12:return js_atomics_notify(ctx,JS_UNDEFINED,4,args);default:abort();}
}
static void isolated(unsigned s,unsigned k,unsigned m,int armed,size_t cutoff){
 scenario=s;kind=k;calls=0;uint32_t rec[14]={0};
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();
 JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 int shared=s==1||(s>=12&&s<=15);uint64_t max=128;
 buffer=checked(js_array_buffer_constructor2(ctx,JS_UNDEFINED,64,&max,shared?JS_CLASS_SHARED_ARRAY_BUFFER:JS_CLASS_ARRAY_BUFFER));
 int class_id=JS_CLASS_INT8_ARRAY+k;if(s>=4)class_id=JS_CLASS_INT32_ARRAY;
 if(((s==13||s==14)&&k==6)||s==20||s==21)class_id=JS_CLASS_BIG_INT64_ARRAY;
 if(s==18){if(k==0)class_id=JS_CLASS_UINT8C_ARRAY;else if(k<4)class_id=JS_CLASS_FLOAT16_ARRAY+k-1;
  else if(k==4)class_id=JS_CLASS_UINT32_ARRAY;else class_id=JS_CLASS_BIG_UINT64_ARRAY;}
 JSValue ctor[]={buffer,JS_NewInt32(ctx,0),s==19?JS_UNDEFINED:JS_NewInt32(ctx,8)};
 object=checked(js_typed_array_constructor(ctx,JS_UNDEFINED,3,ctor,class_id));
 memset(JS_VALUE_GET_OBJ(buffer)->u.array_buffer->data,255,64);
 callback_value=checked(JS_NewObject(ctx));
 if(JS_DefinePropertyValue(ctx,callback_value,JS_ATOM_valueOf,checked(JS_NewCFunction(ctx,callback,"valueOf",0)),7)<0)abort();
 int big=class_id==JS_CLASS_BIG_INT64_ARRAY||class_id==JS_CLASS_BIG_UINT64_ARRAY;
 JSValue input=big?JS_NewBigInt64(ctx,-2):JS_NewInt32(ctx,-2);
 JSValue replacement=big?JS_NewBigInt64(ctx,3):JS_NewInt32(ctx,3);
 if(s==2){JS_FreeValue(ctx,input);input=k>=6?JS_NewBigInt64(ctx,-1):JS_NewInt32(ctx,-1);}
 if(s==3){JS_FreeValue(ctx,input);input=k>=6?checked(JS_NewString(ctx,"18446744073709551617")):__JS_NewFloat64(ctx,4294967297.75);}
 if(s==21){JS_FreeValue(ctx,input);input=checked(JS_NewBigUint64(ctx,UINT64_MAX));callback_big_value=input;}
 JSValue args[]={object,JS_NewInt32(ctx,0),input,replacement};unsigned selected=m;
 if(s==2)selected=6;if(s==3)selected=8;
 if(s==4||s==5||s==19){selected=7;args[1]=callback_value;}
 if(s==6){selected=6;args[2]=callback_value;args[3]=callback_value;}
 if(s==7){selected=8;args[2]=callback_value;}
 if(s==8||s==9){selected=12;args[1]=callback_value;args[2]=callback_value;}
 if(s==10){selected=12;args[1]=JS_NewInt32(ctx,99);args[2]=callback_value;}
 if(s==11||s==12){selected=11;args[1]=callback_value;args[2]=callback_value;args[3]=callback_value;}
 if(s==13){selected=11;args[2]=k==6?JS_NewBigInt64(ctx,0):JS_NewInt32(ctx,0);args[3]=JS_NewInt32(ctx,0);}
 if(s==14){selected=11;args[2]=k==6?JS_NewBigInt64(ctx,-1):JS_NewInt32(ctx,-1);args[3]=JS_NewInt32(ctx,-1);}
 if(s==15){selected=12;args[2]=JS_UNDEFINED;}
 if(s==16){selected=10;args[0]=pause_input(ctx,k);}
 if(s==17){selected=9;args[0]=lock_input(ctx,k);}
 if(s==18){selected=k>=4?11:7;args[1]=callback_value;}
 if(s==20){selected=6;args[2]=callback_value;args[3]=callback_value;}
 if(s==21){selected=8;args[2]=callback_value;}
 rt->can_block=s!=12;unsigned before=faults;fault_after=armed?(long)cutoff:-1;
 JSValue result=invoke(ctx,selected,args);fault_after=-1;
 rec[7]=JS_HasException(ctx);rec[8]=faults-before;
 if(JS_IsException(result)){JSValue e=JS_GetException(ctx);rec[1]=error_kind(ctx,e);JS_FreeValue(ctx,e);}
 else{
  rec[0]=1;uint64_t bits=0;
  if(JS_IsNumber(result)){rec[2]=1;union{double d;uint64_t u;}v;if(JS_ToFloat64(ctx,&v.d,result))abort();bits=v.u;}
  else if(JS_IsBigInt(ctx,result)){rec[2]=2;size_t length;const char *text=JS_ToCStringLen(ctx,&length,result);if(!text)abort();
   for(size_t i=0;i<length;i++)bits=(bits*31+(unsigned char)text[i])&UINT32_MAX;bits|=(uint64_t)length<<32;JS_FreeCString(ctx,text);}
  else if(JS_IsBool(result)){rec[2]=3;bits=JS_VALUE_GET_BOOL(result);}
  else if(JS_IsString(result)){rec[2]=4;size_t length;const char *text=JS_ToCStringLen(ctx,&length,result);if(!text)abort();
   for(size_t i=0;i<length;i++)bits=(bits*31+(unsigned char)text[i])&UINT32_MAX;JS_FreeCString(ctx,text);}
  rec[3]=bits;rec[4]=bits>>32;JS_FreeValue(ctx,result);
 }
 JSArrayBuffer *ab=JS_VALUE_GET_OBJ(buffer)->u.array_buffer;
 for(uint32_t i=0;i<ab->byte_length;i++)rec[5]=(rec[5]*31+ab->data[i])&65535;
 rec[6]=calls;rec[9]=ab->detached;rec[10]=ab->byte_length;rec[11]=JS_VALUE_GET_OBJ(object)->u.array.count;
 JS_FreeValue(ctx,input);JS_FreeValue(ctx,replacement);JS_FreeValue(ctx,callback_value);JS_FreeValue(ctx,object);JS_FreeValue(ctx,buffer);
 JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);rec[12]=live_count;rec[13]=live_bytes;
 for(unsigned i=0;i<14;i++)word(rec[i]);
}
int main(int argc,char **argv){if(argc==6){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]),strtoull(argv[5],NULL,10));return 0;}SEMANTIC_CALLS return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import silk.native_thread { SpawnError }
import byte_buffer { ByteBuffer }
import js_atomics_oracle as oracle
import js_atomics_threads_oracle as threads
import js_atomics_native { SynchronizationError }
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_property_names { OwnKeysError }
import js_prototypes { PrototypeError }
struct Case { scenario: u32, kind: u32, method: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | OwnKeysError | PrototypeError | JsException | WriterError | SynchronizationError | SpawnError {
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut writer = StdoutWriter.make()
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def records(data, count, owner):
    if len(data) != count * 56:
        raise SystemExit(f'{owner}: expected {count * 56} bytes, got {len(data)}')
    rows = list(struct.iter_unpack('<14I', data))
    for index, row in enumerate(rows):
        if row[12:] != (0, 0):
            raise SystemExit(f'{owner} row {index}: leaked allocation/byte ledger {row[12:]}')
        if not row[0] and not row[7]:
            raise SystemExit(f'{owner} row {index}: failure without pending exception')
    return rows


def native(temp, silk, stdlib, cases, cutoffs=1, armed=False):
    entries = ','.join(f'Case {{ scenario: {s}, kind: {k}, method: {m} }}' for s, k, m in cases)
    calls = f'''let cases: [Case; {len(cases)}] = [{entries}]
 let mut at: usize = 0
 while at < cases.length {{
  let mut cutoff: usize = 0
  while cutoff < {cutoffs} {{
   let row = run oracle.isolated(cases[at].scenario, cases[at].kind, cases[at].method, {str(armed).lower()}, cutoff)
   let mut field: usize = 0
   while field < 14 {{ run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
   cutoff = cutoff + 1
  }}
  at = at + 1
 }}'''
    if not armed:
        calls += '\n run threads.runThreads()\n run threads.domainFault()\n'
    (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', calls))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command, 1200, owner='Atomics native consumer', cwd=temp)


def compare(case, expected, actual):
    for field, (wanted, got) in enumerate(zip(expected, actual)):
        if wanted != got:
            raise SystemExit(f'Atomics {case} {FIELDS[field]}: C={wanted:#x}, native={got:#x}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cutoffs', type=int, default=96)
    args = parser.parse_args()
    if args.cutoffs < 1:
        parser.error('--cutoffs must be positive')
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.resolve() if args.stdlib else None
    cases = CASES
    fault_cases = FAULT_CASES
    with tempfile.TemporaryDirectory(prefix='silkjs-atomics-') as directory:
        temp = Path(directory).resolve()
        calls = '\n'.join(f'isolated({s},{k},{m},0,0);' for s, k, m in cases)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('SEMANTIC_CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Atomics unchanged-C compilation')
        c_rows = records(process([str(temp / 'oracle')], 600, owner='Atomics C semantics'), len(cases), 'C semantics')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="atomics-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = native(temp, silk, stdlib, cases)
        native_rows = records(actual, len(cases), 'native semantics')
        for case, c_row, n_row in zip(cases, c_rows, native_rows):
            compare(case, c_row, n_row)
        baseline = dict(zip(cases, native_rows))
        for scenario, callbacks in ((4, 1), (5, 1), (6, 2), (7, 1), (12, 3)):
            row = baseline[(scenario, 0, 0)]
            if row[0] or row[1] != 4 or row[6] != callbacks:
                raise SystemExit(f'coercion-order contract {scenario}: {row}')
        for scenario in (8, 9):
            row = baseline[(scenario, 0, 0)]
            if not row[0] or row[3:5] != (0, 0) or row[6] != 2:
                raise SystemExit(f'notify no-revalidation contract {scenario}: {row}')
        if baseline[(19, 0, 0)][1] != 1 or baseline[(19, 0, 0)][6] != 1:
            raise SystemExit('index growth incorrectly replaced the source pre-coercion length')
        faults = records(native(temp, silk, stdlib, fault_cases, args.cutoffs, True),
                         len(fault_cases) * args.cutoffs, 'native faults')
        for index, case in enumerate(fault_cases):
            group = faults[index * args.cutoffs:(index + 1) * args.cutoffs]
            clean = [row for row in group if not row[8]]
            if not clean:
                raise SystemExit(f'native {case}: no allocation-unfaulted sweep outcome')
            for row in clean:
                compare(case, baseline[case], row)
        if not any(row[8] for row in faults):
            raise SystemExit('native fault sweeps injected no allocation failures')
        c_failures = 0
        defects = []
        for case in fault_cases:
            clean = False
            for cutoff in range(args.cutoffs):
                command = [str(temp / 'oracle'), *(str(v) for v in case), '1', str(cutoff)]
                probe = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    defects.append(f'C {case} cutoff={cutoff}: {probe.returncode}: {probe.stderr.decode(errors="replace")}')
                    continue
                try:
                    row = records(probe.stdout, 1, f'C {case} cutoff={cutoff}')[0]
                except SystemExit as error:
                    defects.append(str(error))
                    continue
                c_failures += row[8]
                if not row[8]:
                    clean = True
                    compare(case, baseline[case], row)
            if not clean:
                defects.append(f'C {case}: no allocation-unfaulted sweep outcome')
        if not c_failures:
            defects.append('C fault sweeps injected no allocation failures')
        if defects:
            raise SystemExit('SOURCE/ORACLE FAILURES (not suppressed):\n' + '\n'.join(defects))
        print(f'PASS all13 Atomics entries through complete native dispatch: {len(cases)} semantic records; {pins} source pins; sha256={hashlib.sha256(actual).hexdigest()}')
        print('OS threads: 1/2/4/8-byte RMW; overlapping u64/u32/ordinary-byte accesses; bounded tails1..15; 32/64-bit wait/notify and timeouts; domain allocation fault; zero ledgers')
        print(f'Independent fault sweeps: native={len(faults)} attempts/{sum(row[8] for row in faults)} failures; C={len(fault_cases) * args.cutoffs} attempts/{c_failures} failures')
        print('Atomics.pause: actual hardware CPU hint; integral positive/negative Float64 and large finite integers; no coercion of invalid types')


if __name__ == '__main__':
    main()
