/* Stable Node-API values implemented by the owning SilkJS realm. */
#include "napi_bridge.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <limits.h>

#define TRY(expr) do { napi_status s_ = (expr); if (s_ != napi_ok) return s_; } while (0)
#define REQUIRE(test) do { if (!(test)) return silk_napi_status(env, napi_invalid_arg); } while (0)
#define CHECK() TRY(silk_napi_check(env))
#define OWNER() REQUIRE(env && silk_napi_on_owner(env))
static napi_status js(napi_env env, const char *op, size_t count, const napi_value *args, napi_value *out) {
  napi_value ignored;
  for (size_t i = 0; i < count; ++i) REQUIRE(args[i] && args[i]->env == env);
  return silk_napi_js(env, op, count, args, out ? out : &ignored);
}
/* These dispatcher operations only inspect internal metadata or allocate plain
 * values. Node permits them with an exception pending; preserve that exception
 * while entering Silk's JS implementation of the operation. */
static napi_status pure_js(napi_env env, const char *op, size_t count, const napi_value *args, napi_value *out) {
  OWNER(); bool pending; TRY(napi_is_exception_pending(env,&pending));
  napi_value saved=NULL;
  if (pending) TRY(napi_get_and_clear_last_exception(env,&saved));
  napi_status status=js(env,op,count,args,out);
  if (pending) {
    silk_napi_packet restore={.values={saved}};
    napi_status restored=silk_napi_call(env,SILK_NAPI_THROW,&restore);
    if (restored!=napi_ok) return restored;
  }
  return silk_napi_status(env,status);
}
static napi_status pure_boolean(napi_env env, const char *op, size_t count, const napi_value *args, bool *result) {
  OWNER(); REQUIRE(result); napi_value value;
  TRY(pure_js(env,op,count,args,&value)); return napi_get_value_bool(env,value,result);
}
/* Only for arrays freshly produced by the private dispatcher, never user
 * properties: reading these cannot invoke accessors or proxy traps. */
