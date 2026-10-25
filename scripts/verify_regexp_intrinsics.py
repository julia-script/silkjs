#!/usr/bin/env python3
"""Compare real native RegExp adapters with a separate unchanged pinned C consumer.

Both consumers compile and execute their own real regexp engine. Callback code
only supplies user coercions/species/replacers; it never implements matching.
Records expose UTF-16 results, capture absence, indices, null-prototype groups,
lastIndex, callback order, species exceptions and iterator terminal transitions.
Allocation ordinals are independently swept with fresh runtimes and zero final
block/byte ledgers; C crashes or leaks are failures, not skipped observations.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    'named_optional_indices', 'global_start', 'sticky_miss',
    'nonglobal_still_coerces_lastIndex', 'readonly_success', 'readonly_miss',
    'input_before_lastIndex', 'input_throws', 'lastIndex_throws',
    'unicode_astral', 'unicode_sets_astral', 'unicode_sets_intersection',
    'unicode_empty_match', 'codeunit_empty_match', 'named_substitution',
    'optimized_substitution', 'functional_replace_gc', 'replacer_throws',
    'search_restores_negative_zero', 'search_throw_does_not_restore',
    'split_capture_insertion', 'split_species_before_limit',
    'matchAll_unicode_empty_terminal', 'matchAll_nonglobal_terminal',
    'incompatible_uv_flags', 'generic_flags_getter_order', 'source_escaping',
    'escape_punctuation', 'compile_mutates_before_lastIndex_error',
    'test_rejects_primitive_exec', 'test_custom_exec_receives_uncoerced_input',
    'constructor_identity', 'matchAll_species_throws', 'split_flags_throws',
    'escape_rejects_object_without_coercion',
    'toString_getter_then_coercion_order',
    'constructor_pattern_before_flags_coercion',
)
FIELDS = ('success', 'error', 'lastIndex', 'events', 'callbacks', 'value',
          'length', 'index', 'item0', 'item1', 'item2', 'named_capture',
          'groups_null_prototype', 'indices0_start', 'indices0_end',
          'indices1_start', 'indices1_end', 'identity_or_step0',
          'compile_source_or_step1', 'step2', 'step3', 'replacer_argc',
          'replacer_offset', 'pending_exception')
SWEEPS = (0, 6, 14, 15, 16, 20, 21, 22, 28, 35, 36)
C_SOURCE = ALLOCATOR_SOURCE + r'''
static uint32_t rec[24];static unsigned mode,events,calls,callback_argc,callback_offset;
static JSValue roots[12];
static uint32_t code(JSValueConst v){
 if(JS_IsString(v)){JSString*s=JS_VALUE_GET_STRING(v);uint32_t h=2166136261u;for(int i=0;i<s->len;i++)h=(h^string_get(s,i))*16777619u;return h;}
 if(JS_IsNumber(v)){double n=JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v);if(n==0&&signbit(n))return 0x80000000u;if(n<0)return 0xffffffffu;return (uint32_t)n;}
 if(JS_IsUndefined(v))return 0xfffffff0u;if(JS_IsNull(v))return 0xfffffff1u;if(JS_IsBool(v))return JS_VALUE_GET_BOOL(v);return 0xfffffff2u;
}
static uint32_t prop(JSContext*ctx,JSValueConst o,JSAtom atom){JSValue v=checked(JS_GetProperty(ctx,o,atom));uint32_t n=code(v);JS_FreeValue(ctx,v);return n;}
static unsigned error_kind(JSContext*ctx,JSValue v){if(!JS_IsObject(v)||JS_VALUE_GET_OBJ(v)->class_id!=JS_CLASS_ERROR)return 99;for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(v)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;}
static JSValue observed(JSContext*ctx,JSValueConst self,int argc,JSValueConst*argv,int id){
 calls++;events=events*16+id;JS_RunGC(ctx->rt);
 if((id==1&&mode==7)||(id==2&&mode==8)||(id==3&&mode==17)||(id==4&&mode==19)||(id==5&&mode==32)||(id==6&&mode==33))return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(id==1)return JS_NewString(ctx,"za");if(id==2)return JS_NewInt32(ctx,1);
 if(id==3){callback_argc=argc;callback_offset=code(argv[3]);return JS_NewString(ctx,"X");}
 if(id==4)return mode==29?JS_NewInt32(ctx,1):JS_NULL;
 if(id==5)return JS_DupValue(ctx,roots[10]);if(id==6)return JS_NewString(ctx,"g");
 if(mode==35&&id==7)return JS_DupValue(ctx,roots[6]);if(mode==35&&id==8)return JS_DupValue(ctx,roots[7]);
 if(id>=8&&id<=15)return JS_NewBool(ctx,id%2==0);abort();
}
static JSValue host(JSContext*ctx,int id){return checked(JS_NewCFunctionMagic(ctx,observed,"regexp fixture",2,JS_CFUNC_generic_magic,id));}
static void put(JSContext*ctx,JSValueConst o,JSAtom atom,JSValue v,int flags){if(JS_DefinePropertyValue(ctx,o,atom,v,flags)<0)abort();}
static void accessor(JSContext*ctx,JSValueConst o,JSAtom atom,int id){if(JS_DefinePropertyGetSet(ctx,o,atom,host(ctx,id),JS_UNDEFINED,7)<0)abort();}
static JSValue builtin(JSContext*ctx,int id){
 if(id==0)return JS_DupValue(ctx,roots[10]);if(id==6)return checked(JS_GetPropertyStr(ctx,roots[10],"escape"));
 JSValue proto=ctx->class_proto[id==14?JS_CLASS_REGEXP_STRING_ITERATOR:JS_CLASS_REGEXP];
 if(id==1)return checked(JS_GetPropertyStr(ctx,proto,"compile"));
 if(id==8)return checked(JS_GetPropertyStr(ctx,proto,"test"));
 JSAtom atom=JS_ATOM_exec;
 switch(id){case 2:atom=JS_ATOM_source;break;case 3:atom=JS_ATOM_flags;break;case 9:atom=JS_ATOM_Symbol_match;break;case 10:atom=JS_ATOM_Symbol_matchAll;break;case 11:atom=JS_ATOM_Symbol_replace;break;case 12:atom=JS_ATOM_Symbol_search;break;case 13:atom=JS_ATOM_Symbol_split;break;case 14:atom=JS_ATOM_next;break;}
 if(id==5)atom=JS_ATOM_toString;
 if(id==2||id==3){JSPropertyDescriptor d;if(JS_GetOwnProperty(ctx,&d,proto,atom)!=1)abort();JSValue f=JS_DupValue(ctx,d.getter);js_free_desc(ctx,&d);return f;}
 return checked(JS_GetProperty(ctx,proto,atom));
}
static JSValue invoke(JSContext*ctx,JSValueConst fn,JSValueConst self,JSValueConst a,JSValueConst b,int argc){JSValue args[]={a,b};return JS_Call(ctx,fn,self,argc,args);}
static void setup(JSContext*ctx,unsigned m){
 mode=m;events=calls=callback_argc=callback_offset=0;for(int i=0;i<12;i++)roots[i]=JS_UNDEFINED;
 roots[10]=JS_DupValue(ctx,ctx->regexp_ctor);
 const char*pattern="(?<value>a)(b)?",*flags="d",*input="za";int method=7;
 if(m==1){flags="dg";input="baab";}if(m==2){flags="gy";input="ba";}
 if(m>=3&&m<=8)flags="g";if(m==3)flags="";if(m==5)input="zz";
 if(m==9||m==10){pattern=".";input="\xf0\x9f\x98\x80";flags=m==9?"u":"v";}
 if(m==11){pattern="[[a-z]&&[^b]]+";flags="v";input="abc";}
 if(m==12||m==13||m==22){pattern="";flags=m==13?"g":"gu";input="\xf0\x9f\x98\x80";method=m==22?10:9;}
 if(m>=14&&m<=17){flags="g";method=11;if(m==15)pattern="(a)(b)?";if(m>=16)input="aa";}
 if(m==18||m==19){flags="g";method=12;}
 if(m==20||m==21||m==33){pattern="(,)";flags="";input="a,b,c";method=13;}
 if(m==23||m==32){pattern="a";flags="";input="aa";method=10;}
 if(m==24||m==31||m==36)method=0;if(m==25)method=3;
 if(m==26){pattern="a/b\n";flags="";method=2;}
 if(m==27||m==34){method=6;input="a-b /\n";}if(m==28)method=1;if(m==29||m==30)method=8;
 if(m==35)method=5;
 roots[4]=checked(JS_NewString(ctx,pattern));roots[5]=checked(JS_NewString(ctx,flags));
 roots[0]=checked(invoke(ctx,roots[10],JS_UNDEFINED,roots[4],roots[5],2));
 roots[1]=checked(JS_NewString(ctx,input));roots[3]=builtin(ctx,method);JSValue receiver=roots[0];
 if(m==1&&JS_SetProperty(ctx,receiver,JS_ATOM_lastIndex,JS_NewInt32(ctx,1))<0)abort();
 if(m==18&&JS_SetProperty(ctx,receiver,JS_ATOM_lastIndex,__JS_NewFloat64(ctx,-0.0))<0)abort();
 if(m==19&&JS_SetProperty(ctx,receiver,JS_ATOM_lastIndex,JS_NewInt32(ctx,9))<0)abort();
 if(m==4||m==5||m==28)put(ctx,receiver,JS_ATOM_lastIndex,JS_NewInt32(ctx,0),0);
 if(m==3||(m>=6&&m<=8)){roots[6]=checked(JS_NewObjectProto(ctx,JS_NULL));put(ctx,roots[6],JS_ATOM_Symbol_toPrimitive,host(ctx,2),7);if(JS_SetProperty(ctx,receiver,JS_ATOM_lastIndex,JS_DupValue(ctx,roots[6]))<0)abort();}
 if((m>=6&&m<=8)||m==30||m==34||m==36){JS_FreeValue(ctx,roots[1]);roots[1]=checked(JS_NewObjectProto(ctx,JS_NULL));put(ctx,roots[1],JS_ATOM_Symbol_toPrimitive,host(ctx,1),7);}
 if(m==14||m==15)roots[2]=checked(JS_NewString(ctx,"$<value>-$1-$2-$$-$&-$`-$'"));
 if(m==16||m==17)roots[2]=host(ctx,3);
 if(m==19||m==29||m==30)put(ctx,receiver,JS_ATOM_exec,host(ctx,4),7);
 if(m==21||m==32||m==33){roots[7]=checked(JS_NewObjectProto(ctx,JS_NULL));accessor(ctx,roots[7],JS_ATOM_Symbol_species,5);put(ctx,receiver,JS_ATOM_constructor,JS_DupValue(ctx,roots[7]),7);if(m==21)roots[2]=JS_NewInt32(ctx,2);if(m==33)accessor(ctx,receiver,JS_ATOM_flags,6);}
 if(m==24)roots[2]=checked(JS_NewString(ctx,"uv"));
 if(m==25){JS_FreeValue(ctx,roots[0]);roots[0]=checked(JS_NewObjectProto(ctx,JS_NULL));JSAtom fields[]={JS_ATOM_hasIndices,JS_ATOM_global,JS_ATOM_ignoreCase,JS_ATOM_multiline,JS_ATOM_dotAll,JS_ATOM_unicode,JS_ATOM_unicodeSets,JS_ATOM_sticky};for(int i=0;i<8;i++)accessor(ctx,roots[0],fields[i],i+8);}
 if(m==28){JS_FreeValue(ctx,roots[1]);roots[1]=checked(JS_NewString(ctx,"z"));}
 if(m==22||m==23)roots[11]=builtin(ctx,14);
 if(m==31){JS_FreeValue(ctx,roots[1]);roots[1]=JS_DupValue(ctx,receiver);}
 if(m==36){roots[2]=checked(JS_NewObjectProto(ctx,JS_NULL));put(ctx,roots[2],JS_ATOM_Symbol_toPrimitive,host(ctx,6),7);}
 if(m==35){JS_FreeValue(ctx,roots[0]);roots[0]=checked(JS_NewObjectProto(ctx,JS_NULL));roots[6]=checked(JS_NewObjectProto(ctx,JS_NULL));roots[7]=checked(JS_NewObjectProto(ctx,JS_NULL));put(ctx,roots[6],JS_ATOM_Symbol_toPrimitive,host(ctx,1),7);put(ctx,roots[7],JS_ATOM_Symbol_toPrimitive,host(ctx,6),7);accessor(ctx,roots[0],JS_ATOM_source,7);accessor(ctx,roots[0],JS_ATOM_flags,8);}
}
static JSValue perform(JSContext*ctx){
 JSValue value=invoke(ctx,roots[3],(mode==24||mode==31||mode==36)?JS_UNDEFINED:roots[0],roots[1],roots[2],2);
 if(JS_IsException(value)||(mode!=22&&mode!=23))return value;
 roots[6]=value;roots[7]=JS_NewArray(ctx);if(JS_IsException(roots[7]))return JS_EXCEPTION;
 for(int i=0;i<4;i++){JS_RunGC(ctx->rt);JSValue step=invoke(ctx,roots[11],value,JS_UNDEFINED,JS_UNDEFINED,0);if(JS_IsException(step))return step;if(JS_DefinePropertyValueUint32(ctx,roots[7],i,step,7)<0)return JS_EXCEPTION;}
 return JS_DupValue(ctx,roots[7]);
}
static void summarize(JSContext*ctx,JSValueConst v){
 rec[5]=code(v);if(JS_IsString(v)){rec[6]=JS_VALUE_GET_STRING(v)->len;return;}if(!JS_IsObject(v))return;
 rec[6]=prop(ctx,v,JS_ATOM_length);rec[7]=prop(ctx,v,JS_ATOM_index);for(int i=0;i<3;i++)rec[8+i]=prop(ctx,v,__JS_AtomFromUInt32(i));
 roots[8]=checked(JS_GetProperty(ctx,v,JS_ATOM_groups));
 if(JS_IsObject(roots[8])){rec[11]=prop(ctx,roots[8],JS_ATOM_value);rec[12]=!JS_VALUE_GET_OBJ(roots[8])->shape->proto;}else rec[11]=code(roots[8]);
 roots[9]=checked(JS_GetProperty(ctx,v,JS_ATOM_indices));if(JS_IsObject(roots[9]))for(int i=0;i<2;i++){JSValue pair=checked(JS_GetPropertyUint32(ctx,roots[9],i));if(JS_IsObject(pair)){rec[13+i*2]=prop(ctx,pair,__JS_AtomFromUInt32(0));rec[14+i*2]=prop(ctx,pair,__JS_AtomFromUInt32(1));}else rec[13+i*2]=code(pair);JS_FreeValue(ctx,pair);}
}
static void teardown(JSContext*ctx){for(int i=0;i<12;i++){JS_FreeValue(ctx,roots[i]);roots[i]=JS_UNDEFINED;}JS_RunGC(ctx->rt);}
static void semantic(JSContext*ctx,unsigned m){
 setup(ctx,m);memset(rec,0,sizeof(rec));JSValue result=perform(ctx);
 if(JS_IsException(result)){if(!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);rec[1]=JS_IsNumber(error)?code(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}else{
 rec[0]=1;summarize(ctx,result);
 if(m==22||m==23)for(int i=0;i<4;i++){JSValue step=checked(JS_GetPropertyUint32(ctx,result,i)),item=checked(JS_GetProperty(ctx,step,JS_ATOM_value));if(prop(ctx,step,JS_ATOM_done)==1){if(!JS_IsUndefined(item))abort();rec[17+i]=0xffffffffu;}else rec[17+i]=prop(ctx,item,JS_ATOM_index);JS_FreeValue(ctx,item);JS_FreeValue(ctx,step);}
 if(m==31)rec[17]=JS_VALUE_GET_PTR(result)==JS_VALUE_GET_PTR(roots[0]);JS_FreeValue(ctx,result);}
 rec[2]=prop(ctx,roots[0],JS_ATOM_lastIndex);
 if(m==28){JSValue source=builtin(ctx,2),v=checked(invoke(ctx,source,roots[0],JS_UNDEFINED,JS_UNDEFINED,0));rec[18]=code(v);JS_FreeValue(ctx,v);JS_FreeValue(ctx,source);}
 rec[3]=events;rec[4]=calls;rec[21]=callback_argc;rec[22]=callback_offset;rec[23]=JS_HasException(ctx);
 for(int i=0;i<24;i++)word(rec[i]);teardown(ctx);
}
static void sweep(unsigned m){unsigned failed=0,succeeded=0,deferred_slash_failure=0;
 for(int cutoff=0;cutoff<256;cutoff++){
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();setup(ctx,m);
 faults=0;fault_after=cutoff;JSValue v=perform(ctx);fault_after=-1;
 if(faults)failed++;else succeeded++;if(JS_IsException(v)){if(faults&&events==7)deferred_slash_failure=1;if(!JS_HasException(ctx))abort();}else JS_FreeValue(ctx,v);
 if(JS_HasException(ctx))JS_FreeValue(ctx,JS_GetException(ctx));teardown(ctx);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(live_count||live_bytes){fprintf(stderr,"RegExp C sweep mode=%u cutoff=%d blocks=%zu bytes=%zu\n",m,cutoff,live_count,live_bytes);abort();}}
 word(4|(failed?1:0)|(succeeded?2:0)|((m==35&&deferred_slash_failure)?8:0));word(live_count);word(live_bytes);
}
int main(int argc,char**argv){if(argc==3&&strcmp(argv[1],"sweep")==0){sweep(atoi(argv[2]));return 0;}
 JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 for(unsigned m=0;m<CASE_COUNT;m++)semantic(ctx,m);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_runtime as runtime
import js_gc as gc
import native_stack { currentFrameAddress }
import js_string_types { StringLengthError }
import js_exceptions { JsException }
import js_regexp_intrinsics_test_support as fixture
import js_regexp_intrinsics_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 let mut mode: u32 = 0 while mode < CASE_COUNT {
  let record = run unsafe fixture.runCase(&mut hooks, ctx, mode) |> Effect.provideMut<Allocator>(&mut memory)
  let mut field: usize = 0 while field < 24 { run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
  mode = mode + 1
 }
 unsafe fixture.finish(&mut hooks, ctx)
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 SWEEPS
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def compare(expected, actual):
    size = len(CASES) * len(FIELDS) * 4 + 8
    if len(expected) != size or expected[-8:] != bytes(8):
        raise SystemExit(f'Invalid C record/ledger: {len(expected)} bytes, suffix={expected[-8:].hex()}')
    if len(actual) != size + len(SWEEPS) * 4 or actual[size - 8:size] != bytes(8):
        raise SystemExit(f'Invalid native record/ledger: {len(actual)} bytes')
    for row, case in enumerate(CASES):
        c = struct.unpack_from('<24I', expected, row * 96)
        native = struct.unpack_from('<24I', actual, row * 96)
        for field, (left, right) in enumerate(zip(c, native)):
            if left != right:
                raise SystemExit(f'{case}: {FIELDS[field]} C=0x{left:08x} native=0x{right:08x}')
    flags = struct.unpack_from(f'<{len(SWEEPS)}I', actual, size)
    if flags != tuple(15 if mode == 35 else 7 for mode in SWEEPS):
        raise SystemExit(f'Native sweeps lack fault/success/empty-ledger witnesses: {dict(zip(SWEEPS, flags))}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    sweep_calls = '\n'.join(
        f'let sweep{i} = run unsafe fixture.allocationSweep({mode}) |> Effect.provideMut<Allocator>(&mut system)\n'
        f'run out.writeU32(sweep{i}) |> Effect.provideMut<Allocator>(&mut system)'
        for i, mode in enumerate(SWEEPS))
    with tempfile.TemporaryDirectory(prefix='silkjs-regexp-intrinsics-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CASE_COUNT', str(len(CASES))))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='RegExp C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='RegExp C semantic oracle')
        # Source arenas are disabled, not ASan enabled. No sanitizer result is claimed.
        for mode in SWEEPS:
            data = process([str(temp / 'oracle'), 'sweep', str(mode)], 600,
                           owner=f'RegExp isolated C allocation sweep {CASES[mode]}')
            if data != struct.pack('<III', 15 if mode == 35 else 7, 0, 0):
                raise SystemExit(f'C sweep {CASES[mode]} missing witnesses/zero ledgers: {data.hex()}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        source = SILK_SOURCE.replace('CASE_COUNT', str(len(CASES))).replace('SWEEPS', sweep_calls)
        (temp / 'src/main.silk').write_text(source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="regexp-intrinsics-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1800, owner='Native RegExp semantic/allocation consumer', cwd=temp)
        compare(expected, actual)
        print(f'PASS RegExp intrinsics: {len(CASES)} semantic cases; {len(SWEEPS)} independent C/native '
              f'allocation sweeps; zero ledgers; {pins} pinned files; native SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
