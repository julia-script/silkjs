/* SilkJS Node-API asynchronous operations. SPDX-License-Identifier: MIT */
#include "napi_bridge.h"
#include <stdlib.h>

struct napi_async_context__ {
  napi_env env;
  napi_value resource;
  struct napi_async_context__ *next;
  size_t scopes;
  int destroyed;
};

struct napi_callback_scope__ {
  napi_env env;
  napi_async_context context;
  struct napi_callback_scope__ *previous;
};

struct napi_async_work__ {
  napi_env env;
  uv_work_t request;
  napi_async_context context;
  napi_async_execute_callback execute;
  napi_async_complete_callback complete;
  void *data;
  struct napi_async_work__ *next;
  /* Only the owner writes lifecycle state; the pool only calls execute. */
  enum { WORK_CREATED, WORK_QUEUED, WORK_COMPLETING, WORK_COMPLETE } state;
  int delete_requested;
};

struct silk_napi_queue_item {
  void *data;
  struct silk_napi_queue_item *next;
};

struct napi_threadsafe_function__ {
  napi_env env;
  uv_async_t signal;
  uv_mutex_t mutex;
  uv_cond_t space;
  struct silk_napi_queue_item *head, *tail;
  size_t count, maximum, threads;
  int closing, handle_closing;
  napi_value callback;
  napi_async_context resource;
  void *context, *finalize_data;
  napi_finalize finalize;
  napi_threadsafe_function_call_js call;
  struct napi_threadsafe_function__ *next;
};

/* Removed hooks stay allocated until teardown. An async cleanup hook may
 * acknowledge completion from a native thread while its owner callback runs. */
struct napi_async_cleanup_hook_handle__ {
  napi_env env;
  napi_cleanup_hook sync;
  napi_async_cleanup_hook async;
  void *data;
  int removed, started;
  struct napi_async_cleanup_hook_handle__ *next;
};

struct silk_napi_async {
  uv_async_t wake;
  uv_mutex_t hooks_mutex;
  struct napi_async_cleanup_hook_handle__ *hooks;
  size_t pending_cleanup;
  napi_async_context contexts;
  napi_callback_scope scope;
  napi_async_work works;
  napi_threadsafe_function functions;
  uint64_t activity;
  int draining;
};

static struct silk_napi_async *async_state(napi_env env) {
  return (struct silk_napi_async *)env->async;
}

static napi_status owner_status(napi_env env) {
  if (!env || !silk_napi_on_owner(env)) return napi_invalid_arg;
  return napi_ok;
}

static napi_status context_operation(napi_async_context context,
                                     const char *operation) {
  napi_env env = context->env;
  bool pending = false;
  napi_value exception = NULL;
  napi_status status = napi_is_exception_pending(env, &pending);
  if (status != napi_ok) return status;
  if (pending) {
    status = napi_get_and_clear_last_exception(env, &exception);
    if (status != napi_ok) return status;
  }
  status = silk_napi_js(env, operation, 1, &context->resource, NULL);
  if (exception) {
    bool secondary = false;
    napi_is_exception_pending(env, &secondary);
    if (secondary) {
      napi_value ignored;
      napi_get_and_clear_last_exception(env, &ignored);
    }
    napi_throw(env, exception);
  }
  return status;
}

static void context_free(napi_async_context context) {
  napi_env env = context->env;
  napi_async_context *link = &async_state(env)->contexts;
  while (*link && *link != context) link = &(*link)->next;
  if (*link) *link = context->next;
  silk_napi_release_root(env, context->resource);
  free(context);
}