static napi_status packet_element(napi_env env,napi_value packet,uint32_t index,napi_value *result) {
  napi_value args[]={packet,NULL}; TRY(napi_create_uint32(env,index,&args[1]));
  return pure_js(env,"get",2,args,result);
}
static napi_status primitive(napi_env env, int op, silk_napi_packet *packet, napi_value *result) {
  OWNER(); REQUIRE(result);
  packet->result = silk_napi_slot(env);
  if (!packet->result) return silk_napi_status(env, napi_generic_failure);
  TRY(silk_napi_call(env, op, packet)); *result = packet->result; return napi_ok;
}
static napi_status expect(napi_env env, napi_value value, napi_valuetype type, napi_status error) {
  napi_valuetype actual; TRY(napi_typeof(env, value, &actual));
  return actual == type ? napi_ok : silk_napi_status(env, error);
}
static napi_status object(napi_env env, napi_value value) {
  napi_valuetype type; TRY(napi_typeof(env, value, &type));
  return type == napi_object || type == napi_function ? napi_ok : silk_napi_status(env, napi_object_expected);
}
static napi_status boolean_op(napi_env env, const char *op, size_t argc, const napi_value *argv, bool *result) {
  CHECK(); REQUIRE(result); napi_value value; TRY(js(env, op, argc, argv, &value)); return napi_get_value_bool(env, value, result);
}
napi_status napi_get_undefined(napi_env env, napi_value *result) { silk_napi_packet p = {0}; return primitive(env, SILK_NAPI_UNDEFINED, &p, result); }
napi_status napi_get_null(napi_env env, napi_value *result) { silk_napi_packet p = {0}; return primitive(env, SILK_NAPI_NULL, &p, result); }
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result) { silk_napi_packet p = {.flags = value}; return primitive(env, SILK_NAPI_BOOLEAN, &p, result); }
napi_status napi_create_double(napi_env env, double value, napi_value *result) { silk_napi_packet p = {.number = value}; return primitive(env, SILK_NAPI_NUMBER, &p, result); }
napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result) { return napi_create_double(env, value, result); }
napi_status napi_create_uint32(napi_env env, uint32_t value, napi_value *result) { return napi_create_double(env, value, result); }
napi_status napi_create_int64(napi_env env, int64_t value, napi_value *result) { return napi_create_double(env, (double)value, result); }
static napi_status string(napi_env env, const void *data, size_t length, int encoding, napi_value *result) {
  OWNER(); REQUIRE(data || length == 0);
  if (length == NAPI_AUTO_LENGTH) {
    length = 0;
    if (encoding == 2) { const char16_t *s = data; while (s[length]) ++length; }
    else length = strlen(data);
  }
  silk_napi_packet p = {.data = (void *)data, .size = length, .flags = encoding};
  return primitive(env, SILK_NAPI_STRING, &p, result);
}
napi_status napi_create_string_utf8(napi_env env, const char *s, size_t n, napi_value *r) { return string(env, s, n, 0, r); }
napi_status napi_create_string_latin1(napi_env env, const char *s, size_t n, napi_value *r) { return string(env, s, n, 1, r); }
napi_status napi_create_string_utf16(napi_env env, const char16_t *s, size_t n, napi_value *r) { return string(env, s, n, 2, r); }
napi_status node_api_create_property_key_utf8(napi_env e, const char *s, size_t n, napi_value *r) { return napi_create_string_utf8(e,s,n,r); }
napi_status node_api_create_property_key_latin1(napi_env e, const char *s, size_t n, napi_value *r) { return napi_create_string_latin1(e,s,n,r); }
napi_status node_api_create_property_key_utf16(napi_env e, const char16_t *s, size_t n, napi_value *r) { return napi_create_string_utf16(e,s,n,r); }
napi_status node_api_create_external_string_latin1(napi_env env, char *s, size_t n, node_api_basic_finalize cb, void *hint, napi_value *r, bool *copied) {
  TRY(napi_create_string_latin1(env,s,n,r)); if (copied) *copied = true; if (cb) cb(env,s,hint); return napi_ok;
}
napi_status node_api_create_external_string_utf16(napi_env env, char16_t *s, size_t n, node_api_basic_finalize cb, void *hint, napi_value *r, bool *copied) {
  TRY(napi_create_string_utf16(env,s,n,r)); if (copied) *copied = true; if (cb) cb(env,s,hint); return napi_ok;
}
static napi_status read_string(napi_env env, napi_value value, void *buffer, size_t size, size_t *result, int encoding) {
  OWNER(); REQUIRE(buffer || result); TRY(expect(env,value,napi_string,napi_string_expected));
  silk_napi_packet p = {.values = {value}, .data = buffer, .size = size, .flags = encoding};
  TRY(silk_napi_call(env,SILK_NAPI_READ_STRING,&p)); if (result) *result = p.offset; return napi_ok;
}
napi_status napi_get_value_string_utf8(napi_env e,napi_value v,char *b,size_t n,size_t *r) { return read_string(e,v,b,n,r,0); }
napi_status napi_get_value_string_latin1(napi_env e,napi_value v,char *b,size_t n,size_t *r) { return read_string(e,v,b,n,r,1); }
napi_status napi_get_value_string_utf16(napi_env e,napi_value v,char16_t *b,size_t n,size_t *r) { return read_string(e,v,b,n,r,2); }
napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result) {
  OWNER(); REQUIRE(value && value->env == env && result);
  silk_napi_packet p = {.values = {value}}; TRY(silk_napi_call(env,SILK_NAPI_TYPEOF,&p));
  *result = (napi_valuetype)p.flags;
  if (*result == napi_object) { bool external; TRY(pure_boolean(env,"externalType",1,&value,&external)); if (external) *result = napi_external; }
  return napi_ok;
}
napi_status napi_get_value_double(napi_env env,napi_value value,double *result) {
  OWNER(); REQUIRE(result); TRY(expect(env,value,napi_number,napi_number_expected));
  silk_napi_packet p = {.values = {value}}; TRY(silk_napi_call(env,SILK_NAPI_READ_NUMBER,&p)); *result=p.number; return napi_ok;
}
napi_status napi_get_value_bool(napi_env env,napi_value value,bool *result) {
  OWNER(); REQUIRE(result); TRY(expect(env,value,napi_boolean,napi_boolean_expected));
  silk_napi_packet p = {.values = {value}}; TRY(silk_napi_call(env,SILK_NAPI_READ_NUMBER,&p)); *result=p.number != 0; return napi_ok;
}
napi_status napi_get_value_uint32(napi_env env,napi_value value,uint32_t *result) {
  OWNER(); REQUIRE(result); double n; TRY(napi_get_value_double(env,value,&n));
  double mod = isfinite(n) ? fmod(trunc(n),4294967296.0) : 0; if (mod < 0) mod += 4294967296.0; *result=(uint32_t)mod; return napi_ok;
}
napi_status napi_get_value_int32(napi_env env,napi_value value,int32_t *result) {
  OWNER(); REQUIRE(result); uint32_t n; TRY(napi_get_value_uint32(env,value,&n)); memcpy(result,&n,sizeof(n)); return napi_ok;
}
napi_status napi_get_value_int64(napi_env env,napi_value value,int64_t *result) {
  OWNER(); REQUIRE(result); double n; TRY(napi_get_value_double(env,value,&n));
  *result = !isfinite(n) ? 0 : n >= 0x1p63 ? INT64_MAX : n <= -0x1p63 ? INT64_MIN : (int64_t)n; return napi_ok;
}
#define ZERO_API(name,op) napi_status name(napi_env env,napi_value *result) { OWNER(); REQUIRE(result); return pure_js(env,op,0,NULL,result); }
ZERO_API(napi_get_global,"global")
ZERO_API(napi_create_object,"object")
ZERO_API(napi_create_array,"array")
#define UNARY_API(name,op) napi_status name(napi_env env,napi_value value,napi_value *result) { CHECK(); REQUIRE(value && result); return js(env,op,1,&value,result); }
UNARY_API(napi_coerce_to_bool,"bool")
UNARY_API(napi_coerce_to_number,"number")
UNARY_API(napi_coerce_to_object,"objectCoerce")
UNARY_API(napi_coerce_to_string,"string")
#define PREDICATE(name,op) napi_status name(napi_env env,napi_value value,bool *result) { return pure_boolean(env,op,1,&value,result); }
PREDICATE(napi_is_array,"isArray")
PREDICATE(napi_is_error,"isError")
PREDICATE(napi_is_date,"isDate")
PREDICATE(napi_is_promise,"isPromise")
PREDICATE(napi_is_arraybuffer,"isArrayBuffer")
PREDICATE(napi_is_typedarray,"isTypedArray")
PREDICATE(napi_is_dataview,"isDataView")
PREDICATE(napi_is_buffer,"isBuffer")
napi_status napi_create_array_with_length(napi_env env,size_t length,napi_value *result) {
  OWNER(); REQUIRE(result && length <= UINT32_MAX); napi_value n; TRY(napi_create_double(env,(double)length,&n)); return pure_js(env,"array",1,&n,result);
}
napi_status napi_create_symbol(napi_env env,napi_value description,napi_value *result) {
  OWNER(); REQUIRE(result); if (!description) TRY(napi_get_undefined(env,&description)); else TRY(expect(env,description,napi_string,napi_string_expected));
  return pure_js(env,"symbol",1,&description,result);
}
napi_status node_api_symbol_for(napi_env env,const char *description,size_t length,napi_value *result) {
  OWNER(); REQUIRE(result); napi_value str; TRY(napi_create_string_utf8(env,description,length,&str)); return pure_js(env,"symbolFor",1,&str,result);
}
static napi_status error_value(napi_env env,int kind,napi_value code,napi_value msg,napi_value *result) {
  OWNER(); REQUIRE(result); TRY(expect(env,msg,napi_string,napi_string_expected));
  if (code) TRY(expect(env,code,napi_string,napi_string_expected)); else TRY(napi_get_undefined(env,&code));
  napi_value args[3]; TRY(napi_create_int32(env,kind,args)); args[1]=code; args[2]=msg; return pure_js(env,"error",3,args,result);
}
napi_status napi_create_error(napi_env e,napi_value c,napi_value m,napi_value *r) { return error_value(e,0,c,m,r); }
napi_status napi_create_type_error(napi_env e,napi_value c,napi_value m,napi_value *r) { return error_value(e,1,c,m,r); }
napi_status napi_create_range_error(napi_env e,napi_value c,napi_value m,napi_value *r) { return error_value(e,2,c,m,r); }
napi_status node_api_create_syntax_error(napi_env e,napi_value c,napi_value m,napi_value *r) { return error_value(e,3,c,m,r); }
napi_status napi_get_prototype(napi_env env,napi_value value,napi_value *result) { CHECK(); REQUIRE(result); TRY(object(env,value)); return js(env,"prototype",1,&value,result); }
napi_status napi_set_property(napi_env env,napi_value value,napi_value key,napi_value data) { CHECK(); TRY(object(env,value)); napi_value a[]={value,key,data}; return js(env,"set",3,a,NULL); }
napi_status napi_get_property(napi_env env,napi_value value,napi_value key,napi_value *result) { CHECK(); REQUIRE(result); TRY(object(env,value)); napi_value a[]={value,key}; return js(env,"get",2,a,result); }
napi_status napi_has_property(napi_env env,napi_value value,napi_value key,bool *result) { CHECK(); TRY(object(env,value)); napi_value a[]={value,key}; return boolean_op(env,"has",2,a,result); }
napi_status napi_delete_property(napi_env env,napi_value value,napi_value key,bool *result) { CHECK(); TRY(object(env,value)); bool ignored; napi_value a[]={value,key}; return boolean_op(env,"delete",2,a,result ? result : &ignored); }
napi_status napi_has_own_property(napi_env env,napi_value value,napi_value key,bool *result) {
  CHECK(); TRY(object(env,value)); napi_valuetype type; TRY(napi_typeof(env,key,&type));
  if (type != napi_string && type != napi_symbol) return silk_napi_status(env,napi_name_expected);
  napi_value a[]={value,key}; return boolean_op(env,"hasOwn",2,a,result);
}
#define NAMED_API(name,target,outtype) napi_status name(napi_env env,napi_value object,const char *name,outtype out) { CHECK(); REQUIRE(name); napi_value key; TRY(napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&key)); return target(env,object,key,out); }
NAMED_API(napi_set_named_property,napi_set_property,napi_value)
NAMED_API(napi_get_named_property,napi_get_property,napi_value *)
NAMED_API(napi_has_named_property,napi_has_property,bool *)
#define ELEMENT_API(name,target,outtype) napi_status name(napi_env env,napi_value object,uint32_t index,outtype out) { napi_value key; TRY(napi_create_uint32(env,index,&key)); return target(env,object,key,out); }
ELEMENT_API(napi_set_element,napi_set_property,napi_value)
ELEMENT_API(napi_get_element,napi_get_property,napi_value *)
ELEMENT_API(napi_has_element,napi_has_property,bool *)
ELEMENT_API(napi_delete_element,napi_delete_property,bool *)
napi_status napi_get_array_length(napi_env env,napi_value value,uint32_t *result) {
  CHECK(); REQUIRE(result); bool yes; TRY(napi_is_array(env,value,&yes)); if (!yes) return silk_napi_status(env,napi_array_expected);
  napi_value n; TRY(js(env,"arrayLength",1,&value,&n)); return napi_get_value_uint32(env,n,result);
}
napi_status napi_strict_equals(napi_env env,napi_value a,napi_value b,bool *result) { napi_value args[]={a,b}; return boolean_op(env,"equal",2,args,result); }
napi_status napi_instanceof(napi_env env,napi_value value,napi_value constructor,bool *result) {
  CHECK(); TRY(expect(env,constructor,napi_function,napi_function_expected)); napi_value args[]={value,constructor}; return boolean_op(env,"instanceOf",2,args,result);
}
static napi_status argument_array(napi_env env,size_t count,const napi_value *argv,napi_value *array) {
  REQUIRE(!count || argv); REQUIRE(count <= UINT32_MAX); TRY(napi_create_array_with_length(env,count,array));
  for (size_t i=0;i<count;++i) TRY(napi_set_element(env,*array,(uint32_t)i,argv[i])); return napi_ok;
}
napi_status napi_call_function(napi_env env,napi_value recv,napi_value fn,size_t argc,const napi_value *argv,napi_value *result) {
  CHECK(); REQUIRE(recv); TRY(expect(env,fn,napi_function,napi_function_expected)); napi_value args[]={recv,fn,NULL};
  TRY(argument_array(env,argc,argv,&args[2])); return js(env,"call",3,args,result);
}
napi_status napi_new_instance(napi_env env,napi_value fn,size_t argc,const napi_value *argv,napi_value *result) {
  CHECK(); REQUIRE(result); TRY(expect(env,fn,napi_function,napi_function_expected)); napi_value args[]={fn,NULL};
  TRY(argument_array(env,argc,argv,&args[1])); return js(env,"construct",2,args,result);
}
static napi_status define_property(napi_env env,napi_value object,const napi_property_descriptor *p) {
  napi_value args[6]={object};
  if (p->utf8name) TRY(napi_create_string_utf8(env,p->utf8name,NAPI_AUTO_LENGTH,&args[1])); else args[1]=p->name;
  REQUIRE(args[1]); napi_valuetype type; TRY(napi_typeof(env,args[1],&type));
  if (type != napi_string && type != napi_symbol) return silk_napi_status(env,napi_name_expected);
  TRY(napi_get_undefined(env,&args[2])); args[3]=args[4]=args[2];
  if (p->getter) TRY(napi_create_function(env,p->utf8name ? p->utf8name : "",NAPI_AUTO_LENGTH,p->getter,p->data,&args[3]));
  if (p->setter) TRY(napi_create_function(env,p->utf8name ? p->utf8name : "",NAPI_AUTO_LENGTH,p->setter,p->data,&args[4]));
  if (!p->getter && !p->setter) {
    if (p->method) TRY(napi_create_function(env,p->utf8name ? p->utf8name : "",NAPI_AUTO_LENGTH,p->method,p->data,&args[2]));
    else if (p->value) args[2]=p->value;
  }
  TRY(napi_create_uint32(env,p->attributes,&args[5])); return js(env,"define",6,args,NULL);
}
napi_status napi_define_properties(napi_env env,napi_value value,size_t count,const napi_property_descriptor *properties) {
  CHECK(); REQUIRE(!count || properties); TRY(object(env,value)); for(size_t i=0;i<count;++i) TRY(define_property(env,value,&properties[i])); return napi_ok;
}
napi_status napi_define_class(napi_env env,const char *name,size_t length,napi_callback constructor,void *data,size_t count,const napi_property_descriptor *properties,napi_value *result) {
  CHECK(); REQUIRE(name && constructor && result && (!count || properties)); napi_value fn,prototype;
  TRY(napi_create_function(env,name,length,constructor,data,&fn)); TRY(napi_get_named_property(env,fn,"prototype",&prototype));
  for(size_t i=0;i<count;++i) TRY(define_property(env,(properties[i].attributes & napi_static) ? fn : prototype,&properties[i]));
  *result=fn; return napi_ok;
}
napi_status napi_get_all_property_names(napi_env env,napi_value value,napi_key_collection_mode mode,napi_key_filter filter,napi_key_conversion conversion,napi_value *result) {
  CHECK(); REQUIRE(result && (mode==napi_key_own_only || mode==napi_key_include_prototypes) && !(filter & ~31) && (conversion==napi_key_keep_numbers || conversion==napi_key_numbers_to_strings));
  TRY(object(env,value)); napi_value args[]={value,NULL,NULL,NULL}; TRY(napi_create_int32(env,mode,&args[1])); TRY(napi_create_int32(env,filter,&args[2])); TRY(napi_create_int32(env,conversion,&args[3])); return js(env,"keys",4,args,result);
}
napi_status napi_get_property_names(napi_env e,napi_value v,napi_value *r) { return napi_get_all_property_names(e,v,napi_key_include_prototypes,napi_key_enumerable|napi_key_skip_symbols,napi_key_numbers_to_strings,r); }
napi_status napi_object_freeze(napi_env env,napi_value value) { CHECK(); TRY(object(env,value)); return js(env,"freeze",1,&value,NULL); }
napi_status napi_object_seal(napi_env env,napi_value value) { CHECK(); TRY(object(env,value)); return js(env,"seal",1,&value,NULL); }
napi_status napi_run_script(napi_env env,napi_value script,napi_value *result) { CHECK(); REQUIRE(result); TRY(expect(env,script,napi_string,napi_string_expected)); return js(env,"runScript",1,&script,result); }
napi_status napi_create_date(napi_env env,double time,napi_value *result) { CHECK(); REQUIRE(result); napi_value value; TRY(napi_create_double(env,time,&value)); return js(env,"date",1,&value,result); }
napi_status napi_get_date_value(napi_env env,napi_value value,double *result) {
  CHECK(); REQUIRE(result); bool yes; TRY(napi_is_date(env,value,&yes)); if (!yes) return silk_napi_status(env,napi_date_expected);
  napi_value n; TRY(js(env,"dateValue",1,&value,&n)); return napi_get_value_double(env,n,result);
}

