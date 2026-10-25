#!/usr/bin/env python3
"""Independent pinned-C callback/iterator semantics and per-engine fault sweeps."""
import argparse
import hashlib
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE
from verify_buffers import SILK_SOURCE as DRIVER_TEMPLATE, records

ROOT = Path(__file__).resolve().parents[1]
CASES = [(method, kind, 0) for method in range(7) for kind in range(8)]
CASES += [(scenario, kind, 0) for scenario in range(7, 13) for kind in range(3)]
CASES += [(scenario, method, 0) for scenario in range(13, 16) for method in range(7)]
CASES += [(16, 3, 0)]
FAULT_CASES = [(3, 0, 0), (4, 0, 0), (4, 2, 0), (5, 4, 0),
               (7, 2, 0), (8, 2, 0), (10, 1, 0), (13, 3, 0), (13, 4, 0), (14, 5, 0)]
# Independently debugged at quickjs.c5781: add_property returns NULL when the
# Array constructor creates its length property; the source dereferences it.
SOURCE_ARRAY_SHAPE_CRASHES = {((13, 3, 0), 11), ((13, 4, 0), 11)}
SOURCE_FAULT_MARKER = b'SOURCE_ARRAY_CONSTRUCTOR_OOM\n'
FIELDS = ('success', 'error_kind', 'scalar', 'result_length', 'digest', 'steps',
          'done_count', 'source_length', 'detached', 'key_digest', 'callbacks',
          'pending', 'allocation_failures', 'reserved', 'final_allocations', 'final_bytes')
