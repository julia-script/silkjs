/* Oracle-only embedding of the pinned C QuickJS; never linked into SilkJS. */
#define _POSIX_C_SOURCE 200809L
#include "quickjs.h"
#include "quickjs-libc.h"
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static _Atomic(JSRuntime *) root_runtime;
static JSClassID sentinel_class;
static _Atomic int root_freed;
static _Atomic int completion;

static JSValue host_done(JSContext *ctx, JSValueConst receiver, int argc,
                         JSValueConst *argv) {
    (void)receiver; (void)argc; (void)argv;
    if (!atomic_load_explicit(&root_freed, memory_order_acquire))
        return JS_ThrowInternalError(ctx, "child completed before root free");
    atomic_store_explicit(&completion, 1, memory_order_release);
    return JS_UNDEFINED;
}

static void sentinel_finalizer(JSRuntime *rt, JSValue value) {
    (void)rt; (void)value;
    int previous = atomic_load_explicit(&completion, memory_order_acquire);
    atomic_store_explicit(&completion, previous == 1 ? 2 : -1,
                          memory_order_release);
}

static JSContext *new_context(JSRuntime *rt) {
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) return NULL;
    js_init_module_std(ctx, "std");
    js_init_module_os(ctx, "os");
    if (rt != root_runtime) {
        JSClassDef definition = { .class_name = "CompletionSentinel",
                                  .finalizer = sentinel_finalizer };
        if (JS_NewClass(rt, sentinel_class, &definition) < 0) goto failure;
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue sentinel = JS_NewObjectClass(ctx, sentinel_class);
        if (JS_IsException(sentinel)) { JS_FreeValue(ctx, global); goto failure; }
        if (JS_SetPropertyStr(ctx, global, "__completionSentinel", sentinel) < 0 ||
            JS_SetPropertyStr(ctx, global, "__hostDone",
                              JS_NewCFunction(ctx, host_done, "__hostDone", 0)) < 0) {
            JS_FreeValue(ctx, global); goto failure;
        }
        JS_FreeValue(ctx, global);
    }
    return ctx;
failure:
    js_std_dump_error(ctx);
    JS_FreeContext(ctx);
    return NULL;
}

static void pause_thread(void) {
    const struct timespec delay = { .tv_sec = 0, .tv_nsec = 1000000 };
    nanosleep(&delay, NULL);
}

static int input_locked(void) {
    if (ftrylockfile(stdin) != 0) return 1;
    funlockfile(stdin);
    return 0;
}

static int descriptor_count(void) {
    int count = 0;
    for (int fd = 0; fd < 4096; ++fd)
        if (fcntl(fd, F_GETFD) >= 0) ++count;
    return count;
}

int main(void) {
    int status = 1, saved = -1, input[2] = {-1, -1}, source_fd = -1;
    int child_started = 0, fed = 0;
    JSContext *ctx = NULL;
    char path[] = "/tmp/silkjs-detached-oracle-XXXXXX";
    const char child[] = "import * as std from 'std';"
        "if(std.in.getline()!=='OK')throw Error('host input lost');__hostDone();";
    source_fd = mkstemp(path);
    if (source_fd < 0 || write(source_fd, child, sizeof(child) - 1) != sizeof(child) - 1)
        goto cleanup;
    if (close(source_fd) != 0) { source_fd = -1; goto cleanup; }
    source_fd = -1;
    saved = dup(STDIN_FILENO);
    if (saved < 0 || pipe(input) != 0 || dup2(input[0], STDIN_FILENO) < 0) goto cleanup;
    if (close(input[0]) != 0) goto cleanup;
    input[0] = -1;
    int baseline = descriptor_count();
    JS_NewClassID(&sentinel_class);
    root_runtime = JS_NewRuntime();
    if (!root_runtime) goto cleanup;
    js_std_set_worker_new_context_func(new_context);
    js_std_init_handlers(root_runtime);
    ctx = new_context(root_runtime);
    if (!ctx) goto cleanup;
    JS_SetModuleLoaderFunc2(root_runtime, NULL, js_module_loader,
                           js_module_check_attributes, NULL);
    char source[512];
    int length = snprintf(source, sizeof(source),
                          "import * as os from 'os';globalThis.worker=new os.Worker('%s');", path);
    if (length < 0 || (size_t)length >= sizeof(source)) goto cleanup;
    JSValue result = JS_Eval(ctx, source, (size_t)length,
                             "oracle-detached:root", JS_EVAL_TYPE_MODULE);
    result = js_std_await(ctx, result);
    if (JS_IsException(result)) {
        js_std_dump_error(ctx); JS_FreeValue(ctx, result); goto cleanup;
    }
    JS_FreeValue(ctx, result);
    child_started = 1;
    int turns = 0;
    while (!input_locked() && turns++ < 5000) pause_thread();
    if (turns >= 5000) { status = 2; goto cleanup; }
    js_std_free_handlers(root_runtime);
    JS_FreeContext(ctx); ctx = NULL;
    JS_FreeRuntime(root_runtime); root_runtime = NULL;
    atomic_store_explicit(&root_freed, 1, memory_order_release);
    if (!input_locked()) { status = 3; goto cleanup; }
    if (write(input[1], "OK\n", 3) != 3) { status = 4; goto cleanup; }
    fed = 1;
    turns = 0;
    while ((atomic_load_explicit(&completion, memory_order_acquire) != 2 ||
            descriptor_count() != baseline) && turns++ < 5000) pause_thread();
    if (turns >= 5000 || ferror(stdin) || feof(stdin)) { status = 5; goto cleanup; }
    status = 0;
cleanup:
    if (root_runtime) {
        js_std_free_handlers(root_runtime);
        if (ctx) JS_FreeContext(ctx);
        JS_FreeRuntime(root_runtime);
        root_runtime = NULL;
        atomic_store_explicit(&root_freed, 1, memory_order_release);
    }
    if (child_started && !fed && input[1] >= 0) {
        ssize_t ignored = write(input[1], "OK\n", 3); (void)ignored;
        for (int i = 0; i < 5000 && atomic_load(&completion) == 0; ++i) pause_thread();
    }
    if (saved >= 0) {
        if (dup2(saved, STDIN_FILENO) < 0 && status == 0) status = 6;
        if (close(saved) != 0 && status == 0) status = 7;
    }
    if (input[0] >= 0 && close(input[0]) != 0 && status == 0) status = 8;
    if (input[1] >= 0 && close(input[1]) != 0 && status == 0) status = 9;
    if (source_fd >= 0) close(source_fd);
    if (unlink(path) != 0 && errno != ENOENT && status == 0) status = 10;
    if (status) fprintf(stderr, "detached oracle failure: status=%d completion=%d\n",
                        status, atomic_load(&completion));
    else puts("detached-root-free:ok");
    return status;
}
