#!/usr/bin/env python3
"""Compare native class creation and method names with unchanged pinned QuickJS."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE

ROOT = Path(__file__).resolve().parents[1]
CASES = [('class', parent, name) for parent in range(10) for name in range(11)]
CASES += [('method', mode, name) for mode in range(6) for name in (2, 3, 4, 5, 6, 10)]
C_SOURCE = ALLOCATOR_SOURCE + r'''
static unsigned calls;
static uint32_t hash(JSValue value) {
 JSString *s=JS_VALUE_GET_STRING(value);uint32_t h=0;
 for(int i=0;i<s->len;i++)h=h*31+(s->is_wide_char?s->u.str16[i]:s->u.str8[i]);return h;
}
static int error_kind(JSContext *ctx,JSValue error) {
 if(!JS_IsObject(error))return 99;JSObject *p=JS_VALUE_GET_OBJ(error);
 if(p->class_id!=JS_CLASS_ERROR)return 99;
 for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;
}
static JSValue get_owned(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int magic,JSValue *data) {
 calls++;JS_RunGC(ctx->rt);if(magic)return JS_Throw(ctx,JS_DupValue(ctx,data[0]));return JS_DupValue(ctx,data[0]);
}
static JSValue make_key(JSContext *ctx,int kind) {
 if(kind==2)return checked(JS_NewString(ctx,"named"));
 if((kind>=3&&kind<=5)||kind==10) {
  return checked(JS_NewSymbol(ctx,kind==4?NULL:kind==3?"named":kind==10?"\xce\xbb":"",FALSE));
 }
 if(kind==6)return JS_NewInt32(ctx,123);
 if(kind==7||kind==8) {
  JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL));
  JSValue result=kind==7?checked(JS_NewString(ctx,"computed")):JS_NewInt32(ctx,37);
  JSValue method=checked(JS_NewCFunctionData(ctx,get_owned,0,kind==8,1,&result));
  if(JS_DefinePropertyValue(ctx,object,JS_ATOM_Symbol_toPrimitive,method,7)<0)abort();
  JS_FreeValue(ctx,result);return object;
 }
 return JS_UNDEFINED;
}
static JSValue make_bytecode(JSContext *ctx,int home,int prototype) {
 const char *text="(function(a,b){})";
 JSValue function=checked(JS_Eval(ctx,text,strlen(text),"class-consumer",JS_EVAL_TYPE_GLOBAL));
 JSFunctionBytecode *b=JS_VALUE_GET_OBJ(function)->u.func.function_bytecode;
 __js_rc(b)->ref_count++;b->need_home_object=home;b->has_prototype=prototype;
 JSValue result=JS_MKPTR(JS_TAG_FUNCTION_BYTECODE,b);JS_FreeValue(ctx,function);return result;
}
static void error_record(JSContext *ctx,uint32_t *out) {
 if(!JS_HasException(ctx))return;JSValue error=JS_GetException(ctx);
 out[1]=error_kind(ctx,error);out[3]=JS_VALUE_GET_TAG(error)+100;
 if(JS_IsObject(error)) { JSProperty *pr;JSShapeProperty *p=find_own_property(&pr,JS_VALUE_GET_OBJ(error),JS_ATOM_message);
  if(p&&JS_IsString(pr->u.value))out[2]=hash(pr->u.value);
 }else if(JS_VALUE_GET_TAG(error)==JS_TAG_INT)out[2]=JS_VALUE_GET_INT(error);
 JS_FreeValue(ctx,error);
}
static void name_record(JSValue object,uint32_t *out) {
 JSProperty *pr;JSShapeProperty *p=find_own_property(&pr,JS_VALUE_GET_OBJ(object),JS_ATOM_name);
 if(!p)return;out[10]=1;out[11]=JS_VALUE_GET_TAG(pr->u.value)+100;out[14]=p->flags;
 if(JS_IsString(pr->u.value)){out[12]=JS_VALUE_GET_STRING(pr->u.value)->len;out[13]=hash(pr->u.value);}
}
static int has_parent(JSValue object,JSValue parent) {
 return JS_VALUE_GET_OBJ(object)->shape->proto==(JS_IsObject(parent)?JS_VALUE_GET_OBJ(parent):NULL);
}
static void class_case(JSContext *ctx,int parent_kind,int name_kind) {
 uint32_t out[24]={0};calls=0;
 JSValue parent_proto=checked(JS_NewObjectProto(ctx,JS_NULL));
 JSValue parent=JS_UNDEFINED;int flags=JS_DEFINE_CLASS_HAS_HERITAGE;
 if(parent_kind==0)flags=0;else if(parent_kind==1)parent=JS_NULL;
 else if(parent_kind==4)parent=JS_NewInt32(ctx,8);
 else {
  parent=checked(JS_NewObjectProto(ctx,JS_NULL));JS_SetConstructorBit(ctx,parent,parent_kind!=3);
  JSValue value=JS_DupValue(ctx,parent_proto);
  if(parent_kind==5||parent_kind==7){JS_FreeValue(ctx,value);value=JS_NewInt32(ctx,37);}
  if(parent_kind==8){JS_FreeValue(ctx,value);value=JS_NULL;}
  if(parent_kind==9){JS_FreeValue(ctx,value);value=JS_UNDEFINED;}
  if(parent_kind>=6){JSValue getter=checked(JS_NewCFunctionData(ctx,get_owned,0,parent_kind==7,1,&value));
   if(JS_DefinePropertyGetSet(ctx,parent,JS_ATOM_prototype,getter,JS_UNDEFINED,1)<0)abort();JS_FreeValue(ctx,value);
  }else if(JS_DefinePropertyValue(ctx,parent,JS_ATOM_prototype,value,3)<0)abort();
 }
 JSValue parent_root=JS_DupValue(ctx,parent);
 JSValue code=make_bytecode(ctx,(name_kind&1)==0,1),observed=JS_DupValue(ctx,code);
 JSValue key=make_key(ctx,name_kind);JSAtom name=JS_ATOM_value;int computed=0;
 if(name_kind==1)name=JS_ATOM_NULL;else if(name_kind==9)name=__JS_AtomFromUInt32(123);else if(name_kind>=2)computed=1;
 JSValue stack[3]={key,parent,code};
 int result=js_op_define_class(ctx,stack+3,name,flags,NULL,NULL,computed);
 parent=stack[1];code=stack[2];
 if(result==0){
  out[0]=1;out[5]=JS_IsConstructor(ctx,parent);
  JSValue expected_parent=(parent_kind<=1)?ctx->function_proto:parent_root;
  JSValue expected_proto=parent_kind==0?ctx->class_proto[JS_CLASS_OBJECT]:parent_proto;
  if(parent_kind==1||parent_kind==8)expected_proto=JS_NULL;
  out[6]=has_parent(parent,expected_parent);out[7]=has_parent(code,expected_proto);
  JSProperty *pr;JSShapeProperty *p=find_own_property(&pr,JS_VALUE_GET_OBJ(parent),JS_ATOM_length);
  out[8]=p&&JS_VALUE_GET_TAG(pr->u.value)==JS_TAG_INT?JS_VALUE_GET_INT(pr->u.value):0xffffffff;out[9]=p?p->flags:0;
  name_record(parent,out);
  p=find_own_property(&pr,JS_VALUE_GET_OBJ(parent),JS_ATOM_prototype);out[15]=p->flags;out[16]=JS_VALUE_GET_OBJ(pr->u.value)==JS_VALUE_GET_OBJ(code);
  p=find_own_property(&pr,JS_VALUE_GET_OBJ(code),JS_ATOM_constructor);out[17]=p->flags;out[18]=JS_VALUE_GET_OBJ(pr->u.value)==JS_VALUE_GET_OBJ(parent);
  out[19]=JS_VALUE_GET_OBJ(parent)->u.func.home_object==JS_VALUE_GET_OBJ(code);
  out[21]=get_shape_prop(JS_VALUE_GET_OBJ(code)->shape)[0].atom==JS_ATOM_constructor;
 }else out[4]=JS_IsUndefined(parent)&&JS_IsUndefined(code);
 out[20]=calls;out[22]=__js_rc(JS_VALUE_GET_PTR(observed))->ref_count;error_record(ctx,out);
 JS_FreeValue(ctx,parent);JS_FreeValue(ctx,code);JS_FreeValue(ctx,observed);JS_FreeValue(ctx,key);
 JS_FreeValue(ctx,parent_root);JS_FreeValue(ctx,parent_proto);JS_RunGC(ctx->rt);
 for(int i=0;i<24;i++)word(out[i]);
}
static void method_case(JSContext *ctx,int mode,int name_kind) {
 uint32_t out[24]={0};calls=0;
 JSValue home=checked(JS_NewObjectProto(ctx,JS_NULL)),previous=checked(JS_NewObjectProto(ctx,JS_NULL));
 JSValue function=checked(js_closure(ctx,make_bytecode(ctx,mode!=4,0),NULL,NULL,FALSE));
 js_method_set_home_object(ctx,function,previous);
 if(mode==5&&JS_DefinePropertyValue(ctx,function,JS_ATOM_name,checked(JS_NewString(ctx,"fixed")),0)<0)abort();
 JSValue key=make_key(ctx,name_kind);JSAtom atom=JS_ValueToAtom(ctx,key);if(!atom)abort();
 int flags=0;if(mode==1||mode==3)flags|=JS_PROP_HAS_GET;if(mode==2||mode==3)flags|=JS_PROP_HAS_SET;
 out[0]=js_method_set_properties(ctx,function,atom,flags,home)==0;
 name_record(function,out);error_record(ctx,out);
 out[19]=JS_VALUE_GET_OBJ(function)->u.func.home_object==JS_VALUE_GET_OBJ(home);out[20]=calls;
 out[22]=__js_rc(JS_VALUE_GET_OBJ(home))->ref_count;out[23]=__js_rc(JS_VALUE_GET_OBJ(previous))->ref_count;
 JS_FreeAtom(ctx,atom);JS_FreeValue(ctx,key);JS_FreeValue(ctx,function);JS_FreeValue(ctx,home);JS_FreeValue(ctx,previous);JS_RunGC(ctx->rt);
 for(int i=0;i<24;i++)word(out[i]);
}
static void name_oom(JSContext *ctx) {
 JSValue object=checked(JS_NewObjectProto(ctx,JS_NULL));fault_after=0;
 int result=JS_DefineObjectName(ctx,object,__JS_AtomFromUInt32(123),1);fault_after=-1;
 JSProperty *pr;JSShapeProperty *p=find_own_property(&pr,JS_VALUE_GET_OBJ(object),JS_ATOM_name);
 word(result==0);word(p&&JS_IsException(pr->u.value));
 JSValue error=JS_GetException(ctx);word(error_kind(ctx,error)==6);word(p?p->flags:0);
 JS_FreeValue(ctx,error);JS_FreeValue(ctx,object);
}
static void fault_sweep(JSContext *ctx) {
 for(int phase=0;phase<2;phase++)for(int position=0;position<64;position++) {
  if(phase==0){
   JSValue code=make_bytecode(ctx,1,1),observed=JS_DupValue(ctx,code);
   JSValue stack[2]={JS_UNDEFINED,code};fault_after=position;
   int result=js_op_define_class(ctx,stack+2,JS_ATOM_value,0,NULL,NULL,FALSE);fault_after=-1;
   if(result<0&&(!JS_HasException(ctx)||!JS_IsUndefined(stack[0])||!JS_IsUndefined(stack[1])))abort();
   if(result==0&&(!JS_IsObject(stack[0])||!JS_IsObject(stack[1])))abort();
   JS_FreeValue(ctx,JS_GetException(ctx));JS_FreeValue(ctx,stack[0]);JS_FreeValue(ctx,stack[1]);JS_RunGC(ctx->rt);
   if(__js_rc(JS_VALUE_GET_PTR(observed))->ref_count!=1)abort();JS_FreeValue(ctx,observed);
  }else{
   JSValue home=checked(JS_NewObjectProto(ctx,JS_NULL)),previous=checked(JS_NewObjectProto(ctx,JS_NULL));
   JSValue function=checked(js_closure(ctx,make_bytecode(ctx,1,0),NULL,NULL,FALSE));js_method_set_home_object(ctx,function,previous);
   JSValue key=make_key(ctx,3);JSAtom atom=JS_ValueToAtom(ctx,key);if(!atom)abort();fault_after=position;
   int result=js_method_set_properties(ctx,function,atom,JS_PROP_HAS_GET,home);fault_after=-1;
   if(result<0&&!JS_HasException(ctx))abort();
   if(JS_VALUE_GET_OBJ(function)->u.func.home_object!=JS_VALUE_GET_OBJ(result<0?previous:home))abort();
   JS_FreeValue(ctx,JS_GetException(ctx));JS_FreeAtom(ctx,atom);JS_FreeValue(ctx,key);JS_FreeValue(ctx,function);JS_FreeValue(ctx,home);JS_FreeValue(ctx,previous);
  }
  JS_RunGC(ctx->rt);
 }
 if(!faults)abort();
}
int main(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 CALLS
 name_oom(ctx);fault_sweep(ctx);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);return 0;
}
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
import js_class_definitions_test_support as fixture
import js_property_mutations_test_support { Hooks }
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
struct Case { method: bool, kind: u32, mode: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let failure = run fixture.nameOom()
 let mut index: usize = 0 while index < 4 { run out.writeU32(failure[index]) |> Effect.provideMut<Allocator>(&mut system) index = index + 1 }
 run fixture.allocationSweep()
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
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
    rows = ',\n'.join(f'Case {{ method: {str(kind == "method").lower()}, kind: {a}, mode: {b} }}' for kind, a, b in CASES)
    s_calls = f'let inputs: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < inputs.length {
  let mut record: [u32; 24] = [0; 24]
  if inputs[at].method { record = run unsafe fixture.methodCase(&observer, ctx, inputs[at].kind, inputs[at].mode) |> Effect.provideMut<Allocator>(&mut memory) }
  else { record = run unsafe fixture.classCase(&observer, ctx, inputs[at].kind, inputs[at].mode) |> Effect.provideMut<Allocator>(&mut memory) }
  let mut i: usize = 0 while i < 24 { run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system) i = i + 1 }
  at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-class-definitions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread',
                 '-o', str(temp / 'oracle')], 600, owner='Class C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Class C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="class-definitions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200,
                         owner='Native Silk class definitions', cwd=temp)
        if len(expected) != len(CASES) * 96 + 24 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C records or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                left, right = expected[offset:offset + 4], actual[offset:offset + 4]
                if left != right:
                    case, word = divmod(offset // 4, 24)
                    row = CASES[case] if case < len(CASES) else 'literal-name OOM / teardown'
                    raise SystemExit(f'Class {row} word {word}: C={left.hex()} Silk={right.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS class definitions/method names: {len(CASES)} cases, literal-name OOM; '
              f'128 allocation attempts per implementation; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both ledgers zero')

if __name__ == '__main__':
    main()
