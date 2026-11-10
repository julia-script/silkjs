#include "silk_wamr_internal.h"
#include "mem_alloc.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static os_thread_local_attribute SilkWasmInvocation *current_invocation;
extern uint64_t silk_wamr_shared_capacity(WASMMemoryInstance *);

static void invocation_error(SilkWasmInvocation *invocation, int kind,
                              const char *message)
{
    invocation->status = kind;
    invocation->error_kind = kind;
    snprintf(invocation->error, sizeof(invocation->error), "%s", message);
}

void silk_wasm_invocation_fail(SilkWasmInvocation *invocation, int kind,
                                const char *message)
{ invocation_error(invocation, kind, message); }

static void copy_store_error(SilkWasmInvocation *invocation)
{
    int kind = invocation->store->error_kind;
    if (kind == SILK_WASM_OK) kind = SILK_WASM_OOM;
    invocation_error(invocation, kind, invocation->store->error);
}

typedef struct Projection {
    SilkWasmStore *store;
    SilkWasmVisitHandle handle;
    SilkWasmVisitReference reference;
    void *context;
} Projection;

static void project_object(void *object, void *context)
{
    Projection *projection = context;
    silk_wasm_visit_object(projection->store, object, projection->handle,
                            projection->reference, projection->context);
}

static void invocation_raw_roots(SilkWasmHandle *roots, SilkWasmVisitHandle handle,
                                  SilkWasmVisitReference reference, void *context)
{
    SilkWasmInvocation *invocation = roots->host;
    Projection projection = { invocation->store, handle, reference, context };
    if (invocation->invocation)
        wasm_interp_invocation_visit_roots(invocation->invocation, project_object, &projection);
}

static bool synchronize(SilkWasmInvocation *invocation)
{
    /* Retain stack roots before releasing an overwritten table/global edge.
     * Nothing here recursively invokes JS; new canonical owners are held in
     * the dispatch's transient creation roots until the operation returns. */
    if (!silk_wasm_sync_edges(&invocation->roots, invocation_raw_roots)
        || !silk_wasm_sync_store_edges(invocation->store)) {
        copy_store_error(invocation);
        return false;
    }
    return true;
}

static void *raise_conversion(SilkWasmInvocation *invocation, WASMExecEnv *env)
{
    SilkWasmStore *store = invocation->store;
    int kind = store->error_kind;
    if (kind != SILK_WASM_TYPE_ERROR && kind != SILK_WASM_RANGE_ERROR) {
        copy_store_error(invocation);
        return NULL;
    }
    char message[sizeof(store->error)];
    memcpy(message, store->error, sizeof(message));
    if (!synchronize(invocation)) return NULL;
    SilkWasmHandle *exception = store->callbacks.raise(store->context, kind, message);
    if (!exception || !silk_wasm_edge_handle(&invocation->roots, exception)) {
        copy_store_error(invocation);
        return NULL;
    }
    return silk_wasm_exception_to_guest(store, env, exception);
}

static bool reserve_values(SilkWasmValue **values, uint32_t *capacity, uint32_t count)
{
    if (count <= *capacity) return true;
    SilkWasmValue *allocation = realloc(*values, (size_t)count * sizeof(**values));
    if (!allocation) return false;
    *values = allocation;
    *capacity = count;
    return true;
}

