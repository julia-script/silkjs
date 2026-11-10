#include "silk_wamr_internal.h"
#include "wasm_export.h"
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static os_thread_local_attribute SilkWasmStore *thread_stores;
static pthread_once_t exception_hooks_once = PTHREAD_ONCE_INIT;

static void initialize_exception_hooks(void)
{ wasm_silk_set_exception_hooks(&silk_wasm_exception_hooks); }

SilkWasmStore *silk_wasm_thread_stores(void) { return thread_stores; }

void silk_wasm_set_error(SilkWasmStore *store, int kind, const char *message)
{
    store->error_kind = kind;
    snprintf(store->error, sizeof(store->error), "%s", message ? message : "");
}

SilkWasmStore *silk_wasm_open(const SilkWasmCallbacks *callbacks, void *context)
{
    RuntimeInitArgs args = { 0 };
    SilkWasmStore *store = calloc(1, sizeof(*store));
    if (!store) return NULL;
    args.mem_alloc_type = Alloc_With_System_Allocator;
    args.running_mode = Mode_Interp;
    if (!wasm_runtime_full_init(&args)) { free(store); return NULL; }
    store->callbacks = *callbacks;
    store->context = context;
    store->next_thread_store = thread_stores;
    store->previous_thread_store = &thread_stores;
    if (thread_stores) thread_stores->previous_thread_store = &store->next_thread_store;
    thread_stores = store;
    pthread_once(&exception_hooks_once, initialize_exception_hooks);
    return store;
}

static void store_destroy(SilkWasmStore *store)
{
    *store->previous_thread_store = store->next_thread_store;
    if (store->next_thread_store)
        store->next_thread_store->previous_thread_store = store->previous_thread_store;
    silk_wasm_reference_context_destroy(store);
    wasm_runtime_destroy();
    free(store);
}

void silk_wasm_close(SilkWasmStore *store)
{
    if (!store || store->closed) return;
    store->closed = true;
    if (!store->handle_count) store_destroy(store);
}

int silk_wasm_error_kind(const SilkWasmStore *store) { return store->error_kind; }
const char *silk_wasm_error(const SilkWasmStore *store) { return store->error; }
uint32_t silk_wasm_kind(const SilkWasmHandle *handle) { return handle->kind; }
void *silk_wasm_get_host(const SilkWasmHandle *handle) { return handle->host; }
void silk_wasm_set_host(SilkWasmHandle *handle, void *host) { handle->host = host; }

