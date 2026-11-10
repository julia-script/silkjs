#include "silk_wamr_internal.h"
#include "silk_wamr_types.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>


static WASMImport *import_at(WASMModule *module, uint32_t index)
{
    for (uint32_t i = 0; i < module->import_count; ++i)
        if (module->imports[i].silk_original_index == index) return &module->imports[i];
    return NULL;
}

uint8_t silk_wasm_type(SilkWasmHandle *handle, SilkWasmTypeInfo *info)
{
    memset(info, 0, sizeof(*info));
    info->kind = handle->kind;
    if (handle->kind == SILK_WASM_FUNCTION) return silk_wasm_function_type(handle, info);
    if (handle->kind == SILK_WASM_TAG) {
        info->parameter_count = handle->as.tag.type->param_count;
        info->result_count = handle->as.tag.type->result_count;
        info->types = silk_wasm_tag_types(handle);
        return true;
    }
    return silk_wasm_resource_type(handle, info);
}

uint8_t silk_wasm_check_import(SilkWasmHandle *module_handle, uint32_t index,
                            const SilkWasmImport *value)
{
    SilkWasmStore *store = module_handle->store;
    WASMModule *module = module_handle->as.module.module;
    WASMImport *import = import_at(module, index);
    SilkWasmTypeInfo expected, actual;
    const char *unused_module, *unused_name;
    uint32_t unused_module_length, unused_name_length;
    if (!import || !silk_wasm_import_info(module_handle, index, &unused_module,
                                          &unused_module_length, &unused_name,
                                          &unused_name_length, &expected)) return false;
    if (!value->handle) {
        if (expected.kind == SILK_WASM_FUNCTION && value->callable) return true;
        if (expected.kind == SILK_WASM_GLOBAL && !expected.mutable_) {
            if (silk_wasm_value_matches(store, module, import->u.global.type.val_type,
                                        import->u.global.ref_type, &value->value)) return true;
            goto mismatch;
        }
        silk_wasm_set_error(store, SILK_WASM_LINK_ERROR,
                            "WebAssembly import does not have the required type");
        return false;
    }
    SilkWasmHandle *handle = value->handle;
    if (handle->store != store || handle->finalized || handle->kind != expected.kind
        || !silk_wasm_type(handle, &actual)) goto mismatch;
    switch (expected.kind) {
    case SILK_WASM_FUNCTION: {
        SilkWasmHandle *owner = handle->as.function.instance;
        WASMModule *actual_module = owner->as.instance.module->as.module.module;
        if (!wasm_silk_func_type_matches(module, import->u.function.func_type,
                                         actual_module, handle->as.function.type)) goto mismatch;
        return true;
    }
    case SILK_WASM_MEMORY:
    case SILK_WASM_TABLE:
        if (actual.minimum < expected.minimum || actual.shared != expected.shared
            || actual.address64 != expected.address64
            || (expected.has_maximum && (!actual.has_maximum
                || actual.maximum > expected.maximum))) goto mismatch;
        if (expected.kind == SILK_WASM_TABLE) {
            WASMTableType *decl = &import->u.table.table_type;
            WASMTableInstance *table = handle->as.table.table;
            if (!wasm_silk_reftype_matches(module, decl->elem_type, decl->elem_ref_type,
                    handle->as.table.type_module, table->elem_type, table->elem_ref_type.elem_ref_type)
                || !wasm_silk_reftype_matches(handle->as.table.type_module,
                    table->elem_type, table->elem_ref_type.elem_ref_type,
                    module, decl->elem_type, decl->elem_ref_type)) goto mismatch;
        }
        return true;
    case SILK_WASM_GLOBAL:
        if (actual.mutable_ != expected.mutable_) goto mismatch;
        if (wasm_is_type_reftype(import->u.global.type.val_type)) {
            if (!wasm_silk_reftype_matches(module, import->u.global.type.val_type,
                    import->u.global.ref_type, handle->as.global.type_module,
                    (uint8_t)handle->as.global.type, handle->as.global.ref_type)) goto mismatch;
            if (expected.mutable_ && !wasm_silk_reftype_matches(handle->as.global.type_module,
                    (uint8_t)handle->as.global.type, handle->as.global.ref_type,
                    module, import->u.global.type.val_type, import->u.global.ref_type)) goto mismatch;
        } else if (handle->as.global.type != import->u.global.type.val_type) goto mismatch;
        return true;
    case SILK_WASM_TAG:
        if (!wasm_silk_func_type_matches(module, import->u.tag.tag_type,
                handle->as.tag.type_module, handle->as.tag.type)
            || !wasm_silk_func_type_matches(handle->as.tag.type_module,
                handle->as.tag.type, module, import->u.tag.tag_type)) goto mismatch;
        return true;
    default: break;
    }
mismatch:
    silk_wasm_set_error(store, SILK_WASM_LINK_ERROR,
                        "WebAssembly import type is incompatible with its declaration");
    return false;
}