static int native_call(void *context, WASMExecEnv *env,
                        WASMFunctionInstance *function,
                        const uint32_t *arguments, uint32_t argument_cells,
                        uint32_t *results, uint32_t result_cells,
                        void **exception)
{
    SilkWasmInvocation *invocation = context;
    SilkWasmStore *store = invocation->store;
    WASMFuncType *type = function->u.func_import->func_type;
    SilkWasmImport *binding = function->u.func_import->attachment;
    if (!binding || !binding->callable || argument_cells != type->param_cell_num
        || result_cells != type->ret_cell_num) {
        invocation_error(invocation, SILK_WASM_LINK_ERROR, "Invalid native function binding");
        return -1;
    }
    if (!reserve_values(&invocation->host_arguments, &invocation->host_argument_capacity, type->param_count)
        || !reserve_values(&invocation->host_results, &invocation->host_result_capacity, type->result_count)) {
        invocation_error(invocation, SILK_WASM_OOM, "Out of memory");
        return -1;
    }
    if (!silk_wasm_from_cells(store, env, type->types, type->param_count,
                              arguments, invocation->host_arguments)
        || !synchronize(invocation)) {
        copy_store_error(invocation);
        return -1;
    }
    if (type->result_count)
        memset(invocation->host_results, 0, (size_t)type->result_count * sizeof(SilkWasmValue));
    SilkWasmHandle *thrown = NULL;
    invocation->pending_type = type;
    invocation->pending_module = ((WASMModuleInstance *)env->module_inst)->module;
    SilkWasmHandle *instance = wasm_silk_context((WASMModuleInstance *)env->module_inst);
    const uint8_t *js_types = silk_wasm_js_types(instance->as.instance.module, type);
    if (!js_types) { copy_store_error(invocation); return -1; }
    int status = store->callbacks.call(store->context, invocation, binding->callable,
        (uint8_t)(binding->suspending != 0), js_types, type->param_count,
        invocation->host_arguments, type->result_count,
        invocation->host_results, &thrown);
    if (status == SILK_WASM_YIELD) return 1;
    if (status == SILK_WASM_THROW) {
        if (!thrown || thrown->kind != SILK_WASM_EXCEPTION) {
            invocation_error(invocation, SILK_WASM_RUNTIME_ERROR,
                              "Native callback did not supply its thrown exception");
            return -1;
        }
        if (!silk_wasm_edge_handle(&invocation->roots, thrown)) {
            copy_store_error(invocation);
            return -1;
        }
        *exception = silk_wasm_exception_to_guest(store, env, thrown);
        if (!*exception) { copy_store_error(invocation); return -1; }
        return 2;
    }
    if (status != SILK_WASM_OK) {
        if (invocation->error_kind == SILK_WASM_OK)
            invocation_error(invocation, status, "JavaScript import callback failed");
        return -1;
    }
    if (!silk_wasm_function_to_cells(store, env, invocation->pending_module,
                                     type, true, invocation->host_results, results)) {
        *exception = raise_conversion(invocation, env);
        return *exception ? 2 : -1;
    }
    return 0;
}

static void complete(SilkWasmInvocation *invocation, WASMInterpInvocationStatus status)
{
    if (invocation->error_kind != SILK_WASM_OK) {
        synchronize(invocation);
        return;
    }
    WASMExecEnv *env = wasm_interp_invocation_exec_env(invocation->invocation);
    if (status == WASM_INVOCATION_SUSPENDED) {
        invocation->status = SILK_WASM_YIELD;
        synchronize(invocation);
        return;
    }
    if (status == WASM_INVOCATION_THREW) {
        void *guest = wasm_interp_invocation_exception(invocation->invocation);
        if (guest) {
            invocation->exception = silk_wasm_exception_from_guest(invocation->store, env, guest);
            if (!invocation->exception
                || !silk_wasm_edge_handle(&invocation->roots, invocation->exception)) {
                copy_store_error(invocation);
                return;
            }
            invocation->status = SILK_WASM_THROW;
        } else {
            const char *trap = wasm_interp_invocation_trap(invocation->invocation);
            invocation_error(invocation, SILK_WASM_RUNTIME_ERROR,
                              trap && *trap ? trap : "WebAssembly execution trapped");
        }
        synchronize(invocation);
        return;
    }
    if (status != WASM_INVOCATION_COMPLETED) {
        invocation_error(invocation, SILK_WASM_RUNTIME_ERROR, "WebAssembly invocation was cancelled");
        synchronize(invocation);
        return;
    }
    WASMFuncType *type = invocation->function->as.function.type;
    uint32_t count = 0;
    const uint32_t *cells = wasm_interp_invocation_results(invocation->invocation, &count);
    if (count != type->ret_cell_num) {
        invocation_error(invocation, SILK_WASM_RUNTIME_ERROR, "Incorrect WebAssembly result cell count");
        return;
    }
    invocation->result_count = type->result_count;
    if (type->result_count) {
        invocation->results = calloc(type->result_count, sizeof(SilkWasmValue));
        if (!invocation->results) {
            invocation_error(invocation, SILK_WASM_OOM, "Out of memory");
            return;
        }
    }
    if (!silk_wasm_from_cells(invocation->store, env, type->types + type->param_count,
                              type->result_count, cells, invocation->results)) {
        copy_store_error(invocation);
        return;
    }
    invocation->status = SILK_WASM_OK;
    synchronize(invocation);
}

