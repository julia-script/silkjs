#include "silk_wamr_internal.h"
#include "gc_export.h"
#include "gc_type.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>

static bool tag_type(uint8_t type)
{
    switch (type) {
    case VALUE_TYPE_I32: case VALUE_TYPE_I64:
    case VALUE_TYPE_F32: case VALUE_TYPE_F64: case VALUE_TYPE_V128:
    case REF_TYPE_FUNCREF: case REF_TYPE_EXTERNREF:
    case REF_TYPE_ANYREF: case REF_TYPE_EQREF: case REF_TYPE_I31REF:
    case REF_TYPE_STRUCTREF: case REF_TYPE_ARRAYREF:
    case SILK_WASM_EXNREF:
        return true;
    default:
        return false;
    }
}
static bool js_payload_type(WASMFuncType *type, uint32_t index)
{
    uint8_t code = type->types[index];
    if (code == VALUE_TYPE_V128 || code == SILK_WASM_EXNREF
        || code == SILK_WASM_NULLEXNREF)
        return false;
    if (code == REF_TYPE_HT_NULLABLE || code == REF_TYPE_HT_NON_NULLABLE) {
        wasm_ref_type_t ref = wasm_func_type_get_param_type(type, index);
        return ref.heap_type != HEAP_TYPE_EXN && ref.heap_type != HEAP_TYPE_NOEXN;
    }
    return true;
}


SilkWasmHandle *silk_wasm_tag(SilkWasmStore *store, const uint8_t *types,
                              uint32_t count)
{
    uint32_t cells = 0;
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    if (count > UINT16_MAX) {
        silk_wasm_set_error(store, SILK_WASM_RANGE_ERROR, "Too many tag parameters");
        return NULL;
    }
    for (uint32_t i = 0; i < count; ++i) {
        if (!tag_type(types[i])) {
            silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Invalid tag parameter type");
            return NULL;
        }
        cells += silk_wasm_cell_count(types[i]);
    }
    if (cells > UINT16_MAX) {
        silk_wasm_set_error(store, SILK_WASM_RANGE_ERROR, "Tag payload is too large");
        return NULL;
    }
    SilkWasmHandle *tag = silk_wasm_new_handle(store, SILK_WASM_TAG);
    if (!tag) return NULL;
    WASMFuncType *type = calloc(1, sizeof(*type) + count);
    if (!type) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        silk_wasm_free(tag);
        return NULL;
    }
    type->base_type.type_flag = WASM_TYPE_FUNC;
    type->base_type.is_sub_final = true;
    type->base_type.parent_type_idx = UINT32_MAX;
    type->base_type.rec_count = 1;
    type->base_type.root_type = &type->base_type;
    type->param_count = (uint16_t)count;
    type->param_cell_num = (uint16_t)cells;
    if (count) memcpy(type->types, types, count);
    tag->as.tag.type = type;
    tag->as.tag.owns_type = true;
    if (!silk_wasm_publish(tag)) { silk_wasm_free(tag); return NULL; }
    return tag;
}

SilkWasmHandle *silk_wasm_tag_from_guest(SilkWasmHandle *instance,
                                         uint32_t index, WASMFuncType *type)
{
    if (index < instance->as.instance.tag_count
        && instance->as.instance.tags[index])
        return instance->as.instance.tags[index];
    SilkWasmHandle *tag = silk_wasm_new_handle(instance->store, SILK_WASM_TAG);
    if (!tag) return NULL;
    tag->as.tag.type = type;
    tag->as.tag.type_module = instance->as.instance.module->as.module.module;
    if (type->ref_type_map_count && type->param_count) {
        tag->as.tag.js_types = malloc(type->param_count);
        if (!tag->as.tag.js_types) {
            silk_wasm_set_error(instance->store, SILK_WASM_OOM, "Out of memory");
            silk_wasm_free(tag);
            return NULL;
        }
        for (uint32_t i = 0; i < type->param_count; ++i) {
            uint8_t code = type->types[i];
            if (code == REF_TYPE_HT_NULLABLE || code == REF_TYPE_HT_NON_NULLABLE) {
                wasm_ref_type_t ref = wasm_func_type_get_param_type(type, i);
                if (ref.heap_type < 0)
                    code = (uint8_t)(ref.heap_type & 0x7f);
                else {
                    WASMType *defined = tag->as.tag.type_module->types[ref.heap_type];
                    switch (defined->type_flag) {
                    case WASM_TYPE_FUNC: code = SILK_WASM_FUNCREF; break;
                    case WASM_TYPE_STRUCT: code = SILK_WASM_STRUCTREF; break;
                    case WASM_TYPE_ARRAY: code = SILK_WASM_ARRAYREF; break;
                    }
                }
            }
            tag->as.tag.js_types[i] = code;
        }
    }
    if (!silk_wasm_edge_handle(tag, instance->as.instance.module)
        || !silk_wasm_publish(tag)) {
        silk_wasm_free(tag);
        return NULL;
    }
    if (index < instance->as.instance.tag_count)
        instance->as.instance.tags[index] = tag;
    return tag;
}

