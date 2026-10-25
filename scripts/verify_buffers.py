#!/usr/bin/env python3
"""Compare native buffer/DataView operations with unchanged pinned QuickJS.

The two executables share no runtime implementation. Coercion callbacks really
resize/detach their backing object. Fail-after ordinals are swept independently;
only clean semantic records are paired, and every emitted final owner ledger is
checked. Upstream crashes/leaks fail with the exact isolated reproduction case.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(0, kind, endian) for kind in range(11) for endian in range(2)]
CASES += [(1, 0, 0), (2, 0, 0), (3, 0, 0), (3, 1, 0),
          (4, 0, 0), (5, 0, 0), (6, 0, 0), (7, 0, 0)]
FAULT_CASES = [(0, 7, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0),
               (3, 1, 0), (4, 0, 0), (5, 0, 0), (6, 0, 0), (7, 0, 0)]
FIELDS = ('success', 'error_kind', 'bits_low', 'bits_high', 'result_length',
          'result_resizable', 'original_length', 'detached', 'view_stored_length',
          'byte_digest', 'callbacks', 'pending_exception', 'allocation_failures',
          'result_byte_digest', 'final_allocations', 'final_bytes')
C_SOURCE = ALLOCATOR_SOURCE + r'''
static JSValue buffer,view,callback_value;
static unsigned scenario,kind,little,calls;
static unsigned error_kind(JSContext *ctx,JSValue e){
 if(!JS_IsObject(e)||JS_VALUE_GET_OBJ(e)->class_id!=JS_CLASS_ERROR)return 99;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 calls++;
 if(scenario==4)JS_DetachArrayBuffer(ctx,buffer);
 else {JSValue size=JS_NewInt32(ctx,6);JSValue result=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);if(JS_IsException(result))return result;JS_FreeValue(ctx,result);}
 return JS_NewInt32(ctx,7);
}
static JSValue input(JSContext *ctx){
 if(kind==6||kind==7)return JS_NewBigInt64(ctx,-2);
 if(kind==8){union{uint64_t u;double d;}v={.u=UINT64_C(0x3ff0020000000001)};return __JS_NewFloat64(ctx,v.d);}
 if(kind==9)return __JS_NewFloat64(ctx,16777217.0);
 if(kind==10)return __JS_NewFloat64(ctx,-0.0);
 return JS_NewInt32(ctx,-12345);
}
static JSValue typed_pipeline(JSContext *ctx){
 JSValue roots[4]={JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED};
 JSValue args[]={buffer,JS_NewInt32(ctx,0),JS_NewInt32(ctx,3)};
 JSValue result=JS_EXCEPTION,step;
 roots[0]=js_typed_array_constructor(ctx,JS_UNDEFINED,3,args,JS_CLASS_UINT16_ARRAY);
 if(JS_IsException(roots[0])){roots[0]=JS_UNDEFINED;goto done;}
 args[1]=JS_NewInt32(ctx,1);
 roots[1]=js_typed_array_constructor(ctx,JS_UNDEFINED,3,args,JS_CLASS_UINT8_ARRAY);
 if(JS_IsException(roots[1])){roots[1]=JS_UNDEFINED;goto done;}
 if(JS_SetPropertyUint32(ctx,roots[0],0,JS_NewInt32(ctx,1))<0||
    JS_SetPropertyUint32(ctx,roots[0],1,JS_NewInt32(ctx,65537))<0||
    JS_SetPropertyUint32(ctx,roots[0],2,JS_NewInt32(ctx,65535))<0)goto done;
 JSValue write_args[]={JS_NewInt32(ctx,1),JS_NewInt32(ctx,43981),JS_TRUE};
 step=js_dataview_setValue(ctx,view,3,write_args,JS_CLASS_UINT16_ARRAY);
 if(JS_IsException(step))goto done;JS_FreeValue(ctx,step);
 JSValue copy_args[]={roots[0],JS_UNDEFINED,JS_UNDEFINED};
 roots[2]=js_typed_array_constructor(ctx,JS_UNDEFINED,1,copy_args,JS_CLASS_UINT16_ARRAY);
 if(JS_IsException(roots[2])){roots[2]=JS_UNDEFINED;goto done;}
 if(JS_SetPropertyUint32(ctx,roots[1],0,JS_NewInt32(ctx,18))<0)goto done;
 step=JS_GetPropertyUint32(ctx,roots[0],0);
 if(JS_IsException(step))goto done;
 if(JS_ToUint32(ctx,&calls,step))abort();JS_FreeValue(ctx,step);
 JSValue size=JS_NewInt32(ctx,16);
 roots[3]=js_array_buffer_transfer(ctx,buffer,1,&size,0);
 if(JS_IsException(roots[3])){roots[3]=JS_UNDEFINED;goto done;}
 calls+=65536*(JS_VALUE_GET_OBJ(roots[0])->u.array.count+JS_VALUE_GET_OBJ(roots[1])->u.array.count);
 result=roots[2];roots[2]=JS_UNDEFINED;
done:
 for(unsigned i=0;i<4;i++)JS_FreeValue(ctx,roots[i]);
 return result;
}
static JSValue perform(JSContext *ctx){
 if(scenario==0){
  JSValue args[]={JS_NewInt32(ctx,2),input(ctx),JS_NewBool(ctx,little)};
  JSValue result=js_dataview_setValue(ctx,view,3,args,JS_CLASS_INT8_ARRAY+kind);
  JS_FreeValue(ctx,args[1]);if(JS_IsException(result))return result;JS_FreeValue(ctx,result);
  JSValue get[]={args[0],args[2]};return js_dataview_getValue(ctx,view,2,get,JS_CLASS_INT8_ARRAY+kind);
 }
 if(scenario==1||scenario==2){
  JSValue size=JS_NewInt32(ctx,6);JSValue result=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);
  if(JS_IsException(result))return result;JS_FreeValue(ctx,result);
  if(scenario==1)return js_dataview_get_byteLength(ctx,view);
  JSValue args[]={JS_NewInt32(ctx,99),JS_UNDEFINED};return js_dataview_getValue(ctx,view,2,args,JS_CLASS_UINT8_ARRAY);
 }
 if(scenario==3){JSValue size=JS_NewInt32(ctx,24);return js_array_buffer_transfer(ctx,buffer,1,&size,kind!=0);}
 if(scenario==4||scenario==5){JSValue args[]={JS_NewInt32(ctx,scenario==4?999:0),callback_value,JS_UNDEFINED};return js_dataview_setValue(ctx,view,3,args,JS_CLASS_UINT32_ARRAY);}
 if(scenario==7)return typed_pipeline(ctx);
 JSValue args[]={buffer,JS_NewInt32(ctx,1),JS_UNDEFINED};return js_dataview_constructor(ctx,JS_UNDEFINED,3,args);
}
static void isolated(unsigned s,unsigned k,unsigned le,int armed,size_t cutoff){
 scenario=s;kind=k;little=le;calls=0;uint32_t rec[16]={0};
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 uint64_t max=32;buffer=checked(js_array_buffer_constructor1(ctx,JS_UNDEFINED,16,&max));
 JSValue args[]={buffer,JS_NewInt32(ctx,1),scenario==1?JS_UNDEFINED:JS_NewInt32(ctx,12)};
 view=checked(js_dataview_constructor(ctx,JS_UNDEFINED,3,args));
 JSArrayBuffer *ab=JS_VALUE_GET_OBJ(buffer)->u.array_buffer;memset(ab->data,0xa5,16);
 callback_value=JS_UNDEFINED;
 if(scenario==4||scenario==5){callback_value=checked(JS_NewObject(ctx));JSValue fn=checked(JS_NewCFunction(ctx,callback,"valueOf",0));if(JS_DefinePropertyValue(ctx,callback_value,JS_ATOM_valueOf,fn,7)<0)abort();}
 unsigned before=faults;fault_after=armed?(long)cutoff:-1;
 JSValue result=perform(ctx);fault_after=-1;rec[11]=JS_HasException(ctx);rec[12]=faults-before;
 if(JS_IsException(result)){JSValue e=JS_GetException(ctx);rec[1]=error_kind(ctx,e);JS_FreeValue(ctx,e);}
 else {
  rec[0]=1;uint64_t bits=0;
  if(JS_IsNumber(result)){union{double d;uint64_t u;}v;JS_ToFloat64(ctx,&v.d,result);bits=v.u;}
  else if(scenario==0&&(kind==6||kind==7)){int64_t v;if(JS_ToBigInt64(ctx,&v,result))abort();bits=(uint64_t)v;}
  else if(JS_IsObject(result)){
   JSObject *p=JS_VALUE_GET_OBJ(result);
   if(p->class_id==JS_CLASS_ARRAY_BUFFER){
    JSArrayBuffer *b=p->u.array_buffer;rec[4]=b->byte_length;rec[5]=array_buffer_is_resizable(b);
    for(uint32_t i=0;i<b->byte_length;i++)rec[13]=(rec[13]*31+b->data[i])&65535;
   }else{
    rec[4]=p->u.typed_array->length;
    if(scenario==7){
     uint32_t a,b;JSValue v=checked(JS_GetPropertyUint32(ctx,result,0));
     if(JS_ToUint32(ctx,&a,v))abort();JS_FreeValue(ctx,v);
     v=checked(JS_GetPropertyUint32(ctx,result,1));if(JS_ToUint32(ctx,&b,v))abort();JS_FreeValue(ctx,v);
     bits=(uint64_t)a|((uint64_t)b<<32);
     size_t offset,length,width;JSValue owner=checked(JS_GetTypedArrayBuffer(ctx,result,&offset,&length,&width));
     size_t capacity;uint8_t *bytes=JS_GetArrayBuffer(ctx,&capacity,owner);
     for(size_t i=0;i<length;i++)rec[13]=(rec[13]*31+bytes[offset+i])&65535;
     JS_FreeValue(ctx,owner);
    }
   }
  }
  rec[2]=bits;rec[3]=bits>>32;JS_FreeValue(ctx,result);
 }
 ab=JS_VALUE_GET_OBJ(buffer)->u.array_buffer;rec[6]=ab->byte_length;rec[7]=ab->detached;rec[8]=JS_VALUE_GET_OBJ(view)->u.typed_array->length;
 for(uint32_t i=0;i<ab->byte_length;i++)rec[9]=(rec[9]*31+ab->data[i])&65535;rec[10]=calls;
 JS_FreeValue(ctx,callback_value);JS_FreeValue(ctx,view);JS_FreeValue(ctx,buffer);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 rec[14]=live_count;rec[15]=live_bytes;for(unsigned i=0;i<16;i++)word(rec[i]);
}
int main(int argc,char **argv){if(argc==6){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]),strtoull(argv[5],NULL,10));return 0;}SEMANTIC_CALLS return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_buffer_oracle as oracle
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_property_names { OwnKeysError }
import js_prototypes { PrototypeError }
struct Case { scenario: u32, kind: u32, little: bool }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | OwnKeysError | PrototypeError | JsException | WriterError {
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def records(data, count, owner):
    if len(data) != count * 64:
        raise SystemExit(f'{owner}: expected {count * 64} bytes, got {len(data)}')
    rows = list(struct.iter_unpack('<16I', data))
    for index, row in enumerate(rows):
        if row[14:] != (0, 0):
            raise SystemExit(f'{owner} record {index}: residual allocation/byte ledger {row[14:]}')
        if not row[0] and not row[11]:
            raise SystemExit(f'{owner} record {index}: failure without pending exception')
    return rows


def native(temp, silk, stdlib, cases, cutoffs=1, armed=False):
    entries = ','.join(f'Case {{ scenario: {s}, kind: {k}, little: {str(bool(le)).lower()} }}' for s, k, le in cases)
    calls = f'''let cases: [Case; {len(cases)}] = [{entries}]
 let mut at: usize = 0
 while at < cases.length {{
  let mut cutoff: usize = 0
  while cutoff < {cutoffs} {{
   let row = run oracle.isolated(cases[at].scenario, cases[at].kind, cases[at].little, {str(armed).lower()}, cutoff)
   let mut field: usize = 0
   while field < 16 {{ run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
   cutoff = cutoff + 1
  }}
  at = at + 1
 }}'''
    (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', calls))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command, 1200, owner='buffer native consumer', cwd=temp)


def compare(case, expected, actual):
    for field, (c_word, n_word) in enumerate(zip(expected, actual)):
        if c_word != n_word:
            raise SystemExit(f'buffer {case} {FIELDS[field]}: C={c_word:#x}, native={n_word:#x}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--cutoffs', type=int, default=96)
    args = parser.parse_args()
    if args.cutoffs < 1:
        parser.error('--cutoffs must be positive')
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.resolve() if args.stdlib else None
    with tempfile.TemporaryDirectory(prefix='silkjs-buffers-') as directory:
        temp = Path(directory).resolve()
        calls = '\n'.join(f'isolated({s},{k},{le},0,0);' for s, k, le in CASES)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('SEMANTIC_CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='buffer unchanged-C compilation')
        c_rows = records(process([str(temp / 'oracle')], 600, owner='buffer C semantics'), len(CASES), 'C semantics')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="buffer-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = native(temp, silk, stdlib, CASES)
        native_rows = records(actual, len(CASES), 'native semantics')
        for case, c_row, n_row in zip(CASES, c_rows, native_rows):
            compare(case, c_row, n_row)
        baseline = dict(zip(CASES, native_rows))
        for scenario in (4, 5):
            row = baseline[(scenario, 0, 0)]
            if row[0] or row[1] != 4 or row[10] != 1:
                raise SystemExit(f'callback {scenario}: missing real coercion-before-bounds TypeError: {row}')
        pipeline = baseline[(7, 0, 0)]
        digest = 0
        for byte in (1, 0, 0xcd, 0xab, 0xff, 0xff):
            digest = (digest * 31 + byte) & 65535
        if (pipeline[2:8] != (1, 43981, 6, 0, 0, 1)
                or pipeline[10] != 4609 or pipeline[13] != digest):
            raise SystemExit(f'typed constructor/copy/alias/detach pipeline mismatch: {pipeline}')
        faults = records(native(temp, silk, stdlib, FAULT_CASES, args.cutoffs, True),
                         len(FAULT_CASES) * args.cutoffs, 'native OOM')
        for at, case in enumerate(FAULT_CASES):
            group = faults[at * args.cutoffs:(at + 1) * args.cutoffs]
            clean = [row for row in group if not row[12]]
            if not clean:
                raise SystemExit(f'native {case}: sweep never reached allocation-unfaulted execution')
            for row in clean:
                compare(case, baseline[case], row)
        if not any(row[12] for row in faults):
            raise SystemExit('native sweeps injected no failures')
        c_failures = 0
        defects = []
        for case in FAULT_CASES:
            clean = False
            for cutoff in range(args.cutoffs):
                command = [str(temp / 'oracle'), *(str(v) for v in case), '1', str(cutoff)]
                probe = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    defects.append(f'C {case} cutoff={cutoff}: returncode={probe.returncode}; {probe.stderr.decode(errors="replace")}')
                    continue
                try:
                    row = records(probe.stdout, 1, f'C {case} cutoff={cutoff}')[0]
                except SystemExit as error:
                    defects.append(str(error))
                    continue
                c_failures += row[12]
                if not row[12]:
                    clean = True
                    compare(case, baseline[case], row)
            if not clean:
                defects.append(f'C {case}: sweep never reached allocation-unfaulted execution')
        if not c_failures:
            defects.append('C sweeps injected no failures')
        if defects:
            raise SystemExit('SOURCE/ORACLE FAILURES (not suppressed):\n' + '\n'.join(defects))
        print(f'PASS buffers: {len(CASES)} semantic records; {pins} source pins; sha256={hashlib.sha256(actual).hexdigest()}')
        print(f'Independent fault sweeps: native={len(faults)} attempts/{sum(row[12] for row in faults)} failures; C={len(FAULT_CASES) * args.cutoffs} attempts/{c_failures} failures; final ledgers zero')


if __name__ == '__main__':
    main()