SilkWasmInvocation *silk_wasm_call(SilkWasmHandle *function,
                                  const SilkWasmValue *arguments,
                                  uint32_t count, uint8_t promising)
{
    SilkWasmStore *store = function->store;
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    WASMFuncType *type = function->as.function.type;
    if (count != type->param_count) {
        silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Incorrect WebAssembly argument count");
        return NULL;
    }
    SilkWasmInvocation *invocation = calloc(1, sizeof(*invocation));
    if (!invocation) { silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory"); return NULL; }
    invocation->store = store;
    invocation->function = function;
    invocation->roots.store = store;
    invocation->roots.kind = UINT32_MAX;
    invocation->roots.host = invocation;
    invocation->next = store->invocations;
    invocation->previous = &store->invocations;
    if (invocation->next) invocation->next->previous = &invocation->next;
    store->invocations = invocation;
    if (!silk_wasm_edge_handle(&invocation->roots, function)) goto failure;
    if (!silk_wasm_reference_context_init(store)) goto failure;
    SilkWasmHandle *owner = function->as.function.instance;
    WASMModuleInstance *native = owner->as.instance.instance;
    invocation->invocation = wasm_interp_invocation_create(native,
        &native->e->functions[function->as.function.index], SILK_WASM_STACK_SIZE,
        native_call, invocation, promising);
    if (!invocation->invocation) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Cannot allocate WebAssembly invocation");
        goto failure;
    }
    WASMExecEnv *env = wasm_interp_invocation_exec_env(invocation->invocation);
    uint32_t *cells = calloc(type->param_cell_num ? type->param_cell_num : 1, sizeof(uint32_t));
    WASMLocalObjectRef *roots = calloc(count ? count : 1, sizeof(*roots));
    if (!cells || !roots) {
        free(cells); free(roots);
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        goto failure;
    }
    if (!silk_wasm_function_to_cells(store, env, native->module, type, false, arguments, cells)) {
        free(cells); free(roots);
        goto failure;
    }
    uint32_t root_count = silk_wasm_pin_cells(env, type->types, count, cells, roots);
    SilkWasmInvocation *previous_invocation = current_invocation;
    current_invocation = invocation;
    WASMInterpInvocationStatus status = wasm_interp_invocation_start(invocation->invocation,
                                                                     cells, type->param_cell_num);
    current_invocation = previous_invocation;
    mem_allocator_enable_gc_reclaim(store->gc_heap, store->reference_exec_env);
    if (root_count) wasm_runtime_pop_local_obj_refs(env, root_count);
    free(roots); free(cells);
    complete(invocation, status);
    return invocation;
failure:
    silk_wasm_invocation_free(invocation);
    return NULL;
}

int silk_wasm_resume(SilkWasmInvocation *invocation, const SilkWasmValue *values,
                     uint32_t count, SilkWasmHandle *exception)
{
    if (invocation->status != SILK_WASM_YIELD || !invocation->pending_type) {
        invocation_error(invocation, SILK_WASM_RUNTIME_ERROR, "WebAssembly invocation is not suspended");
        return invocation->status;
    }
    WASMFuncType *type = invocation->pending_type;
    WASMExecEnv *env = wasm_interp_invocation_exec_env(invocation->invocation);
    void *guest_exception = NULL;
    uint32_t *cells = NULL;
    WASMLocalObjectRef *roots = NULL;
    uint32_t root_count = 0;
    if (exception) {
        if (!silk_wasm_edge_handle(&invocation->roots, exception)) goto failure;
        guest_exception = silk_wasm_exception_to_guest(invocation->store, env, exception);
        if (!guest_exception) goto failure;
    } else {
        if (count != type->result_count) {
            silk_wasm_set_error(invocation->store, SILK_WASM_TYPE_ERROR, "Incorrect resumed WebAssembly result count");
            guest_exception = raise_conversion(invocation, env);
            if (!guest_exception) goto failure;
        }
        if (!guest_exception) {
            cells = calloc(type->ret_cell_num ? type->ret_cell_num : 1, sizeof(uint32_t));
            roots = calloc(count ? count : 1, sizeof(*roots));
            if (!cells || !roots) {
                silk_wasm_set_error(invocation->store, SILK_WASM_OOM, "Out of memory");
                goto failure;
            }
            if (!silk_wasm_function_to_cells(invocation->store, env, invocation->pending_module,
                                             type, true, values, cells)) {
                guest_exception = raise_conversion(invocation, env);
                if (!guest_exception) goto failure;
            } else {
                root_count = silk_wasm_pin_cells(env, type->types + type->param_count, count, cells, roots);
            }
        }
    }
    invocation->status = SILK_WASM_OK;
    SilkWasmInvocation *previous_invocation = current_invocation;
    current_invocation = invocation;
    WASMInterpInvocationStatus status = wasm_interp_invocation_resume(invocation->invocation,
        cells, guest_exception ? 0 : type->ret_cell_num, guest_exception);
    current_invocation = previous_invocation;
    mem_allocator_enable_gc_reclaim(invocation->store->gc_heap, invocation->store->reference_exec_env);
    if (root_count) wasm_runtime_pop_local_obj_refs(env, root_count);
    free(roots); free(cells);
    complete(invocation, status);
    return invocation->status;
failure:
    free(roots); free(cells);
    copy_store_error(invocation);
    return invocation->status;
}