SilkWasmHandle *silk_wasm_new_handle(SilkWasmStore *store, uint32_t kind)
{
    if (store->closed) {
        silk_wasm_set_error(store, SILK_WASM_RUNTIME_ERROR, "WebAssembly realm is closed");
        return NULL;
    }
    SilkWasmHandle *handle = calloc(1, sizeof(*handle));
    if (!handle) { silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory"); return NULL; }
    handle->store = store;
    handle->kind = kind;
    handle->next = store->handles;
    handle->previous = &store->handles;
    if (handle->next) handle->next->previous = &handle->next;
    store->handles = handle;
    ++store->handle_count;
    return handle;
}

bool silk_wasm_publish(SilkWasmHandle *handle)
{
    if (handle->published) return true;
    if (!handle->store->callbacks.handle_created(handle->store->context, handle)) {
        silk_wasm_set_error(handle->store, SILK_WASM_OOM, "Cannot allocate WebAssembly owner");
        return false;
    }
    handle->published = true;
    return true;
}

static void destroy_shell(SilkWasmHandle *handle);

static bool edge_add(SilkWasmHandle *owner, SilkWasmHandle *handle, void *reference)
{
    if (!handle && !reference) return true;
    if (owner->edge_count == owner->edge_capacity) {
        size_t capacity = owner->edge_capacity ? owner->edge_capacity * 2 : 4;
        if (capacity < owner->edge_capacity || capacity > SIZE_MAX / sizeof(SilkWasmEdge)) {
            silk_wasm_set_error(owner->store, SILK_WASM_OOM, "Native owner graph is too large");
            return false;
        }
        SilkWasmEdge *edges = realloc(owner->edges, capacity * sizeof(*edges));
        if (!edges) { silk_wasm_set_error(owner->store, SILK_WASM_OOM, "Out of memory"); return false; }
        owner->edges = edges;
        owner->edge_capacity = capacity;
    }
    if (handle && !silk_wasm_publish(handle)) return false;
    SilkWasmStore *store = owner->store;
    if (handle) {
        ++handle->incoming_edges;
        store->callbacks.retain_handle(store->context, handle);
    }
    else store->callbacks.retain_reference(store->context, reference);
    owner->edges[owner->edge_count++] = (SilkWasmEdge){ handle, reference };
    return true;
}
bool silk_wasm_edge_handle(SilkWasmHandle *owner, SilkWasmHandle *value)
{ return edge_add(owner, value, NULL); }
bool silk_wasm_edge_reference(SilkWasmHandle *owner, void *value)
{ return edge_add(owner, NULL, value); }

void silk_wasm_clear_edges(SilkWasmHandle *owner)
{
    SilkWasmEdge *edges = owner->edges;
    size_t count = owner->edge_count;
    owner->edges = NULL;
    owner->edge_count = owner->edge_capacity = 0;
    for (size_t i = 0; i < count; ++i) {
        if (edges[i].handle) {
            SilkWasmHandle *target = edges[i].handle;
            owner->store->callbacks.release_handle(owner->store->context, target);
            if (--target->incoming_edges == 0 && target->finalized)
                destroy_shell(target);
        } else
            owner->store->callbacks.release_reference(owner->store->context, edges[i].reference);
    }
    free(edges);
}

void silk_wasm_visit(SilkWasmHandle *owner, SilkWasmVisitHandle handle,
                     SilkWasmVisitReference reference, void *context)
{
    for (size_t i = 0; i < owner->edge_count; ++i) {
        if (owner->edges[i].handle) handle(context, owner->edges[i].handle);
        else reference(context, owner->edges[i].reference);
    }
    for (size_t i = 0; i < owner->reference_edge_count; ++i) {
        if (owner->reference_edges[i].handle) handle(context, owner->reference_edges[i].handle);
        else reference(context, owner->reference_edges[i].reference);
    }
}

static void destroy_shell(SilkWasmHandle *handle)
{
    SilkWasmStore *store = handle->store;
    *handle->previous = handle->next;
    if (handle->next) handle->next->previous = handle->previous;
    if (handle->kind == SILK_WASM_MODULE) {
        silk_wasm_compile_options_destroy(handle);
        silk_wasm_js_types_destroy(handle);
        if (handle->as.module.module) wasm_unload(handle->as.module.module);
        free(handle->as.module.bytes);
        free(handle->as.module.loaded_bytes);
    }
    free(handle);
    if (--store->handle_count == 0 && store->closed) store_destroy(store);
}

void silk_wasm_free(SilkWasmHandle *handle)
{
    if (!handle || handle->finalized) return;
    handle->host = NULL;
    handle->finalized = true;
    /* Pin the shell across recursive edge release. Native payload teardown
     * occurs while its module and imports are still retained. Module payloads
     * are separately kept until every incoming native owner edge disappears. */
    ++handle->incoming_edges;
    if (handle->kind != SILK_WASM_MODULE) silk_wasm_destroy_resource(handle);
    silk_wasm_clear_reference_edges(handle);
    silk_wasm_clear_edges(handle);
    if (--handle->incoming_edges == 0) destroy_shell(handle);
}

SilkWasmHandle *silk_wasm_compile(SilkWasmStore *store, const uint8_t *bytes,
                                 uint64_t length, const SilkWasmCompileOptions *options)
{
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    store->last_exception = NULL;
    if (length > UINT32_MAX) {
        silk_wasm_set_error(store, SILK_WASM_COMPILE_ERROR, "WebAssembly binary exceeds implementation limit");
        return NULL;
    }
    SilkWasmHandle *handle = silk_wasm_new_handle(store, SILK_WASM_MODULE);
    if (!handle) return NULL;
    handle->as.module.bytes = malloc(length ? (size_t)length : 1);
    handle->as.module.loaded_bytes = malloc(length ? (size_t)length : 1);
    if (!handle->as.module.bytes || !handle->as.module.loaded_bytes) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        silk_wasm_free(handle);
        return NULL;
    }
    if (length) memcpy(handle->as.module.bytes, bytes, (size_t)length);
    if (length) memcpy(handle->as.module.loaded_bytes, bytes, (size_t)length);
    handle->as.module.length = (uint32_t)length;
    LoadArgs args = { 0 };
    args.no_resolve = true;
    handle->as.module.module = wasm_load(handle->as.module.loaded_bytes, (uint32_t)length,
#if WASM_ENABLE_MULTI_MODULE != 0
                                         true,
#endif
                                         &args, store->error, sizeof(store->error));
    if (!handle->as.module.module) {
        store->error_kind = SILK_WASM_COMPILE_ERROR;
        silk_wasm_free(handle);
        return NULL;
    }
    if (!silk_wasm_compile_options_init(handle, options)) {
        silk_wasm_free(handle);
        return NULL;
    }
    if (!silk_wasm_publish(handle)) { silk_wasm_free(handle); return NULL; }
    return handle;
}

