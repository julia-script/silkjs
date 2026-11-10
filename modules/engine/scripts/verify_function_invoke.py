#!/usr/bin/env python3
"""Independent pinned QuickJS/native invocation differential, with real callbacks.

The unchanged quickjs.c is compiled into a separate oracle process. Allocation
failure ordinals are representation-specific; both implementations must clear
real allocator ledgers. Arena disabling is not sanitizer instrumentation.
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
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(mode, magic) for mode in range(25) for magic in range(3)]
FIELDS = ('success', 'result_or_error', 'calls', 'getter_order', 'constructor_bits',
          'reentered_result', 'function_refs', 'new_target_refs')
C_SOURCE = ALLOCATOR_SOURCE + r'''
static uint32_t rec[8]; static int mode; static JSValue target,new_target;
static int number(JSValueConst value) {
 if(JS_VALUE_GET_TAG(value)==JS_TAG_INT)return JS_VALUE_GET_INT(value);
 if(JS_IsString(value))return JS_VALUE_GET_STRING(value)->len;
 return 0;
}
static unsigned error_kind(JSContext *ctx,JSValue error){
 if(!JS_IsObject(error)||JS_VALUE_GET_OBJ(error)->class_id!=JS_CLASS_ERROR)return 99;
 for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(error)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 return 99;
}
static JSValue callback(JSContext *ctx,JSValueConst function,JSValueConst receiver,int argc,JSValueConst *argv,int flags){
 if(flags&JS_CALL_FLAG_CONSTRUCTOR){
  rec[4]=1;if(JS_VALUE_GET_PTR(function)==JS_VALUE_GET_PTR(target))rec[4]|=2;
  if(JS_VALUE_GET_PTR(receiver)==JS_VALUE_GET_PTR(new_target))rec[4]|=4;
  JSValue prototype=JS_GetProperty(ctx,receiver,JS_ATOM_prototype);if(JS_IsException(prototype))return prototype;
  JSValue object=JS_NewObjectProto(ctx,prototype);JS_FreeValue(ctx,prototype);if(JS_IsException(object))return object;
  int sum=0;for(int i=0;i<argc;i++)sum=sum*10+number(argv[i]);
  if(JS_DefinePropertyValue(ctx,object,JS_ATOM_value,JS_NewInt32(ctx,sum),7)<0){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
  JS_RunGC(ctx->rt);return object;
 }
 rec[2]++;JS_RunGC(ctx->rt);int sum=number(receiver);
 for(int i=0;i<argc;i++)sum=sum*10+number(argv[i]);
 if(mode==14)return JS_Throw(ctx,JS_NewInt32(ctx,909));return JS_NewInt32(ctx,sum);
}
static JSValue make_target(JSContext *ctx){
 JSCFunctionType body={0};body.constructor_or_func_flags=callback;
 JSValue function=checked(JS_NewCFunction2(ctx,body.generic,"target",0,JS_CFUNC_constructor_or_func_flags,0));
 JS_SetConstructorBit(ctx,function,1);
 if(JS_DefinePropertyValue(ctx,function,JS_ATOM_prototype,checked(JS_NewObjectProto(ctx,JS_NULL)),1)<0)abort();
 return function;
}
static int mutate(JSContext *ctx,JSValueConst object,JSAtom atom,JSValue value){return JS_DefinePropertyValue(ctx,object,atom,value,7);}
static JSValue getter(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int body,JSValue *data){
 rec[3]=rec[3]*10+body-29;
 if(body==30&&mode==17&&mutate(ctx,receiver,__JS_AtomFromUInt32(1),JS_NewInt32(ctx,7))<0)return JS_EXCEPTION;
 if(body==31&&mode==1){
  if(mutate(ctx,receiver,JS_ATOM_length,JS_NewInt32(ctx,0))<0||mutate(ctx,receiver,__JS_AtomFromUInt32(1),JS_NewInt32(ctx,7))<0)return JS_EXCEPTION;
 }
 if(body==32&&mode==16&&mutate(ctx,receiver,__JS_AtomFromUInt32(0),JS_UNDEFINED)<0)return JS_EXCEPTION;
 if(body==31&&mode==18){
  JSValue values[]={JS_NewInt32(ctx,0),JS_NewInt32(ctx,8)};
  JSValue result=js_function_call(ctx,target,2,values);if(JS_IsException(result))return result;
  rec[5]=number(result);JS_FreeValue(ctx,result);
 }
 JS_RunGC(ctx->rt);
 if((body==30&&mode==12)||(body==32&&mode==13))return JS_Throw(ctx,JS_NewInt32(ctx,707));
 return JS_DupValue(ctx,data[0]);
}
static void accessor(JSContext *ctx,JSValue object,JSAtom atom,int body,JSValue result){
 JSValue function=checked(JS_NewCFunctionData(ctx,getter,0,body,1,&result));
 if(JS_DefineProperty(ctx,object,atom,JS_UNDEFINED,function,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|1)<0)abort();
 JS_FreeValue(ctx,function);
}
static JSValue evaluate(JSContext *ctx,const char *source){return checked(JS_Eval(ctx,source,strlen(source),"invoke-fixture",JS_EVAL_TYPE_GLOBAL));}
static JSValue array_like(JSContext *ctx){
 if(mode==6)return JS_NULL;if(mode==7)return JS_UNDEFINED;if(mode==8)return JS_NewInt32(ctx,2);
 if(mode==0)return evaluate(ctx,"[1,2,3]");
 if(mode==3)return evaluate(ctx,"new Uint8Array([1,2,3])");
 if(mode==4)return evaluate(ctx,"(function(a,b,c){a=7;return arguments})(1,2,3)");
 if(mode==5)return evaluate(ctx,"(function(){'use strict';return arguments})(1,2,3)");
 JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL)),length=JS_NewInt32(ctx,3);
 if(mode==9)length=JS_NewInt32(ctx,65535);if(mode==10)length=JS_NewInt32(ctx,-1);if(mode==11)length=JS_NewInt32(ctx,0);
 if(mode==20)length=JS_NewFloat64(ctx,4294967297.0);if(mode==21)length=JS_NewFloat64(ctx,INFINITY);
 if(mode==19){length=checked(JS_NewObjectProto(ctx,JS_NULL));JSValue result=JS_NewInt32(ctx,3);
  JSValue method=checked(JS_NewCFunctionData(ctx,getter,0,34,1,&result));if(mutate(ctx,length,JS_ATOM_valueOf,method)<0)abort();}
 if(mutate(ctx,object,JS_ATOM_length,length)<0)abort();
 if(mode==1||mode==12||mode==15||mode==17)accessor(ctx,object,JS_ATOM_length,30,JS_NewInt32(ctx,3));
 if(mode==2){if(mutate(ctx,object,__JS_AtomFromUInt32(1),JS_NewInt32(ctx,2))<0)abort();return object;}
 for(int i=0;i<3;i++)if(mutate(ctx,object,__JS_AtomFromUInt32(i),JS_NewInt32(ctx,i+1))<0)abort();
 if(mode==1||mode==18){accessor(ctx,object,__JS_AtomFromUInt32(0),31,JS_NewInt32(ctx,1));accessor(ctx,object,__JS_AtomFromUInt32(2),33,JS_NewInt32(ctx,3));}
 if(mode==13||mode==16){if(mutate(ctx,object,__JS_AtomFromUInt32(0),checked(JS_NewString(ctx,"owned")))<0)abort();accessor(ctx,object,__JS_AtomFromUInt32(1),32,JS_NewInt32(ctx,2));}
 return object;
}
static void run_case(JSContext *ctx,int scenario,int magic){
 memset(rec,0,sizeof(rec));mode=scenario;target=make_target(ctx);new_target=make_target(ctx);
 JSValue array=array_like(ctx),receiver=magic==1?new_target:JS_NewInt32(ctx,4);
 JSValue values[]={receiver,array,JS_NewInt32(ctx,2),JS_NewInt32(ctx,3)};int argc=2;
 if(mode==22){values[0]=JS_NewInt32(ctx,4);values[1]=JS_NewInt32(ctx,1);argc=4;}
 if(mode==23)argc=0;if(mode==24)argc=1;
 JSValue function=mode==15?JS_NewInt32(ctx,1):target;
 JSValue result=mode>=22?js_function_call(ctx,function,argc,values):js_function_apply(ctx,function,argc,values,magic);
 if(JS_IsException(result)){JSValue error=JS_GetException(ctx);rec[1]=JS_IsNumber(error)?number(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}
 else {rec[0]=1;if(JS_IsObject(result)){JSValue field=checked(JS_GetProperty(ctx,result,JS_ATOM_value));rec[1]=number(field);JS_FreeValue(ctx,field);}else rec[1]=number(result);JS_FreeValue(ctx,result);}
 rec[6]=__js_rc(JS_VALUE_GET_PTR(target))->ref_count;rec[7]=__js_rc(JS_VALUE_GET_PTR(new_target))->ref_count;
 JS_FreeValue(ctx,array);JS_FreeValue(ctx,target);JS_FreeValue(ctx,new_target);JS_RunGC(ctx->rt);
 for(int i=0;i<8;i++)word(rec[i]);
}
static void failure_probes(JSContext *ctx){
 unsigned observed=0;
 for(int kind=0;kind<3;kind++)for(int position=0;position<16;position++){
  memset(rec,0,sizeof(rec));mode=kind==0?11:kind==1?16:0;target=make_target(ctx);new_target=target;
  JSValue array=array_like(ctx),values[]={target,array};unsigned before=faults;fault_after=position;
  JSValue result=js_function_apply(ctx,target,2,values,kind==2?1:0);fault_after=-1;
  if(kind==0&&position==0&&(!JS_IsException(result)||faults-before!=1||rec[2]))abort();
  if(JS_IsException(result)){if(!JS_HasException(ctx))abort();}else JS_FreeValue(ctx,result);
  JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
  if(__js_rc(JS_VALUE_GET_PTR(target))->ref_count!=1)abort();
  JS_FreeValue(ctx,array);JS_FreeValue(ctx,target);JS_RunGC(ctx->rt);observed+=faults-before;
 }
 if(observed<3)abort();word(observed);
}
int main(int argc,char **argv){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 if(argc>1)failure_probes(ctx);else { CALLS }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.core.result { Result }
import silk.mem.pointer { Pointer }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_value { ValueBits }
import js_core_types { FrameSlots }
import js_runtime as runtime
import js_gc as gc
import js_function_invoke as invoke
import js_function_invoke_test_support as fixture
import js_function_invoke_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, rc, trap }
import js_exceptions as exceptions
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_errors_test_support { FaultAllocator }
import native_stack { currentFrameAddress }
struct Case { mode: u32, magic: i32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut fault = FaultAllocator { parent: move memory, armed: false, remaining: 0, persistent: false, failures: 0 }
 let mut kind: u32 = 0
 while kind < 3 {
  let mut position: usize = 0
  while position < 16 {
   let mut scenario: u32 = 11 if kind == 1 { scenario = 16 } if kind == 2 { scenario = 0 }
   hooks.mode = scenario hooks.calls = 0
   let function = run unsafe fixture.target(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut fault)
   hooks.target = function hooks.expectedNewTarget = function
   let array = run unsafe fixture.arrayLike(&mut hooks, &observer, ctx, scenario) |> Effect.provideMut<Allocator>(&mut fault)
   let mut values = [function, array] let slots = FrameSlots.Borrowed { data: Pointer.fromMutRef<ValueBits>(&mut values[0]), length: 2 }
   let mut magic: i32 = 0 if kind == 2 { magic = 1 }
   let before = fault.failures fault.armed = true fault.remaining = position
   let result = run Effect.result(unsafe invoke.apply(&mut hooks, ctx, function, &slots, magic)) |> Effect.provideMut<Allocator>(&mut fault)
   fault.armed = false
   match move result {
    Result<ValueBits, JsException>.Success { value } => {
     if kind == 0 && position == 0 { trap() }
     unsafe gc.release(&mut hooks, rt, value)
    }
    Result<ValueBits, JsException>.Failure { .. } => { if !unsafe exceptions.has(rt) { trap() } }
   }
   if kind == 0 && position == 0 && (fault.failures - before != 1 || hooks.calls != 0) { trap() }
   let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending)
   if unsafe rc(reference(function)) != 1 { trap() }
   unsafe gc.release(&mut hooks, rt, array) unsafe gc.release(&mut hooks, rt, function)
   run unsafe gc.collect(&mut hooks, rt, true) |> Effect.provideMut<Allocator>(&mut fault) position = position + 1
  }
  kind = kind + 1
 }
 if fault.failures < 3 { trap() }
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = '\n'.join(f'run_case(ctx,{mode},{magic});' for mode, magic in CASES)
    rows = ',\n'.join(f'Case {{ mode: {mode}, magic: {magic} }}' for mode, magic in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < cases.length {
  let record = run unsafe fixture.runCase(&observer, ctx, cases[at].mode, cases[at].magic) |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0 while i < 8 { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-function-invoke-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Invocation C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Invocation C oracle')
        fault_record = process([str(temp / 'oracle'), 'faults'], 600, owner='Invocation C allocation probes')
        if len(fault_record) != 12:
            raise SystemExit('Invalid C allocation probe output')
        failures, allocations, size = struct.unpack('<3I', fault_record)
        if failures < 3 or allocations or size:
            raise SystemExit(f'Invalid C allocation failure ledger: {failures=}, {allocations=}, {size=}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="function-invoke-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native Silk invocation oracle', cwd=temp)
        if len(expected) != len(CASES) * 32 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C records or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset + 4], actual[offset:offset + 4]
                if c != native:
                    row, field = divmod(offset // 4, 8)
                    case = CASES[row] if row < len(CASES) else 'teardown'
                    raise SystemExit(f'Invocation {case}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS invocation: {len(CASES)} cases; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; ledgers zero')
        print('OOM: 48 attempts per implementation; zero-length scratch failure exercised; native/C ledgers zero')


if __name__ == '__main__':
    main()