static bool allocate_vectors(SilkWasmHandle *handle)
{
    WASMModule *module = handle->as.instance.module->as.module.module;
    handle->as.instance.function_count = module->import_function_count + module->function_count;
    handle->as.instance.memory_count = module->import_memory_count + module->memory_count;
    handle->as.instance.table_count = module->import_table_count + module->table_count;
    handle->as.instance.global_count = module->import_global_count + module->global_count;
    handle->as.instance.tag_count = module->import_tag_count + module->tag_count;
#define ALLOCATE_VECTOR(field, count, type) \
    do { if ((count) && !(handle->as.instance.field = calloc((count), sizeof(type)))) return false; } while (0)
    ALLOCATE_VECTOR(functions, handle->as.instance.function_count, SilkWasmHandle *);
    ALLOCATE_VECTOR(memories, handle->as.instance.memory_count, SilkWasmHandle *);
    ALLOCATE_VECTOR(tables, handle->as.instance.table_count, SilkWasmHandle *);
    ALLOCATE_VECTOR(globals, handle->as.instance.global_count, SilkWasmHandle *);
    ALLOCATE_VECTOR(tags, handle->as.instance.tag_count, SilkWasmHandle *);
    ALLOCATE_VECTOR(function_imports, module->import_function_count, WASMFunctionImport);
#undef ALLOCATE_VECTOR
    return true;
}

SilkWasmHandle *silk_wasm_instance_function(SilkWasmHandle *instance, uint32_t index)
{
    if (index >= instance->as.instance.function_count) return NULL;
    SilkWasmHandle *function = instance->as.instance.functions[index];
    if (function) return function;
    WASMModule *module = instance->as.instance.module->as.module.module;
    if (index < module->import_function_count) {
        uint32_t original = module->import_functions[index].silk_original_index;
        SilkWasmHandle *imported = instance->as.instance.imports[original].handle;
        if (imported) {
            instance->as.instance.functions[index] = imported;
            return imported;
        }
    }
    function = silk_wasm_new_handle(instance->store, SILK_WASM_FUNCTION);
    if (!function) return NULL;
    function->as.function.instance = instance;
    function->as.function.index = index;
    function->as.function.type = silk_wasm_function_signature(module, index);
    if (!silk_wasm_edge_handle(function, instance)) {
        silk_wasm_free(function);
        return NULL;
    }
    if (!silk_wasm_publish(function)) { silk_wasm_free(function); return NULL; }
    if (!silk_wasm_edge_handle(instance, function)) return NULL;
    instance->as.instance.functions[index] = function;
    return function;
}

/* Every imported function has an instance-local import descriptor. The
 * continuation interpreter intercepts the descriptor and calls the host bridge
 * directly; no mutable link state is installed on the shared compiled module. */
