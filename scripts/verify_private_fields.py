#!/usr/bin/env python3
"""Compare real native private storage/brands with separately compiled pinned C.

No C is linked into Silk. Every emitted result, exception class/message, owner
count and exotic-trap count is compared; independent teardown ledgers must clear.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE

ROOT = Path(__file__).resolve().parents[1]
CASES = [('field', kind, operation) for kind in range(9) for operation in range(6)]
CASES += [('brand', family, mode) for family in range(4) for mode in range(12)]
C_SOURCE = ALLOCATOR_SOURCE + r'''
static uint32_t rec[22],exotic_calls;
static JSValue unused(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv){abort();}
static int own_trap(JSContext *ctx,JSPropertyDescriptor *d,JSValueConst object,JSAtom atom){exotic_calls++;abort();}
static uint32_t text_hash(JSValue value){JSString *s=JS_VALUE_GET_STRING(value);uint32_t h=0;for(unsigned i=0;i<s->len;i++)h=h*31+(s->is_wide_char?s->u.str16[i]:s->u.str8[i]);return h;}
static unsigned error_kind(JSContext *ctx,JSValue value){
 if(!JS_IsObject(value)||JS_VALUE_GET_OBJ(value)->class_id!=JS_CLASS_ERROR)return 99;
 for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(value)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;
}
static void record(JSContext *ctx,unsigned stage,JSValue value){
 unsigned offset=stage*4;
 if(JS_IsException(value)){
  if(!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);rec[offset+1]=error_kind(ctx,error);
  JSValue message=checked(JS_GetProperty(ctx,error,JS_ATOM_message));if(JS_IsString(message))rec[offset+2]=text_hash(message);
  JS_FreeValue(ctx,message);JS_FreeValue(ctx,error);
 }else{
  rec[offset]=1;rec[offset+1]=JS_VALUE_GET_NORM_TAG(value)+100;
  if(JS_VALUE_GET_TAG(value)==JS_TAG_INT)rec[offset+2]=JS_VALUE_GET_INT(value);
  else if(JS_IsString(value)){rec[offset+2]=JS_VALUE_GET_STRING(value)->len;rec[offset+3]=text_hash(value);}
  else if(JS_VALUE_GET_TAG(value)==JS_TAG_BOOL)rec[offset+2]=JS_VALUE_GET_BOOL(value);
  JS_FreeValue(ctx,value);
 }
}
static JSValue void_value(int result){return result<0?JS_EXCEPTION:JS_UNDEFINED;}
static JSValue bool_value(int result){return result<0?JS_EXCEPTION:JS_MKVAL(JS_TAG_BOOL,result);}
static JSValue private_in(JSContext *ctx,JSValue object,JSValue key){
 JSValue slots[]={JS_DupValue(ctx,object),JS_DupValue(ctx,key)};
 if(js_operator_private_in(ctx,slots+2)<0){JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);return JS_EXCEPTION;}
 return slots[0];
}
static void field_case(JSContext *ctx,unsigned kind,unsigned operation){
 memset(rec,0,sizeof(rec));exotic_calls=0;
 JSValue name=checked(JS_NewSymbolFromAtom(ctx,JS_ATOM_value,JS_ATOM_TYPE_PRIVATE));
 JSValue other=checked(JS_NewSymbolFromAtom(ctx,JS_ATOM_value,JS_ATOM_TYPE_PRIVATE));
 JSValue incoming=checked(JS_NewString(ctx,"payload")),parent=JS_UNDEFINED,object;
 if(kind==2)object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));
 else if(kind==3){object=checked(JS_NewArray(ctx));if(JS_SetPropertyUint32(ctx,object,0,JS_NewInt32(ctx,1))<0)abort();}
 else if(kind==4)object=JS_NULL;
 else if(kind==5)object=JS_NewInt32(ctx,7);
 else if(kind==6)object=checked(JS_NewString(ctx,"primitive"));
 else if(kind==7){const char *text="new Uint8Array([1,2])";object=checked(JS_Eval(ctx,text,strlen(text),"private.js",JS_EVAL_TYPE_GLOBAL));}
 else if(kind==8){parent=checked(JS_NewObjectProto(ctx,JS_NULL));if(JS_DefinePrivateField(ctx,parent,name,JS_NewInt32(ctx,11))<0)abort();object=checked(JS_NewObjectProto(ctx,parent));}
 else object=checked(JS_NewObjectProto(ctx,JS_NULL));
 if(kind==1&&JS_PreventExtensions(ctx,object)<0)abort();
 if(operation==1&&JS_IsObject(object)&&JS_DefinePrivateField(ctx,object,name,JS_NewInt32(ctx,11))<0)abort();
 JSValue defined_name=name,queried_name=name,public_name=JS_UNDEFINED;
 if(operation==3)defined_name=queried_name=JS_NewInt32(ctx,9);
 if(operation==4)queried_name=other;
 if(operation==5)queried_name=public_name=checked(JS_NewString(ctx,"length"));
 record(ctx,0,operation==2?JS_UNDEFINED:void_value(JS_DefinePrivateField(ctx,object,defined_name,JS_DupValue(ctx,incoming))));
 record(ctx,1,JS_GetPrivateField(ctx,object,queried_name));
 record(ctx,2,void_value(JS_SetPrivateField(ctx,object,queried_name,JS_NewInt32(ctx,22))));
 record(ctx,3,private_in(ctx,object,queried_name));record(ctx,4,JS_GetPrivateField(ctx,object,queried_name));
 rec[20]=__js_rc(JS_VALUE_GET_PTR(incoming))->ref_count;rec[21]=exotic_calls;
 JS_FreeValue(ctx,incoming);JS_FreeValue(ctx,object);JS_FreeValue(ctx,parent);JS_FreeValue(ctx,name);JS_FreeValue(ctx,other);JS_FreeValue(ctx,public_name);
 for(int i=0;i<22;i++)word(rec[i]);
}
static JSValue method(JSContext *ctx,JSValue home,unsigned family,int attached){
 const char *sources[]={"(function(){})","(function*(){})","(async function(){})","(async function*(){})"};
 const char *source=sources[family];JSValue function=checked(JS_Eval(ctx,source,strlen(source),"brand.js",JS_EVAL_TYPE_GLOBAL));
 if(attached){JS_DupValue(ctx,home);JS_VALUE_GET_OBJ(function)->u.func.home_object=JS_VALUE_GET_OBJ(home);}
 return function;
}
static void brand_case(JSContext *ctx,unsigned family,unsigned mode){
 memset(rec,0,sizeof(rec));JSValue home=checked(JS_NewObjectProto(ctx,JS_NULL)),other_home=checked(JS_NewObjectProto(ctx,JS_NULL));
 JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL)),child=checked(JS_NewObjectProto(ctx,object));
 JSValue function=method(ctx,home,family,mode!=7),other_method=method(ctx,other_home,0,1);
 if(JS_AddBrand(ctx,JS_NULL,other_home)<0)abort();JSValue native=JS_UNDEFINED,fn=function,receiver=object;
 if(mode==1)receiver=child;if(mode==5)fn=JS_NewInt32(ctx,1);
 if(mode==6)fn=native=checked(JS_NewCFunction(ctx,unused,"native",0));if(mode==8)receiver=JS_NULL;
 JSValue installed=JS_UNDEFINED;
 if(mode==2){if(JS_AddBrand(ctx,object,other_home)<0)abort();installed=void_value(JS_AddBrand(ctx,JS_NULL,home));}
 else if(mode==3){}
 else if(mode==4){if(JS_DefinePropertyValue(ctx,home,JS_ATOM_Private_brand,JS_NewInt32(ctx,17),7)<0)abort();}
 else if(mode==10)installed=void_value(JS_AddBrand(ctx,object,JS_NULL));
 else if(mode==11)installed=void_value(JS_AddBrand(ctx,JS_NewInt32(ctx,3),home));
 else{installed=void_value(JS_AddBrand(ctx,object,home));if(mode==9)installed=void_value(JS_AddBrand(ctx,object,home));}
 record(ctx,0,installed);record(ctx,1,bool_value(JS_CheckBrand(ctx,receiver,fn)));record(ctx,2,private_in(ctx,receiver,fn));
 record(ctx,3,bool_value(JS_CheckBrand(ctx,child,fn)));record(ctx,4,bool_value(JS_CheckBrand(ctx,object,other_method)));
 rec[20]=__js_rc(JS_VALUE_GET_PTR(function))->ref_count;
 JS_FreeValue(ctx,function);JS_FreeValue(ctx,other_method);JS_FreeValue(ctx,native);JS_FreeValue(ctx,child);JS_FreeValue(ctx,object);JS_FreeValue(ctx,home);JS_FreeValue(ctx,other_home);
 for(int i=0;i<22;i++)word(rec[i]);
}
static void faults_sweep(JSContext *ctx){
 unsigned refused=0;
 for(int phase=0;phase<2;phase++)for(int position=0;position<32;position++){
  JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL)),home=checked(JS_NewObjectProto(ctx,JS_NULL));
  JSValue name=checked(JS_NewSymbolFromAtom(ctx,JS_ATOM_value,JS_ATOM_TYPE_PRIVATE)),incoming=checked(JS_NewString(ctx,"owned"));
  unsigned before=faults;fault_after=position;
  int result=phase?JS_AddBrand(ctx,object,home):JS_DefinePrivateField(ctx,object,name,JS_DupValue(ctx,incoming));fault_after=-1;refused+=faults-before;
  if(result<0&&(!JS_HasException(ctx)||__js_rc(JS_VALUE_GET_PTR(incoming))->ref_count!=1))abort();
  JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
  JS_FreeValue(ctx,object);JS_FreeValue(ctx,home);JS_FreeValue(ctx,name);JS_FreeValue(ctx,incoming);JS_RunGC(ctx->rt);
 }
 if(!refused)abort();
}
int main(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 JSClassExoticMethods exotic={.get_own_property=own_trap};JSClassDef definition={.class_name="PrivateExotic",.exotic=&exotic};
 if(JS_NewClass(rt,67,&definition))abort();
 CALLS
 faults_sweep(ctx);JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;
}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_runtime as runtime
import js_gc as gc
import js_value { Value }
import js_private_fields_cases as cases
import js_private_fields_test_support as fixture
import js_private_fields as fields
import js_runtime_registry as registry
import js_runtime_classes as classDefinitions
import js_class_data as classes
import js_atom_data as atoms
import js_object_allocate as objects
import js_property_mutations_test_support { Hooks }
import js_property_get_test_support as base
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap, rc }
import js_string_types { StringLengthError, stringReference }
import js_strings { Strings }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_errors_test_support { FaultAllocator }
struct Case { brand: bool, kind: u32, operation: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer) run unsafe base.prepare(&mut hooks.base, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let asyncClass = run unsafe registry.registerClassAtom(rt, classes.JS_CLASS_ASYNC_FUNCTION, atoms.JS_ATOM_AsyncFunction, classDefinitions.asyncFunctionDefinition()) |> Effect.provideMut<Allocator>(&mut memory)
 let asyncGeneratorClass = run unsafe registry.registerClassAtom(rt, classes.JS_CLASS_ASYNC_GENERATOR_FUNCTION, atoms.JS_ATOM_AsyncGeneratorFunction, classDefinitions.asyncGeneratorFunctionDefinition()) |> Effect.provideMut<Allocator>(&mut memory)
 if !asyncClass || !asyncGeneratorClass { trap() }
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut fault = FaultAllocator { parent: move memory, armed: false, remaining: 0, persistent: false, failures: 0 }
 let mut phase: usize = 0
 while phase < 2 {
  let mut position: usize = 0
  while position < 32 {
   let object = run unsafe objects.withPrototype(&mut hooks, &observer, ctx, Value.Null) |> Effect.provideMut<Allocator>(&mut fault)
   let home = run unsafe objects.withPrototype(&mut hooks, &observer, ctx, Value.Null) |> Effect.provideMut<Allocator>(&mut fault)
   let name = run unsafe fixture.symbol(rt) |> Effect.provideMut<Allocator>(&mut fault)
   let incoming = run Strings.fromLatin1(b"owned") |> Effect.provideMut<Allocator>(&mut fault)
   fault.armed = true fault.remaining = position
   let mut result = Result<(), JsException>.Success { value: () }
   if phase == 0 { result = run Effect.result(unsafe fields.definePrivateField(&mut hooks, ctx, object, name, unsafe incoming.retained())) |> Effect.provideMut<Allocator>(&mut fault) }
   else { result = run Effect.result(unsafe fields.addBrand(&mut hooks, ctx, object, home)) |> Effect.provideMut<Allocator>(&mut fault) }
   fault.armed = false
   match move result { Result<(), JsException>.Failure { .. } => { if !unsafe exceptions.has(rt) || unsafe rc(stringReference(incoming)) != 1 { trap() } } _ => () }
   let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending)
   unsafe gc.release(&mut hooks, rt, object) unsafe gc.release(&mut hooks, rt, home)
   unsafe gc.release(&mut hooks, rt, name) unsafe gc.release(&mut hooks, rt, incoming)
   run unsafe gc.collect(&mut hooks, rt, true) |> Effect.provideMut<Allocator>(&mut fault) position = position + 1
  }
  phase = phase + 1
 }
 if fault.failures == 0 { trap() }
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system) run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut system)
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_calls = '\n'.join(f'{kind}_case(ctx,{a},{b});' for kind, a, b in CASES)
    rows = ',\n'.join(f'Case {{ brand: {str(kind == "brand").lower()}, kind: {a}, operation: {b} }}' for kind, a, b in CASES)
    s_calls = f'let inputs: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < inputs.length {
  let mut record: [u32; 22] = [0; 22]
  if inputs[at].brand { record = run unsafe cases.brandCase(&observer, ctx, inputs[at].kind, inputs[at].operation) |> Effect.provideMut<Allocator>(&mut memory) }
  else { record = run unsafe cases.fieldCase(&observer, ctx, inputs[at].kind, inputs[at].operation) |> Effect.provideMut<Allocator>(&mut memory) }
  let mut i: usize = 0 while i < 22 { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-private-fields-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread',
                 '-o', str(temp / 'oracle')], 600, owner='Private field C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Private field C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="private-fields-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200,
                         owner='Native Silk private fields', cwd=temp)
        if len(expected) != len(CASES) * 88 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C records or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                left, right = expected[offset:offset + 4], actual[offset:offset + 4]
                if left != right:
                    case, word = divmod(offset // 4, 22)
                    row = CASES[case] if case < len(CASES) else 'teardown'
                    raise SystemExit(f'Private {row} word {word}: C={left.hex()} Silk={right.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS private fields/brands: {len(CASES)} cases; 64 allocation attempts per implementation; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; both ledgers zero')

if __name__ == '__main__':
    main()
