/* Separate executable: unchanged quickjs.c at commit
 * 7d1c13c5d8f8c6b32893786ed35cdcebd88194d2, VERSION 2026-06-04.
 * Source hashes are checked by scripts/verify_typed_array_codecs.py. */
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>

typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes, failures;
static long remaining = -1;
static int fault(void) {
    if (remaining < 0) return 0;
    if (remaining) { remaining--; return 0; }
    failures++; remaining = -1; return 1;
}
static void *allocate(JSMallocState *s, size_t n) {
    if (!n || fault()) return NULL;
    Header *h = malloc(sizeof(*h) + n);
    if (!h) return NULL;
    h->size = n; live_count++; live_bytes += n;
    s->malloc_count++; s->malloc_size += n; return h + 1;
}
static void release(JSMallocState *s, void *p) {
    if (!p) return;
    Header *h = (Header *)p - 1;
    live_count--; live_bytes -= h->size;
    s->malloc_count--; s->malloc_size -= h->size; free(h);
}
static void *resize(JSMallocState *s, void *p, size_t n) {
    if (!p) return allocate(s, n);
    if (!n) { release(s, p); return NULL; }
    if (fault()) return NULL;
    Header *h = (Header *)p - 1;
    size_t old = h->size;
    Header *r = realloc(h, sizeof(*h) + n);
    if (!r) return NULL;
    r->size = n; live_bytes = live_bytes - old + n;
    s->malloc_size = s->malloc_size - old + n; return r + 1;
}
static size_t usable(const void *p) { return p ? ((const Header *)p - 1)->size : 0; }
static const JSMallocFunctions allocator = { allocate, release, resize, usable };
static JSValue checked(JSValue v) { if (JS_IsException(v)) abort(); return v; }
static void put(JSContext *ctx, JSValue object, JSAtom key, JSValue value) {
    if (JS_DefinePropertyValue(ctx, object, key, value, 7) < 0) abort();
}
static JSValue target;
static unsigned scenario, calls, events;
static JSValue getter(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv, int id) {
    calls++; events = events * 10 + id - 100;
    if (scenario == 16) JS_DetachArrayBuffer(ctx, target);
    else {
        JSValue size = JS_NewInt32(ctx, 2);
        JSValue result = js_array_buffer_resize(ctx, target, 1, &size, JS_CLASS_ARRAY_BUFFER);
        if (JS_IsException(result)) return result;
        JS_FreeValue(ctx, result);
    }
    return JS_UNDEFINED;
}
static void accessor(JSContext *ctx, JSValue options, JSAtom atom, int id) {
    JSValue fn = checked(JS_NewCFunctionMagic(ctx, getter, "codec option", 0, JS_CFUNC_generic_magic, id));
    int result = JS_DefineProperty(ctx, options, atom, JS_UNDEFINED, fn, JS_UNDEFINED,
                                  JS_PROP_HAS_GET | JS_PROP_HAS_CONFIGURABLE | JS_PROP_CONFIGURABLE);
    JS_FreeValue(ctx, fn); if (result < 0) abort();
}
static const char *text(unsigned kind, int hex) {
    if (kind == 9) return "";
    if (kind == 10) return "f";
    if (kind == 11) return "ff00gg";
    if (kind == 12) return "aAbB";
    if (kind == 14) return "\xc3\xa9";
    if (hex) return "666f6f";
    if (kind == 1) return "Zh==";
    if (kind == 2 || kind == 3) return "Zg";
    if (kind == 4) return "Zm9v Zg";
    if (kind == 5) return "Zm9v!";
    if (kind == 6) return "Zg==!";
    if (kind == 7) return "Zg==";
    if (kind == 8) return "Zm8=";
    if (kind == 13) return "-_8=";
    if (kind == 21) return "\tZ m\r9\nv ";
    if (kind == 22) return "Zm9v!";
    if (kind == 23) return "Zg=";
    return "Zm9v";
}
static unsigned error_kind(JSContext *ctx, JSValue e) {
    if (!JS_IsObject(e) || JS_VALUE_GET_OBJ(e)->class_id != JS_CLASS_ERROR) return 99;
    for (unsigned i = 0; i < 9; i++)
        if (JS_VALUE_GET_OBJ(e)->shape->proto == JS_VALUE_GET_OBJ(ctx->native_error_proto[i])) return i;
    return 99;
}
static void word(uint32_t value) {
    for (unsigned i = 0; i < 4; i++) putchar((value >> (8 * i)) & 255);
}
static void isolated(unsigned method, unsigned kind, int armed, size_t cutoff) {
    uint32_t row[16] = {0}; scenario = kind; calls = events = 0;
    JSRuntime *rt = JS_NewRuntime2(&allocator, NULL); if (!rt) abort();
    JSContext *ctx = JS_NewContext(rt); if (!ctx) abort();
    unsigned capacity = 6;
    if (kind == 7 || kind == 8) capacity = 1;
    if (kind == 9) capacity = 0;
    if (kind == 22) capacity = 3;
    uint64_t maximum = 16;
    target = checked(js_array_buffer_constructor1(ctx, JS_UNDEFINED, capacity, &maximum));
    JSValue ctor_args[] = {target, JS_NewInt32(ctx, 0), JS_UNDEFINED};
    JSValue view = checked(js_typed_array_constructor(ctx, JS_UNDEFINED, 3, ctor_args, JS_CLASS_UINT8_ARRAY));
    memset(JS_VALUE_GET_OBJ(target)->u.array_buffer->data, 0xa5, capacity);
    JSValue input = checked(JS_NewString(ctx, text(kind, method & 1)));
    JSValue options = checked(JS_NewObject(ctx));
    JSValue alphabet = JS_UNDEFINED, last = JS_UNDEFINED;
    if (kind == 13) alphabet = checked(JS_NewString(ctx, "base64url"));
    if (kind == 18) alphabet = checked(JS_NewStringLen(ctx, "base64\0junk", 11));
    if (kind == 1 || kind == 3) last = checked(JS_NewString(ctx, "strict"));
    if (kind == 4 || kind == 23) last = checked(JS_NewString(ctx, "stop-before-partial"));
    put(ctx, options, JS_ATOM_alphabet, alphabet);
    put(ctx, options, JS_ATOM_lastChunkHandling, last);
    put(ctx, options, JS_ATOM_omitPadding, JS_NewBool(ctx, kind == 24));
    if (kind == 16 || kind == 17) {
        accessor(ctx, options, JS_ATOM_alphabet, 104);
        accessor(ctx, options, method == 0 ? JS_ATOM_omitPadding : JS_ATOM_lastChunkHandling, 106);
    }
    JSValue supplied = kind == 15 ? JS_NewInt32(ctx, 1) : options;
    JSValue receiver = kind == 19 ? JS_NULL : view;
    JSValue args[] = {kind == 20 ? JS_NewInt32(ctx, 1) : input, supplied};
    if (method < 2) args[0] = supplied;
    static JSCFunction *const functions[] = {js_uint8array_to_base64, js_uint8array_to_hex,
        js_uint8array_set_from_base64, js_uint8array_set_from_hex,
        js_uint8array_from_base64, js_uint8array_from_hex};
    size_t old_failures = failures; remaining = armed ? (long)cutoff : -1;
    JSValue result = functions[method](ctx, receiver, 2, args);
    remaining = -1; row[11] = JS_HasException(ctx); row[12] = failures - old_failures;
    if (JS_IsException(result)) {
        JSValue e = JS_GetException(ctx); row[1] = error_kind(ctx, e); JS_FreeValue(ctx, e);
    } else {
        row[0] = 1;
        if (JS_IsString(result)) {
            size_t n; const char *s = JS_ToCStringLen(ctx, &n, result); if (!s) abort();
            row[2] = n;
            for (size_t i = 0; i < n; i++) row[3] = (row[3] * 31 + (unsigned char)s[i]) & 65535;
            JS_FreeCString(ctx, s);
        } else if (method >= 4) {
            JSObject *p = JS_VALUE_GET_OBJ(result); row[2] = p->u.array.count;
            for (unsigned i = 0; i < row[2]; i++) row[3] = (row[3] * 31 + p->u.array.u.uint8_ptr[i]) & 65535;
        } else {
            JSValue r = checked(JS_GetPropertyStr(ctx, result, "read"));
            JSValue w = checked(JS_GetPropertyStr(ctx, result, "written"));
            if (JS_ToUint32(ctx, &row[4], r) || JS_ToUint32(ctx, &row[5], w)) abort();
            JS_FreeValue(ctx, r); JS_FreeValue(ctx, w);
        }
        JS_FreeValue(ctx, result);
    }
    JSArrayBuffer *b = JS_VALUE_GET_OBJ(target)->u.array_buffer;
    row[6] = b->byte_length; row[10] = b->detached;
    for (unsigned i = 0; i < b->byte_length; i++) row[7] = (row[7] * 31 + b->data[i]) & 65535;
    row[8] = calls; row[9] = events;
    /* JS_ToCStringLen2 retains its flat input at4565, then loses that owner
       on UTF-8 allocation failure at4589-4591/4643. Observe while input lives. */
    int reclaim = armed && cutoff == 0 && method >= 2 && kind == 14 && row[12];
    if (reclaim && (row[0] || !JS_IsString(input) ||
        JS_VALUE_GET_STRING(input)->atom_type ||
        __js_rc(JS_VALUE_GET_PTR(input))->ref_count != 2)) abort();
    JS_FreeValue(ctx, options); JS_FreeValue(ctx, input);
    if (reclaim) {
        if (__js_rc(JS_VALUE_GET_PTR(input))->ref_count != 1) abort();
        size_t blocks = live_count, bytes = live_bytes;
        JS_FreeValue(ctx, input); /* Only the measured, source-lost owner. */
        if (blocks - live_count != 1) abort();
        row[13] = bytes - live_bytes;
        fprintf(stderr, "C UTF-8 source orphan method=%u kind=%u cutoff=%zu: owners=1, bytes=%u; measured before reclaim\n",
                method, kind, cutoff, row[13]);
    }
    JS_FreeValue(ctx, view); JS_FreeValue(ctx, target);
    JS_RunGC(rt); JS_FreeContext(ctx); JS_FreeRuntime(rt);
    row[14] = live_count; row[15] = live_bytes;
    for (unsigned i = 0; i < 16; i++) word(row[i]);
}
int main(int argc, char **argv) {
    if (argc == 5) { isolated(atoi(argv[1]), atoi(argv[2]), atoi(argv[3]), strtoull(argv[4], NULL, 10)); return 0; }
    if (argc != 1) return 2;
    for (unsigned method = 0; method < 6; method++)
        for (unsigned kind = 0; kind < 25; kind++) isolated(method, kind, 0, 0);
    return 0;
}
