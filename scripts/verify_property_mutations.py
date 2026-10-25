#!/usr/bin/env python3
"""Independent pinned-C versus native property mutation differential.

No C runtime is linked into Silk. Records are observed operation results, stored
own descriptors, array state, callback effects and ownership counts. Each process
also must empty its allocation ledger. Allocation-failure behavior is tested in
the focused native suite rather than equating different allocator layouts.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(family, variant, throwing) for family in range(45)
         for variant in range(8) for throwing in (False, True)]
FIELDS = ('result', 'error_kind', 'present', 'attributes', 'value_kind', 'value_low',
          'value_high', 'length', 'fast_array', 'setter_calls', 'exotic_sets',
          'exotic_defines', 'exotic_deletes', 'autoinit_calls', 'coercion_calls',
          'input_refs', 'receiver_refs', 'closure_finalizers', 'setter_argument_or_extensibility_calls',
          'original_receiver')
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;
static void *allocate(JSMallocState *s,size_t n) {
 if(!n)return NULL;Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p) {return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static unsigned setters,sets,defines,deletes,coercions,finalized,extensibility;
static int fail_write,last_argument;static JSObject *last_receiver;static JSValue detach_target;
typedef struct {JSAtom atom;int flags,present;JSValue value,getter,setter;} Stored;
static void finalizer(JSRuntime *rt,JSValue object){
 Stored *p=JS_GetOpaque(object,67);if(!p)abort();JS_FreeAtomRT(rt,p->atom);
 JS_FreeValueRT(rt,p->value);JS_FreeValueRT(rt,p->getter);JS_FreeValueRT(rt,p->setter);js_free_rt(rt,p);
}
static void marker(JSRuntime *rt,JSValueConst object,JS_MarkFunc *mark){
 Stored *p=JS_GetOpaque(object,67);JS_MarkValue(rt,p->value,mark);JS_MarkValue(rt,p->getter,mark);JS_MarkValue(rt,p->setter,mark);
}
static int own(JSContext *ctx,JSPropertyDescriptor *d,JSValueConst object,JSAtom atom){
 JS_RunGC(ctx->rt);Stored *p=JS_GetOpaque(object,67);if(p->atom!=atom||!p->present)return 0;
 if(d){d->flags=p->flags;d->value=JS_DupValue(ctx,p->value);d->getter=JS_DupValue(ctx,p->getter);d->setter=JS_DupValue(ctx,p->setter);}return 1;
}
static int before(JSContext *ctx){JS_RunGC(ctx->rt);if(fail_write){JS_Throw(ctx,JS_NewInt32(ctx,707));return -1;}return 0;}
static int publish(JSContext *ctx,JSValueConst object,JSAtom atom,JSValueConst value,JSValueConst getter,JSValueConst setter,int flags){
 Stored *p=JS_GetOpaque(object,67);if(p->atom!=atom)abort();p->present=1;
 if(flags&JS_PROP_HAS_VALUE){JS_FreeValue(ctx,p->value);p->value=JS_DupValue(ctx,value);}
 if(flags&JS_PROP_HAS_GET){JS_FreeValue(ctx,p->getter);p->getter=JS_DupValue(ctx,getter);p->flags|=JS_PROP_GETSET;}
 if(flags&JS_PROP_HAS_SET){JS_FreeValue(ctx,p->setter);p->setter=JS_DupValue(ctx,setter);p->flags|=JS_PROP_GETSET;}
 unsigned bits=(flags>>8)&7;p->flags=(p->flags&~bits)|(flags&bits);return 1;
}
static int set(JSContext *ctx,JSValueConst object,JSAtom atom,JSValueConst value,JSValueConst receiver,int flags){
 sets++;if(before(ctx)<0)return -1;last_receiver=JS_IsObject(receiver)?JS_VALUE_GET_OBJ(receiver):NULL;
 return publish(ctx,object,atom,value,JS_UNDEFINED,JS_UNDEFINED,8192|1792|7);
}
static int define(JSContext *ctx,JSValueConst object,JSAtom atom,JSValueConst value,JSValueConst getter,JSValueConst setter,int flags){
 defines++;if(before(ctx)<0)return -1;return publish(ctx,object,atom,value,getter,setter,flags);
}
static int del(JSContext *ctx,JSValueConst object,JSAtom atom){
 deletes++;if(before(ctx)<0)return -1;Stored *p=JS_GetOpaque(object,67);
 if(p->atom==atom&&p->present){if(!(p->flags&1))return 0;p->present=0;}return 1;
}
static JSClassExoticMethods exotic={.get_own_property=own,.set_property=set,.define_own_property=define,.delete_property=del};
static int extensible(JSContext *ctx,JSValueConst object){extensibility++;if(before(ctx)<0)return -1;return JS_VALUE_GET_OBJ(object)->extensible;}
static JSClassExoticMethods extensible_exotic={.get_own_property=own,.is_extensible=extensible};
static const JSClassDef definition={.class_name="StoredKeys",.finalizer=finalizer,.gc_mark=marker,.exotic=&exotic};
typedef struct {int body;JSAtom atom;JSValue result;} Closure;
static void closure_finalizer(JSRuntime *rt,JSValue object){Closure *p=JS_GetOpaque(object,69);finalized++;JS_FreeValueRT(rt,p->result);js_free_rt(rt,p);}
static void closure_marker(JSRuntime *rt,JSValueConst object,JS_MarkFunc *mark){Closure *p=JS_GetOpaque(object,69);JS_MarkValue(rt,p->result,mark);}
static JSValue call(JSContext *ctx,JSValueConst function,JSValueConst receiver,int argc,JSValueConst *argv,int flags){
 Closure *p=JS_GetOpaque(function,69);int body=p->body;JSAtom atom=p->atom;JSValue result=JS_DupValue(ctx,p->result);
 if(body==4){if(argc!=1)abort();setters++;last_argument=JS_VALUE_GET_INT(argv[0]);last_receiver=JS_IsObject(receiver)?JS_VALUE_GET_OBJ(receiver):NULL;
  if(JS_IsObject(receiver)&&JS_DefinePropertyValue(ctx,receiver,atom,JS_DupValue(ctx,argv[0]),7)<0)abort();
  JS_RunGC(ctx->rt);return result;}
 coercions++;
 if(body==5){JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,detach_target,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);}
 JS_RunGC(ctx->rt);return result;
}
static const JSClassDef closure_definition={.class_name="CoercionClosure",.finalizer=closure_finalizer,.gc_mark=closure_marker,.call=call};
static JSValue closure(JSContext *ctx,int body,JSAtom atom,JSValueConst result){
 JSValue object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,69));Closure *p=js_mallocz(ctx,sizeof(*p));if(!p)abort();
 *p=(Closure){body,atom,JS_DupValue(ctx,result)};JS_SetOpaque(object,p);return object;
}
static const JSCFunctionListEntry lazy=JS_PROP_STRING_DEF("key","lazy",3);
static void add(JSContext *ctx,JSValue object,JSAtom key,int flags,JSValue value){
 JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,flags);if(!p)abort();p->u.value=value;
}
static int perform(JSContext *ctx,JSValue object,JSValue receiver,JSAtom atom,JSValue value,int family,int variant,int flags){
 if(family==39)return JS_DeletePropertyInt64(ctx,object,variant%4,flags);
 if(family==41)return JS_SetPropertyInt64(ctx,object,INT64_C(9007199254740993),value);
 if(family==42)return JS_DefinePropertyValueInt64(ctx,object,INT64_C(9007199254740993),value,variant);
 if(family==43)return JS_DefineObjectName(ctx,object,JS_ATOM_length,variant)<0?-1:1;
 if(family==44)return JS_DefineObjectNameComputed(ctx,object,value,variant)<0?-1:1;
 if(family==2||family==16||family==21||family==24)return JS_DeleteProperty(ctx,object,atom,flags);
 if(family==32)return delete_property(ctx,JS_VALUE_GET_OBJ(object),atom);
 if(family==30)return JS_DefinePropertyValue(ctx,object,atom,value,variant|flags);
 if(family==26){JSValue key=checked(JS_NewObjectProto(ctx,JS_NULL)),name=checked(JS_NewString(ctx,"key"));
  JSValue convert=closure(ctx,0,0,name);JS_FreeValue(ctx,name);add(ctx,key,JS_ATOM_Symbol_toPrimitive,7,convert);
  return JS_SetPropertyValue(ctx,object,key,value,flags);}
 if(family==31)return JS_SetPropertyStr(ctx,object,"key\0ignored",value);
 if(family==34)return JS_SetPropertyInt64(ctx,object,-1,value);
 if(family==0||family==3||family==4||family==5||family==11||family==12||family==15||family==20||family==25||family==28||family==29||family==33||family==37||family==38||family==40){
  int changes=JS_PROP_HAS_VALUE;if(family==11||family==12||family==28)changes|=JS_PROP_HAS_WRITABLE;
  if(family==20||family==37)changes|=1792|variant;
  if(family==40)changes|=JS_PROP_NO_EXOTIC;
  return JS_DefineProperty(ctx,object,atom,value,JS_UNDEFINED,JS_UNDEFINED,changes|flags);}
 return JS_SetPropertyInternal(ctx,object,atom,value,receiver,flags);
}
static void run_case(JSContext *ctx,int family,int variant,int throwing){
 setters=sets=defines=deletes=coercions=finalized=extensibility=0;last_argument=0;last_receiver=NULL;fail_write=family==22;
 ctx->rt->class_array[67].exotic=family==33?&extensible_exotic:&exotic;
 JSValue text=checked(JS_NewString(ctx,"owned")),object,receiver,incoming=JS_NewInt32(ctx,41);JSAtom key=JS_NewAtom(ctx,"key");
 if((family>=10&&family<=13)||family==38||family==39){object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,JS_CLASS_ARRAY));
  for(int i=0;i<3;i++)if(JS_SetPropertyUint32(ctx,object,i,JS_NewInt32(ctx,10+i))<0)abort();
  JS_FreeAtom(ctx,key);key=JS_ATOM_length;
  if(family==11&&JS_DefineProperty(ctx,object,__JS_AtomFromUInt32(1),JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_CONFIGURABLE)!=1)abort();
  if(family==12)key=__JS_AtomFromUInt32(1);if(family==13)key=__JS_AtomFromUInt32(5);
  if(family==39)key=__JS_AtomFromUInt32(variant%4);
  if(family==38&&JS_DefineProperty(ctx,object,key,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_WRITABLE)!=1)abort();
 }else if((family>=14&&family<=18)||family==37){JSValue length=JS_NewInt32(ctx,3);object=checked(JS_NewTypedArray(ctx,1,&length,JS_TYPED_ARRAY_UINT8));
  JSObject *p=JS_VALUE_GET_OBJ(object);p->u.array.u.uint8_ptr[0]=19;p->u.array.u.uint8_ptr[1]=203;p->u.array.u.uint8_ptr[2]=7;
  static const char *names[]={"0","3","-0","-1","1.5","NaN","01","2147483648"};JS_FreeAtom(ctx,key);key=JS_NewAtom(ctx,names[variant]);
  if(family==37){JS_FreeAtom(ctx,key);key=__JS_AtomFromUInt32(0);}
  if(family==17){JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,object,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);}
 }else if((family>=19&&family<=22)||family==33||family==40){object=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored *p=js_mallocz(ctx,sizeof(*p));if(!p)abort();
  *p=(Stored){JS_DupAtom(ctx,key),variant,1,JS_NewInt32(ctx,7),JS_UNDEFINED,JS_UNDEFINED};JS_SetOpaque(object,p);
  if(family==33){JS_VALUE_GET_OBJ(object)->extensible=variant&1;JS_FreeAtom(ctx,key);key=JS_NewAtom(ctx,"fresh");}
  if(family==40){JS_FreeAtom(ctx,key);key=JS_NewAtom(ctx,"fresh");}
 }else if(family==23)object=JS_NULL;else if(family==24){object=checked(JS_NewString(ctx,"abc"));JS_FreeAtom(ctx,key);key=__JS_AtomFromUInt32(0);}
 else if(family==25)object=JS_NewInt32(ctx,9);else object=checked(JS_NewObjectProto(ctx,JS_NULL));
 receiver=object;if(family==6||family==7)receiver=checked(JS_NewObjectProto(ctx,JS_NULL));
 if(family==34){JS_FreeAtom(ctx,key);key=JS_NewAtom(ctx,"-1");}
 if(family==41||family==42){JS_FreeAtom(ctx,key);key=JS_NewAtom(ctx,family==41?"9007199254740993":"9007199254740992");}
 if(family==43||family==44){JS_FreeAtom(ctx,key);key=JS_ATOM_name;
  if(variant==1)add(ctx,object,key,7,checked(JS_NewString(ctx,"")));
  else if(variant==2)add(ctx,object,key,7,JS_NewInt32(ctx,0));
  else if(variant==3){JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,23);if(!p)abort();p->u.getset.getter=NULL;p->u.getset.setter=NULL;}}
 if(family==36)receiver=JS_NewInt32(ctx,73);
 if(family<=4||family==6||family==7||family==32||family==35){JSValue previous=JS_NewInt32(ctx,7);int flags=variant;
  if(family==3){previous=JS_NAN;incoming=JS_NAN;flags=0;}if(family==4){previous=__JS_NewFloat64(ctx,-0.0);incoming=JS_NewInt32(ctx,0);flags=0;}
  add(ctx,object,key,flags,previous);}
 if(family==5)JS_VALUE_GET_OBJ(object)->extensible=0;
 if(family==7){JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(receiver),key,23);if(!p)abort();p->u.getset.getter=NULL;p->u.getset.setter=NULL;}
 if(family==8||family==36){JSValue setter=closure(ctx,4,key,JS_UNDEFINED);JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,23);if(!p)abort();p->u.getset.getter=NULL;p->u.getset.setter=JS_VALUE_GET_OBJ(setter);}
 if(family==9&&JS_DefineAutoInitProperty(ctx,object,key,JS_AUTOINIT_ID_PROP,(void*)&lazy,3)<0)abort();
 if(family==10||family==11)incoming=JS_NewInt32(ctx,0);
 if(family==38)incoming=JS_NewFloat64(ctx,1.5);
 if(family==18){JSValue convert=closure(ctx,5,0,JS_NewInt32(ctx,45));incoming=checked(JS_NewObjectProto(ctx,JS_NULL));add(ctx,incoming,JS_ATOM_Symbol_toPrimitive,7,convert);detach_target=object;}
 if(family==27||family==28){JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,39);if(!p)abort();p->u.var_ref=js_create_var_ref(ctx,FALSE);if(!p->u.var_ref)abort();p->u.var_ref->value=JS_NewInt32(ctx,7);}
 if(family==29){JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,23);if(!p)abort();p->u.getset.getter=NULL;p->u.getset.setter=NULL;}
 if(family==30||family==35)incoming=JS_DupValue(ctx,text);
 uint32_t r[20]={0};int result=perform(ctx,object,receiver,key,incoming,family,variant,throwing?JS_PROP_THROW:0);r[0]=result+1;
 if(result<0){JSValue pending=JS_GetException(ctx);r[1]=99;if(JS_IsObject(pending))for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)
  if(JS_VALUE_GET_OBJ(pending)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))r[1]=i;JS_FreeValue(ctx,pending);}
 JSValue inspected=(family==6||family==7)?receiver:object;
 if(JS_IsObject(inspected)){JSPropertyDescriptor d;int found=JS_GetOwnProperty(ctx,&d,inspected,key);if(found<0)abort();
  if(found){r[2]=1;r[3]=d.flags;if(JS_IsNumber(d.value)){r[4]=1;union{double d;uint64_t u;}bits;bits.d=JS_VALUE_GET_TAG(d.value)==JS_TAG_INT?JS_VALUE_GET_INT(d.value):JS_VALUE_GET_FLOAT64(d.value);r[5]=bits.u;r[6]=bits.u>>32;}
   else if(JS_IsString(d.value)){r[4]=2;r[5]=JS_VALUE_GET_STRING(d.value)->len;}else if(JS_IsObject(d.value))r[4]=3;js_free_desc(ctx,&d);}
  r[8]=JS_VALUE_GET_OBJ(inspected)->fast_array;
  if((family>=10&&family<=13)||family==38||family==39){JSValue length=checked(JS_GetProperty(ctx,object,JS_ATOM_length));if(JS_ToUint32(ctx,&r[7],length))abort();JS_FreeValue(ctx,length);}}
 r[9]=setters;r[10]=sets;r[11]=defines;r[12]=deletes;
 if(family==9){JSShapeProperty *property=find_own_property1(JS_VALUE_GET_OBJ(object),key);r[13]=property&&(property->flags&JS_PROP_TMASK)!=JS_PROP_AUTOINIT;}
 r[14]=coercions;
 r[15]=js_rc(JS_VALUE_GET_STRING(text))->ref_count;if(JS_IsObject(receiver))r[16]=js_rc(JS_VALUE_GET_OBJ(receiver))->ref_count;
 r[17]=finalized;r[18]=last_argument;r[19]=JS_IsObject(receiver)&&last_receiver==JS_VALUE_GET_OBJ(receiver);
 if(family==33)r[18]=extensibility;
 for(int i=0;i<20;i++)word(r[i]);
 if(family==6||family==7)JS_FreeValue(ctx,receiver);JS_FreeValue(ctx,object);JS_FreeValue(ctx,text);JS_FreeAtom(ctx,key);
}
int main(void){JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,67,&definition)||JS_NewClass(rt,69,&closure_definition))abort();
 CALLS
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();return 0;
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
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_property_mutations_test_support as fixture
import js_property_mutations_test_support { Hooks }
import js_property_get_test_support as base
import js_array_storage_test_support as storage
import js_array_storage_test_support { trap }
struct Case { family: u32, variant: u32, throwing: bool }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut hooks = Hooks.make(&observer)
 run unsafe base.prepare(&mut hooks.base, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
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
    c_calls = '\n'.join(f'run_case(ctx,{family},{variant},{int(throwing)});' for family, variant, throwing in CASES)
    rows = ',\n'.join(f'Case {{ family: {family}, variant: {variant}, throwing: {str(throwing).lower()} }}'
                     for family, variant, throwing in CASES)
    s_calls = f'let cases: [Case; {len(CASES)}] = [{rows}]\n' + r'''
 let mut at: usize = 0
 while at < cases.length {
   let record = run unsafe fixture.runCase(&observer, ctx, cases[at].family,
     cases[at].variant, cases[at].throwing) |> Effect.provideMut<Allocator>(&mut memory)
   let mut i: usize = 0
   while i < 20 {
     run out.writeU32(record[i]) |> Effect.provideMut<Allocator>(&mut system)
     i = i + 1
   }
   at = at + 1
 }
'''
    with tempfile.TemporaryDirectory(prefix='silkjs-property-mutations-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(reference),
                 str(temp / 'oracle.c'), *(str(reference / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], 600, owner='Property mutation C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Property mutation C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="property-mutations-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Native property mutation oracle', cwd=temp)
        if len(expected) != len(CASES) * 80 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid C mutation record count or nonzero allocation ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, native = expected[offset:offset+4], actual[offset:offset+4]
                if c != native:
                    record, field = divmod(offset // 4, 20)
                    case = CASES[record] if record < len(CASES) else 'teardown'
                    raise SystemExit(f'Mutation {case}, {FIELDS[field]}: C={c.hex()} Silk={native.hex()}; '
                                     f'bytes={len(expected)}/{len(actual)}')
        print(f'PASS property mutations: {len(CASES)} cases, {len(actual)//4} words; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both teardown ledgers zero')


if __name__ == '__main__':
    main()