static SilkWasmHandle *exception_new(SilkWasmHandle *tag,
                                     SilkWasmValue *values,
                                     uint32_t count)
{
    SilkWasmStore *store = tag->store;
    SilkWasmHandle *exception = silk_wasm_new_handle(store, SILK_WASM_EXCEPTION);
    if (!exception) { free(values); return NULL; }
    exception->as.exception.tag = tag;
    exception->as.exception.count = count;
    exception->as.exception.values = values;
    if (!silk_wasm_edge_handle(exception, tag)) goto fail;
    for (uint32_t i = 0; i < count; ++i)
        if (!silk_wasm_value_edge(exception, tag->as.tag.type->types[i], &values[i]))
            goto fail;
    if (!silk_wasm_publish(exception)) goto fail;
    return exception;
fail:
    silk_wasm_free(exception);
    return NULL;
}

uint8_t silk_wasm_tag_value_matches(SilkWasmHandle *tag, uint32_t index,
                                  const SilkWasmValue *value)
{
    if (!tag || tag->finalized || tag->kind != SILK_WASM_TAG) return false;
    WASMFuncType *type = tag->as.tag.type;
    if (index >= type->param_count) {
        silk_wasm_set_error(tag->store, SILK_WASM_RANGE_ERROR, "Tag argument index is out of bounds");
        return false;
    }
    if (!js_payload_type(type, index)) {
        silk_wasm_set_error(tag->store, SILK_WASM_TYPE_ERROR, "Exception argument type cannot be represented in JavaScript");
        return false;
    }
    const WASMRefType *reference = NULL;
    if (type->types[index] == REF_TYPE_HT_NULLABLE
        || type->types[index] == REF_TYPE_HT_NON_NULLABLE)
        reference = wasm_reftype_map_find(type->ref_type_maps,
                                          type->ref_type_map_count, index);
    return silk_wasm_value_matches(tag->store, tag->as.tag.type_module,
                                    type->types[index], reference, value);
}

SilkWasmHandle *silk_wasm_exception(SilkWasmHandle *tag,
                                    const SilkWasmValue *values, uint32_t count)
{
    if (!tag || tag->kind != SILK_WASM_TAG || tag->finalized) return NULL;
    SilkWasmStore *store = tag->store;
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    if (count != tag->as.tag.type->param_count) {
        silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Exception payload length does not match tag");
        return NULL;
    }
    for (uint32_t i = 0; i < count; ++i)
        if (!silk_wasm_tag_value_matches(tag, i, values + i)) return NULL;
    SilkWasmValue *copy = count ? malloc((size_t)count * sizeof(*copy)) : NULL;
    if (count && !copy) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        return NULL;
    }
    if (count) memcpy(copy, values, (size_t)count * sizeof(*copy));
    return exception_new(tag, copy, count);
}

uint8_t silk_wasm_exception_is(SilkWasmHandle *exception, SilkWasmHandle *tag)
{
    return exception && tag && !exception->finalized && !tag->finalized
        && exception->kind == SILK_WASM_EXCEPTION && tag->kind == SILK_WASM_TAG
        && exception->as.exception.tag == tag;
}

