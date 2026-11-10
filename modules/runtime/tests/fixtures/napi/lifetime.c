/* Real Node-API scope/reference/worker lifetime fixture. SPDX-License-Identifier: MIT */
#define NAPI_VERSION 10
#include <node_api.h>
#include <stdlib.h>
#include <stdio.h>
#define CALL(expr) do { napi_status call_status=(expr); if(call_status!=napi_ok){napi_throw_error(env,"NAPI_FIXTURE",#expr);return NULL;} } while(0)
typedef struct { napi_ref reference; unsigned finalized; } state;
static state *get(napi_env env) { state *s=NULL; napi_get_instance_data(env,(void**)&s); return s; }
static void finish(napi_env env,void *data,void *hint) { (void)env;(void)hint;free(data); }
static void collected(napi_env env,void *data,void *hint) { (void)env;(void)hint;((state*)data)->finalized++; }
static napi_value hold(napi_env env,napi_callback_info info) {
  state *s=get(env);napi_value args[2],target;size_t argc=2;uint32_t count=0;
  CALL(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
  if(argc<2){napi_throw_type_error(env,NULL,"Expected target and count");return NULL;}
  CALL(napi_get_value_uint32(env,args[1],&count));
  if(s->reference){CALL(napi_delete_reference(env,s->reference));s->reference=NULL;}
  CALL(napi_add_finalizer(env,args[0],s,collected,NULL,NULL));
  CALL(napi_create_reference(env,args[0],count,&s->reference));
  CALL(napi_get_reference_value(env,s->reference,&target));return target;
}
static napi_value current(napi_env env,napi_callback_info info) {
  (void)info;state *s=get(env);napi_value result=NULL;
  if(s->reference)CALL(napi_get_reference_value(env,s->reference,&result));
  return result;
}
static napi_value unref(napi_env env,napi_callback_info info) {
  (void)info;uint32_t count;state *s=get(env);napi_value result;
  CALL(napi_reference_unref(env,s->reference,&count));CALL(napi_create_uint32(env,count,&result));return result;
}
static napi_value stats(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;CALL(napi_create_uint32(env,get(env)->finalized,&result));return result;
}
static napi_value scoped(napi_env env,napi_callback_info info) {
  size_t argc=2;napi_value args[2],receiver,output,escaped;napi_handle_scope outer;napi_escapable_handle_scope inner;
  CALL(napi_get_cb_info(env,info,&argc,args,&receiver,NULL));
  if(argc<2){napi_throw_type_error(env,NULL,"Expected callback and object");return NULL;}
  CALL(napi_open_handle_scope(env,&outer));CALL(napi_open_escapable_handle_scope(env,&inner));
  napi_status status=napi_call_function(env,receiver,args[0],1,&args[1],&output);
  if(status==napi_pending_exception){
    napi_value error;CALL(napi_get_and_clear_last_exception(env,&error));CALL(napi_throw(env,error));
    napi_close_escapable_handle_scope(env,inner);napi_close_handle_scope(env,outer);return NULL;
  }
  if(status!=napi_ok){napi_close_escapable_handle_scope(env,inner);napi_close_handle_scope(env,outer);napi_throw_error(env,NULL,"Callback failed");return NULL;}
  CALL(napi_escape_handle(env,inner,output,&escaped));
  napi_value second;status=napi_escape_handle(env,inner,output,&second);
  if(status!=napi_escape_called_twice)abort();
  CALL(napi_close_escapable_handle_scope(env,inner));
  napi_ref saved;CALL(napi_create_reference(env,escaped,1,&saved));
  CALL(napi_close_handle_scope(env,outer));CALL(napi_get_reference_value(env,saved,&output));CALL(napi_delete_reference(env,saved));return output;
}
static napi_value primitive(napi_env env,napi_callback_info info) {
  napi_value value,result;size_t argc=1;napi_ref ref;uint32_t count;
  CALL(napi_get_cb_info(env,info,&argc,&value,NULL,NULL));CALL(napi_create_reference(env,value,1,&ref));
  CALL(napi_get_reference_value(env,ref,&result));CALL(napi_reference_unref(env,ref,&count));
  napi_value cleared=(napi_value)1;CALL(napi_get_reference_value(env,ref,&cleared));if(cleared)abort();
  CALL(napi_delete_reference(env,ref));return result;
}
NAPI_MODULE_INIT() {
  state *s=calloc(1,sizeof(*s));if(!s){napi_throw_error(env,NULL,"allocation failed");return NULL;}
  CALL(napi_set_instance_data(env,s,finish,NULL));
  napi_property_descriptor methods[]={
    {"hold",NULL,hold,NULL,NULL,NULL,napi_default,NULL},
    {"current",NULL,current,NULL,NULL,NULL,napi_default,NULL},
    {"unref",NULL,unref,NULL,NULL,NULL,napi_default,NULL},
    {"stats",NULL,stats,NULL,NULL,NULL,napi_default,NULL},
    {"scoped",NULL,scoped,NULL,NULL,NULL,napi_default,NULL},
    {"primitive",NULL,primitive,NULL,NULL,NULL,napi_default,NULL}
  };
  CALL(napi_define_properties(env,exports,sizeof(methods)/sizeof(*methods),methods));return exports;
}