napi_status NAPI_CDECL napi_async_init(napi_env env, napi_value resource,
                                      napi_value name, napi_async_context *result) {
  napi_status status = silk_napi_check(env);
  if (status != napi_ok) return status;
  if (!name || !result) return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  napi_async_context context = calloc(1, sizeof(*context));
  if (!context) return silk_napi_status(env, napi_generic_failure);
  if (!resource) {
    status = napi_get_undefined(env, &resource);
    if (status != napi_ok) { free(context); return status; }
  }
  napi_value arguments[] = { resource, name }, value;
  status = silk_napi_js(env, "asyncInit", 2, arguments, &value);
  if (status != napi_ok) { free(context); return status; }
  context->resource = silk_napi_root(env, value);
  if (!context->resource) { free(context); return silk_napi_status(env, napi_generic_failure); }
  context->env = env;
  context->next = async_state(env)->contexts;
  async_state(env)->contexts = context;
  *result = context;
  return silk_napi_status(env, napi_ok);
}


napi_status NAPI_CDECL napi_async_destroy(napi_env env,
                                         napi_async_context context) {
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!context || context->env != env || context->destroyed)
    return silk_napi_status(env, napi_invalid_arg);
  context->destroyed = 1;
  napi_status status = context_operation(context, "asyncDestroy");
  if (!context->scopes) context_free(context);
  return silk_napi_status(env, status);
}

static napi_status open_callback_scope(napi_env env, napi_value resource,
                                       napi_async_context context,
                                       napi_callback_scope *result,
                                       const char *operation) {
  napi_status status = silk_napi_check(env);
  if (status != napi_ok) return status;
  if (!resource || !context || context->env != env || context->destroyed || !result)
    return silk_napi_status(env, napi_invalid_arg);
  napi_callback_scope scope = malloc(sizeof(*scope));
  if (!scope) return silk_napi_status(env, napi_generic_failure);
  status = context_operation(context, operation);
  if (status != napi_ok) { free(scope); return status; }
  scope->env = env;
  scope->context = context;
  scope->previous = async_state(env)->scope;
  async_state(env)->scope = scope;
  context->scopes++;
  *result = scope;
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_open_callback_scope(napi_env env,
                                               napi_value resource,
                                               napi_async_context context,
                                               napi_callback_scope *result) {
  return open_callback_scope(env, resource, context, result, "asyncBefore");
}

napi_status NAPI_CDECL napi_close_callback_scope(napi_env env,
                                                napi_callback_scope scope) {
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!scope || async_state(env)->scope != scope)
    return silk_napi_status(env, napi_callback_scope_mismatch);
  napi_async_context context = scope->context;
  napi_status status = context_operation(context, "asyncAfter");
  async_state(env)->scope = scope->previous;
  context->scopes--;
  if (context->destroyed && !context->scopes) context_free(context);
  free(scope);
  return silk_napi_status(env, status);
}

napi_status NAPI_CDECL napi_make_callback(napi_env env,
                                         napi_async_context context,
                                         napi_value recv, napi_value func,
                                         size_t argc, const napi_value *argv,
                                         napi_value *result) {
  napi_status status = silk_napi_check(env);
  if (status != napi_ok) return status;
  if (!recv || !func || (argc && !argv)) return silk_napi_status(env, napi_invalid_arg);
  napi_callback_scope scope = NULL;
  if (context) {
    status = open_callback_scope(env, recv, context, &scope, "asyncBeforeCallback");
    if (status != napi_ok) return status;
  }
  status = napi_call_function(env, recv, func, argc, argv, result);
  if (scope) {
    napi_status after = napi_close_callback_scope(env, scope);
    if (status == napi_ok) status = after;
  }
  return silk_napi_status(env, status);
}

static void work_free(napi_async_work work) {
  napi_env env = work->env;
  napi_async_work *link = &async_state(env)->works;
  while (*link && *link != work) link = &(*link)->next;
  if (*link) *link = work->next;
  napi_async_destroy(env, work->context);
  free(work);
}

static void work_execute(uv_work_t *request) {
  napi_async_work work = request->data;
  work->execute(work->env, work->data);
}