C_SOURCE = ('static void reportSourceFault(void);\n' + ALLOCATOR_SOURCE.replace(
    'faults++;return NULL;', 'faults++;reportSourceFault();return NULL;')) + r'''
static unsigned scenario,kind,calls;
static void reportSourceFault(void){
 if(scenario==13&&(kind==3||kind==4))fputs("SOURCE_ARRAY_CONSTRUCTOR_OOM\n",stderr);
}
static JSValue buffer,source,callback_value;
static uint32_t rec[16];
static uint32_t scalar(JSValueConst v){
 if(JS_IsBool(v))return JS_VALUE_GET_BOOL(v);
 if(JS_IsNumber(v)){double n;JS_ToFloat64(NULL,&n,v);return (uint32_t)n;}
 return 900;
}
static unsigned error_kind(JSContext *ctx,JSValue e){
 if(!JS_IsObject(e)||JS_VALUE_GET_OBJ(e)->class_id!=JS_CLASS_ERROR)return 99;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 calls++;
 if(scenario<7&&kind==2)JS_DetachArrayBuffer(ctx,buffer);
 if(scenario<7&&kind==3){JSValue size=JS_NewInt32(ctx,1);JSValue r=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);if(JS_IsException(r))return r;JS_FreeValue(ctx,r);}
 return JS_NewInt32(ctx,scenario<7&&kind==1?0:7);
}
static JSValue perform(JSContext *ctx){
 if(scenario>=13){
  JSValue object=JS_NewArray(ctx),result=JS_EXCEPTION;
  if(JS_IsException(object))return object;
  if(scenario==16){JS_FreeValue(ctx,object);object=JS_NewObject(ctx);if(JS_IsException(object))return object;}
  if(JS_SetProperty(ctx,object,JS_ATOM_length,JS_NewFloat64(ctx,scenario==16?4294967296.0:3))<0)goto array_done;
  if(scenario!=14&&scenario!=16){
   if(JS_DefinePropertyValueUint32(ctx,object,0,JS_NewInt32(ctx,1),7)<0||
      JS_DefinePropertyValueUint32(ctx,object,2,JS_NewInt32(ctx,4),7)<0)goto array_done;
  }
  if(scenario==15&&JS_DefinePropertyValue(ctx,object,JS_ATOM_constructor,JS_NewInt32(ctx,99),7)<0)goto array_done;
  JSValue args[]={callback_value,JS_UNDEFINED};
  if(kind<5)result=js_array_every(ctx,object,1,args,kind);
  else result=js_array_reduce(ctx,object,1,args,kind-5);
 array_done:JS_FreeValue(ctx,object);return result;
 }
 if(scenario<7){
  JSValue args[]={callback_value,JS_NewInt32(ctx,19)};
  if(kind==6)args[0]=JS_NewInt32(ctx,99);
  if(kind==7)JS_DetachArrayBuffer(ctx,buffer);
  if(scenario<5)return js_array_every(ctx,source,kind==5?2:1,args,scenario|8);
  return js_array_reduce(ctx,source,kind==5?2:1,args,(scenario-5)|8);
 }
 JSValue object=JS_DupValue(ctx,source),it=JS_UNDEFINED,value=JS_UNDEFINED,result=JS_EXCEPTION;
 if(scenario==8||scenario==11){
  JS_FreeValue(ctx,object);object=JS_NewObject(ctx);if(JS_IsException(object)){object=JS_UNDEFINED;goto done;}
  if(JS_DefinePropertyValue(ctx,object,JS_ATOM_length,JS_NewFloat64(ctx,scenario==11?4294967297.0:3),7)<0||
     JS_DefinePropertyValueUint32(ctx,object,0,JS_NewInt32(ctx,11),7)<0||
     JS_DefinePropertyValueUint32(ctx,object,2,JS_NewInt32(ctx,44),7)<0)goto done;
 }
 it=js_create_array_iterator(ctx,object,0,NULL,kind);if(JS_IsException(it)){it=JS_UNDEFINED;goto done;}
 for(unsigned step=0;step<5;step++){
  if(scenario==9&&(step==1||step==2)){
   JSValue size=JS_NewInt32(ctx,step==1?1:3),r=js_array_buffer_resize(ctx,buffer,1,&size,JS_CLASS_ARRAY_BUFFER);
   if(JS_IsException(r))goto done;JS_FreeValue(ctx,r);
  }
  if((scenario==10&&step==1)||(scenario==12&&step==4))JS_DetachArrayBuffer(ctx,buffer);
  int finished=0;value=js_array_iterator_next(ctx,it,0,NULL,&finished,0);
  if(JS_IsException(value)){value=JS_UNDEFINED;goto done;}
  rec[5]++;if(finished)rec[6]++;
  else {
   JSValue item=JS_DupValue(ctx,value);
   if(kind==2){
    JS_FreeValue(ctx,item);item=JS_GetPropertyUint32(ctx,value,0);if(JS_IsException(item))goto done;
    rec[9]=rec[9]*5+scalar(item);JS_FreeValue(ctx,item);
    item=JS_GetPropertyUint32(ctx,value,1);if(JS_IsException(item))goto done;
   }
   rec[4]=(rec[4]*31+scalar(item))&65535;JS_FreeValue(ctx,item);
  }
  JS_FreeValue(ctx,value);value=JS_UNDEFINED;
 }
 result=JS_UNDEFINED;
done:JS_FreeValue(ctx,value);JS_FreeValue(ctx,it);JS_FreeValue(ctx,object);return result;
}
static void isolated(unsigned s,unsigned k,unsigned unused,int armed,size_t cutoff){
 scenario=s;kind=k;calls=0;memset(rec,0,sizeof(rec));
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 uint64_t maximum=8;uint32_t size=scenario<7&&kind==4?0:3;
 buffer=checked(js_array_buffer_constructor1(ctx,JS_UNDEFINED,size,&maximum));
 JSValue args[]={buffer,JS_NewInt32(ctx,0),JS_UNDEFINED};
 source=checked(js_typed_array_constructor(ctx,JS_UNDEFINED,3,args,JS_CLASS_UINT8_ARRAY));
 unsigned input[]={1,2,4};for(unsigned i=0;i<size;i++)if(JS_SetPropertyUint32(ctx,source,i,JS_NewInt32(ctx,input[i]))<0)abort();
 callback_value=checked(JS_NewCFunction(ctx,callback,"callback",0));
 unsigned before=faults;fault_after=armed?(long)cutoff:-1;
 JSValue result=perform(ctx);fault_after=-1;rec[11]=JS_HasException(ctx);rec[12]=faults-before;
 if(JS_IsException(result)){JSValue e=JS_GetException(ctx);rec[1]=error_kind(ctx,e);JS_FreeValue(ctx,e);}
 else {
  rec[0]=1;rec[2]=scalar(result);
  if(JS_IsObject(result)&&(JS_VALUE_GET_OBJ(result)->class_id==JS_CLASS_UINT8_ARRAY||JS_VALUE_GET_OBJ(result)->class_id==JS_CLASS_ARRAY)){
   if(JS_VALUE_GET_OBJ(result)->class_id==JS_CLASS_UINT8_ARRAY)rec[3]=JS_VALUE_GET_OBJ(result)->u.array.count;
   else {JSValue len=checked(JS_GetProperty(ctx,result,JS_ATOM_length));rec[3]=scalar(len);JS_FreeValue(ctx,len);}
   for(unsigned i=0;i<rec[3];i++){JSValue v=checked(JS_GetPropertyUint32(ctx,result,i));rec[4]=(rec[4]*31+scalar(v))&65535;JS_FreeValue(ctx,v);}
  }
  JS_FreeValue(ctx,result);
 }
 rec[7]=JS_VALUE_GET_OBJ(source)->u.array.count;rec[8]=JS_VALUE_GET_OBJ(buffer)->u.array_buffer->detached;rec[10]=calls;
 JS_FreeValue(ctx,callback_value);JS_FreeValue(ctx,source);JS_FreeValue(ctx,buffer);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 rec[14]=live_count;rec[15]=live_bytes;for(unsigned i=0;i<16;i++)word(rec[i]);
}
int main(int argc,char **argv){if(argc==6){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]),strtoull(argv[5],NULL,10));return 0;}SEMANTIC_CALLS return 0;}
'''


