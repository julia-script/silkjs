#define NAPI_VERSION 10
#include <node_api.h>
#include <uv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(call) do { if ((call) != napi_ok) { \
  napi_throw_error(env, NULL, #call); return NULL; } } while (0)
#define REQUIRE(call) do { napi_status required_status = (call); if (required_status != napi_ok) { fprintf(stderr, "%s returned %d at line %d\n", #call, required_status, __LINE__); abort(); } } while (0)

static napi_value undefined(napi_env env) {
  napi_value value;
  REQUIRE(napi_get_undefined(env, &value));
  return value;
}

static void number_property(napi_env env, napi_value object, const char *name, int value) {
  napi_value number;
  REQUIRE(napi_create_int32(env, value, &number));
  REQUIRE(napi_set_named_property(env, object, name, number));
}

struct work_data {
  napi_async_work work;
  napi_deferred deferred;
  int value;
  napi_status cancel_status;
};

static void execute(napi_env env, void *data) {
  (void)env;
  struct work_data *work = data;
  work->value *= 2;
}

static void complete(napi_env env, napi_status status, void *data) {
  struct work_data *work = data;
  napi_value result;
  REQUIRE(napi_create_object(env, &result));
  number_property(env, result, "value", work->value);
  number_property(env, result, "status", status);
  number_property(env, result, "cancelStatus", work->cancel_status);
  REQUIRE(napi_resolve_deferred(env, work->deferred, result));
  REQUIRE(napi_delete_async_work(env, work->work));
  free(work);
}

static napi_value work(napi_env env, napi_callback_info info) {
  napi_value arguments[2], promise, name;
  size_t argc = 2;
  CHECK(napi_get_cb_info(env, info, &argc, arguments, NULL, NULL));
  if (argc != 2) { napi_throw_type_error(env, NULL, "value and cancel required"); return NULL; }
  int32_t value;
  bool cancel;
  CHECK(napi_get_value_int32(env, arguments[0], &value));
  CHECK(napi_get_value_bool(env, arguments[1], &cancel));
  struct work_data *data = calloc(1, sizeof(*data));
  if (!data) abort();
  data->value = value;
  CHECK(napi_create_string_utf8(env, "silk-napi-work", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_promise(env, &data->deferred, &promise));
  CHECK(napi_create_async_work(env, NULL, name, execute, complete, data, &data->work));
  CHECK(napi_queue_async_work(env, data->work));
  if (cancel) data->cancel_status = napi_cancel_async_work(env, data->work);
  return promise;
}

struct function_data {
  napi_threadsafe_function function;
  napi_deferred deferred;
  uv_thread_t thread;
  int threaded, count, delivered, disposed, queue_status, error, teardown;
};

static void call_js(napi_env env, napi_value callback, void *context, void *data) {
  struct function_data *state = context;
  int value = *(int *)data;
  free(data);
  if (!env) { state->disposed++; return; }
  napi_value argument;
  REQUIRE(napi_create_int32(env, value, &argument));
  napi_status status = napi_call_function(env, undefined(env), callback, 1, &argument, NULL);
  if (status == napi_cannot_run_js) state->disposed++;
  else { REQUIRE(status); state->delivered++; }
}

static void finalize_function(napi_env env, void *data, void *hint) {
  struct function_data *state = data;
  if (hint != state) abort();
  if (state->threaded && uv_thread_join(&state->thread)) abort();
  if (state->teardown) { free(state); return; }
  napi_value result;
  REQUIRE(napi_create_object(env, &result));
  number_property(env, result, "delivered", state->delivered);
  number_property(env, result, "disposed", state->disposed);
  number_property(env, result, "queueStatus", state->queue_status);
  number_property(env, result, "error", state->error);
  REQUIRE(napi_resolve_deferred(env, state->deferred, result));
  free(state);
}

static int *item(int value) {
  int *data = malloc(sizeof(*data));
  if (!data) abort();
  *data = value;
  return data;
}

static void produce(void *data) {
  struct function_data *state = data;
  for (int i = 0; i < state->count; i++) {
    int *value = item(i);
    napi_status status = napi_call_threadsafe_function(state->function, value, napi_tsfn_blocking);
    if (status != napi_ok) {
      free(value);
      state->error = status;
      if (status == napi_closing) return;
      break;
    }
  }
  REQUIRE(napi_release_threadsafe_function(state->function, napi_tsfn_release));
}

static napi_value threaded(napi_env env, napi_callback_info info) {
  napi_value arguments[3], name, promise;
  size_t argc = 3;
  CHECK(napi_get_cb_info(env, info, &argc, arguments, NULL, NULL));
  if (argc < 2) { napi_throw_type_error(env, NULL, "callback and count required"); return NULL; }
  int32_t count;
  CHECK(napi_get_value_int32(env, arguments[1], &count));
  struct function_data *state = calloc(1, sizeof(*state));
  if (!state) abort();
  state->count = count;
  state->threaded = 1;
  CHECK(napi_create_promise(env, &state->deferred, &promise));
  CHECK(napi_create_string_utf8(env, "silk-napi-thread", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_threadsafe_function(env, arguments[0], NULL, name, 2, 1,
    state, finalize_function, state, call_js, &state->function));
  if (argc == 3) {
    bool unref;
    CHECK(napi_get_value_bool(env, arguments[2], &unref));
    state->teardown = unref;
    if (unref) CHECK(napi_unref_threadsafe_function(env, state->function));
  }
  void *context = NULL;
  CHECK(napi_get_threadsafe_function_context(state->function, &context));
  if (context != state) abort();
  if (uv_thread_create(&state->thread, produce, state)) abort();
  return promise;
}

static napi_value queue(napi_env env, napi_callback_info info) {
  napi_value arguments[2], name, promise;
  size_t argc = 2;
  CHECK(napi_get_cb_info(env, info, &argc, arguments, NULL, NULL));
  if (argc != 2) { napi_throw_type_error(env, NULL, "callback and abort required"); return NULL; }
  bool abort_queue;
  CHECK(napi_get_value_bool(env, arguments[1], &abort_queue));
  struct function_data *state = calloc(1, sizeof(*state));
  if (!state) abort();
  CHECK(napi_create_promise(env, &state->deferred, &promise));
  CHECK(napi_create_string_utf8(env, "silk-napi-queue", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_threadsafe_function(env, arguments[0], NULL, name, 2, 1,
    state, finalize_function, state, call_js, &state->function));
  CHECK(napi_unref_threadsafe_function(env, state->function));
  CHECK(napi_ref_threadsafe_function(env, state->function));
  CHECK(napi_acquire_threadsafe_function(state->function));
  CHECK(napi_release_threadsafe_function(state->function, napi_tsfn_release));
  CHECK(napi_call_threadsafe_function(state->function, item(1), napi_tsfn_nonblocking));
  CHECK(napi_call_threadsafe_function(state->function, item(2), napi_tsfn_nonblocking));
  int *rejected = item(3);
  state->queue_status = napi_call_threadsafe_function(state->function, rejected, napi_tsfn_nonblocking);
  if (state->queue_status != napi_queue_full) abort();
  free(rejected);
  CHECK(napi_release_threadsafe_function(state->function,
    abort_queue ? napi_tsfn_abort : napi_tsfn_release));
  return promise;
}

static napi_value scopes(napi_env env, napi_callback_info info) {
  napi_value callback, name, resource, result;
  size_t argc = 1;
  CHECK(napi_get_cb_info(env, info, &argc, &callback, NULL, NULL));
  if (argc != 1) { napi_throw_type_error(env, NULL, "callback required"); return NULL; }
  CHECK(napi_create_object(env, &resource));
  CHECK(napi_create_string_utf8(env, "silk-napi-scope", NAPI_AUTO_LENGTH, &name));
  napi_async_context context;
  CHECK(napi_async_init(env, resource, name, &context));
  napi_callback_scope outer, inner;
  CHECK(napi_open_callback_scope(env, resource, context, &outer));
  CHECK(napi_open_callback_scope(env, resource, context, &inner));
  napi_status status = napi_call_function(env, resource, callback, 0, NULL, &result);
  REQUIRE(napi_close_callback_scope(env, inner));
  REQUIRE(napi_close_callback_scope(env, outer));
  if (status == napi_ok)
    status = napi_make_callback(env, context, resource, callback, 0, NULL, &result);
  REQUIRE(napi_async_destroy(env, context));
  if (status != napi_ok) return NULL;
  return result;
}

struct cleanup_data {
  char *path;
  uv_loop_t *loop;
  uv_timer_t timer;
  napi_async_cleanup_hook_handle hook;
};

static void append(struct cleanup_data *data, const char *line) {
  FILE *file = fopen(data->path, "a");
  if (!file || fputs(line, file) < 0 || fclose(file)) abort();
}

static void cleanup_a(void *data) { append(data, "A\n"); }
static void cleanup_b(void *data) { append(data, "B\n"); }
static void cleanup_removed(void *data) { (void)data; abort(); }

static void cleanup_closed(uv_handle_t *handle) {
  struct cleanup_data *data = handle->data;
  free(data->path);
  free(data);
}

static void cleanup_timer(uv_timer_t *timer) {
  struct cleanup_data *data = timer->data;
  append(data, "async-end\n");
  REQUIRE(napi_remove_async_cleanup_hook(data->hook));
  uv_close((uv_handle_t *)timer, cleanup_closed);
}

static void cleanup_async(napi_async_cleanup_hook_handle hook, void *arg) {
  struct cleanup_data *data = arg;
  data->hook = hook;
  append(data, "async-start\n");
  if (uv_timer_init(data->loop, &data->timer)) abort();
  data->timer.data = data;
  if (uv_timer_start(&data->timer, cleanup_timer, 1, 0)) abort();
}

static napi_value cleanup(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argc = 1, length;
  CHECK(napi_get_cb_info(env, info, &argc, &argument, NULL, NULL));
  if (argc != 1) { napi_throw_type_error(env, NULL, "path required"); return NULL; }
  CHECK(napi_get_value_string_utf8(env, argument, NULL, 0, &length));
  struct cleanup_data *data = calloc(1, sizeof(*data));
  if (!data) abort();
  data->path = malloc(length + 1);
  if (!data->path) abort();
  CHECK(napi_get_value_string_utf8(env, argument, data->path, length + 1, NULL));
  CHECK(napi_get_uv_event_loop(env, &data->loop));
  CHECK(napi_add_env_cleanup_hook(env, cleanup_a, data));
  napi_async_cleanup_hook_handle removed;
  CHECK(napi_add_async_cleanup_hook(env, cleanup_async, data, &removed));
  CHECK(napi_remove_async_cleanup_hook(removed));
  CHECK(napi_add_async_cleanup_hook(env, cleanup_async, data, NULL));
  CHECK(napi_add_env_cleanup_hook(env, cleanup_removed, data));
  CHECK(napi_remove_env_cleanup_hook(env, cleanup_removed, data));
  CHECK(napi_add_env_cleanup_hook(env, cleanup_b, data));
  return undefined(env);
}

static napi_value fatal(napi_env env, napi_callback_info info) {
  napi_value error;
  size_t argc = 1;
  CHECK(napi_get_cb_info(env, info, &argc, &error, NULL, NULL));
  if (argc != 1) { napi_throw_type_error(env, NULL, "error required"); return NULL; }
  CHECK(napi_fatal_exception(env, error));
  return undefined(env);
}

struct retained_resources {
  napi_async_context context;
  struct work_data work;
  uv_loop_t *loop;
};

static void finalize_resources(napi_env env, void *data, void *hint) {
  (void)hint;
  struct retained_resources *resources = data;
  uv_loop_t *loop;
  REQUIRE(napi_get_uv_event_loop(env, &loop));
  if (loop != resources->loop) abort();
  REQUIRE(napi_async_destroy(env, resources->context));
  REQUIRE(napi_delete_async_work(env, resources->work.work));
  free(resources);
}

NAPI_MODULE_INIT() {
  struct retained_resources *resources = calloc(1, sizeof(*resources));
  if (!resources) abort();
  napi_value name;
  CHECK(napi_create_string_utf8(env, "silk-napi-retained", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_get_uv_event_loop(env, &resources->loop));
  CHECK(napi_async_init(env, NULL, name, &resources->context));
  CHECK(napi_create_async_work(env, NULL, name, execute, NULL,
                              &resources->work, &resources->work.work));
  CHECK(napi_set_instance_data(env, resources, finalize_resources, NULL));
  const napi_property_descriptor properties[] = {
    { "work", NULL, work, NULL, NULL, NULL, napi_default, NULL },
    { "threaded", NULL, threaded, NULL, NULL, NULL, napi_default, NULL },
    { "queue", NULL, queue, NULL, NULL, NULL, napi_default, NULL },
    { "scopes", NULL, scopes, NULL, NULL, NULL, napi_default, NULL },
    { "cleanup", NULL, cleanup, NULL, NULL, NULL, napi_default, NULL },
    { "fatal", NULL, fatal, NULL, NULL, NULL, napi_default, NULL }
  };
  CHECK(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
  return exports;
}