static void work_complete(uv_work_t *request, int uv_status) {
  napi_async_work work = request->data;
  napi_env env = work->env;
  async_state(env)->activity++;
  work->state = WORK_COMPLETING;
  napi_handle_scope handles;
  silk_napi_enter_callback(env, &handles);
  napi_callback_scope scope = NULL;
  napi_status status = napi_open_callback_scope(env, work->context->resource,
                                                work->context, &scope);
  if (status == napi_ok && work->complete)
    work->complete(env, uv_status == UV_ECANCELED ? napi_cancelled :
                   (uv_status ? napi_generic_failure : napi_ok), work->data);
  if (scope) napi_close_callback_scope(env, scope);
  silk_napi_fatal_pending(env);
  work->state = WORK_COMPLETE;
  if (work->delete_requested) work_free(work);
  silk_napi_leave_callback(env, handles);
}

napi_status NAPI_CDECL napi_create_async_work(napi_env env, napi_value resource,
                                             napi_value name,
                                             napi_async_execute_callback execute,
                                             napi_async_complete_callback complete,
                                             void *data, napi_async_work *result) {
  napi_status status = silk_napi_check(env);
  if (status != napi_ok) return status;
  if (!execute || !result || !name) return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  napi_async_work work = calloc(1, sizeof(*work));
  if (!work) return silk_napi_status(env, napi_generic_failure);
  status = napi_async_init(env, resource, name, &work->context);
  if (status != napi_ok) { free(work); return status; }
  work->env = env;
  work->execute = execute;
  work->complete = complete;
  work->data = data;
  work->request.data = work;
  work->next = async_state(env)->works;
  async_state(env)->works = work;
  *result = work;
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_delete_async_work(napi_env env, napi_async_work work) {
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!work || work->env != env || work->delete_requested)
    return silk_napi_status(env, napi_invalid_arg);
  if (work->state == WORK_QUEUED || work->state == WORK_COMPLETING)
    work->delete_requested = 1;
  else work_free(work);
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_queue_async_work(node_api_basic_env basic,
                                            napi_async_work work) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!work || work->env != env || work->state != WORK_CREATED || work->delete_requested)
    return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  int error = uv_queue_work(&env->loop, &work->request, work_execute, work_complete);
  if (!error) work->state = WORK_QUEUED;
  return silk_napi_status(env, error ? napi_generic_failure : napi_ok);
}

napi_status NAPI_CDECL napi_cancel_async_work(node_api_basic_env basic,
                                             napi_async_work work) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!work || work->env != env || work->state != WORK_QUEUED)
    return silk_napi_status(env, napi_invalid_arg);
  return silk_napi_status(env, uv_cancel((uv_req_t *)&work->request) ?
                          napi_generic_failure : napi_ok);
}

static void function_closed(uv_handle_t *handle) {
  napi_threadsafe_function function = handle->data;
  napi_env env = function->env;
  async_state(env)->activity++;
  napi_handle_scope handles;
  silk_napi_enter_callback(env, &handles);
  if (function->finalize)
    function->finalize(env, function->finalize_data, function->context);
  napi_async_destroy(env, function->resource);
  if (function->callback) silk_napi_release_root(env, function->callback);
  napi_threadsafe_function *link = &async_state(env)->functions;
  while (*link && *link != function) link = &(*link)->next;
  if (*link) *link = function->next;
  uv_cond_destroy(&function->space);
  uv_mutex_destroy(&function->mutex);
  free(function);
  silk_napi_fatal_pending(env);
  silk_napi_leave_callback(env, handles);
}

