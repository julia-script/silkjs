#!/usr/bin/env python3
"""Independent unchanged pinned-C/native Proxy semantics and isolated OOM sweeps.

Native and C allocation ordinals are intentionally not compared. Every attempt
owns a fresh allocator/runtime/context and emits actual final allocation ledgers.
The two suspected upstream ownership defects run separately from semantic cases:
construct's residual method owner is measured then explicitly reclaimed by the
consumer; intrinsic's consumed-negative definition path runs in a subprocess.
No source patch, C binding, precomputed native expected records, or JS mock is used.
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
FAMILIES = ("getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions",
            "has", "get", "set", "deleteProperty", "ownKeys",
            "getOwnPropertyDescriptor", "defineProperty", "apply", "construct",
            "revocable", "source_ownership", "descriptor_conversion")
EXTRA_END = (13, 11, 11, 11, 13, 16, 17, 13, 22, 30, 21, 11, 15)
CASES = [(family, mode) for family in range(13)
         for mode in range(EXTRA_END[family] + 1)]
CASES += [(13, mode) for mode in range(9)] + [(15, mode) for mode in range(3)]
FAULT_CASES = [(8, 16), (9, 26), (10, 18), (11, 3), (12, 3), (13, 3), (13, 4), (15, 2)]
CUTOFFS = 48
FIELDS = ("success", "kind_or_error", "payload_low", "payload_high", "trap_calls",
          "getter_calls", "identity_bits", "argc", "key_count", "key_order",
          "descriptor_presence", "descriptor_flags", "descriptor_kind", "descriptor_value",
          "revoked", "target_calls", "getter_order_or_capture_drop", "descriptor_order_or_repeat_drop",
          "proxy_refs", "pending_on_success", "allocation_failures", "pending_before_finish",
          "final_allocations", "final_bytes")

C_SOURCE = ALLOCATOR_SOURCE + r'''
static uint32_t rec[24]; static int family,mode; static JSValue roots[9],input,desired_proto; static int define_flags;
static int kind(JSValueConst v){if(JS_IsUndefined(v))return 0;if(JS_IsNull(v))return 1;if(JS_IsBool(v))return 2;if(JS_IsNumber(v))return 3;if(JS_IsObject(v))return 4;if(JS_IsString(v))return 5;if(JS_IsSymbol(v))return 6;return 7;}
static uint32_t code(JSValueConst v){
 if(JS_IsNumber(v)){double n=JS_VALUE_GET_TAG(v)==JS_TAG_INT?JS_VALUE_GET_INT(v):JS_VALUE_GET_FLOAT64(v);
  if(isnan(n))return 0x7ff80000;if(n==0){union{double d;uint64_t u;} b={n};return b.u>>32;}
  if(n>=0&&n<4294967296.0)return (uint32_t)n;return 0xffffffff;}
 return JS_IsBool(v)?JS_VALUE_GET_BOOL(v):kind(v);
}
static int same_object(JSValueConst a,JSValueConst b){return JS_IsObject(a)&&JS_IsObject(b)&&JS_VALUE_GET_PTR(a)==JS_VALUE_GET_PTR(b);}
static unsigned error_kind(JSContext *ctx,JSValue error){if(!JS_IsObject(error)||JS_VALUE_GET_OBJ(error)->class_id!=JS_CLASS_ERROR)return 99;for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(error)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;return 99;}
static uint32_t key_code(JSAtom atom){
 if(atom==JS_ATOM_value)return 1;if(atom==JS_ATOM_name)return 2;if(atom==JS_ATOM_Symbol_iterator)return 3;if(atom==__JS_AtomFromUInt32(2))return 4;
 if(atom==JS_ATOM_get)return 5;if(atom==JS_ATOM_set)return 6;if(atom==JS_ATOM_writable)return 7;if(atom==JS_ATOM_enumerable)return 8;if(atom==JS_ATOM_configurable)return 9;return 15;
}
static JSAtom trap_atom(int f){JSAtom atoms[]={JS_ATOM_getPrototypeOf,JS_ATOM_setPrototypeOf,JS_ATOM_isExtensible,JS_ATOM_preventExtensions,JS_ATOM_has,JS_ATOM_get,JS_ATOM_set,JS_ATOM_deleteProperty,JS_ATOM_ownKeys,JS_ATOM_getOwnPropertyDescriptor,JS_ATOM_defineProperty,JS_ATOM_apply,JS_ATOM_construct};return atoms[f<13?f:12];}
static int reference_count(JSValueConst v){return __js_rc(JS_VALUE_GET_PTR(v))->ref_count;}
static JSValue revoke(JSContext *ctx){return JS_Call(ctx,roots[8],JS_UNDEFINED,0,NULL);}
static int observe(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv){
 rec[4]++;rec[7]=argc;unsigned bits=256;
 if(same_object(receiver,roots[1]))bits|=1;if(argc>0&&same_object(argv[0],roots[0]))bits|=2;
 if(family>=4&&family<=10&&family!=8&&argc>1&&JS_IsString(argv[1])&&JS_VALUE_GET_STRING(argv[1])->len==5)bits|=4;
 if(family==5&&same_object(argv[2],roots[3]))bits|=8;
 if(family==6){if(same_object(argv[3],roots[3]))bits|=8;if(js_same_value(ctx,argv[2],input))bits|=16;}
 if(family==11||family==12){
  JSValueConst array=argv[family==12?1:2];JSValue a=JS_GetPropertyUint32(ctx,array,0);if(JS_IsException(a))return -1;
  JSValue b=JS_GetPropertyUint32(ctx,array,1);if(JS_IsException(b)){JS_FreeValue(ctx,a);return -1;}
  JSValue n=JS_GetProperty(ctx,array,JS_ATOM_length);if(JS_IsException(n)){JS_FreeValue(ctx,a);JS_FreeValue(ctx,b);return -1;}
  if(same_object(a,roots[3])&&code(b)==23&&code(n)==2)bits|=32;JS_FreeValue(ctx,a);JS_FreeValue(ctx,b);JS_FreeValue(ctx,n);
  if(family==11&&same_object(argv[1],roots[3]))bits|=64;
  if(family==12&&same_object(argv[2],mode==13?roots[2]:roots[4]))bits|=64;
 }
 if(family==10){JSPropertyEnum *tab=NULL;uint32_t count=0;if(JS_GetOwnPropertyNames(ctx,&tab,&count,argv[2],3)<0)return -1;
  for(uint32_t i=0;i<count;i++)rec[17]=rec[17]*16+key_code(tab[i].atom);JS_FreePropertyEnum(ctx,tab,count);}
 JSStackFrame *frame=ctx->rt->current_stack_frame;if(frame&&JS_IsObject(frame->cur_func)&&frame->arg_count==argc)bits|=128;
 rec[6]=bits;JS_RunGC(ctx->rt);return 0;
}
static JSValue data_callback(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int magic,JSValue *data){
 if(magic==30){rec[4]++;if(mode==1||(JS_IsString(argv[1])&&JS_VALUE_GET_STRING(argv[1])->len==10))return JS_Throw(ctx,JS_NewInt32(ctx,707));return JS_FALSE;}
 if(magic==31){rec[5]++;return JS_UNDEFINED;}
 if(magic==32){rec[5]++;JS_SetConstructorBit(ctx,roots[0],0);return JS_DupValue(ctx,data[0]);}
 if(magic==33)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 if(magic==1){
  if(observe(ctx,receiver,argc,argv)<0)return JS_EXCEPTION;
  if(mode==8){JSValue v=revoke(ctx);if(JS_IsException(v))return v;JS_FreeValue(ctx,v);}
  if(family==3&&mode==11)JS_VALUE_GET_OBJ(roots[0])->extensible=0;
  if(mode==5)return JS_Throw(ctx,JS_NewInt32(ctx,707));
 }else{
  rec[5]++;if(magic>=10)rec[16]=rec[16]*10+magic-9;
  if(mode==7||(family==8&&(mode==19||mode==20))){JSValue v=revoke(ctx);if(JS_IsException(v))return v;JS_FreeValue(ctx,v);}
  JS_RunGC(ctx->rt);if(mode==6||(family==9&&(mode==24||mode==25)))return JS_Throw(ctx,JS_NewInt32(ctx,707));
 }
 return JS_DupValue(ctx,data[0]);
}
static JSValue target_callback(JSContext *ctx,JSValueConst function,JSValueConst receiver,int argc,JSValueConst *argv,int flags){
 rec[15]++;unsigned bits=0;if(same_object(function,roots[0]))bits|=2;
 if(argc==2&&same_object(argv[0],roots[3])&&code(argv[1])==23)bits|=32;
 if(same_object(receiver,(flags&JS_CALL_FLAG_CONSTRUCTOR)?roots[4]:roots[3]))bits|=64;
 rec[6]=bits;rec[7]=argc;JS_RunGC(ctx->rt);
 if((family==11&&mode==11)||(family==12&&mode==14))return JS_Throw(ctx,JS_NewInt32(ctx,909));
 if(flags&JS_CALL_FLAG_CONSTRUCTOR)return JS_DupValue(ctx,roots[3]);return JS_NewInt32(ctx,23);
}
static JSValue object(JSContext *ctx){return checked(JS_NewObjectProto(ctx,JS_NULL));}
static JSValue function(JSContext *ctx){JSCFunctionType body={0};body.constructor_or_func_flags=target_callback;return checked(JS_NewCFunction2(ctx,body.generic,"target",0,JS_CFUNC_constructor_or_func_flags,0));}
static void put(JSContext *ctx,JSValueConst object,JSAtom atom,JSValueConst value,int flags){if(JS_DefinePropertyValue(ctx,object,atom,JS_DupValue(ctx,value),flags)!=1)abort();}
static void accessor(JSContext *ctx,JSValueConst object,JSAtom atom,JSValueConst value,int magic){
 JSValue fn=checked(JS_NewCFunctionData(ctx,data_callback,0,magic,1,&value));
 if(JS_DefineProperty(ctx,object,atom,JS_UNDEFINED,fn,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|1)!=1)abort();JS_FreeValue(ctx,fn);
}
static void install_method(JSContext *ctx,JSValueConst object,JSAtom atom,int magic){JSValue data=JS_UNDEFINED;JSValue fn=checked(JS_NewCFunctionData(ctx,data_callback,0,magic,1,&data));put(ctx,object,atom,fn,7);JS_FreeValue(ctx,fn);}
static void setup(JSContext *ctx,int f,int m){
 family=f;mode=m;memset(rec,0,sizeof(rec));for(int i=0;i<9;i++)roots[i]=JS_UNDEFINED;
 input=JS_NewInt32(ctx,43);define_flags=8192;desired_proto=JS_NULL;
 roots[0]=(family==11||family==12||family==14)?function(ctx):object(ctx);roots[1]=object(ctx);roots[3]=object(ctx);roots[4]=function(ctx);
 JSValue target=roots[0],handler=roots[1],receiver=roots[3],target_value=JS_NewInt32(ctx,42),result=JS_TRUE;
 int target_flags=7,present=1,accessor_target=0,sealed=0;
 if(family==0)result=JS_NULL;if(family==5||family==11)result=JS_NewInt32(ctx,42);if(family==12)result=receiver;if(mode==4)result=JS_FALSE;
 if(family==0){if(mode==10)result=JS_NewInt32(ctx,1);if(mode==11||mode==13)result=receiver;sealed=mode==11||mode==12;}
 if(family==1){sealed=mode==10||mode==11;if(mode==10)desired_proto=receiver;}
 if(family==2){sealed=mode==10||mode==11;if(mode==11)result=JS_FALSE;}
 if(family==3)sealed=mode==10;
 if(family==4){if(mode>=10&&mode<=12)result=JS_FALSE;if(mode==10||mode==13)target_flags=0;sealed=mode==11||mode==12;present=mode!=12;}
 if(family==5||family==6){
  if(mode>=10)target_flags=0;if(mode==10)result=JS_NewInt32(ctx,43);
  if(mode==11){target_value=__JS_NewFloat64(ctx,0);result=__JS_NewFloat64(ctx,-0.0);input=result;}
  if(mode==12){target_value=__JS_NewFloat64(ctx,NAN);result=target_value;input=target_value;}
  if(mode==13||(family==5&&mode==14))accessor_target=1;if(family==5&&mode==14)result=JS_UNDEFINED;
  if(family==5&&(mode==15||mode==16)){target_value=receiver;result=mode==16?receiver:roots[4];}
  if(family==6){result=JS_TRUE;if(mode==14||mode==15)result=JS_FALSE;if(mode==16)input=target_value;if(mode==17)target_flags=2;}
 }
 if(family==7){if(mode==10)target_flags=0;sealed=mode==11||mode==12;present=mode!=12;if(mode==13)result=JS_FALSE;}
 if(family==8){if(mode==13)target_flags=0;sealed=mode==14||mode==15||mode==17;}
 if(family==9){
  present=mode!=13&&mode!=14&&mode!=28;if(mode==11||(mode>=16&&mode<=22)||mode==29||mode==30)target_flags=0;
  if(mode==18)target_flags=2;if(mode==19)target_value=JS_UNDEFINED;if(mode==21)accessor_target=1;
  if(mode==29)target_value=__JS_NewFloat64(ctx,0);if(mode==30)target_value=__JS_NewFloat64(ctx,NAN);sealed=mode==12||mode==28;
 }
 if(family==10){
  present=mode!=10&&mode!=11;sealed=mode==10;if(mode==11||mode==12)define_flags=256;
  if(mode==13||mode==15||mode==20||mode==21)target_flags=0;if(mode==14){target_flags=2;define_flags=512;}
  if(mode==15)input=target_value;if(mode==16||mode==17)result=JS_FALSE;if(mode==16)define_flags=8192|16384;
  if(mode==18)define_flags=8192|512|1024|256|7;if(mode==19)define_flags=2048|4096|256|1;
  if(mode==20){target_value=__JS_NewFloat64(ctx,0);input=__JS_NewFloat64(ctx,-0.0);}
  if(mode==21){target_value=__JS_NewFloat64(ctx,NAN);input=target_value;}
 }
 if(present){if(accessor_target){if(JS_DefineProperty(ctx,target,JS_ATOM_value,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,2048|4096|256)!=1)abort();}else put(ctx,target,JS_ATOM_value,target_value,target_flags);}
 if(sealed)JS_VALUE_GET_OBJ(target)->extensible=0;
 if(family==8){
  roots[5]=object(ctx);JSValue list=roots[5];JSAtom keys[]={JS_ATOM_value,JS_ATOM_name,JS_ATOM_Symbol_iterator,__JS_AtomFromUInt32(2)};unsigned count=1;
  if(mode==10){keys[1]=JS_ATOM_value;count=2;}if(mode==11){keys[0]=keys[1]=JS_ATOM_Symbol_iterator;count=2;}
  if(mode==13||mode==14)count=0;if(mode==15)count=2;if(mode==16){keys[0]=JS_ATOM_Symbol_iterator;keys[1]=JS_ATOM_name;keys[2]=__JS_AtomFromUInt32(2);keys[3]=JS_ATOM_value;count=4;}
  put(ctx,list,JS_ATOM_length,JS_NewInt32(ctx,count),7);
  for(unsigned i=0;i<count;i++){JSValue key=checked(JS_AtomToValue(ctx,keys[i]));if(mode==12){JS_FreeValue(ctx,key);key=JS_NewInt32(ctx,1);}put(ctx,list,__JS_AtomFromUInt32(i),key,7);JS_FreeValue(ctx,key);}
  if(mode==19)accessor(ctx,list,JS_ATOM_length,JS_NewInt32(ctx,1),2);
  if(mode==20){JSValue key=checked(JS_AtomToValue(ctx,JS_ATOM_value));accessor(ctx,list,__JS_AtomFromUInt32(0),key,2);JS_FreeValue(ctx,key);}
  result=mode==18?JS_NewInt32(ctx,1):list;
  if(mode==21){roots[5]=checked(JS_NewString(ctx,"ab"));result=roots[5];JS_FreeValue(ctx,list);}
  if(mode==22)put(ctx,list,JS_ATOM_length,__JS_NewFloat64(ctx,4294967297.0),7);
 }
 if(family==9){
  roots[5]=object(ctx);JSValue desc=roots[5];result=desc;
  if(mode>=10&&mode<=12)result=JS_UNDEFINED;
  else if(mode!=14&&mode!=15&&mode!=19&&mode!=20&&mode!=21){
   JSValue v=JS_NewInt32(ctx,mode==17?43:42);if(mode==29)v=__JS_NewFloat64(ctx,-0.0);if(mode==30)v=target_value;
   if(mode!=22)put(ctx,desc,JS_ATOM_value,v,7);if(mode<16||(mode>=23&&mode<=28))put(ctx,desc,JS_ATOM_configurable,JS_TRUE,7);
  }
  if(mode==21||mode==23)put(ctx,desc,JS_ATOM_get,JS_UNDEFINED,7);
  if(mode==22){put(ctx,receiver,JS_ATOM_value,JS_NewInt32(ctx,42),7);if(JS_SetPrototype(ctx,desc,receiver)<0)abort();}
  if(mode==24)accessor(ctx,desc,JS_ATOM_value,JS_UNDEFINED,12);if(mode==25)accessor(ctx,desc,JS_ATOM_get,JS_UNDEFINED,14);
  if(mode==26){JSAtom fields[]={JS_ATOM_enumerable,JS_ATOM_configurable,JS_ATOM_value,JS_ATOM_writable,JS_ATOM_get,JS_ATOM_set};for(int i=0;i<6;i++)accessor(ctx,desc,fields[i],JS_UNDEFINED,i+10);}
  if(mode==4)result=JS_FALSE;
 }
 if(family==11&&mode==10){roots[0]=object(ctx);JS_FreeValue(ctx,target);}
 if(family==12&&mode==10)JS_SetConstructorBit(ctx,target,0);if(family==12&&mode==11)result=JS_NewInt32(ctx,1);
 roots[6]=checked(JS_NewCFunctionData(ctx,data_callback,0,1,1,&result));JSValue method=roots[6];
 int absent=mode==0||(family==11&&mode==11)||(family==12&&(mode==14||mode==15));
 if(!absent){if(mode==6||mode==7)accessor(ctx,handler,trap_atom(family),method,2);else put(ctx,handler,trap_atom(family),mode==1?JS_NULL:(mode==2||(family==12&&mode==10))?JS_NewInt32(ctx,1):method,7);}
 JSValue args[]={roots[0],handler};roots[7]=checked(js_proxy_revocable(ctx,JS_UNDEFINED,2,args));
 roots[2]=checked(JS_GetProperty(ctx,roots[7],JS_ATOM_proxy));roots[8]=checked(JS_GetProperty(ctx,roots[7],JS_ATOM_revoke));
 if(mode==9)JS_FreeValue(ctx,checked(revoke(ctx)));
 if(family==14){
  if(mode==0)accessor(ctx,handler,JS_ATOM_construct,method,32);
  else if(mode==1){if(JS_DeleteProperty(ctx,ctx->global_obj,JS_ATOM_Proxy,0)<0)abort();put(ctx,ctx->global_obj,JS_ATOM_Proxy,JS_NewInt32(ctx,1),0);}
  else{install_method(ctx,handler,JS_ATOM_defineProperty,33);JSValue previous=ctx->global_obj;ctx->global_obj=JS_DupValue(ctx,roots[2]);JS_FreeValue(ctx,previous);}
 }
 if(family==15&&mode<2){install_method(ctx,handler,JS_ATOM_has,30);install_method(ctx,handler,JS_ATOM_get,31);}
 if(family==13&&mode==8)put(ctx,handler,JS_ATOM_value,roots[2],7);
}
static JSValue boolean_result(int v){return v<0?JS_EXCEPTION:JS_MKVAL(JS_TAG_BOOL,v!=0);}
static JSValue perform(JSContext *ctx){
 JSValue object=roots[2],receiver=roots[3];
 switch(family){
 case 0:return js_proxy_get_prototype(ctx,object);
 case 1:return boolean_result(js_proxy_set_prototype(ctx,object,desired_proto));
 case 2:return boolean_result(js_proxy_is_extensible(ctx,object));
 case 3:return boolean_result(js_proxy_prevent_extensions(ctx,object));
 case 4:return boolean_result(js_proxy_has(ctx,object,JS_ATOM_value));
 case 5:return js_proxy_get(ctx,object,JS_ATOM_value,receiver);
 case 6:return boolean_result(js_proxy_set(ctx,object,JS_ATOM_value,input,receiver,mode==15?16384:0));
 case 7:return boolean_result(js_proxy_delete_property(ctx,object,JS_ATOM_value));
 case 8:{JSPropertyEnum *tab=NULL;uint32_t count=0;if(js_proxy_get_own_property_names(ctx,&tab,&count,object)<0)return JS_EXCEPTION;
  rec[8]=count;for(uint32_t i=0;i<count;i++)rec[9]=rec[9]*16+key_code(tab[i].atom);JS_FreePropertyEnum(ctx,tab,count);return JS_UNDEFINED;}
 case 9:{JSPropertyDescriptor desc;int got=js_proxy_get_own_property(ctx,mode==27?NULL:&desc,object,JS_ATOM_value);if(got<0)return JS_EXCEPTION;
  if(got){rec[10]=mode==27?1:2;if(mode!=27){rec[11]=desc.flags;rec[12]=kind(desc.value);rec[13]=code(desc.value);js_free_desc(ctx,&desc);}}return JS_UNDEFINED;}
 case 10:return boolean_result(js_proxy_define_own_property(ctx,object,JS_ATOM_value,input,JS_UNDEFINED,JS_UNDEFINED,define_flags));
 case 13:{JSValue args[]={roots[0],roots[1]};if(mode==1)args[0]=JS_NewInt32(ctx,1);if(mode==2)args[1]=JS_NULL;
  if(mode==1||mode==2||mode==4)return js_proxy_constructor(ctx,JS_UNDEFINED,2,args);if(mode==3)return js_proxy_revocable(ctx,JS_UNDEFINED,2,args);
  if(mode>=5&&mode<=7){JS_AddIntrinsicProxy(ctx);JSValue function=JS_GetProperty(ctx,ctx->global_obj,JS_ATOM_Proxy);if(JS_IsException(function))return function;
   if(mode==6){JSValue method=JS_GetPropertyStr(ctx,function,"revocable");JS_FreeValue(ctx,function);function=method;if(JS_IsException(function))return function;}
   JSValue result=mode==5?JS_CallConstructor(ctx,function,2,args):JS_Call(ctx,function,JS_UNDEFINED,2,args);JS_FreeValue(ctx,function);return result;}
  int before=reference_count(object);JSValue a=revoke(ctx);if(JS_IsException(a))return a;JS_FreeValue(ctx,a);int first=reference_count(object);
  JSValue b=revoke(ctx);if(JS_IsException(b))return b;JS_FreeValue(ctx,b);rec[16]=before-first;rec[17]=first-reference_count(object);return JS_TRUE;}
 case 14:{if(mode!=0){JS_AddIntrinsicProxy(ctx);return JS_UNDEFINED;}
  int before=reference_count(roots[6]);JSValue result=js_proxy_call(ctx,object,roots[4],0,NULL,JS_CALL_FLAG_CONSTRUCTOR);
  rec[16]=reference_count(roots[6])-before;
  /* Consumer reclaims exactly the independently measured residual owner. This
     does not patch quickjs.c or hide the recorded source ownership divergence. */
  for(unsigned i=0;i<rec[16];i++)JS_FreeValue(ctx,roots[6]);return result;}
 case 15:{if(mode==2)return js_create_desc(ctx,input,JS_UNDEFINED,JS_UNDEFINED,8192|512|1024|256|7);
  JSPropertyDescriptor desc;if(js_obj_to_desc(ctx,&desc,object)<0)return JS_EXCEPTION;
  rec[10]=2;rec[11]=desc.flags;rec[12]=kind(desc.value);js_free_desc(ctx,&desc);return JS_UNDEFINED;}
 default:{JSValue args[]={receiver,JS_NewInt32(ctx,23)};int argc=family==12&&mode==15?0:2;
  return js_proxy_call(ctx,object,family==12?(mode==13?object:roots[4]):receiver,argc,args,family==12?JS_CALL_FLAG_CONSTRUCTOR:0);}
 }
}
static void finish(JSContext *ctx,JSValue result){
 if(JS_IsException(result)){if(!JS_HasException(ctx))abort();JSValue error=JS_GetException(ctx);rec[1]=JS_IsNumber(error)?code(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error);}
 else{rec[0]=1;rec[1]=kind(result);if(JS_IsNumber(result)){union{double d;uint64_t u;}bits;bits.d=JS_VALUE_GET_TAG(result)==JS_TAG_INT?JS_VALUE_GET_INT(result):JS_VALUE_GET_FLOAT64(result);rec[2]=bits.u;rec[3]=bits.u>>32;}else rec[2]=code(result);
  if(JS_IsObject(result)&&((family==15&&mode==2)||(family==13&&mode==3))){JSPropertyEnum *tab=NULL;uint32_t count=0;if(JS_GetOwnPropertyNames(ctx,&tab,&count,result,3)<0)abort();rec[8]=count;for(uint32_t i=0;i<count;i++)rec[9]=rec[9]*16+key_code(tab[i].atom);JS_FreePropertyEnum(ctx,tab,count);}
  JS_FreeValue(ctx,result);}
 rec[14]=((JSProxyData*)JS_GetOpaque(roots[2],JS_CLASS_PROXY))->is_revoked;rec[18]=reference_count(roots[2]);rec[19]=JS_HasException(ctx);
 JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
}
static void isolated(int f,int m,int armed,int cutoff){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();setup(ctx,f,m);
 unsigned before=faults;fault_after=armed?cutoff:-1;JSValue result=perform(ctx);fault_after=-1;
 rec[20]=faults-before;rec[21]=JS_HasException(ctx);finish(ctx,result);
 for(int i=0;i<9;i++){JSValue owned=roots[i];roots[i]=JS_UNDEFINED;JS_FreeValue(ctx,owned);}JS_RunGC(rt);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);rec[22]=live_count;rec[23]=live_bytes;
 for(int i=0;i<24;i++)word(rec[i]);
}
int main(int argc,char **argv){
 if(argc==5){isolated(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]));return 0;}
 if(argc==2&&!strcmp(argv[1],"faults")){FAULT_CALLS;return 0;}
 SEMANTIC_CALLS
 return 0;
}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_proxy_test_support as fixture
import js_exceptions { JsException }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
struct Case { family: u32, mode: u32 }
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
 let mut system = Allocator.systemAllocatorProvider() let mut out = ByteBuffer.make()
 CALLS
 let mut writer = StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def silk_calls(cases, *, faults=False):
    rows = ',\n'.join(f'Case {{ family: {f}, mode: {m} }}' for f, m in cases)
    return f'let cases: [Case; {len(cases)}] = [{rows}]\n' + f'''
 let mut at: usize = 0
 while at < cases.length {{
  let mut cutoff: usize = 0
  while cutoff < {CUTOFFS if faults else 1} {{
   let record = run fixture.isolated(cases[at].family, cases[at].mode, {'true' if faults else 'false'}, cutoff)
   let mut field: usize = 0
   while field < 24 {{ run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }}
   cutoff = cutoff + 1
  }}
  at = at + 1
 }}
'''


def records(data, count, owner):
    if len(data) != count * 96:
        raise SystemExit(f'{owner}: expected {count * 96} record bytes, got {len(data)}')
    result = list(struct.iter_unpack('<24I', data))
    for index, record in enumerate(result):
        if record[22:] != (0, 0):
            raise SystemExit(f'{owner} record {index}: nonzero final ledger {record[22:]}')
        if not record[0] and not record[21]:
            raise SystemExit(f'{owner} record {index}: failed without a real pending exception')
    return result


def inspect_faults(data, owner):
    rows = records(data, len(FAULT_CASES) * CUTOFFS, owner)
    total = 0
    for phase, case in enumerate(FAULT_CASES):
        group = rows[phase * CUTOFFS:(phase + 1) * CUTOFFS]
        failures = sum(row[20] for row in group)
        if not failures or not any(row[20] == 0 for row in group):
            raise SystemExit(f'{owner} {case}: sweep did not cross both allocation failure and clean execution')
        if any(row[20] > 1 for row in group):
            raise SystemExit(f'{owner} {case}: one-shot allocator fired more than once')
        total += failures
        if case == (15, 2) and not any(row[0] and row[19] and row[8] < 4 for row in group):
            raise SystemExit(f'{owner}: descriptor conversion did not expose ignored field-definition failure and partial object')
    return total


def run_native(temp, silk, stdlib, calls, owner):
    (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', calls))
    command = [silk, 'run', '--quiet', '--release']
    if stdlib:
        command += ['--stdlib', str(stdlib)]
    return process(command,
                   1200, owner=owner, cwd=temp)


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
    stdlib = args.stdlib.resolve() if args.stdlib else None
    with tempfile.TemporaryDirectory(prefix='silkjs-proxy-') as directory:
        temp = Path(directory).resolve()
        semantic_calls = '\n'.join(f'isolated({f},{m},0,0);' for f, m in CASES)
        fault_calls = '\n'.join(f'for(int cutoff=0;cutoff<{CUTOFFS};cutoff++)isolated({f},{m},1,cutoff);' for f, m in FAULT_CASES)
        (temp / 'oracle.c').write_text(C_SOURCE.replace('SEMANTIC_CALLS', semantic_calls).replace('FAULT_CALLS', fault_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Proxy unchanged-C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Proxy C semantic records')
        c_records = records(expected, len(CASES), 'C semantics')
        c_faults = process([str(temp / 'oracle'), 'faults'], 600, owner='Proxy C isolated allocation sweeps')
        c_failures = inspect_faults(c_faults, 'C allocation')
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="proxy-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        actual = run_native(temp, silk, stdlib, silk_calls(CASES), 'Proxy native semantic records')
        native_records = records(actual, len(CASES), 'Native semantics')
        for case, c_record, native_record in zip(CASES, c_records, native_records):
            for field, (c_word, native_word) in enumerate(zip(c_record, native_record)):
                if c_word != native_word:
                    raise SystemExit(f'{FAMILIES[case[0]]} mode={case[1]} {FIELDS[field]}: C={c_word:#x} native={native_word:#x}')
        native_faults = run_native(temp, silk, stdlib, silk_calls(FAULT_CASES, faults=True), 'Proxy native isolated allocation sweeps')
        native_failures = inspect_faults(native_faults, 'Native allocation')

        # Ownership defects are not permitted to poison the ordinary semantic or
        # failure-sweep process. Source is still compiled unchanged for each path.
        source_construct = process([str(temp / 'oracle'), '14', '0', '0', '0'], 120, owner='Proxy C constructor ownership probe')
        c_construct = records(source_construct, 1, 'C constructor ownership')[0]
        native_probes = run_native(temp, silk, stdlib, silk_calls([(14, 0), (14, 1), (14, 2)]), 'Proxy native ownership probes')
        n_construct, n_readonly, n_throwing = records(native_probes, 3, 'Native source-edge probes')
        if n_construct[0] or n_construct[1] != 104 or n_construct[16] != 0 or n_construct[5] != 1:
            raise SystemExit(f'native constructor ownership regression: {n_construct}')
        if c_construct[0] or c_construct[1] != 104 or c_construct[5] != 1 or c_construct[16] not in (0, 1):
            raise SystemExit(f'unexplained C constructor ownership observation: {c_construct}')
        source_readonly = process([str(temp / 'oracle'), '14', '1', '0', '0'], 120, owner='Proxy C readonly intrinsic probe')
        c_readonly = records(source_readonly, 1, 'C readonly intrinsic')[0]
        if c_readonly != n_readonly:
            raise SystemExit(f'readonly intrinsic semantic mismatch: C={c_readonly} native={n_readonly}')
        if n_throwing[0] or n_throwing[1] != 707:
            raise SystemExit(f'native intrinsic consumed-owner regression: {n_throwing}')
        hazard = subprocess.run([str(temp / 'oracle'), '14', '2', '0', '0'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if hazard.returncode == 0:
            hazard_record = records(hazard.stdout, 1, 'C throwing-global intrinsic')[0]
            hazard_status = f'completed, pending={hazard_record[19]}, exception={hazard_record[1]}'
        elif hazard.returncode < 0 and -hazard.returncode in (signal.SIGABRT, signal.SIGSEGV, signal.SIGBUS):
            hazard_status = f'terminated by {signal.Signals(-hazard.returncode).name}'
        else:
            raise SystemExit(f'unexpected C intrinsic probe exit {hazard.returncode}: {hazard.stderr.decode(errors="replace")}')
        print(f'PASS Proxy: {len(CASES)} independent semantic records, {pins} pinned files; sha256={hashlib.sha256(actual).hexdigest()}')
        print(f'OOM: {len(FAULT_CASES) * CUTOFFS} isolated attempts/engine; failures native={native_failures} C={c_failures}; all emitted final ledgers zero')
        print(f'SOURCE OBSERVATION quickjs.c:53764: residual method owners={c_construct[16]} (consumer reclaimed measured owner); native=0')
        print(f'SOURCE OBSERVATION quickjs.c:53973 consumed-negative intrinsic path: {hazard_status}; native cleanup and ledger zero')
        if hazard.returncode:
            print('C crashing intrinsic subprocess has no final ledger; it is an explicit source-defect observation, not a passing allocation-ledger record')


if __name__ == '__main__':
    main()
