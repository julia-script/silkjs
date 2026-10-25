#!/usr/bin/env python3
"""Independent pinned-C/native typed sort, join and search behavior/fault records.

No reference code is linked into the Silk consumer. Source bugs, crashes and
residual owner ledgers fail rather than being filtered from the fault sweep.
"""
import argparse
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
CASES = [(method, kind, mode) for method in range(7) for kind in range(12)
         for mode in range(11 if method >= 4 else 7 if method <= 1 else 6)]
FAULT_CASES = [(0, 10, 1), (0, 8, 1), (0, 9, 1), (1, 11, 3),
               (2, 11, 4), (3, 8, 0), (3, 9, 0), (4, 8, 2), (6, 11, 3)]
FIELDS = ('success', 'error_kind', 'scalar_low', 'scalar_high', 'result_length',
          'result_digest', 'source_length', 'source_digest', 'callbacks',
          'pending_exception', 'faults', 'detached', 'identity', 'result_kind',
          'final_allocations', 'final_bytes')
C_SOURCE = ALLOCATOR_SOURCE + r'''
static unsigned method,kind,mode,calls,width;
static JSValue buffer;
static unsigned error_kind(JSContext *ctx,JSValue e){
 if(!JS_IsObject(e)||JS_VALUE_GET_OBJ(e)->class_id!=JS_CLASS_ERROR)return 99;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 calls++;
 if(mode==2)JS_DetachArrayBuffer(ctx,buffer);
 if(mode==3){JSValue size=JS_NewInt32(ctx,width*3);JSValue r=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);if(JS_IsException(r))return r;JS_FreeValue(ctx,r);}
 if(method==3)return JS_NewInt32(ctx,7);
 if(method<=1&&mode==5)return JS_NewBigInt64(ctx,1);
 return JS_NewInt32(ctx,method<=1&&mode==6?1:0);
}
static unsigned digest(JSValue object){
 JSObject *p=JS_VALUE_GET_OBJ(object);unsigned hash=0;
 const uint8_t *data=p->u.array.u.ptr;
 unsigned size=p->u.array.count<<typed_array_size_log2(p->class_id);
 for(unsigned i=0;i<size;i++)hash=(hash*31+data[i])&65535;
 return hash;
}
static void isolated(unsigned m,unsigned k,unsigned scenario,int armed,size_t cutoff){
 method=m;kind=k;mode=scenario;calls=0;uint32_t rec[16]={0};
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 unsigned id=JS_CLASS_UINT8C_ARRAY+kind;width=1<<typed_array_size_log2(id);
 uint64_t max=width*16;buffer=checked(js_array_buffer_constructor1(ctx,JS_UNDEFINED,width*8,&max));
 JSValue create[]={buffer,JS_NewInt32(ctx,0),JS_UNDEFINED};
 JSValue object=checked(js_typed_array_constructor(ctx,JS_UNDEFINED,2,create,id));
 int values[]={3,0,7,-2,0,1,3,2};int big=id==JS_CLASS_BIG_INT64_ARRAY||id==JS_CLASS_BIG_UINT64_ARRAY;
 for(unsigned i=0;i<8;i++){
  JSValue v=JS_NewInt32(ctx,values[i]);
  if(big)v=JS_NewBigInt64(ctx,values[i]);
  else if(id>=JS_CLASS_FLOAT16_ARRAY&&i==1)v=__JS_NewFloat64(ctx,-0.0);
  else if(id>=JS_CLASS_FLOAT16_ARRAY&&i==2)v=__JS_NewFloat64(ctx,NAN);
  if(JS_SetPropertyUint32(ctx,object,i,checked(v))<0)abort();
 }
 JSValue fn=checked(JS_NewCFunction(ctx,callback,"buffer callback",0));
 JSValue coerce=checked(JS_NewObject(ctx));
 if(JS_DefinePropertyValue(ctx,coerce,JS_ATOM_valueOf,JS_DupValue(ctx,fn),7)<0||JS_DefinePropertyValue(ctx,coerce,JS_ATOM_toString,JS_DupValue(ctx,fn),7)<0)abort();
 if(method==3){JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL));if(JS_DefinePropertyValue(ctx,proto,JS_ATOM_toLocaleString,JS_DupValue(ctx,fn),7)<0)abort();JS_SetClassProto(ctx,big?JS_CLASS_BIG_INT:JS_CLASS_NUMBER,proto);}
 JSValue args[]={JS_UNDEFINED,JS_UNDEFINED},owned=JS_UNDEFINED;int argc=1;
 if(method<=1){if(mode)args[0]=fn;if(mode==4)args[0]=JS_NewInt32(ctx,1);}
 else if(method==2){
  owned=checked(JS_NewString(ctx,"|"));args[0]=owned;
  if(mode==1){JS_FreeValue(ctx,owned);owned=checked(JS_NewString(ctx,""));args[0]=owned;}
  if(mode==2||mode==3)args[0]=coerce;
  if(mode==4){uint16_t wide[]={955,0xd800};JS_FreeValue(ctx,owned);owned=checked(js_new_string16_len(ctx,wide,2));args[0]=owned;}
  if(mode==5)args[0]=JS_UNDEFINED;
 }else if(method>=4){
  args[0]=big?JS_NewBigInt64(ctx,3):JS_NewInt32(ctx,3);
  if(mode==1){args[0]=big?JS_NewBigInt64(ctx,0):JS_NewInt32(ctx,0);args[1]=JS_NewInt32(ctx,-3);argc=2;}
  if(mode==2||mode==3){args[0]=JS_UNDEFINED;args[1]=coerce;argc=2;}
  if(mode==4)args[0]=big?JS_NewBigInt64(ctx,-2):JS_NewInt32(ctx,-2);
  if(mode==5)args[0]=__JS_NewFloat64(ctx,NAN);
  if(mode==6){owned=checked(JS_Eval(ctx,"18446744073709551616n",21,"<fixture>",JS_EVAL_TYPE_GLOBAL));args[0]=owned;}
  if(mode==7){owned=checked(JS_NewBigUint64(ctx,UINT64_C(0xfffffffffffffffe)));args[0]=owned;}
  if(mode==8){args[1]=__JS_NewFloat64(ctx,INFINITY);argc=2;}
  if(mode==9){args[1]=JS_UNDEFINED;argc=2;}
  if(mode==10)args[0]=__JS_NewFloat64(ctx,0.1);
 }
 unsigned before=faults;fault_after=armed?(long)cutoff:-1;JSValue result;
 if(method==0)result=js_typed_array_sort(ctx,object,argc,args);
 else if(method==1)result=js_typed_array_toSorted(ctx,object,argc,args);
 else if(method<=3)result=js_typed_array_join(ctx,object,argc,args,method==3);
 else result=js_typed_array_indexOf(ctx,object,argc,args,method==4?special_indexOf:method==5?special_lastIndexOf:special_includes);
 fault_after=-1;rec[9]=JS_HasException(ctx);rec[10]=faults-before;
 if(JS_IsException(result)){JSValue e=JS_GetException(ctx);rec[1]=error_kind(ctx,e);JS_FreeValue(ctx,e);}
 else{
  rec[0]=1;uint64_t bits=0;
  if(JS_IsNumber(result)){union{double d;uint64_t u;}v;JS_ToFloat64(ctx,&v.d,result);bits=v.u;rec[13]=1;}
  else if(JS_IsString(result)){JSString *s=JS_VALUE_GET_STRING(result);rec[13]=2;rec[4]=s->len;for(unsigned i=0;i<s->len;i++)rec[5]=(rec[5]*31+(s->is_wide_char?s->u.str16[i]:s->u.str8[i]))&65535;}
  else if(JS_IsObject(result)){rec[13]=3;rec[4]=JS_VALUE_GET_OBJ(result)->u.array.count;rec[5]=digest(result);rec[12]=JS_VALUE_GET_PTR(result)==JS_VALUE_GET_PTR(object);}
  else{rec[13]=4;bits=JS_ToBool(ctx,result);}
  rec[2]=bits;rec[3]=bits>>32;JS_FreeValue(ctx,result);
 }
 rec[6]=JS_VALUE_GET_OBJ(object)->u.array.count;rec[7]=digest(object);rec[8]=calls;rec[11]=JS_VALUE_GET_OBJ(buffer)->u.array_buffer->detached;
 JS_FreeValue(ctx,owned);JS_FreeValue(ctx,coerce);JS_FreeValue(ctx,fn);JS_FreeValue(ctx,object);JS_FreeValue(ctx,buffer);
 JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);rec[14]=live_count;rec[15]=live_bytes;
 for(unsigned i=0;i<16;i++)word(rec[i]);
}
int main(int argc,char **argv){if(argc==6){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]),strtoull(argv[5],NULL,10));return 0;}CALLS return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_typed_array_methods_order_oracle as oracle
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_property_names { OwnKeysError }
import js_prototypes { PrototypeError }
struct Case { method: u32, kind: u32, mode: u32 }
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
            raise SystemExit(f'{owner} {index}: residual owner ledger {row[14:]}')
        if not row[0] and not row[9]:
            raise SystemExit(f'{owner} {index}: failure without pending exception')
    return rows


def compare(case, expected, actual):
    for field, (left, right) in enumerate(zip(expected, actual)):
        if left != right:
            raise SystemExit(f'{case} {FIELDS[field]}: C={left:#x}, native={right:#x}')


def native(temp, silk, stdlib, cases, cutoffs=1, armed=False):
    entries = ','.join(f'Case {{ method: {m}, kind: {k}, mode: {v} }}' for m, k, v in cases)
    calls = f'''let cases: [Case; {len(cases)}] = [{entries}]
 let mut at: usize = 0
 while at < cases.length {{
  let mut cutoff: usize = 0
  while cutoff < {cutoffs} {{
   let row = run oracle.isolated(cases[at].method, cases[at].kind, cases[at].mode, {str(armed).lower()}, cutoff)
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
    return process(command, 1200, owner='typed order native consumer', cwd=temp)


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
    with tempfile.TemporaryDirectory(prefix='silkjs-typed-order-') as directory:
        temp = Path(directory).resolve()
        calls = '\n'.join(f'isolated({m},{k},{v},0,0);' for m, k, v in CASES)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='typed order pinned-C compilation')
        c_rows = records(process([str(temp / 'oracle')], 600, owner='typed order C semantics'), len(CASES), 'C semantics')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="typed-order-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        native_rows = records(native(temp, silk, stdlib, CASES), len(CASES), 'native semantics')
        for case, expected, actual in zip(CASES, c_rows, native_rows):
            compare(case, expected, actual)
        baseline = dict(zip(CASES, c_rows))
        faults = records(native(temp, silk, stdlib, FAULT_CASES, args.cutoffs, True), len(FAULT_CASES) * args.cutoffs, 'native fault sweep')
        for at, case in enumerate(FAULT_CASES):
            group = faults[at * args.cutoffs:(at + 1) * args.cutoffs]
            clean = [row for row in group if not row[10]]
            if not clean:
                raise SystemExit(f'native {case}: sweep never reached unfaulted execution')
            for row in clean:
                compare(case, baseline[case], row)
        if not any(row[10] for row in faults):
            raise SystemExit('native sweep injected no faults')
        c_faults = 0
        defects = []
        for case in FAULT_CASES:
            clean = False
            for cutoff in range(args.cutoffs):
                probe = subprocess.run([str(temp / 'oracle'), *(str(v) for v in case), '1', str(cutoff)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    defects.append(f'C {case} cutoff={cutoff}: status={probe.returncode}; {probe.stderr.decode(errors="replace")}')
                    continue
                try:
                    row = records(probe.stdout, 1, f'C {case} cutoff={cutoff}')[0]
                except SystemExit as error:
                    defects.append(str(error))
                    continue
                c_faults += row[10]
                if not row[10]:
                    clean = True
                    compare(case, baseline[case], row)
            if not clean:
                defects.append(f'C {case}: sweep never reached unfaulted execution')
        if not c_faults:
            defects.append('C sweep injected no faults')
        if defects:
            raise SystemExit('SOURCE/ORACLE FAILURES (not suppressed):\n' + '\n'.join(defects))
        print(f'PASS typed order: {len(CASES)} independent records; {pins} pins; native/C fault sweeps; zero final ledgers')


if __name__ == '__main__':
    main()