static void function_dispatch(uv_async_t *signal) {
  napi_threadsafe_function function = signal->data;
  napi_env env = function->env;
  async_state(env)->activity++;
  /* Bound each turn so an active producer cannot starve the host event loop. */
  for (unsigned delivered = 0; delivered < 1024; delivered++) {
    uv_mutex_lock(&function->mutex);
    struct silk_napi_queue_item *item = function->head;
    int closing = function->closing;
    if (item) {
      function->head = item->next;
      if (!function->head) function->tail = NULL;
      function->count--;
      uv_cond_signal(&function->space);
    } else if (!function->threads && !function->handle_closing) {
      function->handle_closing = 1;
      uv_close((uv_handle_t *)&function->signal, function_closed);
    }
    uv_mutex_unlock(&function->mutex);
    if (!item) return;
    if (closing) {
      if (function->call) function->call(NULL, NULL, function->context, item->data);
    } else {
      napi_handle_scope handles;
      silk_napi_enter_callback(env, &handles);
      napi_callback_scope scope = NULL;
      napi_status status = napi_open_callback_scope(env, function->resource->resource,
                                                    function->resource, &scope);
      if (status == napi_ok) {
        if (function->call)
          function->call(env, function->callback, function->context, item->data);
        else {
          napi_value recv;
          if (napi_get_undefined(env, &recv) == napi_ok)
            napi_call_function(env, recv, function->callback, 0, NULL, NULL);
        }
      } else if (function->call) {
        function->call(NULL, NULL, function->context, item->data);
      }
      if (scope) napi_close_callback_scope(env, scope);
      silk_napi_fatal_pending(env);
      silk_napi_leave_callback(env, handles);
    }
    free(item);
  }
  uv_async_send(&function->signal);
}

napi_status NAPI_CDECL napi_create_threadsafe_function(
    napi_env env, napi_value callback, napi_value resource, napi_value name,
    size_t maximum, size_t threads, void *finalize_data, napi_finalize finalize,
    void *context, napi_threadsafe_function_call_js call,
    napi_threadsafe_function *result) {
  napi_status status = silk_napi_check(env);
  if (status != napi_ok) return status;
  if ((!callback && !call) || !threads || !name || !result)
    return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  if (callback) {
    napi_valuetype type;
    status = napi_typeof(env, callback, &type);
    if (status != napi_ok) return status;
    if (type != napi_function) return silk_napi_status(env, napi_function_expected);
  }
  napi_threadsafe_function function = calloc(1, sizeof(*function));
  if (!function) return silk_napi_status(env, napi_generic_failure);
  function->env = env;
  function->maximum = maximum;
  function->threads = threads;
  function->context = context;
  function->call = call;
  function->finalize_data = finalize_data;
  function->finalize = finalize;
  if (uv_mutex_init(&function->mutex)) { free(function); return silk_napi_status(env, napi_generic_failure); }
  if (uv_cond_init(&function->space)) {
    uv_mutex_destroy(&function->mutex);
    free(function);
    return silk_napi_status(env, napi_generic_failure);
  }
  status = napi_async_init(env, resource, name, &function->resource);
  if (status != napi_ok) goto failed;
  if (callback) {
    function->callback = silk_napi_root(env, callback);
    if (!function->callback) { status = napi_generic_failure; goto failed; }
  }
  if (uv_async_init(&env->loop, &function->signal, function_dispatch)) {
    status = napi_generic_failure;
    goto failed;
  }
  function->signal.data = function;
  function->next = async_state(env)->functions;
  async_state(env)->functions = function;
  *result = function;
  return silk_napi_status(env, napi_ok);
failed:
  if (function->callback) silk_napi_release_root(env, function->callback);
  if (function->resource) napi_async_destroy(env, function->resource);
  uv_cond_destroy(&function->space);
  uv_mutex_destroy(&function->mutex);
  free(function);
  return silk_napi_status(env, status);
}

napi_status NAPI_CDECL napi_get_threadsafe_function_context(
    napi_threadsafe_function function, void **result) {
  if (!function || !result) return napi_invalid_arg;
  *result = function->context;
  return napi_ok;
}

