/* Minimal WASI command host for QuickJS: runs one script file with print, console.log,
   performance.now and scriptArgs. quickjs-libc.c needs fork, signals and threads, which
   WASI Preview 1 does not have, so the benchmark build links this file in its place. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "quickjs.h"

static JSValue js_print(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        size_t len;
        const char *str = JS_ToCStringLen(ctx, &len, argv[i]);
        if (!str)
            return JS_EXCEPTION;
        if (i != 0)
            fputc(' ', stdout);
        fwrite(str, 1, len, stdout);
        JS_FreeCString(ctx, str);
    }
    fputc('\n', stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewFloat64(ctx, (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6);
}

static void dump_error(JSContext *ctx)
{
    JSValue exception = JS_GetException(ctx);
    const char *str = JS_ToCString(ctx, exception);
    fprintf(stderr, "%s\n", str ? str : "[exception]");
    JS_FreeCString(ctx, str);
    if (JS_IsError(ctx, exception)) {
        JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
        const char *text = JS_ToCString(ctx, stack);
        if (text)
            fprintf(stderr, "%s\n", text);
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, stack);
    }
    JS_FreeValue(ctx, exception);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: qjs.wasm script.js [arguments]\n");
        return 2;
    }
    FILE *f = fopen(argv[1], "rb");
    if (!f) {
        fprintf(stderr, "cannot open %s\n", argv[1]);
        return 2;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *source = malloc((size_t)size + 1);
    if (!source || fread(source, 1, (size_t)size, f) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 2;
    }
    source[size] = 0;
    fclose(f);

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue print = JS_NewCFunction(ctx, js_print, "print", 1);
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log", JS_DupValue(ctx, print));
    JS_SetPropertyStr(ctx, global, "console", console);
    JS_SetPropertyStr(ctx, global, "print", print);
    JSValue performance = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, performance, "now", JS_NewCFunction(ctx, js_now, "now", 0));
    JS_SetPropertyStr(ctx, global, "performance", performance);
    JSValue args = JS_NewArray(ctx);
    for (int i = 1; i < argc; i++)
        JS_SetPropertyUint32(ctx, args, (uint32_t)(i - 1), JS_NewString(ctx, argv[i]));
    JS_SetPropertyStr(ctx, global, "scriptArgs", args);
    JS_FreeValue(ctx, global);

    int status = 0;
    JSValue result = JS_Eval(ctx, source, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        dump_error(ctx);
        status = 1;
    }
    JS_FreeValue(ctx, result);
    for (;;) {
        JSContext *job_ctx;
        int err = JS_ExecutePendingJob(rt, &job_ctx);
        if (err == 0)
            break;
        if (err < 0) {
            dump_error(job_ctx);
            status = 1;
        }
    }
    fflush(stdout);
    return status;
}
