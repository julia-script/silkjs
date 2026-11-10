#include <node_api.h>
static napi_value fail(napi_env env, napi_callback_info info) {
  (void)env; (void)info;
  napi_fatal_error("diagnostic-fatal-consumer", NAPI_AUTO_LENGTH,
                   "controlled native engine boundary failure", NAPI_AUTO_LENGTH);
  return NULL;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "fail", NAPI_AUTO_LENGTH, fail, NULL, &function) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "fail", function) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