napi_status NAPI_CDECL napi_call_threadsafe_function(
    napi_threadsafe_function function, void *data,
    napi_threadsafe_function_call_mode mode) {
  if (!function || (mode != napi_tsfn_blocking && mode != napi_tsfn_nonblocking))
    return napi_invalid_arg;
  uv_mutex_lock(&function->mutex);
  while (!function->closing && function->maximum && function->count >= function->maximum) {
    if (mode == napi_tsfn_nonblocking) {
      uv_mutex_unlock(&function->mutex);
      return napi_queue_full;
    }
    if (silk_napi_on_owner(function->env)) {
      uv_mutex_unlock(&function->mutex);
      return napi_would_deadlock;
    }
    uv_cond_wait(&function->space, &function->mutex);
  }
  if (function->closing) {
    /* napi_closing relinquishes the caller's participation, as in Node. */
    if (function->threads) function->threads--;
    uv_async_send(&function->signal);
    uv_mutex_unlock(&function->mutex);
    return napi_closing;
  }
  if (!function->threads || function->handle_closing) {
    uv_mutex_unlock(&function->mutex);
    return napi_closing;
  }
  struct silk_napi_queue_item *item = malloc(sizeof(*item));
  if (!item) { uv_mutex_unlock(&function->mutex); return napi_generic_failure; }
  item->data = data;
  item->next = NULL;
  if (function->tail) function->tail->next = item;
  else function->head = item;
  function->tail = item;
  function->count++;
  uv_async_send(&function->signal);
  uv_mutex_unlock(&function->mutex);
  return napi_ok;
}

napi_status NAPI_CDECL napi_acquire_threadsafe_function(napi_threadsafe_function function) {
  if (!function) return napi_invalid_arg;
  uv_mutex_lock(&function->mutex);
  napi_status status = napi_ok;
  if (function->closing || !function->threads || function->handle_closing) status = napi_closing;
  else if (function->threads == SIZE_MAX) status = napi_generic_failure;
  else function->threads++;
  uv_mutex_unlock(&function->mutex);
  return status;
}

napi_status NAPI_CDECL napi_release_threadsafe_function(
    napi_threadsafe_function function, napi_threadsafe_function_release_mode mode) {
  if (!function || (mode != napi_tsfn_abort && mode != napi_tsfn_release))
    return napi_invalid_arg;
  uv_mutex_lock(&function->mutex);
  if (!function->threads || function->handle_closing) {
    uv_mutex_unlock(&function->mutex);
    return napi_invalid_arg;
  }
  function->threads--;
  if (mode == napi_tsfn_abort) function->closing = 1;
  if (!function->threads || function->closing) {
    uv_cond_broadcast(&function->space);
    uv_async_send(&function->signal);
  }
  uv_mutex_unlock(&function->mutex);
  return napi_ok;
}

napi_status NAPI_CDECL napi_unref_threadsafe_function(node_api_basic_env basic,
                                                     napi_threadsafe_function function) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!function || function->env != env) return silk_napi_status(env, napi_invalid_arg);
  uv_unref((uv_handle_t *)&function->signal);
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_ref_threadsafe_function(node_api_basic_env basic,
                                                   napi_threadsafe_function function) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!function || function->env != env) return silk_napi_status(env, napi_invalid_arg);
  uv_ref((uv_handle_t *)&function->signal);
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_add_env_cleanup_hook(node_api_basic_env basic,
                                                napi_cleanup_hook callback, void *data) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!callback) return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  struct silk_napi_async *state = async_state(env);
  uv_mutex_lock(&state->hooks_mutex);
  for (napi_async_cleanup_hook_handle hook = state->hooks; hook; hook = hook->next) {
    if (!hook->removed && hook->sync == callback && hook->data == data) {
      uv_mutex_unlock(&state->hooks_mutex);
      return silk_napi_status(env, napi_invalid_arg);
    }
  }
  napi_async_cleanup_hook_handle hook = calloc(1, sizeof(*hook));
  if (!hook) { uv_mutex_unlock(&state->hooks_mutex); return silk_napi_status(env, napi_generic_failure); }
  hook->env = env;
  hook->sync = callback;
  hook->data = data;
  hook->next = state->hooks;
  state->hooks = hook;
  uv_mutex_unlock(&state->hooks_mutex);
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_remove_env_cleanup_hook(node_api_basic_env basic,
                                                   napi_cleanup_hook callback, void *data) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!callback) return silk_napi_status(env, napi_invalid_arg);
  struct silk_napi_async *state = async_state(env);
  uv_mutex_lock(&state->hooks_mutex);
  for (napi_async_cleanup_hook_handle hook = state->hooks; hook; hook = hook->next) {
    if (!hook->removed && hook->sync == callback && hook->data == data) {
      hook->removed = 1;
      uv_mutex_unlock(&state->hooks_mutex);
      return silk_napi_status(env, napi_ok);
    }
  }
  uv_mutex_unlock(&state->hooks_mutex);
  return silk_napi_status(env, napi_invalid_arg);
}