static napi_status register_finalizer(napi_env env, void *data, node_api_basic_finalize cb, void *hint, uintptr_t *id, napi_value *value) {
  *id = silk_napi_finalizer(env,data,cb,hint);
  if (!*id) return silk_napi_status(env,napi_generic_failure);
  napi_status status = napi_create_double(env,(double)*id,value);
  if (status != napi_ok) silk_napi_cancel_finalizer(env,*id);
  return status;
}
napi_status napi_wrap(napi_env env,napi_value value,void *data,node_api_basic_finalize cb,void *hint,napi_ref *result) {
  CHECK(); TRY(object(env,value)); REQUIRE(!result || cb);
  uintptr_t id; napi_value args[]={value,NULL}; TRY(register_finalizer(env,data,cb,hint,&id,&args[1]));
  bool added; napi_status status=boolean_op(env,"wrap",2,args,&added);
  if (status != napi_ok || !added) { silk_napi_cancel_finalizer(env,id); return status != napi_ok ? status : silk_napi_status(env,napi_invalid_arg); }
  if (result) {
    status=napi_create_reference(env,value,0,result);
    if (status != napi_ok) { js(env,"removeWrap",1,&value,NULL); silk_napi_cancel_finalizer(env,id); }
  }
  return status;
}
static napi_status unwrap(napi_env env,napi_value value,void **result,int remove) {
  CHECK(); REQUIRE(result); TRY(object(env,value)); napi_value record; double id;
  TRY(js(env,remove ? "removeWrap" : "unwrap",1,&value,&record)); TRY(napi_get_value_double(env,record,&id));
  REQUIRE(id != 0); *result=silk_napi_finalizer_data(env,(uintptr_t)id);
  if (remove) silk_napi_cancel_finalizer(env,(uintptr_t)id); return napi_ok;
}
napi_status napi_unwrap(napi_env env,napi_value value,void **result) { return unwrap(env,value,result,0); }
napi_status napi_remove_wrap(napi_env env,napi_value value,void **result) { return unwrap(env,value,result,1); }
napi_status napi_create_external(napi_env env,void *data,node_api_basic_finalize cb,void *hint,napi_value *result) {
  CHECK(); REQUIRE(result); uintptr_t id; napi_value record;
  TRY(register_finalizer(env,data,cb,hint,&id,&record));
  napi_status status=js(env,"external",1,&record,result); if (status != napi_ok) silk_napi_cancel_finalizer(env,id); return status;
}
napi_status napi_get_value_external(napi_env env,napi_value value,void **result) {
  OWNER(); REQUIRE(result); TRY(expect(env,value,napi_external,napi_invalid_arg)); napi_value record; double id;
  TRY(pure_js(env,"externalId",1,&value,&record)); TRY(napi_get_value_double(env,record,&id)); *result=silk_napi_finalizer_data(env,(uintptr_t)id); return napi_ok;
}
napi_status napi_add_finalizer(napi_env env,napi_value value,void *data,node_api_basic_finalize cb,void *hint,napi_ref *result) {
  CHECK(); REQUIRE(cb); TRY(object(env,value));
  napi_ref ref=NULL; if (result) TRY(napi_create_reference(env,value,0,&ref));
  uintptr_t id; napi_value args[]={value,NULL};
  napi_status status=register_finalizer(env,data,cb,hint,&id,&args[1]);
  if (status==napi_ok) { status=js(env,"addFinalizer",2,args,NULL); if(status!=napi_ok) silk_napi_cancel_finalizer(env,id); }
  if (status!=napi_ok && ref) napi_delete_reference(env,ref);
  if (status==napi_ok && result) *result=ref;
  return status;
}
static napi_status tagged_object(napi_env env,napi_value value) {
  napi_valuetype type; TRY(napi_typeof(env,value,&type));
  return type==napi_object || type==napi_function || type==napi_external ? napi_ok : silk_napi_status(env,napi_object_expected);
}
static napi_status tag_string(napi_env env,const napi_type_tag *tag,napi_value *result) {
  REQUIRE(tag); char text[33]; snprintf(text,sizeof(text),"%016llx%016llx",(unsigned long long)tag->lower,(unsigned long long)tag->upper);
  return napi_create_string_utf8(env,text,32,result);
}
napi_status napi_type_tag_object(napi_env env,napi_value value,const napi_type_tag *tag) {
  CHECK(); TRY(tagged_object(env,value)); napi_value args[]={value,NULL}; TRY(tag_string(env,tag,&args[1])); bool added;
  TRY(boolean_op(env,"tag",2,args,&added)); return silk_napi_status(env,added ? napi_ok : napi_invalid_arg);
}
napi_status napi_check_object_type_tag(napi_env env,napi_value value,const napi_type_tag *tag,bool *result) {
  CHECK(); REQUIRE(result); TRY(tagged_object(env,value)); napi_value args[]={value,NULL}; TRY(tag_string(env,tag,&args[1])); return boolean_op(env,"checkTag",2,args,result);
}