def native(temp, silk, stdlib, cases, cutoffs=1, armed=False):
    entries = ','.join(f'Case {{ scenario: {s}, kind: {k}, little: false }}' for s, k, _ in cases)
    calls = f'''let cases: [Case; {len(cases)}] = [{entries}]
 let mut at: usize = 0
 while at < cases.length {{
  let mut cutoff: usize = 0
  while cutoff < {cutoffs} {{
   let row = run oracle.isolated(cases[at].scenario, cases[at].kind, false, {str(armed).lower()}, cutoff)
   let mut field: usize = 0
   while field < 16 {{ run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
   cutoff = cutoff + 1
  }}
  at = at + 1
 }}'''
    driver = DRIVER_TEMPLATE.replace('js_buffer_oracle', 'js_typed_array_methods_iteration_oracle')
    (temp / 'src/main.silk').write_text(driver.replace('CALLS', calls))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command, 1200, owner='typed iteration native consumer', cwd=temp)


def compare(case, expected, actual):
    for field, (left, right) in enumerate(zip(expected, actual)):
        if left != right:
            raise SystemExit(f'iteration {case} {FIELDS[field]}: C={left}, native={right}')


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
    with tempfile.TemporaryDirectory(prefix='silkjs-typed-iteration-') as directory:
        temp = Path(directory).resolve()
        calls = '\n'.join(f'isolated({s},{k},{le},0,0);' for s, k, le in CASES)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('SEMANTIC_CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='iteration unchanged-C compilation')
        c_rows = records(process([str(temp / 'oracle')], 600, owner='iteration C semantics'), len(CASES), 'C semantics')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="typed-iteration-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = native(temp, silk, stdlib, CASES)
        native_rows = records(actual, len(CASES), 'native semantics')
        baseline = dict(zip(CASES, c_rows))
        for case, expected, row in zip(CASES, c_rows, native_rows):
            compare(case, expected, row)
        faults = records(native(temp, silk, stdlib, FAULT_CASES, args.cutoffs, True),
                         len(FAULT_CASES) * args.cutoffs, 'native faults')
        for index, case in enumerate(FAULT_CASES):
            group = faults[index * args.cutoffs:(index + 1) * args.cutoffs]
            clean = [row for row in group if not row[12]]
            if not clean:
                raise SystemExit(f'native {case}: no allocation-unfaulted execution reached')
            for row in clean:
                compare(case, baseline[case], row)
        if not any(row[12] for row in faults):
            raise SystemExit('native sweep injected no faults')
        c_failures = 0
        source_crashes = set()
        for case in FAULT_CASES:
            clean = False
            for cutoff in range(args.cutoffs):
                command = [str(temp / 'oracle'), *(str(v) for v in case), '1', str(cutoff)]
                probe = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    if ((case, cutoff) in SOURCE_ARRAY_SHAPE_CRASHES
                            and probe.returncode in (-signal.SIGSEGV, -signal.SIGBUS)
                            and probe.stderr == SOURCE_FAULT_MARKER):
                        source_crashes.add((case, cutoff))
                        continue
                    raise SystemExit(f'C {case} cutoff={cutoff}: exit={probe.returncode}; {probe.stderr.decode(errors="replace")}')
                row = records(probe.stdout, 1, f'C {case} cutoff={cutoff}')[0]
                c_failures += row[12]
                if not row[12]:
                    clean = True
                    compare(case, baseline[case], row)
            if not clean:
                raise SystemExit(f'C {case}: no allocation-unfaulted execution reached')
        if not c_failures:
            raise SystemExit('C sweep injected no faults')
        expected_crashes = {entry for entry in SOURCE_ARRAY_SHAPE_CRASHES if entry[1] < args.cutoffs}
        if source_crashes != expected_crashes:
            raise SystemExit(f'pinned array-length source crashes changed: {source_crashes}')
        print(f'PASS typed iteration: {len(CASES)} records; {pins} pins; sha256={hashlib.sha256(actual).hexdigest()}')
        print(f'Independent faults: {len(FAULT_CASES) * args.cutoffs} attempts per engine; '
              f'native failures={sum(row[12] for row in faults)}, noncrashing C failures={c_failures}; '
              f'native/noncrashing C ledgers zero; {len(source_crashes)} pinned source null-property crashes isolated, not replicated')


if __name__ == '__main__':
    main()