napi_status NAPI_CDECL napi_add_async_cleanup_hook(node_api_basic_env basic,
                                                  napi_async_cleanup_hook callback,
                                                  void *data,
                                                  napi_async_cleanup_hook_handle *result) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!callback) return silk_napi_status(env, napi_invalid_arg);
  if (env->closing) return silk_napi_status(env, napi_closing);
  napi_async_cleanup_hook_handle hook = calloc(1, sizeof(*hook));
  if (!hook) return silk_napi_status(env, napi_generic_failure);
  hook->env = env;
  hook->async = callback;
  hook->data = data;
  struct silk_napi_async *state = async_state(env);
  uv_mutex_lock(&state->hooks_mutex);
  hook->next = state->hooks;
  state->hooks = hook;
  uv_mutex_unlock(&state->hooks_mutex);
  if (result) *result = hook;
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_remove_async_cleanup_hook(napi_async_cleanup_hook_handle hook) {
  if (!hook || !hook->async) return napi_invalid_arg;
  struct silk_napi_async *state = async_state(hook->env);
  uv_mutex_lock(&state->hooks_mutex);
  if (hook->removed) { uv_mutex_unlock(&state->hooks_mutex); return napi_invalid_arg; }
  hook->removed = 1;
  if (hook->started) state->pending_cleanup--;
  uv_async_send(&state->wake);
  uv_mutex_unlock(&state->hooks_mutex);
  return napi_ok;
}

napi_status NAPI_CDECL napi_get_uv_event_loop(node_api_basic_env basic,
                                             struct uv_loop_s **loop) {
  napi_env env = (napi_env)basic;
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!loop) return silk_napi_status(env, napi_invalid_arg);
  *loop = &env->loop;
  return silk_napi_status(env, napi_ok);
}

napi_status NAPI_CDECL napi_fatal_exception(napi_env env, napi_value error) {
  if (owner_status(env) != napi_ok) return napi_invalid_arg;
  if (!error) return silk_napi_status(env, napi_invalid_arg);
  napi_status status = napi_throw(env, error);
  if (status == napi_ok) silk_napi_fatal_pending(env);
  return silk_napi_status(env, status);
}

static void wake_callback(uv_async_t *handle) {
  struct silk_napi_async *state = handle->data;
  state->activity++;
}

int silk_napi_async_init(napi_env env) {
  struct silk_napi_async *state = calloc(1, sizeof(*state));
  if (!state) return UV_ENOMEM;
  int error = uv_loop_init(&env->loop);
  if (error) { free(state); return error; }
  error = uv_mutex_init(&state->hooks_mutex);
  if (error) { uv_loop_close(&env->loop); free(state); return error; }
  error = uv_async_init(&env->loop, &state->wake, wake_callback);
  if (error) {
    uv_mutex_destroy(&state->hooks_mutex);
    uv_loop_close(&env->loop);
    free(state);
    return error;
  }
  state->wake.data = state;
  uv_unref((uv_handle_t *)&state->wake);
  env->async = state;
  return 0;
}

int silk_napi_poll(napi_env env) {
  if (owner_status(env) != napi_ok || !env->async || async_state(env)->draining) return 0;
  uint64_t before = async_state(env)->activity;
  /* An unreferenced TSFN still delivers while the host has other live work.
   * libuv otherwise skips a loop containing only unreferenced handles. */
  uv_ref((uv_handle_t *)&async_state(env)->wake);
  uv_run(&env->loop, UV_RUN_NOWAIT);
  uv_unref((uv_handle_t *)&async_state(env)->wake);
  return before != async_state(env)->activity || uv_loop_alive(&env->loop);
}