const uint8_t *silk_wasm_module_bytes(SilkWasmHandle *handle, uint64_t *length)
{ *length = handle->as.module.length; return handle->as.module.bytes; }
uint32_t silk_wasm_import_count(const SilkWasmHandle *handle)
{ return handle->as.module.module->import_count; }
uint32_t silk_wasm_export_count(const SilkWasmHandle *handle)
{ return (handle->kind == SILK_WASM_INSTANCE
    ? handle->as.instance.module->as.module.module
    : handle->as.module.module)->export_count; }

WASMFuncType *silk_wasm_function_signature(WASMModule *module, uint32_t index)
{
    return index < module->import_function_count
        ? module->import_functions[index].u.function.func_type
        : module->functions[index - module->import_function_count]->func_type;
}

static bool signature_info(SilkWasmHandle *module, SilkWasmTypeInfo *info, WASMFuncType *type)
{
    info->parameter_count = type->param_count;
    info->result_count = type->result_count;
    info->types = silk_wasm_js_types(module, type);
    return info->types != NULL;
}

bool silk_wasm_type_info(const SilkWasmHandle *owner, uint8_t kind, uint32_t index,
                         SilkWasmTypeInfo *info)
{
    WASMModule *module = owner->as.module.module;
    memset(info, 0, sizeof(*info));
    switch (kind) {
    case IMPORT_KIND_FUNC:
        info->kind = SILK_WASM_FUNCTION;
        return signature_info((SilkWasmHandle *)owner, info,
                              silk_wasm_function_signature(module, index));
    case IMPORT_KIND_MEMORY: {
        WASMMemoryType *type = index < module->import_memory_count
            ? &module->import_memories[index].u.memory.mem_type
            : &module->memories[index - module->import_memory_count];
        info->kind = SILK_WASM_MEMORY;
        info->minimum = type->init_page_count;
        info->maximum = type->max_page_count;
        info->has_maximum = (type->flags & 1) != 0;
        info->shared = (type->flags & 2) != 0;
        info->address64 = (type->flags & 4) != 0;
        return true;
    }
    case IMPORT_KIND_TABLE: {
        WASMTableType *type = index < module->import_table_count
            ? &module->import_tables[index].u.table.table_type
            : &module->tables[index - module->import_table_count].table_type;
        info->kind = SILK_WASM_TABLE;
        info->value_type = silk_wasm_js_type(module, type->elem_type, type->elem_ref_type);
        info->minimum = type->init_size;
        info->maximum = type->silk_declared_maximum;
        info->has_maximum = (type->flags & 1) != 0;
        info->address64 = (type->flags & 4) != 0;
        return true;
    }
    case IMPORT_KIND_GLOBAL: {
        WASMGlobalType *type = index < module->import_global_count
            ? &module->import_globals[index].u.global.type
            : &module->globals[index - module->import_global_count].type;
        info->kind = SILK_WASM_GLOBAL;
        const WASMRefType *reference = index < module->import_global_count
            ? module->import_globals[index].u.global.ref_type
            : module->globals[index - module->import_global_count].ref_type;
        info->value_type = silk_wasm_js_type(module, type->val_type, reference);
        info->mutable_ = type->is_mutable;
        return true;
    }
    case IMPORT_KIND_TAG:
        info->kind = SILK_WASM_TAG;
        return signature_info((SilkWasmHandle *)owner, info, index < module->import_tag_count
            ? module->import_tags[index].u.tag.tag_type
            : module->tags[index - module->import_tag_count]->tag_type);
    default: return false;
    }
}

uint8_t silk_wasm_function_type(SilkWasmHandle *handle, SilkWasmTypeInfo *type)
{
    if (handle->kind != SILK_WASM_FUNCTION) return false;
    memset(type, 0, sizeof(*type));
    type->kind = SILK_WASM_FUNCTION;
    return signature_info(handle->as.function.instance->as.instance.module,
                          type, handle->as.function.type);
}