bool silk_wasm_bind_function(WASMModuleInstance *native, uint32_t index,
                             WASMFunctionInstance *function)
{
    SilkWasmHandle *instance = wasm_silk_context(native);
    instance->as.instance.instance = native;
    WASMModule *module = instance->as.instance.module->as.module.module;
    WASMImport *declaration = &module->import_functions[index];
    SilkWasmImport *binding = &instance->as.instance.imports[declaration->silk_original_index];
    WASMFunctionImport *local = &instance->as.instance.function_imports[index];
    *local = declaration->u.function;
    local->attachment = binding;
    function->u.func_import = local;
    if (binding->handle) {
        SilkWasmHandle *target = binding->handle;
        SilkWasmHandle *target_instance = target->as.function.instance;
        function->import_module_inst = target_instance->as.instance.instance;
        function->import_func_inst = &target_instance->as.instance.instance->e->functions[target->as.function.index];
    }
    return true;
}

SilkWasmHandle *silk_wasm_instantiate(SilkWasmHandle *module,
                                     const SilkWasmImport *imports, uint32_t count)
{
    SilkWasmStore *store = module->store;
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    store->last_exception = NULL;
    if (count != module->as.module.module->import_count) {
        silk_wasm_set_error(store, SILK_WASM_LINK_ERROR, "Incorrect number of WebAssembly imports");
        return NULL;
    }
    for (uint32_t i = 0; i < count; ++i)
        if (!silk_wasm_check_import(module, i, &imports[i])) return NULL;
    SilkWasmHandle *instance = silk_wasm_new_handle(store, SILK_WASM_INSTANCE);
    if (!instance) return NULL;
    instance->as.instance.module = module;
    if (!silk_wasm_edge_handle(instance, module)) { silk_wasm_free(instance); return NULL; }
    if (!allocate_vectors(instance)) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        silk_wasm_free(instance);
        return NULL;
    }
    if (count) {
        instance->as.instance.imports = malloc((size_t)count * sizeof(*imports));
        if (!instance->as.instance.imports) {
            silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
            silk_wasm_free(instance);
            return NULL;
        }
        memcpy(instance->as.instance.imports, imports, (size_t)count * sizeof(*imports));
    }
    instance->as.instance.import_count = count;
    for (uint32_t i = 0; i < count; ++i) {
        if (imports[i].handle && !silk_wasm_edge_handle(instance, imports[i].handle)) goto unpublished_failure;
        if (imports[i].callable && !silk_wasm_edge_reference(instance, imports[i].callable)) goto unpublished_failure;
        WASMImport *declaration = import_at(module->as.module.module, i);
        if (!imports[i].handle && declaration->kind == IMPORT_KIND_GLOBAL
            && !silk_wasm_value_edge(instance, declaration->u.global.type.val_type, &imports[i].value))
            goto unpublished_failure;
    }
    if (!silk_wasm_publish(instance)) goto unpublished_failure;
    instance->as.instance.instance = wasm_silk_instantiate(module->as.module.module,
        SILK_WASM_STACK_SIZE, &silk_wasm_resource_hooks, instance,
        store->error, sizeof(store->error));
    if (!instance->as.instance.instance) {
        if (!store->error_kind) store->error_kind = SILK_WASM_RUNTIME_ERROR;
        return NULL;
    }
    for (uint32_t i = 0; i < instance->as.instance.function_count; ++i)
        if (!silk_wasm_instance_function(instance, i)) return NULL;
    for (uint32_t i = 0; i < instance->as.instance.tag_count; ++i)
        if (!wasm_silk_tag_identity(instance->as.instance.instance, i)) return NULL;
    uint32_t start = module->as.module.module->start_function;
    if (start != UINT32_MAX) {
        SilkWasmInvocation *invocation = silk_wasm_call(instance->as.instance.functions[start], NULL, 0, false);
        if (!invocation) return NULL;
        int status = silk_wasm_invocation_status(invocation);
        if (status != SILK_WASM_OK) {
            SilkWasmHandle *exception = silk_wasm_thrown(invocation);
            if (exception) {
                if (!silk_wasm_edge_handle(instance, exception)) {
                    silk_wasm_invocation_free(invocation);
                    return NULL;
                }
                store->last_exception = exception;
                silk_wasm_set_error(store, SILK_WASM_THROW, "WebAssembly start function threw");
            } else silk_wasm_set_error(store, silk_wasm_invocation_error_kind(invocation),
                                      silk_wasm_invocation_error(invocation));
            silk_wasm_invocation_free(invocation);
            return NULL;
        }
        silk_wasm_invocation_free(invocation);
    }
    return instance;
