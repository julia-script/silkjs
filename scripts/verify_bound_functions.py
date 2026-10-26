#!/usr/bin/env python3
"""Compare native bound functions with separately compiled unchanged pinned QuickJS.

Executes real positional callbacks and constructor allocations, getter mutation,
collection, raw numeric lengths and exceptions. Native code imports no C symbol.
Allocation counts need not match the two representations; both ledgers must clear.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
import signal
import struct
import subprocess
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_native_functions import C_SOURCE as ALLOCATION_ORACLE
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(kind, mode) for kind in range(11) for mode in range(17)]
FIELDS = ('bound', 'bind_error', 'length_low', 'length_high', 'length_flags',
          'name_flags', 'name_units', 'name_hash', 'constructor', 'called',
          'result_or_error', 'callbacks', 'length_gets', 'name_gets', 'construct_bits', 'frame_restored')
ALLOCATOR_SOURCE = ALLOCATION_ORACLE.split('static uint32_t rec')[0]
ALLOCATOR_SOURCE = ALLOCATOR_SOURCE.replace(
    'static size_t live_count,live_bytes;',
    'static long fault_after=-1; static unsigned faults; static size_t live_count,live_bytes;')
ALLOCATOR_SOURCE = ALLOCATOR_SOURCE.replace(
    'if(!n)return NULL;Header *h=malloc',
    'if(!n)return NULL;if(fault_after==0){fault_after=-1;faults++;return NULL;}if(fault_after>0)fault_after--;Header *h=malloc')
ALLOCATOR_SOURCE = ALLOCATOR_SOURCE.replace(
    'Header *h=(Header*)p-1;size_t old=h->size;',
    'if(fault_after==0){fault_after=-1;faults++;return NULL;}if(fault_after>0)fault_after--;Header *h=(Header*)p-1;size_t old=h->size;')
C_SOURCE = ALLOCATOR_SOURCE + r'''
static uint32_t rec[16]; static int mode; static JSValue target,expected_new_target;
static int numeric(JSValueConst v){return JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):0;}
static JSValue callback(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv){
 if(mode==2||mode==3||mode==16){
  rec[14]=1;if(JS_VALUE_GET_PTR(target)==JS_VALUE_GET_PTR(ctx->rt->current_stack_frame->cur_func))rec[14]|=2;
  if(JS_VALUE_GET_PTR(receiver)==JS_VALUE_GET_PTR(expected_new_target))rec[14]|=4;
  JSValue proto=checked(JS_GetProperty(ctx,receiver,JS_ATOM_prototype));
  JSValue object=checked(JS_NewObjectProto(ctx,proto));JS_FreeValue(ctx,proto);
  int sum=0;for(int i=0;i<argc;i++)sum=sum*10+numeric(argv[i]);
  if(JS_DefinePropertyValue(ctx,object,JS_ATOM_value,JS_NewInt32(ctx,sum),7)<0)abort();
  JS_RunGC(ctx->rt);return object;
 }
 rec[11]++;int sum=numeric(receiver);for(int i=0;i<argc;i++)sum=sum*10+numeric(argv[i]);
 JS_RunGC(ctx->rt);if(mode==14)return JS_Throw(ctx,JS_NewInt32(ctx,909));return JS_NewInt32(ctx,sum);
}
static JSValue getter(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int magic,JSValue *data){
 if(magic==10)rec[12]++;else rec[13]++;
 if(magic==10&&mode==7&&JS_DefinePropertyValue(ctx,receiver,JS_ATOM_name,checked(JS_NewString(ctx,"changed")),1)<0)abort();
 JS_RunGC(ctx->rt);
 if((magic==10&&mode==8)||(magic==11&&mode==9))return JS_Throw(ctx,JS_NewInt32(ctx,707));
 return JS_DupValue(ctx,data[0]);
}
static JSValue length_value(JSContext *ctx,int kind){
 switch(kind){
 case 0:return JS_NewInt32(ctx,5);case 1:return __JS_NewFloat64(ctx,5.9);
 case 2:return __JS_NewFloat64(ctx,NAN);case 3:return __JS_NewFloat64(ctx,INFINITY);
 case 4:return __JS_NewFloat64(ctx,-INFINITY);case 5:return __JS_NewFloat64(ctx,-0.0);
 case 6:return __JS_NewFloat64(ctx,-3.9);case 7:return JS_TRUE;
 case 8:return __JS_NewFloat64(ctx,4294967297.0);case 9:return JS_NewInt32(ctx,-2147483647);
 default:return __JS_NewFloat64(ctx,0.9);
 }
}
static unsigned error_kind(JSContext *ctx,JSValue error){
 if(!JS_IsObject(error))return 99;JSObject *p=JS_VALUE_GET_OBJ(error);
 if(p->class_id!=JS_CLASS_ERROR)return 99;
 for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;
}
static void free_descriptor(JSContext *ctx,JSPropertyDescriptor *d){JS_FreeValue(ctx,d->value);JS_FreeValue(ctx,d->getter);JS_FreeValue(ctx,d->setter);}
static JSValue make_target(JSContext *ctx,int kind){
 JSValue f=checked(JS_NewCFunction(ctx,callback,"target",5));JS_SetConstructorBit(ctx,f,mode!=4);
 if(JS_DefinePropertyValue(ctx,f,JS_ATOM_prototype,checked(JS_NewObjectProto(ctx,JS_NULL)),1)<0)abort();
 if(mode==5||mode==6){if(JS_DeleteProperty(ctx,f,JS_ATOM_length,0)<0)abort();}
 else if(JS_DefinePropertyValue(ctx,f,JS_ATOM_length,length_value(ctx,kind),1)<0)abort();
 if(mode==6){JSValue inherited=checked(JS_NewObjectProto(ctx,JS_NULL));
  if(JS_DefinePropertyValue(ctx,inherited,JS_ATOM_length,JS_NewInt32(ctx,99),1)<0||JS_SetPrototype(ctx,f,inherited)<0)abort();JS_FreeValue(ctx,inherited);}
 JSValue name;
 if(mode==10){uint16_t units[]={0x03bb,0xd800,0,0xdc00};name=checked(js_new_string16_len(ctx,units,4));}
 else if(mode==11)name=checked(JS_AtomToValue(ctx,JS_ATOM_Symbol_iterator));
 else name=checked(JS_NewString(ctx,"target"));
 if(JS_DefinePropertyValue(ctx,f,JS_ATOM_name,name,1)<0)abort();
 if(mode==7||mode==8||mode==9){int body=mode==9?11:10;JSAtom atom=mode==9?JS_ATOM_name:JS_ATOM_length;
  JSValue data=mode==9?checked(JS_NewString(ctx,"name")):length_value(ctx,kind);
  JSValue fn=checked(JS_NewCFunctionData(ctx,getter,0,body,1,&data));JS_FreeValue(ctx,data);
  if(JS_DefineProperty(ctx,f,atom,JS_UNDEFINED,fn,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|1)<0)abort();JS_FreeValue(ctx,fn);}
 return f;
}
static void run_case(JSContext *ctx,int kind,int scenario){
 memset(rec,0,sizeof(rec));mode=scenario;target=make_target(ctx,kind);expected_new_target=target;
 JSValue alternate=mode==3?make_target(ctx,0):JS_UNDEFINED;if(mode==3)expected_new_target=alternate;
 JSValue prefix[]={JS_NewInt32(ctx,4),JS_NewInt32(ctx,1),JS_NewInt32(ctx,2)};
 if(mode==15)prefix[0]=JS_UNDEFINED;
 JSValue object=js_function_bind(ctx,target,mode==15?0:3,prefix);
 if(JS_IsException(object)){JSValue error=JS_GetException(ctx);rec[1]=numeric(error);JS_FreeValue(ctx,error);}
 else {
  rec[0]=1;
  if(mode==1||mode==16){JSValue more[]={JS_NewInt32(ctx,9),JS_NewInt32(ctx,3)};JSValue repeated=checked(js_function_bind(ctx,object,2,more));JS_FreeValue(ctx,object);object=repeated;}
  JSPropertyDescriptor length,name;if(JS_GetOwnProperty(ctx,&length,object,JS_ATOM_length)!=1||JS_GetOwnProperty(ctx,&name,object,JS_ATOM_name)!=1)abort();
  union{double d;uint64_t u;} bits;JS_ToFloat64(ctx,&bits.d,length.value);rec[2]=bits.u;rec[3]=bits.u>>32;rec[4]=length.flags;rec[5]=name.flags;
  JSString *s=JS_VALUE_GET_STRING(name.value);rec[6]=s->len;for(unsigned i=0;i<s->len;i++)rec[7]=rec[7]*31+(s->is_wide_char?s->u.str16[i]:s->u.str8[i]);
  free_descriptor(ctx,&length);free_descriptor(ctx,&name);rec[8]=JS_IsConstructor(ctx,object);
  if(mode==13){if(JS_DefinePropertyValue(ctx,target,JS_ATOM_value,JS_DupValue(ctx,object),1)<0||JS_DefinePropertyValue(ctx,object,JS_ATOM_value,JS_DupValue(ctx,object),1)<0)abort();}
  JSValue arguments[]={JS_NewInt32(ctx,5),JS_NewInt32(ctx,6)};JSValue receiver=JS_NewInt32(ctx,8);int flags=0;
  if(mode==2||mode==16){flags=JS_CALL_FLAG_CONSTRUCTOR;receiver=object;}if(mode==3){flags=JS_CALL_FLAG_CONSTRUCTOR;receiver=alternate;}
  uintptr_t limit=ctx->rt->stack_limit;JSStackFrame *previous=ctx->rt->current_stack_frame;
  if(mode==12)ctx->rt->stack_limit=UINTPTR_MAX;
  JSValue result=js_call_bound_function(ctx,object,receiver,2,arguments,flags);ctx->rt->stack_limit=limit;
  if(JS_IsException(result)){JSValue error=JS_GetException(ctx);rec[10]=JS_IsNumber(error)?numeric(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}
  else {rec[9]=1;if(JS_IsObject(result)){JSValue field=checked(JS_GetProperty(ctx,result,JS_ATOM_value));rec[10]=numeric(field);JS_FreeValue(ctx,field);}else rec[10]=numeric(result);JS_FreeValue(ctx,result);}
  rec[15]=ctx->rt->current_stack_frame==previous;JS_FreeValue(ctx,object);
 }
 JS_FreeValue(ctx,target);JS_FreeValue(ctx,alternate);JS_RunGC(ctx->rt);for(int i=0;i<16;i++)word(rec[i]);
}
/* Observe, then execute the unchanged source finalizer, including its null
   dereference. Each failure probe is an independent process. */
static void observe_bound_finalizer(JSRuntime *rt,JSValue value){
 if(faults==1&&!JS_VALUE_GET_OBJ(value)->u.bound_function)fputs("BOUND_STATE_OOM\n",stderr);
 js_bound_function_finalizer(rt,value);
}
static void allocation_probe(JSContext *ctx,int position){
 mode=0;target=make_target(ctx,0);JSValue text=checked(JS_NewString(ctx,"owned bound argument"));
 /* Keep the empty prototype shape shared so descriptor installation exercises COW. */
 JSValue prototype=checked(JS_GetPrototype(ctx,target));
 JSValue sibling=checked(JS_NewObjectProto(ctx,prototype));JS_FreeValue(ctx,prototype);
 JSValue args[]={target,text};unsigned before=faults;fault_after=position;
 JSValue object=js_function_bind(ctx,target,2,args);fault_after=-1;
 unsigned ignored=0;
 if(!JS_IsException(object)){ignored=JS_HasException(ctx);JS_FreeValue(ctx,object);}
 JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
 if(__js_rc(JS_VALUE_GET_PTR(target))->ref_count!=1||__js_rc(JS_VALUE_GET_PTR(text))->ref_count!=1)abort();
 JS_FreeValue(ctx,text);JS_FreeValue(ctx,target);JS_FreeValue(ctx,sibling);JS_RunGC(ctx->rt);
 word(faults-before);word(ignored);
}
int main(int argc,char **argv){JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 if(argc==2){rt->class_array[JS_CLASS_BOUND_FUNCTION].finalizer=observe_bound_finalizer;allocation_probe(ctx,atoi(argv[1]));}
 else { CALLS }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.pointer { Pointer }
import js_core_types { FrameSlots }
import js_value { Value }
import js_bound_functions as bound
import js_exceptions as exceptions
import js_strings { Strings }
import js_string_types { stringReference }
import js_errors_test_support { FaultAllocator }
import js_array_storage_test_support { reference, rc }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_runtime as runtime
import native_stack { currentFrameAddress }
import js_gc as gc
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_bound_functions_test_support as fixture
import js_bound_functions_test_support { Hooks }
import js_property_get_test_support as base
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { kind: u32, mode: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe base.prepare(&mut hooks.base.base, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut fault = FaultAllocator { parent: move memory, armed: false, remaining: 0, persistent: false, failures: 0 }
 let mut position: usize = 0 let mut ignored: usize = 0
 while position < 32 {
  let function = run unsafe fixture.makeTarget(&mut hooks, &observer, ctx, 0, 0) |> Effect.provideMut<Allocator>(&mut fault)
  let text = run Strings.fromLatin1(b"owned bound argument") |> Effect.provideMut<Allocator>(&mut fault)
  fault.armed = true fault.remaining = position
  let mut bindValues = [function, text]
  let bindArguments = FrameSlots.Borrowed { data: Pointer.fromMutRef<Value>(&mut bindValues[0]), length: 2 }
  let result = run Effect.result(unsafe bound.bind(&mut hooks, &observer, ctx, function, &bindArguments)) |> Effect.provideMut<Allocator>(&mut fault)
  fault.armed = false
  match move result {
   Result<Value, JsException>.Success { value } => {
    if unsafe exceptions.has(rt) { ignored = ignored + 1 }
    if !unsafe fixture.isBound(value) { trap() }
    unsafe gc.release(&mut hooks, rt, value)
   }
   Result<Value, JsException>.Failure { .. } => { if !unsafe exceptions.has(rt) { trap() } }
  }
  let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending)
  if unsafe rc(reference(function)) != 1 || unsafe rc(stringReference(text)) != 1 { trap() }
  unsafe gc.release(&mut hooks, rt, function) unsafe gc.release(&mut hooks, rt, text)
  run unsafe gc.collect(&mut hooks, rt, true) |> Effect.provideMut<Allocator>(&mut fault) position = position + 1
 }
 if fault.failures <= 4 || ignored == 0 { trap() }
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 let mut writer = StdoutWriter.make()
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
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
    c_calls = '\n'.join(f'run_case(ctx,{k},{m});' for k, m in CASES)
    rows = ',\n'.join(f'Case {{ kind: {k}, mode: {m} }}' for k, m in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < cases.length {
  let record = run unsafe fixture.runCase(&observer, ctx, cases[at].kind, cases[at].mode) |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0
  while i < 16 { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-bound-functions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 # Disable source allocation arenas for real per-allocation failure probes; no ASan instrumentation.
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Bound function C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Bound function C oracle')
        source_crashes = source_failures = source_ignored = 0
        for position in range(32):
            probe = subprocess.run([str(temp / 'oracle'), str(position)], capture_output=True, timeout=60)
            if probe.returncode in (-signal.SIGSEGV, -signal.SIGBUS) and probe.stderr == b'BOUND_STATE_OOM\n':
                source_crashes += 1
                source_failures += 1
                continue
            if probe.returncode or len(probe.stdout) != 16:
                raise SystemExit(f'Unexpected C bound OOM failure at {position}: {probe.returncode}, {probe.stderr!r}')
            failures, ignored, allocations, size = struct.unpack('<4I', probe.stdout)
            if allocations or size or failures > 1 or ignored > 1:
                raise SystemExit(f'Invalid C bound OOM ledger at {position}: {probe.stdout.hex()}')
            source_failures += failures
            source_ignored += ignored
        if source_crashes != 1 or source_failures <= 4 or not source_ignored:
            raise SystemExit(f'Incomplete C bound failure phases: {source_crashes=}, {source_failures=}, {source_ignored=}')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="bound-functions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native Silk bound oracle', cwd=temp)
        if len(expected) != len(CASES) * 64 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C records or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset + 4], actual[offset:offset + 4]
                if c != native:
                    record, field = divmod(offset // 4, 16)
                    case = CASES[record] if record < len(CASES) else 'teardown'
                    raise SystemExit(f'Bound function {case}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS bound functions: {len(CASES)} cases; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; ordinary ledgers zero')
        print(f'OOM: 32 attempts per implementation; native and noncrashing C ledgers zero; '
              f'{source_crashes} pinned-source null bound-storage crash isolated, not replicated in Silk')


if __name__ == '__main__':
    main()
