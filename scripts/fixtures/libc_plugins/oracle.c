/* Separate pinned QuickJS oracle only. Never linked into native Silk executables.
 * Mirrors observable JS operations, not the Silk command/reply implementation. */
#include "quickjs.h"
#include <stdint.h>

static JSValue operation(JSContext *ctx, JSValueConst self, int argc,
                         JSValueConst *argv, int magic) {
    switch (magic) {
    case 0: {
        double a, b;
        if (JS_ToFloat64(ctx, &a, argv[0]) < 0 || JS_ToFloat64(ctx, &b, argv[1]) < 0)
            return JS_EXCEPTION;
        return JS_NewFloat64(ctx, a + b);
    }
    case 1: return JS_DupValue(ctx, argv[0]);
    case 2: {
        JSAtom key = JS_ValueToAtom(ctx, argv[1]);
        if (key == JS_ATOM_NULL) return JS_EXCEPTION;
        JSValue result = JS_GetProperty(ctx, argv[0], key);
        JS_FreeAtom(ctx, key);
        return result;
    }
    case 3: {
        JSAtom key = JS_ValueToAtom(ctx, argv[1]);
        if (key == JS_ATOM_NULL) return JS_EXCEPTION;
        int result = JS_SetProperty(ctx, argv[0], key, JS_DupValue(ctx, argv[2]));
        JS_FreeAtom(ctx, key);
        return result < 0 ? JS_EXCEPTION : JS_NewBool(ctx, result);
    }
    case 4: return JS_Call(ctx, argv[0], argv[1], 1, argv + 2);
    case 5: return JS_Throw(ctx, JS_DupValue(ctx, argv[0]));
    case 6: {
        size_t length;
        const char *source = JS_ToCStringLen(ctx, &length, argv[0]);
        if (!source) return JS_EXCEPTION;
        JSValue result = JS_Eval(ctx, source, length, "<native-plugin>", JS_EVAL_TYPE_GLOBAL);
        JS_FreeCString(ctx, source);
        return result;
    }
    case 7: case 8: return JS_ToString(ctx, argv[0]);
    }
    return JS_ThrowInternalError(ctx, "oracle operation");
}
static const JSCFunctionListEntry exports[] = {
    JS_CFUNC_MAGIC_DEF("add", 2, operation, 0),
    JS_CFUNC_MAGIC_DEF("identity", 1, operation, 1),
    JS_CFUNC_MAGIC_DEF("get", 2, operation, 2),
    JS_CFUNC_MAGIC_DEF("set", 3, operation, 3),
    JS_CFUNC_MAGIC_DEF("invoke", 3, operation, 4),
    JS_CFUNC_MAGIC_DEF("throwValue", 1, operation, 5),
    JS_CFUNC_MAGIC_DEF("evaluate", 1, operation, 6),
    JS_CFUNC_MAGIC_DEF("text", 1, operation, 7),
    JS_CFUNC_MAGIC_DEF("utf16", 1, operation, 8),
    JS_PROP_INT32_DEF("version", 1, JS_PROP_ENUMERABLE),
};
static int initialize(JSContext *ctx, JSModuleDef *module) {
    return JS_SetModuleExportList(ctx, module, exports, sizeof(exports) / sizeof(exports[0]));
}
JSModuleDef *js_init_module(JSContext *ctx, const char *name) {
    JSModuleDef *module = JS_NewCModule(ctx, name, initialize);
    if (!module) return NULL;
    if (JS_AddModuleExportList(ctx, module, exports, sizeof(exports) / sizeof(exports[0])) < 0)
        return NULL;
    return module;
}