napi_status napi_create_arraybuffer(napi_env env,size_t length,void **data,napi_value *result) {
  CHECK(); silk_napi_packet p={.size=length}; TRY(primitive(env,SILK_NAPI_BUFFER,&p,result)); if(data) *data=p.data; return napi_ok;
}
napi_status napi_create_external_arraybuffer(napi_env env,void *data,size_t length,node_api_basic_finalize cb,void *hint,napi_value *result) {
  CHECK(); REQUIRE(result && (data || !length));
  uintptr_t id=silk_napi_finalizer(env,data,cb,hint); if(!id) return silk_napi_status(env,napi_generic_failure);
  silk_napi_packet p={.size=length,.data=data,.extra=(void *)id};
  napi_status status=primitive(env,SILK_NAPI_EXTERNAL_BUFFER,&p,result);
  if(status!=napi_ok) silk_napi_cancel_finalizer(env,id); return status;
}
napi_status napi_get_arraybuffer_info(napi_env env,napi_value value,void **data,size_t *length) {
  OWNER(); bool yes; TRY(napi_is_arraybuffer(env,value,&yes)); if(!yes) return silk_napi_status(env,napi_arraybuffer_expected);
  silk_napi_packet p={.values={value}}; TRY(silk_napi_call(env,SILK_NAPI_BUFFER_INFO,&p));
  if(data) *data=p.data; if(length) *length=p.size; return napi_ok;
}
napi_status napi_detach_arraybuffer(napi_env env,napi_value value) {
  OWNER(); bool yes; TRY(napi_is_arraybuffer(env,value,&yes)); if(!yes) return silk_napi_status(env,napi_arraybuffer_expected);
  silk_napi_packet p={.values={value}}; return silk_napi_call(env,SILK_NAPI_DETACH,&p);
}
napi_status napi_is_detached_arraybuffer(napi_env env,napi_value value,bool *result) {
  OWNER(); REQUIRE(result); bool yes; TRY(napi_is_arraybuffer(env,value,&yes)); if(!yes) { *result=false; return napi_ok; }
  return pure_boolean(env,"detached",1,&value,result);
}
static napi_status create_view(napi_env env,const char *op,int type,size_t length,napi_value backing,size_t offset,napi_value *result) {
  CHECK(); REQUIRE(result); bool yes; TRY(napi_is_arraybuffer(env,backing,&yes)); if(!yes) return silk_napi_status(env,napi_arraybuffer_expected);
  napi_value args[4]; TRY(napi_create_int32(env,type,&args[0])); TRY(napi_create_double(env,(double)length,&args[1]));
  args[2]=backing; TRY(napi_create_double(env,(double)offset,&args[3]));
  return js(env,op,type < 0 ? 3 : 4,type < 0 ? args+1 : args,result);
}
napi_status napi_create_typedarray(napi_env env,napi_typedarray_type type,size_t length,napi_value backing,size_t offset,napi_value *result) {
  CHECK(); REQUIRE(type>=napi_int8_array && type<=napi_float16_array); return create_view(env,"typedArray",type,length,backing,offset,result);
}
napi_status napi_create_dataview(napi_env env,size_t length,napi_value backing,size_t offset,napi_value *result) { return create_view(env,"dataView",-1,length,backing,offset,result); }
static napi_status size_element(napi_env env,napi_value array,uint32_t index,size_t *result) {
  napi_value item; double number; TRY(packet_element(env,array,index,&item)); TRY(napi_get_value_double(env,item,&number)); *result=(size_t)number; return napi_ok;
}
static napi_status view_info(napi_env env,napi_value value,int typed,napi_typedarray_type *type,size_t *length,void **data,napi_value *backing,size_t *offset) {
  OWNER(); bool yes; TRY(typed ? napi_is_typedarray(env,value,&yes) : napi_is_dataview(env,value,&yes)); REQUIRE(yes);
  napi_value info,buffer; size_t size,byte_offset; TRY(pure_js(env,typed ? "typedInfo" : "viewInfo",1,&value,&info));
  if(typed && type) { size_t kind; TRY(size_element(env,info,0,&kind)); *type=(napi_typedarray_type)kind; }
  TRY(size_element(env,info,typed ? 1 : 0,&size)); TRY(packet_element(env,info,typed ? 2 : 1,&buffer));
  TRY(size_element(env,info,typed ? 3 : 2,&byte_offset));
  if(data) { void *base; TRY(napi_get_arraybuffer_info(env,buffer,&base,NULL)); *data=base ? (unsigned char *)base+byte_offset : NULL; }
  if(length) *length=size; if(backing) *backing=buffer; if(offset) *offset=byte_offset; return napi_ok;
}
napi_status napi_get_typedarray_info(napi_env env,napi_value value,napi_typedarray_type *type,size_t *length,void **data,napi_value *backing,size_t *offset) {
  return view_info(env,value,1,type,length,data,backing,offset);
}
napi_status napi_get_dataview_info(napi_env env,napi_value value,size_t *length,void **data,napi_value *backing,size_t *offset) {
  return view_info(env,value,0,NULL,length,data,backing,offset);
}
napi_status node_api_create_buffer_from_arraybuffer(napi_env env,napi_value backing,size_t offset,size_t length,napi_value *result) {
  CHECK(); REQUIRE(result); size_t total; TRY(napi_get_arraybuffer_info(env,backing,NULL,&total));
  if(offset>total || length>total-offset) {
    TRY(napi_throw_range_error(env,"ERR_OUT_OF_RANGE","Buffer range exceeds its ArrayBuffer")); return silk_napi_status(env,napi_pending_exception);
  }
  napi_value args[]={backing,NULL,NULL}; TRY(napi_create_double(env,(double)offset,&args[1])); TRY(napi_create_double(env,(double)length,&args[2]));
  return js(env,"buffer",3,args,result);
}
napi_status napi_create_buffer(napi_env env,size_t length,void **data,napi_value *result) {
  CHECK(); REQUIRE(result); napi_value backing; TRY(napi_create_arraybuffer(env,length,data,&backing)); return node_api_create_buffer_from_arraybuffer(env,backing,0,length,result);
}
napi_status napi_create_external_buffer(napi_env env,size_t length,void *data,node_api_basic_finalize cb,void *hint,napi_value *result) {
  CHECK(); REQUIRE(result); napi_value backing; TRY(napi_create_external_arraybuffer(env,data,length,cb,hint,&backing)); return node_api_create_buffer_from_arraybuffer(env,backing,0,length,result);
}
napi_status napi_create_buffer_copy(napi_env env,size_t length,const void *data,void **result_data,napi_value *result) {
  CHECK(); REQUIRE(data || !length); void *target; TRY(napi_create_buffer(env,length,&target,result)); if(length) memcpy(target,data,length);
  if(result_data) *result_data=target; return napi_ok;
}
napi_status napi_get_buffer_info(napi_env env,napi_value value,void **data,size_t *length) {
  OWNER(); bool yes; TRY(napi_is_buffer(env,value,&yes)); REQUIRE(yes); return view_info(env,value,1,NULL,length,data,NULL,NULL);
}

