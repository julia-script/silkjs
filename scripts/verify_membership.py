#!/usr/bin/env python3
"""Execute native membership against unchanged pinned QuickJS in separate processes.

C/native records cover borrowed ordinary/bound/custom instanceof, real computed
callbacks, throwing/mutating getters, dynamic exotic chains and timeout ordering,
in key coercion precedence, consuming cleanup and every typeof tag plus HTMLDDA.
Opaque nonobject typeof probes are borrowed tag aliases, never dereferenced/freed.
Both underlying allocator ledgers must reach zero. No native C bindings are used.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_native_functions import C_SOURCE as ALLOCATION_ORACLE
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [*range(29), 30, 31, 32, 33, 34]
FIELDS = ('success', 'result_or_error', 'method_gets', 'prototype_gets', 'calls',
          'coercions', 'exotic_gets', 'interrupts', 'counter', 'borrowed_refs', 'typeof_rhs', 'slots_cleared')
C_SOURCE = ALLOCATION_ORACLE.split('static uint32_t rec')[0] + r'''
static uint32_t rec[12]; static int mode; static JSValue instance,replacement;
static JSContext *active_context;static int finalized_pending;
static void observe_closure_finalizer(JSRuntime *rt,JSValue value){
 if(active_context&&JS_HasException(active_context))finalized_pending=1;
 js_c_function_data_finalizer(rt,value);
}
typedef struct { JSValue prototype; } Stored;
static void finalize(JSRuntime *rt,JSValue value){Stored *s=JS_GetOpaque(value,67);JS_FreeValueRT(rt,s->prototype);js_free_rt(rt,s);}
static void trace(JSRuntime *rt,JSValueConst value,JS_MarkFunc *mark){Stored *s=JS_GetOpaque(value,67);JS_MarkValue(rt,s->prototype,mark);}
static JSValue exotic_get(JSContext *ctx,JSValueConst value){
 rec[6]++;JS_RunGC(ctx->rt);if(mode==17)return JS_DupValue(ctx,value);
 if(mode==18)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 return JS_DupValue(ctx,((Stored*)JS_GetOpaque(value,67))->prototype);
}
static int interrupted(JSRuntime *rt,void *opaque){rec[7]++;JS_RunGC(rt);return mode==17;}
static JSValue callback(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int body,JSValue *data){
 if(body==40){
  rec[4]++;if(argc!=1||!JS_IsObject(receiver))abort();
  JSValue field=checked(JS_GetProperty(ctx,argv[0],JS_ATOM_value));
  int answer=JS_IsNumber(field)&&JS_VALUE_GET_INT(field)==42;JS_FreeValue(ctx,field);JS_RunGC(ctx->rt);
  if(mode==8)return JS_Throw(ctx,JS_NewInt32(ctx,707));
  if(mode==30||mode==31)return JS_DupValue(ctx,replacement);return JS_NewInt32(ctx,answer?7:0);
 }
 if(body==41){rec[2]++;if(mode==9)return JS_Throw(ctx,JS_NewInt32(ctx,707));
  if(mode==10&&JS_SetPrototype(ctx,instance,replacement)<0)abort();}
 else if(body==42)rec[3]++;
 else if(body==43){rec[5]++;if(mode==23)return JS_Throw(ctx,JS_NewInt32(ctx,707));}
 else abort();
 JS_RunGC(ctx->rt);return JS_DupValue(ctx,data[0]);
}
static JSValue closure(JSContext *ctx,int body,JSValue capture){return checked(JS_NewCFunctionData(ctx,callback,0,body,1,&capture));}
static void property(JSContext *ctx,JSValue object,JSAtom atom,JSValue value,int accessor){
 int result;if(accessor)result=JS_DefineProperty(ctx,object,atom,JS_UNDEFINED,value,JS_UNDEFINED,
  JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|JS_PROP_HAS_ENUMERABLE|5);
 else result=JS_DefinePropertyValue(ctx,object,atom,JS_DupValue(ctx,value),7);
 if(result<0)abort();
}
static unsigned error_code(JSContext *ctx,JSValue error){
 if(JS_IsNumber(error))return JS_VALUE_GET_INT(error);
 if(!JS_IsObject(error)||JS_VALUE_GET_OBJ(error)->class_id!=JS_CLASS_ERROR)return 199;
 for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(error)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return 100+i;
 return 199;
}
static int refs(JSValue value){return JS_IsObject(value)?__js_rc(JS_VALUE_GET_PTR(value))->ref_count:0;}
static void run_case(JSContext *ctx,int scenario){
 memset(rec,0,sizeof(rec));mode=scenario;if(scenario==32)mode=0;else if(scenario==33)mode=21;else if(scenario==34)mode=23;
 JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL)),other=checked(JS_NewObjectProto(ctx,proto));
 JSValue function=closure(ctx,40,JS_UNDEFINED),getter=closure(ctx,42,mode==11?JS_NewInt32(ctx,1):proto);
 property(ctx,function,JS_ATOM_prototype,getter,1);
 instance=checked(JS_NewObjectProto(ctx,proto));
 if((mode==1||mode==10)&&JS_SetPrototype(ctx,instance,JS_NULL)<0)abort();
 if(mode>=14&&mode<=20){
  JS_FreeValue(ctx,instance);JSValue successor=proto;if(mode==15||mode==20)successor=JS_NULL;else if(mode==16)successor=other;
  instance=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored *s=js_mallocz(ctx,sizeof(*s));if(!s)abort();s->prototype=JS_DupValue(ctx,successor);JS_SetOpaque(instance,s);
  if(mode==19&&JS_SetPrototype(ctx,instance,proto)<0)abort();
  if(mode==20)JS_VALUE_GET_OBJ(instance)->fast_array=1;
 }
 replacement=proto;property(ctx,instance,JS_ATOM_value,JS_NewInt32(ctx,mode==6?0:42),0);
 JSValue rhs=JS_DupValue(ctx,function);
 if(mode==3){JS_FreeValue(ctx,rhs);rhs=JS_NewInt32(ctx,1);}
 else if(mode==4||mode==26){JS_FreeValue(ctx,rhs);rhs=checked(JS_NewObjectProto(ctx,JS_NULL));}
 JSValue method=JS_UNDEFINED;
 if((mode>=5&&mode<=8)||mode==13||mode==30||mode==31)method=JS_DupValue(ctx,function);
 if(mode==7){JS_FreeValue(ctx,method);method=JS_NewInt32(ctx,1);}if(mode==27)method=JS_NULL;
 if(JS_IsObject(rhs)){
  if(mode==9||mode==10){JSValue g=closure(ctx,41,JS_UNDEFINED);property(ctx,rhs,JS_ATOM_Symbol_hasInstance,g,1);JS_FreeValue(ctx,g);}
  else property(ctx,rhs,JS_ATOM_Symbol_hasInstance,method,0);
 }
 JS_FreeValue(ctx,method);
 if(mode==12||mode==13){JSValue padded=JS_UNDEFINED;JSValue wrapper=checked(js_function_bind(ctx,rhs,0,&padded));JS_FreeValue(ctx,rhs);rhs=wrapper;}
 if(mode==30)JS_VALUE_GET_OBJ(proto)->is_HTMLDDA=1;
 JSValue lhs=JS_DupValue(ctx,instance);
 if(mode==2||mode==28){JS_FreeValue(ctx,lhs);lhs=JS_NewInt32(ctx,42);}
 if(mode>=21&&mode<=24){
  JS_FreeValue(ctx,lhs);lhs=checked(JS_NewObjectProto(ctx,JS_NULL));
  JSValue text=checked(JS_NewString(ctx,mode==24?"missing":"value")),key=closure(ctx,43,text);JS_FreeValue(ctx,text);
  property(ctx,lhs,JS_ATOM_Symbol_toPrimitive,key,0);JS_FreeValue(ctx,key);
  JS_FreeValue(ctx,rhs);rhs=JS_DupValue(ctx,instance);if(mode==22){JS_FreeValue(ctx,rhs);rhs=JS_NewInt32(ctx,1);}
 }
 if(mode==25){JS_FreeValue(ctx,rhs);rhs=JS_NewInt32(ctx,1);}
 JS_SetInterruptHandler(ctx->rt,interrupted,NULL);ctx->interrupt_counter=(mode>=14&&mode<=20)?2:1;
 int left_refs=refs(lhs),right_refs=refs(rhs),result;
 finalized_pending=0;
 if(mode==26||mode==28)result=JS_OrdinaryIsInstanceOf(ctx,lhs,rhs);
 else if((mode>=21&&mode<=24)||mode==25||scenario>=32){
  /* The source opcode consumes success; its caller cleans failure. Borrowed
     probes duplicate roots, whereas consuming probes transfer the real slots. */
  int consuming=mode==25||scenario>=32;
  JSValue slots[]={consuming?lhs:JS_DupValue(ctx,lhs),consuming?rhs:JS_DupValue(ctx,rhs)};
  int status=(mode>=21&&mode<=24)?js_operator_in(ctx,slots+2):js_operator_instanceof(ctx,slots+2);
  if(status<0){result=-1;JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);}
  else result=JS_VALUE_GET_BOOL(slots[0]);
  if(consuming)lhs=rhs=JS_UNDEFINED;
 }else result=JS_IsInstanceOf(ctx,lhs,rhs);
 if(result<0){if(!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);rec[1]=error_code(ctx,error);JS_FreeValue(ctx,error);}
 else {rec[0]=1;rec[1]=result;}
 if(mode==25||scenario>=32){rhs=JS_UNDEFINED;lhs=result<0?JS_UNDEFINED:JS_NewBool(ctx,result);rec[11]=1|(finalized_pending?2:0);}
 rec[8]=ctx->interrupt_counter;rec[9]=1;
 if(JS_IsObject(lhs)&&refs(lhs)!=left_refs)rec[9]=0;
 if(JS_IsObject(rhs)&&refs(rhs)!=right_refs)rec[9]=0;
 rec[10]=js_operator_typeof(ctx,rhs);
 JS_FreeValue(ctx,lhs);JS_FreeValue(ctx,rhs);JS_FreeValue(ctx,getter);JS_FreeValue(ctx,function);
 JS_FreeValue(ctx,instance);JS_FreeValue(ctx,other);JS_FreeValue(ctx,proto);JS_RunGC(ctx->rt);
 for(int i=0;i<12;i++)word(rec[i]);
}
static void types(JSContext *ctx){
 JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL)),function=closure(ctx,40,JS_UNDEFINED);
 JSValue padded=JS_UNDEFINED;JSValue wrapper=checked(js_function_bind(ctx,function,0,&padded));void *p=JS_VALUE_GET_PTR(object);
 JSValue values[]={JS_MKPTR(JS_TAG_BIG_INT,p),JS_MKPTR(JS_TAG_SYMBOL,p),JS_MKPTR(JS_TAG_STRING,p),
  JS_MKPTR(JS_TAG_STRING_ROPE,p),JS_MKPTR(JS_TAG_MODULE,p),JS_MKPTR(JS_TAG_FUNCTION_BYTECODE,p),object,
  JS_NewInt32(ctx,1),JS_TRUE,JS_NULL,JS_UNDEFINED,JS_UNINITIALIZED,JS_MKVAL(JS_TAG_CATCH_OFFSET,1),JS_EXCEPTION,
  JS_MKVAL(JS_TAG_SHORT_BIG_INT,1),__JS_NewFloat64(ctx,1.5),function,wrapper};
 for(unsigned i=0;i<sizeof(values)/sizeof(values[0]);i++)word(js_operator_typeof(ctx,values[i]));
 JS_VALUE_GET_OBJ(object)->is_HTMLDDA=1;JS_VALUE_GET_OBJ(function)->is_HTMLDDA=1;
 word(js_operator_typeof(ctx,object));word(js_operator_typeof(ctx,function));
 JS_FreeValue(ctx,wrapper);JS_FreeValue(ctx,function);JS_FreeValue(ctx,object);
}
int main(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 active_context=ctx;rt->class_array[JS_CLASS_C_FUNCTION_DATA].finalizer=observe_closure_finalizer;
 JSClassExoticMethods methods={.get_prototype=exotic_get};
 JSClassDef definition={.class_name="StoredPrototype",.finalizer=finalize,.gc_mark=trace,.exotic=&methods};
 if(JS_NewClass(rt,67,&definition))abort();
 CALLS
 types(ctx);JS_FreeContext(ctx);active_context=NULL;JS_FreeRuntime(rt);word(live_count);word(live_bytes);return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_runtime as runtime
import native_stack { currentFrameAddress }
import js_gc as gc
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_membership_test_support as fixture
import js_membership_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let types = run unsafe fixture.typeMatrix(&observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut t: usize = 0 while t < types.length { run out.writeU32(types[t]) |> Effect.provideMut<Allocator>(&mut system) t = t + 1 }
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
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
    c_calls = '\n'.join(f'run_case(ctx,{mode});' for mode in CASES)
    s_calls = 'let modes: [u32; %d] = [%s]\n' % (len(CASES), ','.join(map(str, CASES))) + r'''
 let mut at: usize = 0
 while at < modes.length {
  let record = run unsafe fixture.runCase(&observer, ctx, modes[at]) |> Effect.provideMut<Allocator>(&mut memory)
  let mut i: usize = 0 while i < record.length { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-membership-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Membership C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Membership C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="membership-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native Silk membership oracle', cwd=temp)
        if len(expected) != len(CASES) * 48 + 80 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C record length or nonzero allocator ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset + 4], actual[offset:offset + 4]
                if c != native:
                    record, field = divmod(offset // 4, 12)
                    location = f'mode {CASES[record]} {FIELDS[field]}' if record < len(CASES) else f'typeof/ledger word {(offset-len(CASES)*48)//4}'
                    raise SystemExit(f'{location}: C={c.hex()} Silk={native.hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS membership: {len(CASES)} cases, 20 typeof tags; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; ledgers zero')


if __name__ == '__main__':
    main()