uint8_t silk_wasm_exception_get(SilkWasmHandle *exception, SilkWasmHandle *tag,
                              uint32_t index, SilkWasmValue *value)
{
    if (!exception || exception->kind != SILK_WASM_EXCEPTION
        || exception->finalized) return false;
    SilkWasmStore *store = exception->store;
    silk_wasm_set_error(store, SILK_WASM_OK, "");
    if (!silk_wasm_exception_is(exception, tag)) {
        silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Exception tag does not match");
        return false;
    }
    if (index >= exception->as.exception.count) {
        silk_wasm_set_error(store, SILK_WASM_RANGE_ERROR, "Exception argument index is out of bounds");
        return false;
    }
    if (!js_payload_type(tag->as.tag.type, index)) {
        silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Exception argument type cannot be represented in JavaScript");
        return false;
    }
    *value = exception->as.exception.values[index];
    return true;
}

uint32_t silk_wasm_tag_count(SilkWasmHandle *tag)
{
    return tag && !tag->finalized && tag->kind == SILK_WASM_TAG
        ? tag->as.tag.type->param_count : 0;
}

const uint8_t *silk_wasm_tag_types(SilkWasmHandle *tag)
{
    if (!tag || tag->finalized || tag->kind != SILK_WASM_TAG) return NULL;
    return tag->as.tag.js_types ? tag->as.tag.js_types : tag->as.tag.type->types;
}

void silk_wasm_exception_destroy(SilkWasmHandle *handle)
{
    if (handle->kind == SILK_WASM_TAG) {
        if (handle->as.tag.owns_type) free(handle->as.tag.type);
        free(handle->as.tag.js_types);
        handle->as.tag.js_types = NULL;
        handle->as.tag.type = NULL;
    }
    else if (handle->kind == SILK_WASM_EXCEPTION) {
        free(handle->as.exception.values);
        free(handle->as.exception.cells);
        handle->as.exception.values = NULL;
        handle->as.exception.cells = NULL;
        handle->as.exception.guest = NULL;
    }
}

/* This private RTT describes only the managed reference graph, never a guest
 * observable array. Its lifetime covers every store and exception wrapper. */
static WASMArrayType exception_refs_type = {
    .base_type = { .type_flag = WASM_TYPE_ARRAY, .is_sub_final = true,
                   .parent_type_idx = UINT32_MAX, .rec_count = 1 },
    .elem_type = REF_TYPE_ANYREF
};
static WASMRttType exception_refs_rtt = {
    .type_flag = WASM_TYPE_ARRAY,
    .defined_type = (WASMType *)&exception_refs_type,
    .root_type = (WASMType *)&exception_refs_type
};