int silk_napi_alive(napi_env env) {
  if (owner_status(env) != napi_ok || !env->async) return 0;
  return uv_loop_alive(&env->loop);
}

static int run_cleanup_hooks(napi_env env) {
  struct silk_napi_async *state = async_state(env);
  for (;;) {
    uv_mutex_lock(&state->hooks_mutex);
    napi_async_cleanup_hook_handle hook = state->hooks;
    while (hook && (hook->removed || hook->started)) hook = hook->next;
    if (!hook) {
      int pending = state->pending_cleanup != 0;
      uv_mutex_unlock(&state->hooks_mutex);
      return pending;
    }
    hook->started = 1;
    if (hook->async) state->pending_cleanup++;
    else hook->removed = 1;
    uv_mutex_unlock(&state->hooks_mutex);
    state->activity++;
    napi_handle_scope handles;
    silk_napi_enter_callback(env, &handles);
    if (hook->async) hook->async(hook, hook->data);
    else hook->sync(hook->data);
    silk_napi_fatal_pending(env);
    silk_napi_leave_callback(env, handles);
  }
}

static void close_remaining_handle(uv_handle_t *handle, void *data) {
  (void)data;
  if (!uv_is_closing(handle)) uv_close(handle, NULL);
}

void silk_napi_async_close(napi_env env) {
  if (owner_status(env) != napi_ok || !env->async) return;
  struct silk_napi_async *state = async_state(env);
  if (state->draining) return;
  state->draining = 1;
  env->closing = 1;
  /* Keep the wake handle referenced while waiting for async cleanup or a
   * producer which has not yet observed TSFN abort and relinquished ownership. */
  uv_ref((uv_handle_t *)&state->wake);
  for (napi_threadsafe_function function = state->functions; function; function = function->next) {
    uv_mutex_lock(&function->mutex);
    function->closing = 1;
    uv_cond_broadcast(&function->space);
    uv_async_send(&function->signal);
    uv_mutex_unlock(&function->mutex);
  }
  for (napi_async_work work = state->works; work; work = work->next)
    if (work->state == WORK_QUEUED) uv_cancel((uv_req_t *)&work->request);
  for (;;) {
    int cleanup_pending = run_cleanup_hooks(env);
    int work_pending = 0;
    for (napi_async_work work = state->works; work; work = work->next)
      if (work->state == WORK_QUEUED || work->state == WORK_COMPLETING)
        work_pending = 1;
    if (!cleanup_pending && !work_pending && !state->functions) break;
    uv_run(&env->loop, UV_RUN_ONCE);
  }
  while (state->scope) napi_close_callback_scope(env, state->scope);
  uv_unref((uv_handle_t *)&state->wake);
}

/* Core calls this only after object and instance finalizers have had a chance
 * to destroy their contexts, delete work handles and close addon uv handles. */
void silk_napi_async_dispose(napi_env env) {
  if (owner_status(env) != napi_ok || !env->async) return;
  struct silk_napi_async *state = async_state(env);
  if (!state->draining) silk_napi_async_close(env);
  while (state->scope) napi_close_callback_scope(env, state->scope);
  while (state->works) work_free(state->works);
  while (state->contexts) napi_async_destroy(env, state->contexts);
  uv_walk(&env->loop, close_remaining_handle, NULL);
  uv_run(&env->loop, UV_RUN_DEFAULT);
  uv_loop_close(&env->loop);
  while (state->hooks) {
    napi_async_cleanup_hook_handle next = state->hooks->next;
    free(state->hooks);
    state->hooks = next;
  }
  uv_mutex_destroy(&state->hooks_mutex);
  free(state);
  env->async = NULL;
}
