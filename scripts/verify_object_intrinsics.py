#!/usr/bin/env python3
"""Independent native/C Object entrypoints, observable callbacks and owner ledgers.

Every registration entry is invoked, not inspected as source text. C is compiled
unchanged from the pinned tree and never linked into the Silk executable. Fault
ordinals are swept independently. Each C fault is isolated so upstream crashes
or residual owners are measured explicitly rather than hidden by a skipped case.
"""
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
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(method, 0) for method in range(42)]
CASES += [(method, 1) for method in (0, 1, 4, 5, 9, 10, 11, 14, 16, 17, 23, 27, 28, 29, 34, 35, 37, 40, 41)]
CASES += [(8, mode) for mode in range(1, 5)] + [(22, mode) for mode in (1, 2)]
CASES += [(24, mode) for mode in range(1, 6)] + [(41, mode) for mode in (2, 3)]
CASES += [(method, 2) for method in (10, 11, 17)]
CASES += [(method, 2) for method in (12, 13, 18, 19, 20, 21, 36, 38, 39, 40)]
FAULT_CASES = [(1, 1), (4, 1), (5, 1), (8, 0), (11, 1), (14, 1), (15, 0), (19, 0), (22, 0), (24, 1), (32, 0), (41, 2)]
CUTOFFS = 96
FIELDS = ('success', 'result_digest', 'exception', 'target_identity', 'target_digest',
          'callbacks', 'callback_order', 'iterator_closes', 'next_calls', 'group_receiver',
          'interrupts', 'realm_owner_and_prototype', 'allocation_failures', 'pending',
          'final_allocations', 'final_bytes')