static WASMExternrefObjectRef exception_guest(SilkWasmStore *store,
                                              WASMExecEnv *env,
                                              SilkWasmHandle *exception,
                                              const uint32_t *source)
{
    if (!exception || exception->store != store || exception->finalized
        || exception->kind != SILK_WASM_EXCEPTION) {
        silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR, "Invalid WebAssembly exception");
        return NULL;
    }
    if (exception->as.exception.guest) return exception->as.exception.guest;
    WASMFuncType *type = exception->as.exception.tag->as.tag.type;
    uint32_t count = type->param_count, references = 0;
    for (uint32_t i = 0; i < count; ++i)
        if (wasm_is_type_reftype(type->types[i])) ++references;
    uint32_t *cells = calloc(type->param_cell_num ? type->param_cell_num : 1, sizeof(*cells));
    WASMLocalObjectRef *roots = references ? calloc(references, sizeof(*roots)) : NULL;
    if (!cells || (references && !roots)) {
        free(cells);
        free(roots);
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        return NULL;
    }
    if (source && type->param_cell_num)
        memcpy(cells, source, (size_t)type->param_cell_num * sizeof(*cells));
    uint32_t offset = 0, rooted = 0;
    WASMExternrefObjectRef guest = NULL;
    if (!source
        && !silk_wasm_function_to_cells(store, env,
                                        exception->as.exception.tag->as.tag.type_module,
                                        type, false, exception->as.exception.values,
                                        cells))
        goto finish;
    for (uint32_t i = 0; i < count; ++i) {
        if (wasm_is_type_reftype(type->types[i])) {
            wasm_runtime_push_local_obj_ref(env, roots + rooted);
            memcpy(&roots[rooted++].val, cells + offset, sizeof(WASMObjectRef));
        }
        offset += silk_wasm_cell_count(type->types[i]);
    }
    guest = wasm_externref_obj_new(env, exception);
    if (guest) {
        guest->silk_exception_refs = NULL;
        guest->silk_is_exception = true;
        WASMLocalObjectRef wrapper_root;
        wasm_runtime_push_local_obj_ref(env, &wrapper_root);
        wrapper_root.val = (WASMObjectRef)guest;
        if (references) {
            WASMValue empty = { 0 };
            WASMArrayObjectRef graph = wasm_array_obj_new(env, &exception_refs_rtt,
                                                         references, &empty);
            if (!graph) guest = NULL;
            else {
                for (uint32_t i = 0; i < references; ++i) {
                    WASMValue reference = { 0 };
                    reference.gc_obj = roots[i].val;
                    wasm_array_obj_set_elem(graph, i, &reference);
                }
                guest->silk_exception_refs = (WASMObjectRef)graph;
            }
        }
        wasm_runtime_pop_local_obj_ref(env);
    }
    if (!guest) silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
    else {
        exception->as.exception.cells = cells;
        exception->as.exception.guest = guest;
        cells = NULL;
    }
finish:
    if (rooted) wasm_runtime_pop_local_obj_refs(env, rooted);
    free(roots);
    free(cells);
    return guest;
}

void *silk_wasm_exception_to_guest(SilkWasmStore *store, WASMExecEnv *env,
                                   SilkWasmHandle *exception)
{
    return exception_guest(store, env, exception, NULL);
}

SilkWasmHandle *silk_wasm_exception_from_guest(SilkWasmStore *store,
                                              WASMExecEnv *env, void *guest)
{
    (void)env;
    if (!guest) return NULL;
    for (SilkWasmHandle *handle = store->handles; handle; handle = handle->next)
        if (!handle->finalized && handle->kind == SILK_WASM_EXCEPTION
            && handle->as.exception.guest == guest)
            return handle;
    return NULL;
}

static WASMExternrefObjectRef exception_make(WASMExecEnv *env, void *identity,
                                             WASMFuncType *type,
                                             const uint32_t *cells)
{
    SilkWasmHandle *tag = identity;
    if (!tag || tag->kind != SILK_WASM_TAG || tag->finalized) return NULL;
    SilkWasmStore *store = tag->store;
    uint32_t count = type->param_count;
    SilkWasmValue *values = count ? calloc(count, sizeof(*values)) : NULL;
    if (count && !values) {
        silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory");
        return NULL;
    }
    if (!silk_wasm_from_cells(store, env, type->types, count, cells, values)) {
        free(values);
        return NULL;
    }
    SilkWasmHandle *exception = exception_new(tag, values, count);
    if (!exception) return NULL;
    return exception_guest(store, env, exception, cells);
}

static bool exception_inspect(WASMExecEnv *env, WASMExternrefObjectRef guest,
                               void **tag, WASMFuncType **type,
                               const uint32_t **cells)
{
    SilkWasmHandle *instance = wasm_silk_context((WASMModuleInstance *)env->module_inst);
    if (!instance) return false;
    SilkWasmHandle *exception = silk_wasm_exception_from_guest(instance->store, env, guest);
    if (!exception) return false;
    *tag = exception->as.exception.tag;
    *type = exception->as.exception.tag->as.tag.type;
    *cells = exception->as.exception.cells;
    return true;
}

static void *exception_tag_identity(WASMExecEnv *env,
                                     WASMModuleInstance *instance, uint32_t index)
{
    (void)env;
    return wasm_silk_tag_identity(instance, index);
}

const WASMSilkExceptionHooks silk_wasm_exception_hooks = {
    .make = exception_make,
    .inspect = exception_inspect,
    .tag_identity = exception_tag_identity
};
