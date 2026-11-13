#include "silk_wamr_internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Wasm function frames for JavaScript stack traces, as V8 writes them: each
 * invocation remembers the engine StackFrame it was entered from, and the
 * engine asks for the Wasm frames above that frame. */

static bool code_in(const SilkWasmHandle *module, const uint8_t *code)
{
    const uint8_t *bytes = module->as.module.loaded_bytes;
    return module->kind == SILK_WASM_MODULE && module->as.module.module && bytes
        && code >= bytes && code < bytes + module->as.module.length;
}

/* The module whose code holds function: the invocation's own module first, as a
 * frame usually is, then every module of the store. */
static SilkWasmHandle *frame_module(SilkWasmInvocation *invocation, const WASMFunction *function)
{
    SilkWasmHandle *own = invocation->function->as.function.instance;
    if (own && own->kind == SILK_WASM_INSTANCE && own->as.instance.module
        && code_in(own->as.instance.module, function->code))
        return own->as.instance.module;
    for (SilkWasmHandle *handle = invocation->store->handles; handle; handle = handle->next)
        if (code_in(handle, function->code)) return handle;
    return NULL;
}

static bool read_u32(const uint8_t **p, const uint8_t *end, uint32_t *value)
{
    uint32_t result = 0;
    for (unsigned shift = 0; shift < 35 && *p < end; shift += 7) {
        uint8_t byte = *(*p)++;
        result |= (uint32_t)(byte & 0x7f) << shift;
        if (!(byte & 0x80)) { *value = result; return true; }
    }
    return false;
}

/* The name section's module name (subsection 0), from the original bytes. */
static void module_name(SilkWasmHandle *module)
{
    uint32_t length = 0;
    const uint8_t *p = silk_wasm_custom(module, (const uint8_t *)"name", 4, 0, &length);
    const uint8_t *end = p + length;
    while (p && p < end) {
        uint8_t id = *p++;
        uint32_t size, name_length;
        if (!read_u32(&p, end, &size) || size > (uint32_t)(end - p)) return;
        const uint8_t *next = p + size;
        if (id == 0) {
            if (!read_u32(&p, next, &name_length) || name_length > (uint32_t)(next - p)) return;
            module->as.module.frame_module_name = malloc(name_length ? name_length : 1);
            if (!module->as.module.frame_module_name) return;
            memcpy(module->as.module.frame_module_name, p, name_length);
            module->as.module.frame_module_name_length = name_length;
            return;
        }
        if (id > 0) return;
        p = next;
    }
}

/* V8's script URL for a module compiled without a streaming response URL:
 * wasm://wasm/[name-]hash, hash being the string hash field (seed 0) V8
 * computes over the wire bytes, in hex. */
static void script_url(SilkWasmHandle *module)
{
    const uint8_t *bytes = module->as.module.bytes;
    uint32_t length = module->as.module.length, field;
    if (length > 16383) {
        field = (length << 2) | 2;
    } else {
        uint32_t hash = 0;
        for (uint32_t i = 0; i < length; ++i) {
            hash += bytes[i];
            hash += hash << 10;
            hash ^= hash >> 6;
        }
        hash += hash << 3;
        hash ^= hash >> 11;
        hash += hash << 15;
        hash &= (1u << 30) - 1;
        if (!hash) hash = 27;
        field = (hash << 2) | 2;
    }
    uint32_t name_length = module->as.module.frame_module_name_length;
    size_t size = sizeof("wasm://wasm/-00000000") + name_length;
    char *url = malloc(size);
    if (!url) return;
    int written = name_length
        ? snprintf(url, size, "wasm://wasm/%.*s-%08x", (int)name_length,
                   (const char *)module->as.module.frame_module_name, (unsigned)field)
        : snprintf(url, size, "wasm://wasm/%08x", (unsigned)field);
    module->as.module.frame_url = url;
    module->as.module.frame_url_length = (uint32_t)written;
}

uint8_t silk_wasm_module_set_url(SilkWasmHandle *module, const uint8_t *url, uint32_t length)
{
    if (module->kind != SILK_WASM_MODULE) return 0;
    char *copy = malloc(length ? length : 1);
    if (!copy) return 0;
    memcpy(copy, url, length);
    free(module->as.module.frame_url);
    module->as.module.frame_url = copy;
    module->as.module.frame_url_length = length;
    return 1;
}

void silk_wasm_module_frames_destroy(SilkWasmHandle *module)
{
    free(module->as.module.frame_url);
    free(module->as.module.frame_module_name);
}

static void describe(SilkWasmHandle *module)
{
    if (module->as.module.frame_described) return;
    module->as.module.frame_described = true;
    module_name(module);
    if (!module->as.module.frame_url) script_url(module);
}

int silk_wasm_frame(void *opaque, uintptr_t frame, uint32_t index, SilkWasmFrame *out)
{
    (void)opaque;
    if (!frame) return 0;
    for (SilkWasmStore *store = silk_wasm_thread_stores(); store; store = store->next_thread_store) {
        for (SilkWasmInvocation *invocation = store->invocations; invocation; invocation = invocation->next) {
            if (invocation->frame != frame || !invocation->invocation) continue;
            WASMInterpInvocationFrame entry;
            if (!wasm_interp_invocation_frame(invocation->invocation, index, &entry)) return 0;
            const WASMFunction *function = entry.function->u.func;
            SilkWasmHandle *module = frame_module(invocation, function);
            if (!module) return 0;
            WASMModule *wasm = module->as.module.module;
            uint32_t defined = UINT32_MAX;
            for (uint32_t i = 0; i < wasm->function_count; ++i)
                if (wasm->functions[i] == function) { defined = i; break; }
            if (defined == UINT32_MAX) return 0;
            describe(module);
            memset(out, 0, sizeof(*out));
            out->function_index = wasm->import_function_count + defined;
            out->offset = (uint32_t)(entry.instruction - module->as.module.loaded_bytes);
            out->enclosing = (uint32_t)(function->silk_body - module->as.module.loaded_bytes);
            out->entry = invocation->function;
            out->url = module->as.module.frame_url;
            out->url_length = module->as.module.frame_url ? module->as.module.frame_url_length : 0;
            if (function->field_name && function->silk_field_name_length) {
                out->name = function->field_name;
                out->name_length = function->silk_field_name_length;
            }
            out->module = (const char *)module->as.module.frame_module_name;
            out->module_length = module->as.module.frame_module_name_length;
            return 1;
        }
    }
    return 0;
}