int silk_wasm_invocation_status(SilkWasmInvocation *invocation) { return invocation->status; }
int silk_wasm_invocation_error_kind(SilkWasmInvocation *invocation) { return invocation->error_kind; }
const char *silk_wasm_invocation_error(SilkWasmInvocation *invocation) { return invocation->error; }
const SilkWasmValue *silk_wasm_results(SilkWasmInvocation *invocation, uint32_t *count)
{ *count = invocation->result_count; return invocation->results; }
SilkWasmHandle *silk_wasm_thrown(SilkWasmInvocation *invocation) { return invocation->exception; }
void *silk_wasm_invocation_host(SilkWasmInvocation *invocation) { return invocation->host; }
void silk_wasm_invocation_set_host(SilkWasmInvocation *invocation, void *host) { invocation->host = host; }
uint8_t silk_wasm_suspension_allowed(SilkWasmInvocation *invocation)
{ return wasm_interp_invocation_suspension_allowed(wasm_interp_invocation_exec_env(invocation->invocation)); }

void silk_wasm_invocation_visit(SilkWasmInvocation *invocation, SilkWasmVisitHandle handle,
                                SilkWasmVisitReference reference, void *context)
{ silk_wasm_visit(&invocation->roots, handle, reference, context); }

void silk_wasm_invocation_free(SilkWasmInvocation *invocation)
{
    if (!invocation) return;
    *invocation->previous = invocation->next;
    if (invocation->next) invocation->next->previous = invocation->previous;
    if (invocation->store->reference_exec_env)
        mem_allocator_enable_gc_reclaim(invocation->store->gc_heap, invocation->store->reference_exec_env);
    if (invocation->invocation) wasm_interp_invocation_free(invocation->invocation);
    silk_wasm_clear_reference_edges(&invocation->roots);
    silk_wasm_clear_edges(&invocation->roots);
    free(invocation->host_arguments);
    free(invocation->host_results);
    free(invocation->results);
    free(invocation);
}

typedef struct RootCollector { void *heap; bool ok; } RootCollector;
static void collect_root(void *object, void *context)
{
    RootCollector *collector = context;
    if (object && mem_allocator_contains_gc_object(collector->heap, object)
        && mem_allocator_add_root(collector->heap, object) != 0) collector->ok = false;
}
bool silk_wasm_invocation_roots(SilkWasmStore *store, void *heap)
{
    RootCollector collector = { heap, true };
    for (SilkWasmInvocation *invocation = store->invocations; invocation; invocation = invocation->next)
        if (invocation->invocation)
            wasm_interp_invocation_visit_roots(invocation->invocation, collect_root, &collector);
    return collector.ok;
}

uint32_t silk_wamr_shared_wait(WASMMemoryInstance *memory, void *address,
                               uint64_t expected, int64_t timeout_ns, bool is_i64)
{
    SilkWasmInvocation *invocation = current_invocation;
    if (!invocation) return UINT32_MAX;
    SilkWasmStore *store = invocation->store;
    uint64_t offset = (uint64_t)((uintptr_t)address - (uintptr_t)memory->memory_data);
    uint32_t result = store->callbacks.shared_wait(store->context, memory->memory_data,
        silk_wamr_shared_capacity(memory), offset, expected, timeout_ns, (uint8_t)is_i64);
    if (result == UINT32_MAX) {
        WASMExecEnv *env = wasm_interp_invocation_exec_env(invocation->invocation);
        wasm_set_exception((WASMModuleInstance *)env->module_inst, "WebAssembly atomic wait was cancelled");
    }
    return result;
}

uint32_t silk_wamr_shared_notify(WASMMemoryInstance *memory, void *address, uint32_t count)
{
    SilkWasmInvocation *invocation = current_invocation;
    if (!invocation) return UINT32_MAX;
    (void)memory;
    return invocation->store->callbacks.shared_notify(invocation->store->context, address, count);
}