struct napi_deferred__ { napi_env env; napi_value record; uintptr_t cleanup; };
static void free_deferred(napi_env env,void *data,void *hint) {
  (void)hint; napi_deferred deferred=data; silk_napi_release_root(env,deferred->record); free(deferred);
}
napi_status napi_create_promise(napi_env env,napi_deferred *deferred,napi_value *promise) {
  CHECK(); REQUIRE(deferred && promise); napi_value record; TRY(js(env,"promise",0,NULL,&record));
  TRY(napi_get_element(env,record,0,promise));
  napi_deferred d=calloc(1,sizeof(*d)); if(!d) return silk_napi_status(env,napi_generic_failure);
  d->env=env; d->record=silk_napi_root(env,record);
  if(!d->record) { free(d); return silk_napi_status(env,napi_generic_failure); }
  d->cleanup=silk_napi_finalizer(env,d,free_deferred,NULL);
  if(!d->cleanup) { free_deferred(env,d,NULL); return silk_napi_status(env,napi_generic_failure); }
  *deferred=d; return napi_ok;
}
static napi_status settle(napi_env env,napi_deferred deferred,napi_value value,bool reject) {
  CHECK(); REQUIRE(deferred && deferred->env==env && value); napi_value args[]={deferred->record,value,NULL};
  TRY(napi_get_boolean(env,reject,&args[2])); TRY(js(env,"settle",3,args,NULL));
  silk_napi_cancel_finalizer(env,deferred->cleanup); free_deferred(env,deferred,NULL); return napi_ok;
}
napi_status napi_resolve_deferred(napi_env env,napi_deferred d,napi_value v) { return settle(env,d,v,false); }
napi_status napi_reject_deferred(napi_env env,napi_deferred d,napi_value v) { return settle(env,d,v,true); }