unpublished_failure:
    silk_wasm_free(instance);
    return NULL;
}

SilkWasmHandle *silk_wasm_export(SilkWasmHandle *instance, uint32_t index)
{
    WASMModule *module = instance->as.instance.module->as.module.module;
    if (index >= module->export_count) return NULL;
    WASMExport *export = &module->exports[index];
    switch (export->kind) {
    case IMPORT_KIND_FUNC: return silk_wasm_instance_function(instance, export->index);
    case IMPORT_KIND_MEMORY: return instance->as.instance.memories[export->index];
    case IMPORT_KIND_TABLE: return instance->as.instance.tables[export->index];
    case IMPORT_KIND_GLOBAL: return instance->as.instance.globals[export->index];
    case IMPORT_KIND_TAG: return instance->as.instance.tags[export->index];
    default: return NULL;
    }
}

SilkWasmHandle *silk_wasm_last_exception(SilkWasmStore *store)
{ return store->last_exception; }

SilkWasmHandle *silk_wasm_promising(SilkWasmHandle *function)
{
    if (function->kind != SILK_WASM_FUNCTION || function->finalized) return NULL;
    SilkWasmHandle *alias = silk_wasm_new_handle(function->store, SILK_WASM_FUNCTION);
    if (!alias) return NULL;
    alias->as.function.instance = function->as.function.instance;
    alias->as.function.index = function->as.function.index;
    alias->as.function.type = function->as.function.type;
    alias->as.function.promising = true;
    alias->as.function.source = function->as.function.source
        ? function->as.function.source : function;
    if (!silk_wasm_edge_handle(alias, function)) { silk_wasm_free(alias); return NULL; }
    if (!silk_wasm_publish(alias)) { silk_wasm_free(alias); return NULL; }
    uint8_t type = SILK_WASM_FUNCREF;
    SilkWasmValue value = { .ref = alias, .ref_kind = SILK_WASM_REF_HANDLE };
    uint32_t cells[sizeof(void *) / sizeof(uint32_t)];
    if (!silk_wasm_to_cells(function->store, NULL, &type, 1, &value, cells)) return NULL;
    return alias;
}

uint8_t silk_wasm_function_promising(SilkWasmHandle *function)
{ return function->kind == SILK_WASM_FUNCTION && function->as.function.promising; }

SilkWasmHandle *silk_wasm_function_source(SilkWasmHandle *function)
{ return function->as.function.source ? function->as.function.source : function; }

void silk_wasm_destroy_resource(SilkWasmHandle *handle)
{
    switch (handle->kind) {
    case SILK_WASM_INSTANCE: {
        WASMModuleInstance *instance = handle->as.instance.instance;
        handle->as.instance.instance = NULL;
        if (instance) wasm_deinstantiate(instance, false);
        free(handle->as.instance.imports);
        free(handle->as.instance.function_imports);
        free(handle->as.instance.functions);
        free(handle->as.instance.memories);
        free(handle->as.instance.tables);
        free(handle->as.instance.globals);
        free(handle->as.instance.tags);
        break;
    }
    case SILK_WASM_MEMORY:
    case SILK_WASM_TABLE:
    case SILK_WASM_GLOBAL:
        silk_wasm_resource_destroy(handle);
        break;
    case SILK_WASM_TAG:
    case SILK_WASM_EXCEPTION:
        silk_wasm_exception_destroy(handle);
        break;
    case SILK_WASM_FUNCTION:
    case SILK_WASM_REFERENCE:
        break;
    }
}
