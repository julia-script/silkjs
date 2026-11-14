// Thread-safe functions as napi-rs addons (rolldown, oxc) use them.
// hold: a function whose producer count never reaches zero, as napi-rs keeps one for its own
// bookkeeping. Environment teardown must finalize it instead of waiting for the producer.
// pingpong: a producer thread that waits for JavaScript to answer each call from a promise job,
// as napi-rs does for a plugin hook. The loop must run its checkpoint after delivering calls.
#define _GNU_SOURCE
#define NAPI_VERSION 10
#include <node_api.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define CHECK(call) do { if ((call) != napi_ok) { \
  napi_throw_error(env, NULL, #call); return NULL; } } while (0)

static napi_threadsafe_function held_function;

static void call_js(napi_env env, napi_value callback, void *context, void *data) {
  (void)env; (void)callback; (void)context; (void)data;
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)data; (void)hint;
  fputs("held function finalized\n", stdout);
  fflush(stdout);
}

static napi_value hold(napi_env env, napi_callback_info info) {
  napi_value name, result;
  bool referenced = false;
  napi_value argument;
  size_t argc = 1;
  CHECK(napi_get_cb_info(env, info, &argc, &argument, NULL, NULL));
  if (argc == 1) CHECK(napi_get_value_bool(env, argument, &referenced));
  CHECK(napi_create_string_utf8(env, "silk-napi-held", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, finalize, NULL, call_js, &held_function));
  if (!referenced) CHECK(napi_unref_threadsafe_function(env, held_function));
  CHECK(napi_get_undefined(env, &result));
  return result;
}

static napi_value release_held(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  // Another producer joins and stays: the abort alone must still finalize the function.
  CHECK(napi_acquire_threadsafe_function(held_function));
  CHECK(napi_release_threadsafe_function(held_function, napi_tsfn_abort));
  CHECK(napi_get_undefined(env, &result));
  return result;
}

static struct {
  napi_threadsafe_function function;
  pthread_t thread;
  pthread_mutex_t lock;
  pthread_cond_t answered;
  int rounds, answers;
} game = { .lock = PTHREAD_MUTEX_INITIALIZER, .answered = PTHREAD_COND_INITIALIZER };

static void serve(napi_env env, napi_value callback, void *context, void *data) {
  (void)context;
  if (!env) return;
  napi_value argument, receiver;
  if (napi_create_int32(env, (int)(size_t)data, &argument) != napi_ok) abort();
  if (napi_get_undefined(env, &receiver) != napi_ok) abort();
  napi_call_function(env, receiver, callback, 1, &argument, NULL);
}

static void *play(void *data) {
  (void)data;
  for (int i = 0; i < game.rounds; i++) {
    if (napi_call_threadsafe_function(game.function, (void *)(size_t)i, napi_tsfn_blocking) != napi_ok) abort();
    pthread_mutex_lock(&game.lock);
    while (game.answers <= i) pthread_cond_wait(&game.answered, &game.lock);
    pthread_mutex_unlock(&game.lock);
  }
  if (napi_release_threadsafe_function(game.function, napi_tsfn_release) != napi_ok) abort();
  return NULL;
}

static void joined(napi_env env, void *data, void *hint) {
  (void)env; (void)data; (void)hint;
  if (pthread_join(game.thread, NULL)) abort();
}

static napi_value pingpong(napi_env env, napi_callback_info info) {
  napi_value arguments[2], name, result;
  size_t argc = 2;
  CHECK(napi_get_cb_info(env, info, &argc, arguments, NULL, NULL));
  CHECK(napi_get_value_int32(env, arguments[1], &game.rounds));
  CHECK(napi_create_string_utf8(env, "silk-napi-pingpong", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_threadsafe_function(env, arguments[0], NULL, name, 1, 1, NULL, joined, NULL, serve, &game.function));
  if (pthread_create(&game.thread, NULL, play, NULL)) abort();
  CHECK(napi_get_undefined(env, &result));
  return result;
}

static napi_value answer(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  pthread_mutex_lock(&game.lock);
  game.answers++;
  pthread_cond_signal(&game.answered);
  pthread_mutex_unlock(&game.lock);
  CHECK(napi_get_undefined(env, &result));
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "hold", NULL, hold, NULL, NULL, NULL, napi_default, NULL },
    { "abort", NULL, release_held, NULL, NULL, NULL, napi_default, NULL },
    { "pingpong", NULL, pingpong, NULL, NULL, NULL, napi_default, NULL },
    { "answer", NULL, answer, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, 4, properties) != napi_ok) return NULL;
  return exports;
}