static napi_status bigint_words(napi_env env,int sign,size_t count,const uint64_t *words,napi_value *result) {
  OWNER(); REQUIRE(result && (!count || words)); REQUIRE(count <= (SIZE_MAX-4)/16);
  while(count && words[count-1]==0) --count;
  size_t length=count ? count*16+2 : 3; char small[19], *text=length<sizeof(small) ? small : malloc(length+1);
  if(!text) return silk_napi_status(env,napi_generic_failure);
  text[0]='0'; text[1]='x';
  if(!count) { text[2]='0'; text[3]=0; }
  else for(size_t i=0;i<count;++i) snprintf(text+2+i*16,17,"%016llx",(unsigned long long)words[count-1-i]);
  napi_value str; napi_status status=napi_create_string_utf8(env,text,length,&str);
  if(text!=small) free(text);
  if(status!=napi_ok) return status;
  napi_value args[]={str,NULL}; TRY(napi_get_boolean(env,sign!=0,&args[1])); return pure_js(env,"bigint",2,args,result);
}
napi_status napi_create_bigint_words(napi_env env,int sign,size_t count,const uint64_t *words,napi_value *result) {
  CHECK(); REQUIRE(words && count <= INT_MAX); return bigint_words(env,sign,count,words,result);
}
napi_status napi_create_bigint_uint64(napi_env env,uint64_t value,napi_value *result) { return bigint_words(env,0,1,&value,result); }
napi_status napi_create_bigint_int64(napi_env env,int64_t value,napi_value *result) {
  uint64_t magnitude=value<0 ? (uint64_t)(-(value+1))+1 : (uint64_t)value; return bigint_words(env,value<0,1,&magnitude,result);
}
static napi_status bigint64(napi_env env,napi_value value,uint64_t *result,bool *lossless,bool is_signed) {
  OWNER(); REQUIRE(result && lossless); TRY(expect(env,value,napi_bigint,napi_bigint_expected));
  napi_value args[]={value,NULL},info,item; TRY(napi_get_boolean(env,is_signed,&args[1])); TRY(pure_js(env,"bigint64",2,args,&info));
  uint32_t lo,hi; TRY(packet_element(env,info,0,&item)); TRY(napi_get_value_uint32(env,item,&lo));
  TRY(packet_element(env,info,1,&item)); TRY(napi_get_value_uint32(env,item,&hi)); *result=((uint64_t)hi<<32)|lo;
  TRY(packet_element(env,info,2,&item)); return napi_get_value_bool(env,item,lossless);
}
napi_status napi_get_value_bigint_uint64(napi_env env,napi_value value,uint64_t *result,bool *lossless) { return bigint64(env,value,result,lossless,false); }
napi_status napi_get_value_bigint_int64(napi_env env,napi_value value,int64_t *result,bool *lossless) {
  OWNER(); REQUIRE(result); uint64_t bits; TRY(bigint64(env,value,&bits,lossless,true)); memcpy(result,&bits,sizeof(bits)); return napi_ok;
}
napi_status napi_get_value_bigint_words(napi_env env,napi_value value,int *sign,size_t *count,uint64_t *words) {
  OWNER(); REQUIRE(count && ((sign && words) || (!sign && !words))); TRY(expect(env,value,napi_bigint,napi_bigint_expected));
  napi_value info,item; TRY(pure_js(env,"bigintWords",1,&value,&info)); uint32_t length;
  TRY(pure_js(env,"arrayLength",1,&info,&item)); TRY(napi_get_value_uint32(env,item,&length));
  size_t available=(length-1)/2, capacity=*count; *count=available;
  if(!words) return napi_ok;
  int32_t sign_value; TRY(packet_element(env,info,0,&item)); TRY(napi_get_value_int32(env,item,&sign_value)); *sign=sign_value;
  if(capacity>available) capacity=available;
  for(size_t i=0;i<capacity;++i) {
    uint32_t lo,hi; TRY(packet_element(env,info,(uint32_t)(1+i*2),&item)); TRY(napi_get_value_uint32(env,item,&lo));
    TRY(packet_element(env,info,(uint32_t)(2+i*2),&item)); TRY(napi_get_value_uint32(env,item,&hi)); words[i]=((uint64_t)hi<<32)|lo;
  }
  return napi_ok;
}
