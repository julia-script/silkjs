/* Compile normally for deprecated Node-API constructor registration; with
 * -DREJECT_VERSION for an unsupported API, or -DV8_ONLY for a V8-only ABI.
 * SPDX-License-Identifier: MIT */
#include <node_api.h>
#include <stdlib.h>
#if defined(V8_ONLY)
struct legacy_node_module {
  int version; unsigned flags; void *dso; const char *filename;
  void (*register_function)(void); void (*register_context)(void);
  const char *name; void *private_data; struct legacy_node_module *next;
};
extern void node_module_register(void *);
static void forbidden(void) { abort(); }
static struct legacy_node_module module={1,0,NULL,__FILE__,forbidden,NULL,"v8_only",NULL,NULL};
__attribute__((constructor)) static void register_legacy(void) { node_module_register(&module); }
#elif defined(REJECT_VERSION)
NAPI_MODULE_EXPORT int32_t node_api_module_get_api_version_v1(void) { return 999; }
NAPI_MODULE_EXPORT napi_value napi_register_module_v1(napi_env env,napi_value exports) {
  (void)env;(void)exports;abort();
}
#else
static napi_value initialize(napi_env env,napi_value exports) {
  napi_value value;
  if(napi_create_string_utf8(env,"legacy-napi",NAPI_AUTO_LENGTH,&value)!=napi_ok)return NULL;
  if(napi_set_named_property(env,exports,"registration",value)!=napi_ok)return NULL;
  return exports;
}
static napi_module module={1,0,__FILE__,initialize,"legacy_napi",NULL,{0}};
__attribute__((constructor)) static void register_legacy(void) { napi_module_register(&module); }
#endif
