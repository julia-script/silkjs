#define NAPI_VERSION 10
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define OK(expr) do { if ((expr) != napi_ok) { napi_throw_error(env, "NAPI_FIXTURE", #expr); return NULL; } } while (0)
#define ASSERT(test) do { if (!(test)) { napi_throw_error(env,"NAPI_ASSERT",#test); return NULL; } } while (0)
static const napi_type_tag tag = {UINT64_C(0x123456789abcdef0),UINT64_C(0xfedcba9876543210)};
static const napi_type_tag other_tag = {0,1};
static unsigned finalized;
static void release(napi_env env, void *data, void *hint) { (void)env; (void)hint; ++finalized; free(data); }
static napi_value primitives(napi_env env,napi_callback_info info) {
  (void)info; napi_value result,value; OK(napi_create_object(env,&result));
  const char utf8[]={'A',0,(char)0xf0,(char)0x9f,(char)0x98,(char)0x80};
  OK(napi_create_string_utf8(env,utf8,sizeof(utf8),&value)); OK(napi_set_named_property(env,result,"text",value));
  size_t length; char text[8]; OK(napi_get_value_string_utf8(env,value,NULL,0,&length)); ASSERT(length==6);
  OK(napi_get_value_string_utf8(env,value,text,sizeof(text),&length)); ASSERT(length==6 && memcmp(text,utf8,6)==0 && text[6]==0);
  char small[5]; OK(napi_get_value_string_utf8(env,value,small,sizeof(small),&length)); ASSERT(length==2 && small[2]==0);
  char16_t wide[5]; OK(napi_get_value_string_utf16(env,value,wide,5,&length)); ASSERT(length==4 && wide[2]==0xd83d && wide[3]==0xde00);
  const char latin[]={(char)0xff,0,'z'}; OK(napi_create_string_latin1(env,latin,3,&value));
  OK(napi_set_named_property(env,result,"latin",value));
  OK(napi_create_double(env,-4294967297.75,&value)); int32_t signed32; uint32_t unsigned32;
  OK(napi_get_value_int32(env,value,&signed32)); OK(napi_get_value_uint32(env,value,&unsigned32)); ASSERT(signed32==-1 && unsigned32==UINT32_MAX);
  OK(napi_create_double(env,NAN,&value)); int64_t signed64; OK(napi_get_value_int64(env,value,&signed64)); ASSERT(signed64==0);
  ASSERT(napi_get_value_bool(env,value,(bool *)&small[0])==napi_boolean_expected);
  uint64_t words[]={UINT64_MAX,UINT64_C(0x123456789abcdef0)};
  OK(napi_create_bigint_words(env,1,2,words,&value)); OK(napi_set_named_property(env,result,"big",value));
  size_t count=0; OK(napi_get_value_bigint_words(env,value,NULL,&count,NULL)); ASSERT(count==2);
  int sign; uint64_t output[2]; count=2; OK(napi_get_value_bigint_words(env,value,&sign,&count,output)); ASSERT(sign==1 && count==2 && memcmp(output,words,sizeof(words))==0);
  bool lossless; OK(napi_get_value_bigint_int64(env,value,&signed64,&lossless)); ASSERT(!lossless && signed64==1);
  OK(napi_create_bigint_int64(env,INT64_MIN,&value)); OK(napi_get_value_bigint_int64(env,value,&signed64,&lossless)); ASSERT(lossless && signed64==INT64_MIN);
  OK(napi_set_named_property(env,result,"min",value));
  OK(napi_create_date(env,123456789,&value)); double time; OK(napi_get_date_value(env,value,&time)); ASSERT(time==123456789);
  OK(napi_set_named_property(env,result,"date",value));
  OK(node_api_symbol_for(env,"silk.fixture",NAPI_AUTO_LENGTH,&value)); OK(napi_set_named_property(env,result,"symbol",value));
  return result;
}
static napi_value constructor(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1],self,target; OK(napi_get_cb_info(env,info,&argc,args,&self,NULL));
  OK(napi_get_new_target(env,info,&target)); ASSERT(target!=NULL);
  int32_t *data=malloc(sizeof(*data)); ASSERT(data!=NULL); *data=0;
  if(argc) { napi_status status=napi_get_value_int32(env,args[0],data); if(status!=napi_ok) { free(data); napi_throw_type_error(env,NULL,"number required"); return NULL; } }
  napi_status status=napi_wrap(env,self,data,release,NULL,NULL); if(status!=napi_ok) { free(data); napi_throw_error(env,NULL,"wrap failed"); return NULL; }
  OK(napi_type_tag_object(env,self,&tag)); bool match; OK(napi_check_object_type_tag(env,self,&other_tag,&match)); ASSERT(!match);
  return self;
}
static napi_value getter(napi_env env,napi_callback_info info) {
  napi_value self,result; OK(napi_get_cb_info(env,info,NULL,NULL,&self,NULL)); void *data; OK(napi_unwrap(env,self,&data));
  OK(napi_create_int32(env,*(int32_t *)data,&result)); return result;
}
static napi_value setter(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value self,arg; OK(napi_get_cb_info(env,info,&count,&arg,&self,NULL)); ASSERT(count==1);
  void *data; OK(napi_unwrap(env,self,&data)); OK(napi_get_value_int32(env,arg,data)); return NULL;
}
static napi_value method(napi_env env,napi_callback_info info) {
  napi_value self,result; void *hint; OK(napi_get_cb_info(env,info,NULL,NULL,&self,&hint)); ASSERT(hint==(void *)(uintptr_t)99);
  bool match; OK(napi_check_object_type_tag(env,self,&tag,&match)); ASSERT(match); OK(napi_get_boolean(env,true,&result)); return result;
}
static napi_value buffers(napi_env env,napi_callback_info info) {
  (void)info; napi_value result,backing,view,buffer; void *data; OK(napi_create_object(env,&result));
  OK(napi_create_arraybuffer(env,16,&data,&backing)); memset(data,0,16); ((uint32_t *)data)[1]=1234;
  OK(napi_create_typedarray(env,napi_uint32_array,2,backing,4,&view));
  napi_typedarray_type type; size_t length,offset; napi_value original; void *view_data;
  OK(napi_get_typedarray_info(env,view,&type,&length,&view_data,&original,&offset)); ASSERT(type==napi_uint32_array && length==2 && offset==4 && view_data==(char *)data+4);
  bool same; OK(napi_strict_equals(env,original,backing,&same)); ASSERT(same);
  OK(napi_set_named_property(env,result,"view",view)); OK(napi_set_named_property(env,result,"backing",backing));
  OK(node_api_create_buffer_from_arraybuffer(env,backing,4,8,&buffer)); OK(napi_get_buffer_info(env,buffer,&view_data,&length)); ASSERT(view_data==(char *)data+4 && length==8);
  OK(napi_set_named_property(env,result,"buffer",buffer));
  OK(napi_create_dataview(env,3,backing,2,&view)); OK(napi_get_dataview_info(env,view,&length,&view_data,&original,&offset)); ASSERT(length==3 && offset==2 && view_data==(char *)data+2);
  OK(napi_set_named_property(env,result,"dataView",view));
  unsigned char *external=malloc(3); ASSERT(external); external[0]=7; external[1]=8; external[2]=9;
  OK(napi_create_external_buffer(env,3,external,release,NULL,&buffer)); OK(napi_get_buffer_info(env,buffer,&view_data,&length)); ASSERT(view_data==external && length==3);
  external[1]=42; OK(napi_set_named_property(env,result,"external",buffer));
  return result;
}
static napi_value promise(napi_env env,napi_callback_info info) {
  size_t count=2; napi_value args[2],promise; OK(napi_get_cb_info(env,info,&count,args,NULL,NULL)); ASSERT(count==2);
  bool reject; OK(napi_get_value_bool(env,args[1],&reject)); napi_deferred deferred; OK(napi_create_promise(env,&deferred,&promise));
  bool yes; OK(napi_is_promise(env,promise,&yes)); ASSERT(yes);
  if(reject) { OK(napi_reject_deferred(env,deferred,args[0])); } else { OK(napi_resolve_deferred(env,deferred,args[0])); }
  return promise;
}
static napi_value detach(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value value; OK(napi_get_cb_info(env,info,&count,&value,NULL,NULL)); ASSERT(count==1);
  OK(napi_detach_arraybuffer(env,value)); bool yes; OK(napi_is_detached_arraybuffer(env,value,&yes)); ASSERT(yes); return NULL;
}
static napi_value properties(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value value,keys; OK(napi_get_cb_info(env,info,&count,&value,NULL,NULL)); ASSERT(count==1);
  OK(napi_get_all_property_names(env,value,napi_key_include_prototypes,napi_key_enumerable|napi_key_skip_symbols,napi_key_keep_numbers,&keys)); return keys;
}
static napi_value external(napi_env env,napi_callback_info info) {
  (void)info; napi_value value; int *data=malloc(sizeof(*data)); ASSERT(data); *data=42;
  OK(napi_create_external(env,data,release,NULL,&value)); napi_valuetype type; OK(napi_typeof(env,value,&type)); ASSERT(type==napi_external);
  void *pointer; OK(napi_get_value_external(env,value,&pointer)); ASSERT(pointer==data);
  OK(napi_type_tag_object(env,value,&tag)); bool yes; OK(napi_check_object_type_tag(env,value,&tag,&yes)); ASSERT(yes); return value;
}
static napi_value invoke(napi_env env,napi_callback_info info) {
  size_t count=2; napi_value args[2],result; OK(napi_get_cb_info(env,info,&count,args,NULL,NULL)); ASSERT(count==2);
  OK(napi_call_function(env,args[1],args[0],1,&args[1],&result)); return result;
}
static napi_value remove_wrap(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value value; OK(napi_get_cb_info(env,info,&count,&value,NULL,NULL)); ASSERT(count==1);
  void *data; OK(napi_remove_wrap(env,value,&data)); free(data); ASSERT(napi_unwrap(env,value,&data)==napi_invalid_arg); return NULL;
}
static napi_value pending_primitives(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value original,number,boolean,text,big,backing,view,external_value;
  OK(napi_get_cb_info(env,info,&count,&original,NULL,NULL)); ASSERT(count==1);
  OK(napi_create_int32(env,42,&number)); OK(napi_get_boolean(env,true,&boolean));
  OK(napi_create_string_utf8(env,"pending",7,&text)); OK(napi_create_bigint_uint64(env,UINT64_MAX,&big));
  OK(napi_create_arraybuffer(env,8,NULL,&backing)); OK(napi_create_typedarray(env,napi_uint8_array,8,backing,0,&view));
  OK(napi_create_external(env,(void *)(uintptr_t)99,NULL,NULL,&external_value));
  OK(napi_throw(env,original));
  napi_status statuses[16]; napi_value value,cleared,args[3]; napi_valuetype type,external_type;
  bool b=false,is_array=false,lossless=false,pending=false; int32_t integer=0; uint64_t bits=0;
  size_t length=0,view_length=0,capacity=3; char bytes[8]; void *pointer=NULL;
  statuses[0]=napi_typeof(env,original,&type);
  statuses[1]=napi_get_value_bool(env,boolean,&b);
  statuses[2]=napi_get_value_int32(env,number,&integer);
  statuses[3]=napi_get_value_string_utf8(env,text,bytes,sizeof(bytes),&length);
  statuses[4]=napi_get_undefined(env,&value);
  statuses[5]=napi_get_cb_info(env,info,&capacity,args,NULL,NULL);
  statuses[6]=napi_create_array(env,&value);
  statuses[7]=napi_is_array(env,value,&is_array);
  statuses[8]=napi_get_value_bigint_uint64(env,big,&bits,&lossless);
  statuses[9]=napi_get_typedarray_info(env,view,NULL,&view_length,NULL,NULL,NULL);
  statuses[10]=napi_get_value_external(env,external_value,&pointer);
  statuses[11]=napi_typeof(env,external_value,&external_type);
  statuses[12]=napi_create_bigint_int64(env,INT64_MIN,&value);
  statuses[13]=napi_create_string_utf8(env,"preserved",9,&value);
  statuses[14]=napi_create_error(env,NULL,text,&value);
  statuses[15]=napi_is_exception_pending(env,&pending);
  napi_status gated=napi_coerce_to_number(env,number,&value);
  OK(napi_get_and_clear_last_exception(env,&cleared));
  for(size_t i=0;i<16;++i) ASSERT(statuses[i]==napi_ok);
  ASSERT(gated==napi_pending_exception && pending);
  ASSERT(type==napi_object && external_type==napi_external && b && integer==42);
  ASSERT(length==7 && memcmp(bytes,"pending",7)==0 && capacity==1 && is_array);
  ASSERT(bits==UINT64_MAX && lossless && view_length==8 && pointer==(void *)(uintptr_t)99);
  bool same; OK(napi_strict_equals(env,original,cleared,&same)); ASSERT(same);
  OK(napi_typeof(env,args[1],&type)); ASSERT(type==napi_undefined);
  OK(napi_get_boolean(env,true,&value)); return value;
}
NAPI_MODULE_INIT() {
  const char *filename; napi_value module_filename;
  OK(node_api_get_module_file_name(env,&filename));
  OK(napi_create_string_utf8(env,filename,NAPI_AUTO_LENGTH,&module_filename));
  OK(napi_set_named_property(env,exports,"moduleFilename",module_filename));
  napi_property_descriptor functions[]={
    {.utf8name="primitives",.method=primitives}, {.utf8name="buffers",.method=buffers},
    {.utf8name="promise",.method=promise}, {.utf8name="detach",.method=detach},
    {.utf8name="keys",.method=properties}, {.utf8name="external",.method=external},
    {.utf8name="invoke",.method=invoke}, {.utf8name="removeWrap",.method=remove_wrap},
    {.utf8name="pendingPrimitives",.method=pending_primitives}
  };
  OK(napi_define_properties(env,exports,sizeof(functions)/sizeof(functions[0]),functions));
  napi_property_descriptor descriptors[]={
    {.utf8name="value",.getter=getter,.setter=setter,.attributes=napi_enumerable|napi_configurable},
    {.utf8name="check",.method=method,.attributes=napi_default_method,.data=(void *)(uintptr_t)99}
  };
  napi_value cls; OK(napi_define_class(env,"NativeValue",NAPI_AUTO_LENGTH,constructor,NULL,2,descriptors,&cls));
  OK(napi_set_named_property(env,exports,"NativeValue",cls)); return exports;
}