C_SOURCE = ALLOCATOR_SOURCE + r'''

static uint32_t rec[16],method,mode,calls,closed,next_count,events,receiver_matches,interrupted;
static JSValue roots[16],args[3],receiver; static JSContext *foreign; static uint32_t realm_bits;
static unsigned flag(int b){return !!b;}
static uint32_t mix(uint32_t h,uint32_t x){return (h*31+(x&65535))&65535;}
static int same(JSValueConst a,JSValueConst b){return js_same_value(NULL,a,b);}
static uint32_t error_kind(JSContext *ctx,JSValue e){if(!JS_IsObject(e)||JS_VALUE_GET_OBJ(e)->class_id!=JS_CLASS_ERROR)return 99;for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;}
static uint32_t code(JSValueConst v){if(JS_IsNumber(v)){double n=JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v);if(isnan(n))return 0x7ff80000;if(n==0){union{double d;uint64_t u;}b={n};return b.u>>32;}return (uint32_t)n;}if(JS_IsBool(v))return JS_VALUE_GET_BOOL(v);if(JS_IsUndefined(v))return 0;if(JS_IsNull(v))return 1;if(JS_IsObject(v))return 4;if(JS_IsString(v))return 5;if(JS_IsSymbol(v))return 6;return 7;}
static uint32_t digest(JSContext *ctx,JSValueConst value,int depth){
 if(JS_IsNumber(value)){double n;JS_ToFloat64(ctx,&n,value);if(isnan(n))return 900;if(n==0)return signbit(n)?901:902;return mix(3,(uint32_t)n);}
 if(JS_IsString(value)){JSString *s=JS_VALUE_GET_STRING(value);uint32_t h=5;for(int i=0;i<s->len;i++)h=mix(h,s->is_wide_char?s->u.str16[i]:s->u.str8[i]);return h;}
 if(!JS_IsObject(value)){if(JS_IsNull(value))return 101;if(JS_IsUndefined(value))return 102;if(JS_IsBool(value))return JS_VALUE_GET_BOOL(value)?104:103;if(JS_IsSymbol(value))return 105;return 106;}if(JS_IsFunction(ctx,value))return 77;if(!depth)return 88;
 JSPropertyEnum *keys=NULL;uint32_t len=0;if(JS_GetOwnPropertyNames(ctx,&keys,&len,value,3)<0)abort();uint32_t h=7;
 for(uint32_t i=0;i<len;i++){JSValue key=checked(JS_AtomToValue(ctx,keys[i].atom));h=mix(h,digest(ctx,key,0));JS_FreeValue(ctx,key);JSPropertyDescriptor d;int found=JS_GetOwnProperty(ctx,&d,value,keys[i].atom);if(found<0)abort();if(found){h=mix(h,d.flags&7);h=mix(h,(d.flags&JS_PROP_GETSET)?99:digest(ctx,d.value,depth-1));js_free_desc(ctx,&d);}else h=mix(h,0);}
 JS_FreePropertyEnum(ctx,keys,len);return h;
}
static void put(JSContext *ctx,JSValueConst obj,JSAtom atom,JSValueConst value,int flags){if(JS_DefinePropertyValue(ctx,obj,atom,JS_DupValue(ctx,value),flags)<0)abort();}
static JSValue observed(JSContext *ctx,JSValueConst this_val,int argc,JSValueConst *argv,int id){
 calls++;events=(events*17+id)&65535;JS_RunGC(ctx->rt);
 if(id==1)return JS_DupValue(ctx,roots[2]);
 if(id==2){if(mode==2)return JS_Throw(ctx,JS_NewInt32(ctx,707));if(JS_DefineProperty(ctx,roots[0],JS_ATOM_name,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_ENUMERABLE)<0)return JS_EXCEPTION;return JS_NewInt32(ctx,11);}
 if(id==3)return JS_NewInt32(ctx,41);
 if(id==4)return JS_DupValue(ctx,roots[6]);
 if(id==5){next_count++;if(mode==1)return JS_Throw(ctx,JS_NewInt32(ctx,707));JSValue obj=JS_NewObject(ctx);if(JS_IsException(obj))return obj;int done=next_count>3;JSValue item=done?JS_UNDEFINED:roots[6+next_count];if(JS_DefinePropertyValue(ctx,obj,JS_ATOM_value,JS_DupValue(ctx,item),7)<0||JS_DefinePropertyValue(ctx,obj,JS_ATOM_done,JS_NewBool(ctx,done),7)<0){JS_FreeValue(ctx,obj);return JS_EXCEPTION;}return obj;}
 if(id==6){closed++;return JS_Throw(ctx,JS_NewInt32(ctx,909));}
 if(id==7){if(same(this_val,ctx->global_obj))receiver_matches++;if(mode==2)return JS_Throw(ctx,JS_NewInt32(ctx,707));if(mode==3)return JS_DupValue(ctx,roots[10]);int32_t n;if(JS_ToInt32(ctx,&n,argv[0])<0)return JS_EXCEPTION;return JS_NewInt32(ctx,n&1);}
 if(id==8)return JS_DupValue(ctx,roots[2]);if(id==9)return JS_DupValue(ctx,roots[3]);if(id==10){ctx->interrupt_counter=1;return JS_DupValue(ctx,roots[0]);}if(id==11)return JS_NewInt32(ctx,31);if(id==12)return JS_UNDEFINED;if(id==13)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(id==14){if(JS_DefinePropertyValue(ctx,roots[3],JS_ATOM_value,JS_NewInt32(ctx,93),7)<0)return JS_EXCEPTION;return JS_DupValue(ctx,roots[3]);}abort();
}
static JSValue function(JSContext *ctx,int id){JSCFunctionType f={0};f.generic_magic=observed;return checked(JS_NewCFunction2(ctx,f.generic,"callback",0,JS_CFUNC_generic_magic,id));}
static void accessor(JSContext *ctx,JSValueConst object,JSAtom atom,int id){JSValue f=function(ctx,id);if(JS_DefineProperty(ctx,object,atom,JS_UNDEFINED,f,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|JS_PROP_HAS_ENUMERABLE|JS_PROP_CONFIGURABLE|JS_PROP_ENUMERABLE)<0)abort();JS_FreeValue(ctx,f);}
static int interrupt(JSRuntime *rt,void *opaque){interrupted++;return 1;}
static JSValue intrinsic(JSContext *ctx,unsigned m){JSCFunctionType fn={0};JSCFunctionEnum proto=JS_CFUNC_generic;int magic=0;
 switch(m){
 case 0:fn.generic=js_object_constructor;proto=JS_CFUNC_constructor_or_func;break;
 case 1:fn.generic=js_object_create;break;
 case 2:case 36:fn.generic_magic=js_object_getPrototypeOf;proto=JS_CFUNC_generic_magic;magic=m==36;break;
 case 3:fn.generic=js_object_setPrototypeOf;break;
 case 4:case 37:fn.generic_magic=js_object_defineProperty;proto=JS_CFUNC_generic_magic;magic=m==37;break;
 case 5:fn.generic=js_object_defineProperties;break;
 case 6:fn.generic=js_object_getOwnPropertyNames;break;
 case 7:fn.generic=js_object_getOwnPropertySymbols;break;
 case 8:fn.generic_magic=js_object_groupBy;proto=JS_CFUNC_generic_magic;break;
 case 9:case 10:case 11:fn.generic_magic=js_object_keys;proto=JS_CFUNC_generic_magic;magic=m-9;break;
 case 12:case 38:fn.generic_magic=js_object_isExtensible;proto=JS_CFUNC_generic_magic;magic=m==38;break;
 case 13:case 39:fn.generic_magic=js_object_preventExtensions;proto=JS_CFUNC_generic_magic;magic=m==39;break;
 case 14:case 40:fn.generic_magic=js_object_getOwnPropertyDescriptor;proto=JS_CFUNC_generic_magic;magic=m==40;break;
 case 15:fn.generic=js_object_getOwnPropertyDescriptors;break;
 case 16:fn.generic=js_object_is;break;
 case 17:fn.generic=js_object_assign;break;
 case 18:case 19:fn.generic_magic=js_object_seal;proto=JS_CFUNC_generic_magic;magic=m==19;break;
 case 20:case 21:fn.generic_magic=js_object_isSealed;proto=JS_CFUNC_generic_magic;magic=m==21;break;
 case 22:fn.generic=js_object_fromEntries;break;
 case 23:fn.generic=js_object_hasOwn;break;
 case 24:fn.generic=js_object_toString;break;
 case 25:fn.generic=js_object_toLocaleString;break;
 case 26:fn.generic=js_object_valueOf;break;
 case 27:fn.generic=js_object_hasOwnProperty;break;
 case 28:fn.generic=js_object_isPrototypeOf;break;
 case 29:fn.generic=js_object_propertyIsEnumerable;break;
 case 30:fn.getter=js_object_get___proto__;proto=JS_CFUNC_getter;break;
 case 31:fn.setter=js_object_set___proto__;proto=JS_CFUNC_setter;break;
 case 32:case 33:fn.generic_magic=js_object___defineGetter__;proto=JS_CFUNC_generic_magic;magic=m==33;break;
 case 34:case 35:fn.generic_magic=js_object___lookupGetter__;proto=JS_CFUNC_generic_magic;magic=m==35;break;
 default:abort();}
 return checked(JS_NewCFunction2(ctx,fn.generic,"Object intrinsic",3,proto,magic));
}
static void setup(JSContext *ctx,unsigned m,unsigned md){
 foreign=NULL;realm_bits=0;method=m;mode=md;calls=closed=next_count=events=receiver_matches=interrupted=0;memset(rec,0,sizeof(rec));for(int i=0;i<16;i++)roots[i]=JS_UNDEFINED;
 roots[0]=checked(JS_NewObjectProto(ctx,JS_NULL));roots[1]=checked(JS_NewObjectProto(ctx,JS_NULL));roots[2]=checked(JS_NewString(ctx,"value"));roots[3]=checked(JS_NewObject(ctx));roots[4]=checked(JS_NewObject(ctx));roots[5]=function(ctx,11);
 JSValue target=roots[0],proto=roots[1],desc=roots[3];
 put(ctx,target,__JS_AtomFromUInt32(2),JS_NewInt32(ctx,20),7);put(ctx,target,JS_ATOM_value,JS_NewInt32(ctx,11),7);put(ctx,target,JS_ATOM_name,JS_NewInt32(ctx,12),3);put(ctx,target,JS_ATOM_Symbol_iterator,JS_NewInt32(ctx,13),7);
 put(ctx,desc,JS_ATOM_value,JS_NewInt32(ctx,41),7);put(ctx,desc,JS_ATOM_writable,JS_TRUE,7);put(ctx,desc,JS_ATOM_enumerable,JS_TRUE,7);put(ctx,desc,JS_ATOM_configurable,JS_TRUE,7);put(ctx,roots[4],JS_ATOM_value,desc,7);
 args[0]=target;args[1]=roots[2];args[2]=desc;receiver=target;
 if(md==2&&(m==12||m==13||(m>=18&&m<=21)||m==36||m==38||m==39||m==40))args[0]=JS_NewInt32(ctx,7);
 if(m==0){receiver=JS_UNDEFINED;if(md==1)args[0]=JS_NULL;}
 if(m==1){args[0]=JS_NULL;args[1]=roots[4];}if(m==3)args[1]=proto;if(m==5)args[1]=roots[4];
 if(m==16){args[0]=__JS_NewFloat64(ctx,-0.0);args[1]=JS_NewInt32(ctx,0);if(md==1)args[0]=args[1]=__JS_NewFloat64(ctx,NAN);}
 if(m==17){args[1]=desc;args[2]=JS_NULL;}
 if(m==25){JSValue f=function(ctx,8);put(ctx,target,JS_ATOM_toString,f,7);JS_FreeValue(ctx,f);}
 if(m==27||m==29||(m>=32&&m<=35))args[0]=roots[2];
 if(m==28){if(JS_SetPrototype(ctx,target,proto)<0)abort();receiver=proto;}
 if(m==31)args[0]=proto;if(m==32||m==33)args[1]=roots[5];if(m==34||m==35)accessor(ctx,target,JS_ATOM_value,11);
 if(md&&(m==9||m==10||m==11||m==17)){put(ctx,target,JS_ATOM_name,JS_NewInt32(ctx,12),7);accessor(ctx,target,JS_ATOM_value,2);if(m==17){args[0]=proto;args[1]=target;}}
 if(md==1&&(m==1||m==5)){accessor(ctx,roots[4],JS_ATOM_value,9);accessor(ctx,roots[4],JS_ATOM_name,14);}
 if(md==1&&(m==4||m==37||m==14||m==40)){roots[10]=checked(JS_NewObject(ctx));JSValue f=function(ctx,1);put(ctx,roots[10],JS_ATOM_toString,f,7);JS_FreeValue(ctx,f);args[1]=roots[10];}
 if(md==1&&(m==23||m==27||m==29)){roots[10]=checked(JS_NewObject(ctx));JSValue f=function(ctx,13);put(ctx,roots[10],JS_ATOM_toString,f,7);JS_FreeValue(ctx,f);if(m==23){args[0]=JS_NULL;args[1]=roots[10];}else{receiver=JS_NULL;args[0]=roots[10];}}
 if(m==24&&md==1)put(ctx,target,JS_ATOM_Symbol_toStringTag,roots[2],7);if(m==24&&md==2)receiver=JS_NULL;
 if(m==24&&md>=3){roots[11]=md==3?checked(JS_NewArray(ctx)):function(ctx,12);JSValue av[]={roots[11],proto};roots[12]=checked(js_proxy_constructor(ctx,JS_UNDEFINED,2,av));receiver=roots[12];if(md==5)((JSProxyData*)JS_VALUE_GET_OBJ(roots[12])->u.opaque)->is_revoked=TRUE;}
 if(md==1&&(m==28||m==34||m==35)){JSValue f=function(ctx,10);put(ctx,proto,JS_ATOM_getPrototypeOf,f,7);JS_FreeValue(ctx,f);JSValue av[]={target,proto};roots[12]=checked(js_proxy_constructor(ctx,JS_UNDEFINED,2,av));JS_FreeValue(ctx,roots[0]);roots[0]=JS_DupValue(ctx,roots[12]);if(m==28)args[0]=roots[12];else{receiver=roots[12];args[0]=JS_NewInt32(ctx,88);}ctx->interrupt_counter=10000;JS_SetInterruptHandler(ctx->rt,interrupt,NULL);}
 if(m==8||m==22){
  roots[6]=checked(JS_NewObject(ctx));JSValue f=function(ctx,4);put(ctx,roots[6],JS_ATOM_Symbol_iterator,f,7);JS_FreeValue(ctx,f);f=function(ctx,5);put(ctx,roots[6],JS_ATOM_next,f,7);JS_FreeValue(ctx,f);f=function(ctx,6);put(ctx,roots[6],JS_ATOM_return,f,7);JS_FreeValue(ctx,f);
  for(int i=7;i<10;i++){if(m==8)roots[i]=JS_NewInt32(ctx,i-6);else{roots[i]=checked(JS_NewObject(ctx));put(ctx,roots[i],__JS_AtomFromUInt32(0),roots[2],7);put(ctx,roots[i],__JS_AtomFromUInt32(1),JS_NewInt32(ctx,i),7);}}
  if(m==22&&md==2){JS_FreeValue(ctx,roots[7]);roots[7]=JS_NewInt32(ctx,7);}args[0]=roots[6];
  if(m==8){roots[11]=function(ctx,7);args[1]=roots[11];if(md==4){args[1]=JS_NewInt32(ctx,1);args[0]=JS_NULL;}if(md==3){roots[10]=checked(JS_NewObject(ctx));f=function(ctx,13);put(ctx,roots[10],JS_ATOM_toString,f,7);JS_FreeValue(ctx,f);}}
 }
 if(m==41){foreign=JS_NewContext(ctx->rt);if(!foreign)abort();roots[13]=checked(JS_NewObjectProto(foreign,JS_NULL));put(foreign,roots[13],JS_ATOM_value,JS_NewInt32(foreign,81),7);JS_FreeValue(foreign,foreign->class_proto[JS_CLASS_OBJECT]);foreign->class_proto[JS_CLASS_OBJECT]=JS_DupValue(foreign,roots[13]);roots[14]=function(foreign,12);
 JSValue no_arguments=JS_UNDEFINED;
 if(md==1)roots[12]=checked(js_function_bind(ctx,roots[14],0,&no_arguments));else if(md==2||md==3){JSValue av[]={roots[14],proto};roots[12]=checked(js_proxy_constructor(ctx,JS_UNDEFINED,2,av));if(md==3)((JSProxyData*)JS_VALUE_GET_OBJ(roots[12])->u.opaque)->is_revoked=TRUE;}else roots[12]=JS_DupValue(ctx,roots[14]);return;}
 roots[15]=intrinsic(ctx,m);
}
static JSValue perform(JSContext *ctx){if(method!=41)return JS_Call(ctx,roots[15],receiver,3,args);int before=js_rc(foreign)->ref_count;JSContext *realm=JS_GetFunctionRealm(ctx,roots[12]);if(!realm)return JS_EXCEPTION;realm_bits=realm==foreign;if(before==js_rc(foreign)->ref_count)realm_bits|=4;JSValue object=JS_CreateFromConstructor(ctx,roots[12],JS_CLASS_OBJECT);if(JS_IsException(object))return object;JSValue proto=JS_GetPrototype(ctx,object);if(JS_IsException(proto)){JS_FreeValue(ctx,object);return proto;}if(same(proto,roots[13]))realm_bits|=2;JS_FreeValue(ctx,proto);return object;}
static void isolated(unsigned m,unsigned md,int armed,size_t cutoff){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();setup(ctx,m,md);
 unsigned before=faults;fault_after=armed?(long)cutoff:-1;JSValue result=perform(ctx);fault_after=-1;
 rec[12]=faults-before;rec[13]=JS_HasException(ctx);
 if(!JS_IsException(result)){
  rec[0]=1;rec[1]=digest(ctx,result,4);rec[3]=same(result,roots[0]);
  if(m==1||m==5||m==22||(m>=9&&m<=11)){JSValue v=checked(JS_GetProperty(ctx,result,(m>=9&&m<=11)?JS_ATOM_length:JS_ATOM_value));rec[11]=code(v);JS_FreeValue(ctx,v);}
  if((m==18||m==19)&&JS_IsObject(result)){JSPropertyDescriptor d;if(JS_GetOwnProperty(ctx,&d,result,JS_ATOM_value)==1){rec[11]=d.flags&7;js_free_desc(ctx,&d);}}
  if(m==8){JSValue p=checked(JS_GetPrototype(ctx,result));rec[11]=JS_IsNull(p);JS_FreeValue(ctx,p);}
  JS_FreeValue(ctx,result);
 }else{JSValue error=JS_GetException(ctx);rec[2]=JS_IsNumber(error)?code(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}
 // The trap can create a synthetic cycle; disable interrupts before observation.
 JS_SetInterruptHandler(rt,NULL,NULL);rec[4]=digest(ctx,roots[0],3);rec[5]=calls;rec[6]=events;rec[7]=closed;rec[8]=next_count;rec[9]=receiver_matches;rec[10]=interrupted;if(m==41)rec[11]=realm_bits;
 for(int i=0;i<16;i++)JS_FreeValue(ctx,roots[i]);if(foreign)JS_FreeContext(foreign);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);rec[14]=live_count;rec[15]=live_bytes;
 for(int i=0;i<16;i++)word(rec[i]);
}
int main(int argc,char **argv){if(argc==5){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),strtoull(argv[4],NULL,10));return 0;}SEMANTIC_CALLS return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_object_intrinsics_test_support as fixture
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_property_names { OwnKeysError }
import js_prototypes { PrototypeError }
struct Case { method: u32, mode: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | OwnKeysError | PrototypeError | JsException | WriterError {
  let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
  CALLS
  let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def silk_calls(cases, faults=False):
    rows = ','.join(f'Case {{ method: {method}, mode: {mode} }}' for method, mode in cases)
    return f"""let cases: [Case; {len(cases)}] = [{rows}]
    let mut at: usize = 0
    while at < cases.length {{
      let mut cutoff: usize = 0
      while cutoff < {CUTOFFS if faults else 1} {{
        let record = run fixture.isolated(cases[at].method, cases[at].mode, {'true' if faults else 'false'}, cutoff)
        let mut field: usize = 0
        while field < 16 {{ run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
        cutoff = cutoff + 1
      }}
      at = at + 1
    }}"""


def records(data, count, owner, require_clean=True):
    if len(data) != count * 64:
        raise SystemExit(f'{owner}: expected {count * 64} record bytes, got {len(data)}')
    result = list(struct.iter_unpack('<16I', data))
    for index, row in enumerate(result):
        if require_clean and row[14:] != (0, 0):
            raise SystemExit(f'{owner} record {index}: nonzero ledger {row[14:]}')
        if not row[0] and not row[13]:
            raise SystemExit(f'{owner} record {index}: failure without a pending exception')
    return result


def regressions(rows):
    by_case = dict(zip(CASES, rows))
    for case, error, closes in (((8, 1), 707, 0), ((22, 1), 707, 1),
                                ((8, 2), 707, 1), ((8, 3), 707, 1), ((22, 2), 104, 1)):
        row = by_case[case]
        if row[0] or row[2] != error or row[7] != closes:
            raise SystemExit(f'{case}: iterator close/error precedence regression: {row}')
    if by_case[(23, 1)][2] != 104 or by_case[(23, 1)][5] != 0:
        raise SystemExit('Object.hasOwn must box before coercing its key')
    for method in (27, 29):
        if by_case[(method, 1)][2] != 707 or by_case[(method, 1)][5] != 1:
            raise SystemExit('prototype own-property queries must coerce their key before boxing')
    if by_case[(8, 4)][2] != 104 or by_case[(8, 4)][5] != 0:
        raise SystemExit('groupBy must check callback before touching the iterable')
    if by_case[(8, 0)][9] != 3:
        raise SystemExit('groupBy callback must observe the source global receiver')
    for method in (28, 34, 35):
        row = by_case[(method, 1)]
        if row[0] or row[5] == 0 or row[10] != 1:
            raise SystemExit('cyclic proxy traversal must reach its installed interrupt')
    for mode in (0, 1, 2):
        if by_case[(41, mode)][11] != 7:
            raise SystemExit('constructor realm must remain borrowed and select the foreign default prototype')
    if by_case[(41, 3)][0] or by_case[(41, 3)][2] != 104:
        raise SystemExit('revoked constructor proxy must reject realm traversal')


def native(temp, silk, stdlib, cases, faults=False):
    (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', silk_calls(cases, faults)))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command,
                   1200, owner='Object native consumer', cwd=temp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.resolve() if args.stdlib else None
    with tempfile.TemporaryDirectory(prefix='silkjs-object-') as directory:
        temp = Path(directory).resolve()
        calls = '\n'.join(f'isolated({method},{mode},0,0);' for method, mode in CASES)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('SEMANTIC_CALLS', calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Object unchanged-C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Object C semantic records')
        c_rows = records(expected, len(CASES), 'C semantics')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="object-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = native(temp, silk, stdlib, CASES)
        native_rows = records(actual, len(CASES), 'native semantics')
        for case, c_row, n_row in zip(CASES, c_rows, native_rows):
            for field, (c_word, n_word) in enumerate(zip(c_row, n_row)):
                if c_word != n_word:
                    raise SystemExit(f'Object {case}, {FIELDS[field]}: C={c_word:#x} native={n_word:#x}')
        regressions(native_rows)
        n_faults = records(native(temp, silk, stdlib, FAULT_CASES, True),
                           len(FAULT_CASES) * CUTOFFS, 'native allocation')
        native_allocation_free = []
        for index, case in enumerate(FAULT_CASES):
            group = n_faults[index * CUTOFFS:(index + 1) * CUTOFFS]
            if not any(not row[12] for row in group):
                raise SystemExit(f'native {case}: allocation sweep never reached clean execution')
            if not any(row[12] for row in group):
                native_allocation_free.append(case)
        if not any(row[12] for row in n_faults):
            raise SystemExit('native allocation sweeps injected no failures')
        defects = []
        c_failures = 0
        c_allocation_free = []
        for method, mode in FAULT_CASES:
            group = []
            for cutoff in range(CUTOFFS):
                probe = subprocess.run([str(temp / 'oracle'), str(method), str(mode), '1', str(cutoff)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if probe.returncode:
                    if probe.returncode < 0 and -probe.returncode in (signal.SIGABRT, signal.SIGSEGV, signal.SIGBUS):
                        defects.append((method, mode, cutoff, f'signal {-probe.returncode}; no final ledger'))
                        continue
                    raise SystemExit(f'C fault subprocess {method, mode, cutoff}: {probe.returncode}: {probe.stderr.decode(errors="replace")}')
                row = records(probe.stdout, 1, 'C fault', require_clean=False)[0]
                group.append(row)
                c_failures += row[12]
                if row[14:] != (0, 0):
                    defects.append((method, mode, cutoff, f'residual allocations/bytes={row[14:]}'))
            if not any(not row[12] for row in group):
                raise SystemExit(f'C {method, mode}: allocation sweep never reached clean execution')
            if not any(row[12] for row in group):
                c_allocation_free.append((method, mode))
        if not c_failures:
            raise SystemExit('C allocation sweeps injected no failures')
        print(f'PASS Object: {len(CASES)} native/C behavior records; {pins} source pins; sha256={hashlib.sha256(actual).hexdigest()}')
        print(f'Native OOM: {len(n_faults)} attempts, {sum(row[12] for row in n_faults)} injected failures; all final ledgers zero')
        print(f'C OOM: {len(FAULT_CASES) * CUTOFFS} isolated attempts, {c_failures} emitted injected failures')
        print(f'Allocation-free swept paths: native={native_allocation_free}; C={c_allocation_free}')
        for defect in defects:
            print(f'SOURCE OWNERSHIP OBSERVATION method/mode/cutoff={defect[:3]}: {defect[3]}')
        if defects:
            print('Source ownership defects are observations, not passing cleanup records.')


if __name__ == '__main__':
    main()
