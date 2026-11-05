/* SilkJS Node-API embedding contract. SPDX-License-Identifier: MIT */
#ifndef SILK_NAPI_BRIDGE_H
#define SILK_NAPI_BRIDGE_H
#define NAPI_VERSION 10
#include "node_api.h"
#include <uv.h>
#include <stdint.h>
#include <stddef.h>
/* Values are engine-owned, opaque storage. C never interprets their contents.
 * Bridge calls happen only on the environment owner thread. */
typedef struct silk_napi_packet {
  napi_value values[8];
  const napi_value *argv;
  size_t argc;
  void *data;
  void *extra;
  size_t size;
  size_t offset;
  double number;
  uint64_t integer;
  int32_t flags;
  napi_value result;
} silk_napi_packet;
typedef int (*silk_napi_bridge)(void *, int, silk_napi_packet *);
enum silk_napi_operation {
  SILK_NAPI_RELEASE=1, SILK_NAPI_DUPLICATE, SILK_NAPI_UNDEFINED,
  SILK_NAPI_NULL, SILK_NAPI_BOOLEAN, SILK_NAPI_NUMBER, SILK_NAPI_STRING,
  SILK_NAPI_READ_STRING, SILK_NAPI_TYPEOF, SILK_NAPI_READ_NUMBER,
  SILK_NAPI_JS, SILK_NAPI_PENDING, SILK_NAPI_CLEAR_EXCEPTION,
  SILK_NAPI_THROW, SILK_NAPI_BUFFER, SILK_NAPI_BUFFER_INFO,
  SILK_NAPI_EXTERNAL_BUFFER, SILK_NAPI_DETACH, SILK_NAPI_WEAK,
  SILK_NAPI_WEAK_GET, SILK_NAPI_WEAK_RELEASE, SILK_NAPI_EXTERNAL_MEMORY
};
struct napi_value__ { struct napi_env__ *env; unsigned char payload[]; };
struct napi_env__ {
  void *host;
  silk_napi_bridge bridge;
  size_t value_size;
  uv_loop_t loop;
  uv_thread_t owner;
  napi_extended_error_info error;
  struct silk_napi_arena *arena;
  struct napi_handle_scope__ *scope;
  struct napi_ref__ *refs;
  struct silk_napi_callback *callbacks;
  struct silk_napi_library *libraries;
  struct silk_napi_finalizer *finalizers;
  struct silk_napi_finalizer *pending_finalizers;
  void *async;
  void *instance_data;
  napi_finalize instance_finalize;
  void *instance_hint;
  int64_t external_memory;
  const char *filename;
  int32_t api_version;
  int closing;
};
int silk_napi_on_owner(napi_env);
napi_status silk_napi_status(napi_env, napi_status);
napi_status silk_napi_check(napi_env);
napi_value silk_napi_slot(napi_env);
napi_status silk_napi_call(napi_env, int, silk_napi_packet *);
napi_status silk_napi_js(napi_env, const char *, size_t, const napi_value *, napi_value *);
napi_value silk_napi_root(napi_env, napi_value);
void silk_napi_release_root(napi_env, napi_value);
void silk_napi_async_close(napi_env);
void silk_napi_async_dispose(napi_env);
int silk_napi_async_init(napi_env);
int silk_napi_poll(napi_env);
int silk_napi_alive(napi_env);
void silk_napi_enter_callback(napi_env, napi_handle_scope *);
void silk_napi_leave_callback(napi_env, napi_handle_scope);
void silk_napi_fatal_pending(napi_env);
/* Runtime-facing API. load initializes a fresh environment for each addon load;
 * dlopen library ownership outlives callbacks and every cleanup hook. */
napi_env silk_napi_open(void *, silk_napi_bridge, size_t);
void silk_napi_close(napi_env);
void silk_napi_dispose(napi_env);
int silk_napi_load(napi_env, const char *, int, napi_value, napi_value *);
const char *silk_napi_load_error(void);
void *silk_napi_payload(napi_value);
napi_value silk_napi_invoke(napi_env, uintptr_t, napi_value, napi_value, size_t, const napi_value *);
void silk_napi_finalize(napi_env, uintptr_t);
napi_env silk_napi_callback_env(uintptr_t);
napi_env silk_napi_finalizer_env(uintptr_t);
uintptr_t silk_napi_finalizer(napi_env, void *, node_api_basic_finalize, void *);
void silk_napi_cancel_finalizer(napi_env, uintptr_t);
void *silk_napi_finalizer_data(napi_env, uintptr_t);
#endif
