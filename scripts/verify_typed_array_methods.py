#!/usr/bin/env python3
"""Compare TypedArray behavior; measure then reclaim two pinned C with() leaks."""
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

ROOT = Path(__file__).resolve().parents[1]
CASES = range(16)
C_SOURCE = ALLOCATOR_SOURCE + r'''
static JSValue buffer,source,auxiliary,ctor,primitive;
static unsigned scenario,calls,next_calls,closed;
static unsigned error_kind(JSContext *ctx,JSValue error){
 if(!JS_IsObject(error)||JS_VALUE_GET_OBJ(error)->class_id!=JS_CLASS_ERROR)return 99;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(error)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 calls++;
 if(scenario==12||scenario==14||scenario==17)JS_DetachArrayBuffer(ctx,buffer);
 else {JSValue n=JS_NewInt32(ctx,2),r=js_array_buffer_resize(ctx,buffer,1,&n,JS_CLASS_ARRAY_BUFFER);if(JS_IsException(r))return r;JS_FreeValue(ctx,r);}
 if(scenario==17)return JS_DupValue(ctx,primitive);
 return JS_NewInt32(ctx,scenario==15?1:scenario==12?0:7);
}
static JSValue iterator(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){return JS_DupValue(ctx,self);}
static JSValue next(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){next_calls++;return js_create_iterator_result(ctx,JS_NewInt32(ctx,next_calls*100),next_calls>3);}
static unsigned digest(JSValue value){
 JSObject *p=JS_VALUE_GET_OBJ(value);unsigned result=0;
 for(unsigned i=0;i<p->u.array.count;i++)result=(result*31+p->u.array.u.uint8_ptr[i])&65535;
 return result;
}
static JSValue perform(JSContext *ctx){
 JSValue a[3]={JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED};
 switch(scenario){
 case 0:a[0]=JS_NewInt32(ctx,-1);return js_typed_array_at(ctx,source,1,a);
 case 1:a[0]=JS_NewInt32(ctx,-2);a[1]=JS_NewInt32(ctx,99);return js_typed_array_with(ctx,source,2,a);
 case 2:a[0]=JS_NewInt32(ctx,1);a[1]=JS_NewInt32(ctx,0);a[2]=JS_NewInt32(ctx,3);return js_typed_array_copyWithin(ctx,source,3,a);
 case 3:a[0]=JS_NewInt32(ctx,7);a[1]=JS_NewInt32(ctx,1);a[2]=JS_NewInt32(ctx,3);return js_typed_array_fill(ctx,source,3,a);
 case 4:return js_typed_array_reverse(ctx,source,0,a);
 case 5:return js_typed_array_toReversed(ctx,source,0,a);
 case 6:a[0]=JS_NewInt32(ctx,1);a[1]=JS_NewInt32(ctx,3);return js_typed_array_slice(ctx,source,2,a);
 case 7:a[0]=JS_NewInt32(ctx,1);a[1]=JS_NewInt32(ctx,3);return js_typed_array_subarray(ctx,source,2,a);
 case 8:a[0]=auxiliary;a[1]=JS_NewInt32(ctx,1);return js_typed_array_set(ctx,source,2,a);
 case 9:a[0]=JS_NewInt32(ctx,9);a[1]=JS_NewInt32(ctx,8);a[2]=JS_NewInt32(ctx,7);return js_typed_array_of(ctx,ctor,3,a);
 case 10:a[0]=auxiliary;return js_typed_array_from(ctx,ctor,1,a);
 case 11:a[0]=auxiliary;return js_typed_array_fill(ctx,source,1,a);
 case 12:a[0]=auxiliary;return js_typed_array_at(ctx,source,1,a);
 case 13:a[0]=JS_NewInt32(ctx,0);a[1]=auxiliary;return js_typed_array_with(ctx,source,2,a);
 case 14:a[0]=auxiliary;a[1]=JS_NewInt32(ctx,0);return js_typed_array_copyWithin(ctx,source,2,a);
 case 15:a[0]=auxiliary;return js_typed_array_find(ctx,source,1,a,ArrayFind);
 case 16:case 17:a[0]=JS_NewInt32(ctx,scenario==16?99:0);a[1]=auxiliary;return js_typed_array_with(ctx,source,2,a);
 default:abort();
 }
}
static void isolated(unsigned mode,int armed,size_t cutoff){
 scenario=mode;calls=next_calls=closed=0;uint32_t rec[16]={0};
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 uint64_t max=8;buffer=checked(js_array_buffer_constructor1(ctx,JS_UNDEFINED,4,&max));
 JSValue args[]={buffer,JS_NewInt32(ctx,0),JS_UNDEFINED};source=checked(js_typed_array_constructor(ctx,JS_UNDEFINED,3,args,JS_CLASS_UINT8_ARRAY));
 for(unsigned i=0;i<4;i++)JS_VALUE_GET_OBJ(source)->u.array.u.uint8_ptr[i]=i+1;
 auxiliary=ctor=primitive=JS_UNDEFINED;
 if(mode==8){args[2]=JS_NewInt32(ctx,3);auxiliary=checked(js_typed_array_constructor(ctx,JS_UNDEFINED,3,args,JS_CLASS_UINT8_ARRAY));}
 if(mode==9||mode==10)ctor=checked(JS_NewCFunctionMagic(ctx,js_typed_array_constructor,"Uint8Array",3,JS_CFUNC_constructor_magic,JS_CLASS_UINT8_ARRAY));
 if(mode==10){auxiliary=checked(JS_NewObject(ctx));if(JS_DefinePropertyValue(ctx,auxiliary,JS_ATOM_Symbol_iterator,checked(JS_NewCFunction(ctx,iterator,"iterator",0)),7)<0)abort();if(JS_DefinePropertyValue(ctx,auxiliary,JS_ATOM_next,checked(JS_NewCFunction(ctx,next,"next",0)),7)<0)abort();}
 if(mode>=11&&mode<=14){auxiliary=checked(JS_NewObject(ctx));if(JS_DefinePropertyValue(ctx,auxiliary,JS_ATOM_valueOf,checked(JS_NewCFunction(ctx,callback,"valueOf",0)),7)<0)abort();}
 if(mode==15)auxiliary=checked(JS_NewCFunction(ctx,callback,"find",0));
 if(mode==16||mode==17){primitive=checked(JS_NewString(ctx,"owned primitive retained by invalid with"));if(mode==16)auxiliary=JS_DupValue(ctx,primitive);else{auxiliary=checked(JS_NewObject(ctx));if(JS_DefinePropertyValue(ctx,auxiliary,JS_ATOM_valueOf,checked(JS_NewCFunction(ctx,callback,"valueOf",0)),7)<0)abort();}}
 unsigned before=faults;fault_after=armed?(long)cutoff:-1;
 JSValue result=perform(ctx);fault_after=-1;rec[10]=JS_HasException(ctx);rec[11]=faults-before;
 if(JS_IsException(result)){JSValue error=JS_GetException(ctx);rec[1]=error_kind(ctx,error);JS_FreeValue(ctx,error);}
 else {rec[0]=1;if(JS_IsNumber(result)){rec[2]=1;JS_ToUint32(ctx,&rec[3],result);}else if(JS_IsObject(result)){JSObject*p=JS_VALUE_GET_OBJ(result);rec[2]=2;rec[3]=p->u.array.count;rec[4]=digest(result);rec[13]=p->u.typed_array->buffer==JS_VALUE_GET_OBJ(buffer);}JS_FreeValue(ctx,result);}
 rec[5]=JS_VALUE_GET_OBJ(source)->u.array.count;rec[6]=digest(source);rec[7]=calls;rec[8]=next_calls;rec[9]=closed;rec[12]=JS_VALUE_GET_OBJ(buffer)->u.array_buffer->detached;
 JS_FreeValue(ctx,ctor);JS_FreeValue(ctx,auxiliary);
 unsigned orphan_owners=0,orphan_bytes=0;
 if(mode>=16){
  /* Both paths lose exactly the ToPrimitive-owned flat string at61135-61140.
     Inspect while the fixture still owns primitive; never inspect freed data. */
  if(armed||!JS_IsString(primitive)||JS_VALUE_GET_STRING(primitive)->atom_type||
     __js_rc(JS_VALUE_GET_PTR(primitive))->ref_count!=2)abort();
 }
 JS_FreeValue(ctx,primitive);
 if(mode>=16){
  orphan_owners=__js_rc(JS_VALUE_GET_PTR(primitive))->ref_count;
  if(orphan_owners!=1)abort();
  size_t blocks=live_count,bytes=live_bytes;
  JS_FreeValue(ctx,primitive); /* Reclaim only the measured source-lost owner. */
  if(blocks-live_count!=1)abort();orphan_bytes=bytes-live_bytes;
  fprintf(stderr,"C with source orphan case=%u: owners=%u, allocation bytes=%u; measured before reclaim\n",mode,orphan_owners,orphan_bytes);
 }
 JS_FreeValue(ctx,source);JS_FreeValue(ctx,buffer);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 rec[14]=live_count;rec[15]=live_bytes;for(unsigned i=0;i<16;i++)word(rec[i]);
 if(mode>=16){word(orphan_owners);word(orphan_bytes);}
}
int main(int argc,char **argv){if(argc==4){isolated(atoi(argv[1]),atoi(argv[2]),strtoull(argv[3],NULL,10));return 0;}for(unsigned i=0;i<16;i++)isolated(i,0,0);return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_typed_array_methods_oracle as oracle
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 let mut mode: u32 = 0
 while mode < 18 {
  let mut cutoff: usize = 0
  while cutoff < CUTOFFS {
   let row = run oracle.isolated(mode, ARMED, cutoff)
   let mut field: usize = 0
   while field < 16 { run out.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
   cutoff = cutoff + 1
  }
  mode = mode + 1
 }
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''

def records(raw, count, label):
    if len(raw) != count * 64:
        raise SystemExit(f'{label}: expected {count * 64} bytes, got {len(raw)}')
    rows = list(struct.iter_unpack('<16I', raw))
    for row in rows:
        if row[14:] != (0, 0):
            raise SystemExit(f'{label}: residual allocations/bytes {row[14:]}')
        if not row[0] and not row[10]:
            raise SystemExit(f'{label}: missing pending exception: {row}')
    return rows

def native(temp, silk, stdlib, armed=False, cutoffs=1):
    code = SILK_SOURCE.replace('CUTOFFS', str(cutoffs)).replace('ARMED', str(armed).lower())
    (temp / 'src/main.silk').write_text(code)
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return records(process(command, 1200, owner='typed core native', cwd=temp), 18 * cutoffs, 'native')

def compare(mode, c, n):
    if c != n:
        differences = [(i, x, y) for i, (x, y) in enumerate(zip(c, n)) if x != y]
        raise SystemExit(f'typed core case={mode}: field/C/native={differences}')

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
    with tempfile.TemporaryDirectory(prefix='silkjs-typed-core-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='typed core unchanged C compilation')
        expected = records(process([str(temp / 'oracle')], 600, owner='typed core C'), 16, 'C')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="typed-core-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        baseline = native(temp, silk, stdlib)
        for mode, c, n in zip(CASES, expected, baseline):
            compare(mode, c, n)
        faults = native(temp, silk, stdlib, True, args.cutoffs)
        failures = 0
        for mode in range(18):
            group = faults[mode * args.cutoffs:(mode + 1) * args.cutoffs]
            clean = [row for row in group if not row[11]]
            if not clean:
                raise SystemExit(f'native {mode}: fault sweep never completed without injected failure')
            for row in clean:
                compare(mode, baseline[mode], row)
            if mode >= 16:
                continue
            c_clean = False
            for cutoff in range(args.cutoffs):
                row = records(process([str(temp / 'oracle'), str(mode), '1', str(cutoff)], 120,
                                      owner=f'C core mode={mode} cutoff={cutoff}'), 1, 'C fault')[0]
                failures += row[11]
                if not row[11]:
                    c_clean = True
                    compare(mode, expected[mode], row)
            if not c_clean:
                raise SystemExit(f'C {mode}: fault sweep never completed without injected failure')
        if not failures or not any(row[11] for row in faults):
            raise SystemExit('fault sweeps must inject failures in both engines')
        source_owners = source_bytes = 0
        for mode in (16, 17):
            raw = process([str(temp / 'oracle'), str(mode), '0', '0'], 120, owner=f'C with ownership case={mode}')
            if len(raw) != 72:
                raise SystemExit(f'C with ownership case={mode}: expected record plus measured orphan ledger')
            row = records(raw[:64], 1, f'C with ownership case={mode}')[0]
            compare(mode, row, baseline[mode])
            owners, allocation_bytes = struct.unpack('<2I', raw[64:])
            if owners != 1 or allocation_bytes == 0:
                raise SystemExit(f'C with ownership case={mode}: unexpected orphan ledger {owners, allocation_bytes}')
            source_owners += owners
            source_bytes += allocation_bytes
        digest = hashlib.sha256(b''.join(struct.pack('<16I', *row) for row in baseline)).hexdigest()
        print(f'PASS typed core: 16 differential + 2 ownership cases; {pins} pins; '
              f'native={18 * args.cutoffs} and C={16 * args.cutoffs} fault attempts; '
              f'native ledgers zero; C ledgers zero after measuring/reclaiming '
              f'{source_owners} source string owners ({source_bytes} bytes); SHA256={digest}')

if __name__ == '__main__':
    main()
