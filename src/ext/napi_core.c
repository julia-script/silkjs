/* SilkJS Node-API environment, scoped handles and dynamic addon entry points.
 * SPDX-License-Identifier: MIT */
#include "napi_bridge.h"
#include <dlfcn.h>
#include <limits.h>
#include <stdalign.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARENA_SLOTS 256
struct silk_napi_arena { struct silk_napi_arena *previous; size_t used; max_align_t alignment; unsigned char slots[]; };
struct napi_handle_scope__ { napi_env env; struct napi_handle_scope__ *previous; struct silk_napi_arena *arena; size_t used; int escapable, escaped; napi_value escape; };
struct napi_ref__ { napi_env env; struct napi_ref__ *next; uint32_t count; napi_value strong, weak; };
struct silk_napi_callback { struct silk_napi_callback *next; napi_env env; napi_callback callback; void *data; };
struct napi_callback_info__ { napi_env env; struct silk_napi_callback *callback; napi_value receiver, target; size_t argc; const napi_value *argv; };
struct silk_napi_finalizer { struct silk_napi_finalizer *next, *pending_next; napi_env env; void *data, *hint; node_api_basic_finalize callback; int active; };
struct silk_napi_registration { struct silk_napi_registration *next; void *handle; napi_addon_register_func init; size_t references; };
struct silk_napi_library { struct silk_napi_library *next; struct silk_napi_registration *registration; };
static uv_once_t library_once=UV_ONCE_INIT;
static uv_mutex_t library_mutex;
static struct silk_napi_registration *libraries;
static void initialize_libraries(void) { if (uv_mutex_init_recursive(&library_mutex)) abort(); }
static void release_library(struct silk_napi_registration *library) {
  uv_mutex_lock(&library_mutex);
  if (!--library->references) {
    struct silk_napi_registration **link=&libraries;
    while (*link!=library) link=&(*link)->next;
    *link=library->next;
    dlclose(library->handle);
    free(library);
  } else {
    dlclose(library->handle);
  }
  uv_mutex_unlock(&library_mutex);
}
static _Thread_local napi_module *registration;
static _Thread_local int legacy_registration;
static _Thread_local char load_error[2048];
/* The isolate whose report settings napi_fatal_error uses; set by napi_native. */
static _Thread_local void *fatal_context;
void silk_napi_fatal_context(void *context) { fatal_context = context; }
void silkNodeFatalReport(void *context, const char *location, size_t location_length, const char *message, size_t message_length);
static const char *const errors[] = { "", "Invalid argument", "An object was expected", "A string was expected", "A string or symbol was expected", "A function was expected", "A number was expected", "A boolean was expected", "An array was expected", "Unknown failure", "An exception is pending", "The async work item was cancelled", "napi_escape_handle already called", "Invalid handle scope usage", "Invalid callback scope usage", "Thread-safe function queue is full", "Thread-safe function is closing", "A bigint was expected", "A date was expected", "An arraybuffer was expected", "A detachable arraybuffer was expected", "Would deadlock", "No external buffers allowed", "Cannot run JavaScript" };
static size_t stride(napi_env e) { size_t n = sizeof(struct napi_value__) + e->value_size; return (n + alignof(max_align_t)-1) & ~(alignof(max_align_t)-1); }
int silk_napi_on_owner(napi_env e) { if (!e) return 0; uv_thread_t current=uv_thread_self(); return uv_thread_equal(&e->owner,&current); }
napi_status silk_napi_status(napi_env e,napi_status s) { if (e && silk_napi_on_owner(e)) { e->error.error_code=s; e->error.engine_error_code=0; e->error.engine_reserved=NULL; e->error.error_message=(unsigned)s<sizeof(errors)/sizeof(*errors)?errors[s]:"Unknown failure"; } return s; }
napi_status silk_napi_check(napi_env e) { if (!e || !silk_napi_on_owner(e)) return napi_invalid_arg; silk_napi_packet p={0}; int s=e->bridge(e->host,SILK_NAPI_PENDING,&p); return silk_napi_status(e,s? (napi_status)s : p.flags?napi_pending_exception:napi_ok); }
napi_status silk_napi_call(napi_env e,int op,silk_napi_packet *p) { if (!e || !silk_napi_on_owner(e)) return napi_invalid_arg; return silk_napi_status(e,(napi_status)e->bridge(e->host,op,p)); }
void *silk_napi_payload(napi_value v) { return v?v->payload:NULL; }
static void initialize(napi_env e,napi_value v) { v->env=e; silk_napi_packet p={.result=v}; e->bridge(e->host,SILK_NAPI_UNDEFINED,&p); }
napi_value silk_napi_slot(napi_env e) { if (!e || !silk_napi_on_owner(e)) return NULL; size_t n=stride(e); if (!e->arena || e->arena->used==ARENA_SLOTS) { struct silk_napi_arena *a=malloc(sizeof(*a)+ARENA_SLOTS*n); if (!a) return NULL; a->previous=e->arena; a->used=0; e->arena=a; } napi_value v=(napi_value)(e->arena->slots+n*e->arena->used++); initialize(e,v); return v; }
napi_value silk_napi_root(napi_env e,napi_value v) { if (!e || (v && v->env!=e)) return NULL; napi_value r=malloc(stride(e)); if (!r) return NULL; initialize(e,r); if (!v) return r; silk_napi_packet p={.values={v},.result=r}; if (silk_napi_call(e,SILK_NAPI_DUPLICATE,&p)!=napi_ok) { free(r); return NULL; } return r; }
void silk_napi_release_root(napi_env e,napi_value v) { if (!v) return; silk_napi_packet p={.values={v}}; silk_napi_call(e,SILK_NAPI_RELEASE,&p); free(v); }
napi_status silk_napi_js(napi_env e,const char *op,size_t argc,const napi_value *argv,napi_value *out) { napi_status s=silk_napi_check(e); if(s) return s; if(argc && !argv) return silk_napi_status(e,napi_invalid_arg); for(size_t i=0;i<argc;i++) if(!argv[i]||argv[i]->env!=e) return silk_napi_status(e,napi_invalid_arg); napi_value r=silk_napi_slot(e); if(!r) return silk_napi_status(e,napi_generic_failure); silk_napi_packet p={.data=(void*)op,.argc=argc,.argv=argv,.result=r}; s=silk_napi_call(e,SILK_NAPI_JS,&p); if(!s && out) *out=r; return s; }
NAPI_EXTERN napi_status napi_get_last_error_info(napi_env e,const napi_extended_error_info **r) { if(!e||!r||!silk_napi_on_owner(e)) return napi_invalid_arg; *r=&e->error; return napi_ok; }
NAPI_EXTERN napi_status napi_open_handle_scope(napi_env e,napi_handle_scope *out) { if(!e||!out||!silk_napi_on_owner(e)) return napi_invalid_arg; napi_handle_scope s=calloc(1,sizeof(*s)); if(!s) return silk_napi_status(e,napi_generic_failure); s->env=e;s->previous=e->scope;s->arena=e->arena;s->used=e->arena?e->arena->used:0;e->scope=s;*out=s; return silk_napi_status(e,napi_ok); }
static void unwind(napi_env e,struct silk_napi_arena *mark,size_t used) { size_t n=stride(e); while(e->arena) { struct silk_napi_arena *a=e->arena; size_t end=a==mark?used:0; while(a->used>end) { napi_value v=(napi_value)(a->slots+n*--a->used); silk_napi_packet p={.values={v}}; e->bridge(e->host,SILK_NAPI_RELEASE,&p); } if(a==mark) break; e->arena=a->previous;free(a); } }
NAPI_EXTERN napi_status napi_close_handle_scope(napi_env e,napi_handle_scope s) { if(!e||!s||!silk_napi_on_owner(e)) return napi_invalid_arg; if(e->scope!=s||s->env!=e||s->escapable) return silk_napi_status(e,napi_handle_scope_mismatch); e->scope=s->previous;unwind(e,s->arena,s->used);free(s);return silk_napi_status(e,napi_ok); }
NAPI_EXTERN napi_status napi_open_escapable_handle_scope(napi_env e,napi_escapable_handle_scope *out) { if(!e||!out) return napi_invalid_arg; /* Reserve escape slot in the parent before taking the child checkpoint. */ napi_value escape=silk_napi_slot(e); if(!escape) return silk_napi_status(e,napi_generic_failure); napi_handle_scope s; napi_status status=napi_open_handle_scope(e,&s); if(status) return status;s->escapable=1;s->escape=escape;*out=(napi_escapable_handle_scope)s;return napi_ok; }
NAPI_EXTERN napi_status napi_close_escapable_handle_scope(napi_env e,napi_escapable_handle_scope scope) { napi_handle_scope s=(napi_handle_scope)scope;if(!e||!s||e->scope!=s||!s->escapable) return silk_napi_status(e,napi_handle_scope_mismatch);s->escapable=0;return napi_close_handle_scope(e,s); }
NAPI_EXTERN napi_status napi_escape_handle(napi_env e,napi_escapable_handle_scope scope,napi_value v,napi_value *out) { napi_handle_scope s=(napi_handle_scope)scope;if(!e||!s||!v||!out||v->env!=e) return silk_napi_status(e,napi_invalid_arg);if(e->scope!=s||!s->escapable) return silk_napi_status(e,napi_handle_scope_mismatch);if(s->escaped) return silk_napi_status(e,napi_escape_called_twice);silk_napi_packet p={.values={v},.result=s->escape};napi_status status=silk_napi_call(e,SILK_NAPI_DUPLICATE,&p);if(!status){s->escaped=1;*out=s->escape;}return status; }
void silk_napi_enter_callback(napi_env e,napi_handle_scope *out) { if(napi_open_handle_scope(e,out)!=napi_ok) napi_fatal_error("SilkJS",NAPI_AUTO_LENGTH,"Cannot open native callback scope",NAPI_AUTO_LENGTH); }
void silk_napi_leave_callback(napi_env e,napi_handle_scope s) { if(napi_close_handle_scope(e,s)!=napi_ok) napi_fatal_error("SilkJS",NAPI_AUTO_LENGTH,"Native addon left handle scopes open",NAPI_AUTO_LENGTH); }
NAPI_EXTERN napi_status napi_create_reference(napi_env e,napi_value v,uint32_t count,napi_ref *out) {
  if (!e||!silk_napi_on_owner(e)) return napi_invalid_arg;
  napi_status status;
  if (!v||v->env!=e||!out) return silk_napi_status(e,napi_invalid_arg);
  napi_valuetype type;
  status=napi_typeof(e,v,&type);
  if (status) return status;
  bool weakable=type==napi_object||type==napi_function||type==napi_symbol||type==napi_external;
  if (!weakable && e->api_version<10) return silk_napi_status(e,napi_invalid_arg);
  napi_ref ref=calloc(1,sizeof(*ref));
  if (!ref) return silk_napi_status(e,napi_generic_failure);
  ref->env=e;
  ref->count=count;
  if (weakable) {
    ref->weak=silk_napi_root(e,NULL);
    if (!ref->weak) { free(ref); return silk_napi_status(e,napi_generic_failure); }
    silk_napi_packet packet={.values={v},.result=ref->weak};
    status=silk_napi_call(e,SILK_NAPI_WEAK,&packet);
    if (status) { free(ref->weak); free(ref); return status; }
  }
  if (count) {
    ref->strong=silk_napi_root(e,v);
    if (!ref->strong) {
      if (ref->weak) { silk_napi_packet packet={.values={ref->weak}}; silk_napi_call(e,SILK_NAPI_WEAK_RELEASE,&packet); free(ref->weak); }
      free(ref);
      return silk_napi_status(e,napi_generic_failure);
    }
  }
  ref->next=e->refs;
  e->refs=ref;
  *out=ref;
  return silk_napi_status(e,napi_ok);
}
NAPI_EXTERN napi_status napi_delete_reference(napi_env e,napi_ref ref) {
  if (!e||!ref||ref->env!=e||!silk_napi_on_owner(e)) return napi_invalid_arg;
  napi_ref *link=&e->refs;
  while (*link && *link!=ref) link=&(*link)->next;
  if (!*link) return silk_napi_status(e,napi_invalid_arg);
  *link=ref->next;
  silk_napi_release_root(e,ref->strong);
  if (ref->weak) { silk_napi_packet packet={.values={ref->weak}}; silk_napi_call(e,SILK_NAPI_WEAK_RELEASE,&packet); free(ref->weak); }
  free(ref);
  return silk_napi_status(e,napi_ok);
}
NAPI_EXTERN napi_status napi_get_reference_value(napi_env e,napi_ref ref,napi_value *out) {
  if (!e||!ref||ref->env!=e||!out||!silk_napi_on_owner(e)) return napi_invalid_arg;
  if (!ref->strong && !ref->weak) { *out=NULL; return silk_napi_status(e,napi_ok); }
  napi_value value=silk_napi_slot(e);
  if (!value) return silk_napi_status(e,napi_generic_failure);
  silk_napi_packet packet={.values={ref->strong?ref->strong:ref->weak},.result=value};
  napi_status status=silk_napi_call(e,ref->strong?SILK_NAPI_DUPLICATE:SILK_NAPI_WEAK_GET,&packet);
  if (!status) *out=packet.flags?NULL:value;
  return status;
}
NAPI_EXTERN napi_status napi_reference_ref(napi_env e,napi_ref ref,uint32_t *out) {
  if (!e||!ref||ref->env!=e||!silk_napi_on_owner(e)||ref->count==UINT32_MAX) return napi_invalid_arg;
  if (!ref->count) {
    napi_value value;
    napi_status status=napi_get_reference_value(e,ref,&value);
    if (status) return status;
    if (!value) { if (out) *out=0; return silk_napi_status(e,napi_ok); }
    ref->strong=silk_napi_root(e,value);
    if (!ref->strong) return silk_napi_status(e,napi_generic_failure);
  }
  ref->count++;
  if (out) *out=ref->count;
  return silk_napi_status(e,napi_ok);
}
NAPI_EXTERN napi_status napi_reference_unref(napi_env e,napi_ref r,uint32_t *out) { if(!e||!r||r->env!=e||!silk_napi_on_owner(e))return napi_invalid_arg;if(!r->count)return silk_napi_status(e,napi_generic_failure);if(!--r->count){silk_napi_release_root(e,r->strong);r->strong=NULL;}if(out)*out=r->count;return silk_napi_status(e,napi_ok); }
NAPI_EXTERN napi_status napi_create_function(napi_env e,const char *name,size_t length,napi_callback fn,void *data,napi_value *out) { napi_status s=silk_napi_check(e);if(s)return s;if(!fn||!out)return silk_napi_status(e,napi_invalid_arg);struct silk_napi_callback *c=malloc(sizeof(*c));if(!c)return silk_napi_status(e,napi_generic_failure);c->env=e;c->callback=fn;c->data=data;c->next=e->callbacks;e->callbacks=c;napi_value args[2];s=napi_create_string_utf8(e,name?name:"",name?length:0,&args[0]);if(!s)s=napi_create_double(e,(double)(uintptr_t)c,&args[1]);if(!s)s=silk_napi_js(e,"makeFunction",2,args,out);return s; }
napi_env silk_napi_callback_env(uintptr_t id) { return id?((struct silk_napi_callback*)id)->env:NULL; }
napi_value silk_napi_invoke(napi_env e,uintptr_t id,napi_value receiver,napi_value target,size_t argc,const napi_value *argv) { struct silk_napi_callback *c=(void*)id;if(!e||!c||c->env!=e||!silk_napi_on_owner(e))return NULL;napi_handle_scope scope;silk_napi_enter_callback(e,&scope);struct napi_callback_info__ info={e,c,receiver,target,argc,argv};napi_value result=c->callback(e,&info);napi_value owned=silk_napi_root(e,result);silk_napi_leave_callback(e,scope);return owned; }
NAPI_EXTERN napi_status napi_get_cb_info(napi_env e,napi_callback_info info,size_t *argc,napi_value *argv,napi_value *receiver,void **data) { if(!e||!info||info->env!=e||!silk_napi_on_owner(e)||(!argc&&argv))return silk_napi_status(e,napi_invalid_arg);if(argc){size_t capacity=*argc;if(argv){size_t n=capacity<info->argc?capacity:info->argc;for(size_t i=0;i<n;i++)argv[i]=info->argv[i];for(size_t i=n;i<capacity;i++){napi_status s=napi_get_undefined(e,&argv[i]);if(s)return s;}}*argc=info->argc;}if(receiver)*receiver=info->receiver;if(data)*data=info->callback->data;return silk_napi_status(e,napi_ok); }
NAPI_EXTERN napi_status napi_get_new_target(napi_env e,napi_callback_info info,napi_value *out) { if(!e||!info||info->env!=e||!out)return silk_napi_status(e,napi_invalid_arg);*out=info->target;return silk_napi_status(e,napi_ok); }
NAPI_EXTERN napi_status napi_is_exception_pending(napi_env e,bool *out) { if(!out)return silk_napi_status(e,napi_invalid_arg);silk_napi_packet p={0};napi_status s=silk_napi_call(e,SILK_NAPI_PENDING,&p);if(!s)*out=p.flags!=0;return s; }
NAPI_EXTERN napi_status napi_get_and_clear_last_exception(napi_env e,napi_value *out) { if(!e||!out)return silk_napi_status(e,napi_invalid_arg);napi_value v=silk_napi_slot(e);if(!v)return silk_napi_status(e,napi_generic_failure);silk_napi_packet p={.result=v};napi_status s=silk_napi_call(e,SILK_NAPI_CLEAR_EXCEPTION,&p);if(!s)*out=v;return s; }
NAPI_EXTERN napi_status napi_throw(napi_env e,napi_value error) { napi_status status=silk_napi_check(e);if(status)return status;if(!error||error->env!=e)return silk_napi_status(e,napi_invalid_arg);silk_napi_packet p={.values={error}};return silk_napi_call(e,SILK_NAPI_THROW,&p); }
static napi_status throw_text(napi_env e,const char *code,const char *msg,int kind) { napi_status status=silk_napi_check(e);if(status)return status;if(!msg)return silk_napi_status(e,napi_invalid_arg);napi_value c=NULL,m,error;napi_status s=napi_create_string_utf8(e,msg,NAPI_AUTO_LENGTH,&m);if(!s&&code)s=napi_create_string_utf8(e,code,NAPI_AUTO_LENGTH,&c);if(s)return s;if(kind==0)s=napi_create_error(e,c,m,&error);else if(kind==1)s=napi_create_type_error(e,c,m,&error);else if(kind==2)s=napi_create_range_error(e,c,m,&error);else s=node_api_create_syntax_error(e,c,m,&error);return s?s:napi_throw(e,error); }
NAPI_EXTERN napi_status napi_throw_error(napi_env e,const char *c,const char *m){return throw_text(e,c,m,0);}
NAPI_EXTERN napi_status napi_throw_type_error(napi_env e,const char *c,const char *m){return throw_text(e,c,m,1);}
NAPI_EXTERN napi_status napi_throw_range_error(napi_env e,const char *c,const char *m){return throw_text(e,c,m,2);}
NAPI_EXTERN napi_status node_api_throw_syntax_error(napi_env e,const char *c,const char *m){return throw_text(e,c,m,3);}
NAPI_EXTERN napi_status napi_get_version(napi_env e,uint32_t *out){if(!e||!out)return napi_invalid_arg;*out=NAPI_VERSION;return silk_napi_status(e,napi_ok);}
NAPI_EXTERN napi_status napi_get_node_version(napi_env e,const napi_node_version **out){static const napi_node_version version={24,22,2,"SilkJS"};if(!e||!out)return napi_invalid_arg;*out=&version;return silk_napi_status(e,napi_ok);}
NAPI_EXTERN napi_status node_api_get_module_file_name(napi_env e,const char **out){if(!e||!out)return napi_invalid_arg;*out=e->filename;return silk_napi_status(e,napi_ok);}
NAPI_EXTERN napi_status napi_set_instance_data(napi_env e,void *data,napi_finalize fn,void *hint){if(!e||!silk_napi_on_owner(e))return napi_invalid_arg;e->instance_data=data;e->instance_finalize=fn;e->instance_hint=hint;return silk_napi_status(e,napi_ok);}
NAPI_EXTERN napi_status napi_get_instance_data(napi_env e,void **out){if(!e||!out||!silk_napi_on_owner(e))return napi_invalid_arg;*out=e->instance_data;return silk_napi_status(e,napi_ok);}
NAPI_EXTERN napi_status napi_adjust_external_memory(napi_env e,int64_t delta,int64_t *out) {
  if (!e||!out||!silk_napi_on_owner(e)) return napi_invalid_arg;
  if ((delta>0&&e->external_memory>INT64_MAX-delta)||(delta<0&&e->external_memory<INT64_MIN-delta))
    return silk_napi_status(e,napi_invalid_arg);
  silk_napi_packet packet={.integer=delta<0?0-(uint64_t)delta:(uint64_t)delta,.flags=delta<0};
  napi_status status=silk_napi_call(e,SILK_NAPI_EXTERNAL_MEMORY,&packet);
  if (status) return status;
  e->external_memory+=delta;
  *out=e->external_memory;
  return silk_napi_status(e,napi_ok);
}
uintptr_t silk_napi_finalizer(napi_env e,void *data,node_api_basic_finalize fn,void *hint){struct silk_napi_finalizer *f=malloc(sizeof(*f));if(!f)return 0;f->env=e;f->data=data;f->hint=hint;f->callback=fn;f->active=1;f->next=e->finalizers;f->pending_next=e->pending_finalizers;e->pending_finalizers=f;e->finalizers=f;return (uintptr_t)f;}
napi_env silk_napi_finalizer_env(uintptr_t id){return id?((struct silk_napi_finalizer*)id)->env:NULL;}
void *silk_napi_finalizer_data(napi_env e,uintptr_t id){struct silk_napi_finalizer *f=(void*)id;return f&&f->env==e?f->data:NULL;}
void silk_napi_cancel_finalizer(napi_env e,uintptr_t id){struct silk_napi_finalizer *f=(void*)id;if(f&&f->env==e)f->active=0;}
void silk_napi_finalize(napi_env e,uintptr_t id){struct silk_napi_finalizer *f=(void*)id;if(!f||f->env!=e||!f->active)return;f->active=0;if(f->callback){napi_handle_scope scope;silk_napi_enter_callback(e,&scope);f->callback(e,f->data,f->hint);silk_napi_leave_callback(e,scope);}}
NAPI_EXTERN void napi_fatal_error(const char *location, size_t llen,
                                const char *message, size_t mlen) {
  if (!location) location = "";
  if (!message) message = "";
  if (llen == NAPI_AUTO_LENGTH) llen = strlen(location);
  if (mlen == NAPI_AUTO_LENGTH) mlen = strlen(message);
  if (fatal_context) silkNodeFatalReport(fatal_context, location, llen, message, mlen);
  fputs("FATAL ERROR: ", stderr);
  fwrite(location, 1, llen, stderr); fputc(' ', stderr);
  fwrite(message, 1, mlen, stderr); fputc('\n', stderr);
  abort();
}
void silk_napi_fatal_pending(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) return;
  napi_value error;
  napi_get_and_clear_last_exception(env, &error);
  /* The owner-isolate dispatcher reports and terminates unhandled exceptions.
   * Worker termination remains an uncatchable engine exception, not exit(1). */
  silk_napi_js(env, "fatalException", 1, &error, NULL);
}
NAPI_EXTERN void napi_module_register(napi_module *m){registration=m;}
/* A V8 registration is detected, never invoked or forwarded to another runtime. */
__attribute__((visibility("default"))) void node_module_register(void *module){(void)module;legacy_registration=1;}
const char *silk_napi_load_error(void){return load_error;}
napi_env silk_napi_open(void *host,silk_napi_bridge bridge,size_t value_size){if(!bridge||!value_size)return NULL;napi_env e=calloc(1,sizeof(*e));if(!e)return NULL;e->host=host;e->bridge=bridge;e->value_size=value_size;e->owner=uv_thread_self();if(silk_napi_async_init(e)!=0){free(e);return NULL;}return e;}
int silk_napi_load(napi_env e,const char *filename,int flags,napi_value module,napi_value *out) {
  if (!e||!filename||!module||!out||!silk_napi_on_owner(e)) return napi_invalid_arg;
  load_error[0]=0;
  napi_value exports,url;
  napi_status status=napi_get_named_property(e,module,"exports",&exports);
  if (!status) status=silk_napi_js(e,"moduleFilename",1,&module,&url);
  size_t length=0;
  if (!status) status=napi_get_value_string_utf8(e,url,NULL,0,&length);
  if (status) return status;
  if (length==SIZE_MAX) return napi_generic_failure;
  char *path=malloc(length+1);
  if (!path) return napi_generic_failure;
  status=napi_get_value_string_utf8(e,url,path,length+1,&length);
  if (status) { free(path); return status; }
  uv_once(&library_once,initialize_libraries);
  uv_mutex_lock(&library_mutex);
  napi_module *saved=registration;
  int old_legacy=legacy_registration;
  registration=NULL;
  legacy_registration=0;
  dlerror();
  void *library=dlopen(filename,flags);
  napi_module *registered=registration;
  int legacy=legacy_registration;
  registration=saved;
  legacy_registration=old_legacy;
  if (!library) {
    const char *error=dlerror();
    snprintf(load_error,sizeof(load_error),"%s",error?error:"Cannot open native addon");
    uv_mutex_unlock(&library_mutex);
    free(path);
    return napi_generic_failure;
  }
  struct silk_napi_registration *shared=libraries;
  while (shared && shared->handle!=library) shared=shared->next;
  napi_addon_register_func init=(napi_addon_register_func)dlsym(library,"napi_register_module_v1");
  int32_t (*version)(void)=(int32_t(*)(void))dlsym(library,"node_api_module_get_api_version_v1");
  if (!init && shared) init=shared->init;
  if (legacy || (!init && (!registered || !registered->nm_register_func))) {
    snprintf(load_error,sizeof(load_error),"%s: V8/Node module ABI addons are not supported; a Node-API registration is required",filename);
    goto rejected;
  }
  int32_t api=version?version():8;
  if (api<1 || api>NAPI_VERSION) {
    snprintf(load_error,sizeof(load_error),"%s: addon requires Node-API version %d; SilkJS supports %d",filename,api,NAPI_VERSION);
    goto rejected;
  }
  if (!init) {
    if (registered->nm_version!=NAPI_MODULE_VERSION) {
      snprintf(load_error,sizeof(load_error),"%s: incompatible legacy Node-API registration version %d",filename,registered->nm_version);
      goto rejected;
    }
    init=registered->nm_register_func;
  }
  struct silk_napi_library *entry=malloc(sizeof(*entry));
  if (!entry) {
    snprintf(load_error,sizeof(load_error),"Out of memory loading addon");
    goto rejected;
  }
  if (!shared) {
    shared=malloc(sizeof(*shared));
    if (!shared) {
      free(entry);
      snprintf(load_error,sizeof(load_error),"Out of memory loading addon");
      goto rejected;
    }
    *shared=(struct silk_napi_registration){libraries,library,init,0};
    libraries=shared;
  }
  shared->references++;
  entry->registration=shared;
  entry->next=e->libraries;
  e->libraries=entry;
  uv_mutex_unlock(&library_mutex);
  free((void*)e->filename);
  e->filename=path;
  e->api_version=api;
  napi_handle_scope scope;
  silk_napi_enter_callback(e,&scope);
  napi_value returned=init(e,exports);
  bool pending=false;
  napi_is_exception_pending(e,&pending);
  *out=pending?NULL:silk_napi_root(e,returned?returned:exports);
  silk_napi_leave_callback(e,scope);
  if (pending) return napi_pending_exception;
  return *out?napi_ok:napi_generic_failure;
rejected:
  dlclose(library);
  uv_mutex_unlock(&library_mutex);
  free(path);
  return napi_generic_failure;
}
static void drain_finalizers(napi_env e) {
  while (e->pending_finalizers) {
    struct silk_napi_finalizer *f=e->pending_finalizers;
    e->pending_finalizers=f->pending_next;
    silk_napi_finalize(e,(uintptr_t)f);
  }
}
void silk_napi_close(napi_env e) {
  if (!e || e->closing) return;
  e->closing=1;
  silk_napi_async_close(e);
  drain_finalizers(e);
  if (e->instance_finalize) {
    napi_handle_scope scope;
    silk_napi_enter_callback(e,&scope);
    e->instance_finalize(e,e->instance_data,e->instance_hint);
    silk_napi_leave_callback(e,scope);
  }
  drain_finalizers(e);
  silk_napi_async_dispose(e);
  silk_napi_packet accounting={.integer=e->external_memory<0?0-(uint64_t)e->external_memory:(uint64_t)e->external_memory,.flags=e->external_memory>=0};
  silk_napi_call(e,SILK_NAPI_EXTERNAL_MEMORY,&accounting);
  e->external_memory=0;
  while (e->refs) napi_delete_reference(e,e->refs);
  while (e->scope) {
    napi_handle_scope s=e->scope;
    e->scope=s->previous;
    free(s);
  }
  unwind(e,NULL,0);
}
/* Called only after the JS heap is destroyed: native functions and external
 * buffers may still contain these records until the last heap finalizer runs. */
void silk_napi_dispose(napi_env e) {
  if (!e) return;
  while (e->finalizers) {
    struct silk_napi_finalizer *f=e->finalizers;
    e->finalizers=f->next;
    free(f);
  }
  while (e->callbacks) {
    struct silk_napi_callback *c=e->callbacks;
    e->callbacks=c->next;
    free(c);
  }
  while (e->libraries) {
    struct silk_napi_library *l=e->libraries;
    e->libraries=l->next;
    release_library(l->registration);
    free(l);
  }
  free((void*)e->filename);
  free(e);
}
