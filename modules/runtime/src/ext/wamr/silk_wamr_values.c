#include "silk_wamr_internal.h"
#include "silk_wamr_types.h"
#include "wasm_export.h"
#include "gc_export.h"
#include "mem_alloc.h"
#include <stdlib.h>
#include <string.h>

static bool reference_type(uint8_t type)
{
    switch (type) {
    case SILK_WASM_FUNCREF: case SILK_WASM_EXTERNREF:
    case SILK_WASM_ANYREF: case SILK_WASM_EQREF: case SILK_WASM_I31REF:
    case SILK_WASM_STRUCTREF: case SILK_WASM_ARRAYREF: case SILK_WASM_EXNREF:
    case SILK_WASM_NULLREF: case SILK_WASM_NULLFUNCREF:
    case SILK_WASM_NULLEXTERNREF: case SILK_WASM_NULLEXNREF:
    case VALUE_TYPE_HT_NULLABLE_REF: case VALUE_TYPE_HT_NON_NULLABLE_REF:
        return true;
    default: return false;
    }
}

uint32_t silk_wasm_cell_count(uint8_t type)
{
    switch (type) {
    case SILK_WASM_I32: case SILK_WASM_F32: return 1;
    case SILK_WASM_I64: case SILK_WASM_F64: return 2;
    case SILK_WASM_V128: return 4;
    default: return reference_type(type) ? (uint32_t)(sizeof(WASMObjectRef) / 4) : 0;
    }
}

static bool type_error(SilkWasmStore *store)
{
    silk_wasm_set_error(store, SILK_WASM_TYPE_ERROR,
                        "Value does not match the WebAssembly reference type");
    return false;
}

static bool out_of_memory(SilkWasmStore *store)
{
    silk_wasm_set_error(store, SILK_WASM_OOM, "Out of memory converting WebAssembly values");
    return false;
}

static SilkWasmHandle *find_function(SilkWasmStore *store, WASMFuncObjectRef object)
{
    if (object->silk_identity) {
        SilkWasmHandle *identity = object->silk_identity;
        return identity->store == store && !identity->finalized ? identity : NULL;
    }
    WASMModuleInstance *native_owner = wasm_func_obj_get_owner(object);
    SilkWasmHandle *owner = native_owner ? wasm_silk_context(native_owner) : NULL;
    uint32_t index = wasm_func_obj_get_func_idx_bound(object);
    if (!owner || owner->store != store || index >= owner->as.instance.function_count)
        return NULL;
    return silk_wasm_instance_function(owner, index);
}

static SilkWasmHandle *find_exception(SilkWasmStore *store, WASMObjectRef object)
{
    // Only exception-tagged externrefs can name an exception owner. Scanning
    // every handle for each ordinary funcref makes table projection quadratic.
    if (!wasm_obj_is_externref_obj(object)
        || !((WASMExternrefObjectRef)object)->silk_is_exception)
        return NULL;
    for (SilkWasmHandle *h = store->handles; h; h = h->next)
        if (!h->finalized && h->kind == SILK_WASM_EXCEPTION
            && (WASMObjectRef)h->as.exception.guest == object)
            return h;
    return NULL;
}

static SilkWasmHandle *object_module(SilkWasmStore *store, WASMObjectRef object)
{
    if (!object || wasm_obj_is_i31_externref_or_anyref_obj(object)) return NULL;
    WASMRttTypeRef rtt = (WASMRttTypeRef)(object->header & WASM_OBJ_HEADER_MASK);
    for (SilkWasmHandle *h = store->handles; h; h = h->next) {
        if (h->kind != SILK_WASM_MODULE || !h->as.module.module) continue;
        WASMModule *module = h->as.module.module;
        for (uint32_t i = 0; i < module->type_count; ++i)
            if (module->types[i] == rtt->defined_type) return h;
    }
    return NULL;
}

static void visit_projection_source(SilkWasmHandle *, SilkWasmVisitHandle,
                                    SilkWasmVisitReference, void *);

static SilkWasmHandle *find_reference(SilkWasmStore *store, WASMObjectRef object)
{
    for (SilkWasmHandle *h = store->handles; h; h = h->next)
        if (!h->finalized && h->kind == SILK_WASM_REFERENCE
            && h->as.reference.object == object)
            return h;
    return NULL;
}

static SilkWasmHandle *box_object(SilkWasmStore *store, WASMObjectRef object)
{
    SilkWasmHandle *existing = find_reference(store, object);
    if (existing) return existing;
    SilkWasmHandle *h = silk_wasm_new_handle(store, SILK_WASM_REFERENCE);
    if (!h) return NULL;
    h->as.reference.object = object;
    h->as.reference.module = object_module(store, object);
    if ((h->as.reference.module && !silk_wasm_edge_handle(h, h->as.reference.module))
        || !silk_wasm_sync_edges(h, visit_projection_source)
        || !silk_wasm_publish(h)
        || !silk_wasm_sync_store_edges(store)) {
        silk_wasm_free(h);
        return NULL;
    }
    return h;
}

static bool matches_reference(SilkWasmStore *store, uint8_t type, WASMObjectRef object)
{
    if (!object) return type != VALUE_TYPE_HT_NON_NULLABLE_REF;
    switch (type) {
    case SILK_WASM_FUNCREF: return wasm_obj_is_func_obj(object);
    case SILK_WASM_EXTERNREF: return wasm_obj_is_externref_obj(object);
    case SILK_WASM_ANYREF: return wasm_obj_is_internal_obj(object);
    case SILK_WASM_EQREF: return wasm_obj_is_eq_obj(object);
    case SILK_WASM_I31REF: return wasm_obj_is_i31_obj(object);
    case SILK_WASM_STRUCTREF: return wasm_obj_is_struct_obj(object);
    case SILK_WASM_ARRAYREF: return wasm_obj_is_array_obj(object);
    case SILK_WASM_EXNREF: return find_exception(store, object) != NULL;
    case VALUE_TYPE_HT_NULLABLE_REF: case VALUE_TYPE_HT_NON_NULLABLE_REF: return true;
    default: return false;
    }
}

static bool to_reference(SilkWasmStore *store, WASMExecEnv *env, uint8_t type,
                         const SilkWasmValue *value, WASMObjectRef *result)
{
    WASMObjectRef object = NULL;
    if (value->ref_kind == SILK_WASM_REF_I31) {
        int32_t integer = (int32_t)value->bits;
        if (integer < -1073741824 || integer > 1073741823) return type_error(store);
        object = (WASMObjectRef)wasm_i31_obj_new((uint32_t)value->bits);
    }
    else if (value->ref) {
        if (value->ref_kind == SILK_WASM_REF_HANDLE || type == SILK_WASM_FUNCREF
            || type == SILK_WASM_EXNREF) {
            SilkWasmHandle *handle = value->ref;
            if (handle->store != store || handle->finalized) return type_error(store);
            switch (handle->kind) {
            case SILK_WASM_FUNCTION:
                object = (WASMObjectRef)handle->as.function.reference;
                if (!object) {
                    WASMFuncObjectRef canonical = wasm_create_func_obj(
                        handle->as.function.instance->as.instance.instance,
                        handle->as.function.index, false, store->error, sizeof(store->error));
                    if (!canonical) return out_of_memory(store);
                    handle->as.function.reference = handle->as.function.promising
                        ? wasm_silk_func_ref_alias(canonical, handle) : canonical;
                    object = (WASMObjectRef)handle->as.function.reference;
                }
                break;
            case SILK_WASM_REFERENCE: object = handle->as.reference.object; break;
            case SILK_WASM_EXCEPTION:
                object = silk_wasm_exception_to_guest(store, env, handle);
                break;
            default: return type_error(store);
            }
            if (!object) return out_of_memory(store);
        }
        else if (value->ref_kind == SILK_WASM_REF_HOST
                 && (type == SILK_WASM_EXTERNREF || type == SILK_WASM_ANYREF
                     || type == VALUE_TYPE_HT_NULLABLE_REF
                     || type == VALUE_TYPE_HT_NON_NULLABLE_REF)) {
            object = type == SILK_WASM_EXTERNREF
                ? (WASMObjectRef)wasm_externref_obj_new(env, value->ref)
                : (WASMObjectRef)wasm_anyref_obj_new(env, value->ref);
            if (!object) return out_of_memory(store);
        }
        else return type_error(store);
    }
    if (object && type == SILK_WASM_EXTERNREF && !wasm_obj_is_externref_obj(object)) {
        WASMLocalObjectRef root;
        wasm_runtime_push_local_obj_ref(env, &root);
        root.val = object;
        object = (WASMObjectRef)wasm_internal_obj_to_externref_obj(env, object);
        wasm_runtime_pop_local_obj_ref(env);
        if (!object) return out_of_memory(store);
    }
    if (!matches_reference(store, type, object)) return type_error(store);
    *result = object;
    return true;
}

static bool from_reference(SilkWasmStore *store, uint8_t type,
                           WASMObjectRef object, SilkWasmValue *value)
{
    if (!matches_reference(store, type, object)) return type_error(store);
    if (!object) return true;
    SilkWasmHandle *exception = find_exception(store, object);
    if (exception) {
        value->ref = exception;
        value->ref_kind = SILK_WASM_REF_HANDLE;
        return silk_wasm_publish(exception);
    }
    if (wasm_obj_is_externref_obj(object))
        object = wasm_externref_obj_to_internal_obj((WASMExternrefObjectRef)object);
    if (!object) return true;
    if (wasm_obj_is_i31_obj(object)) {
        value->bits = wasm_i31_obj_get_value((WASMI31ObjectRef)object, true);
        value->ref_kind = SILK_WASM_REF_I31;
    }
    else if (wasm_obj_is_anyref_obj(object)) {
        value->ref = (void *)wasm_anyref_obj_get_value((WASMAnyrefObjectRef)object);
    }
    else {
        if (wasm_obj_is_func_obj(object)) {
            value->ref = find_function(store, (WASMFuncObjectRef)object);
            if (!value->ref) return type_error(store);
        }
        else {
            value->ref = box_object(store, object);
            if (!value->ref) return false;
        }
        value->ref_kind = SILK_WASM_REF_HANDLE;
        if (!silk_wasm_publish(value->ref)) return false;
    }
    return true;
}

bool silk_wasm_to_cells(SilkWasmStore *store, WASMExecEnv *env,
                        const uint8_t *types, uint32_t count,
                        const SilkWasmValue *values, uint32_t *cells)
{
    uint32_t references = 0, rooted = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (!silk_wasm_cell_count(types[i])) return type_error(store);
        references += reference_type(types[i]);
    }
    if (references && !env) {
        if (!silk_wasm_reference_context_init(store)) return false;
        env = store->reference_exec_env;
    }
    if (references) mem_allocator_enable_gc_reclaim(store->gc_heap, env);
    WASMLocalObjectRef local[16];
    WASMLocalObjectRef *roots = references > 16 ? calloc(references, sizeof(*roots)) : local;
    if (!roots) return out_of_memory(store);
    bool ok = true;
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t type = types[i];
        if (reference_type(type)) {
            WASMObjectRef object;
            if (!to_reference(store, env, type, &values[i], &object)) { ok = false; break; }
            wasm_runtime_push_local_obj_ref(env, &roots[rooted]);
            roots[rooted++].val = object;
            memcpy(cells, &object, sizeof(object));
        }
        else if (type == SILK_WASM_I32 || type == SILK_WASM_F32) {
            uint32_t bits = (uint32_t)values[i].bits;
            memcpy(cells, &bits, sizeof(bits));
        }
        else {
            memcpy(cells, &values[i].bits, sizeof(values[i].bits));
            if (type == SILK_WASM_V128)
                memcpy(cells + 2, &values[i].bits_high, sizeof(values[i].bits_high));
        }
        cells += silk_wasm_cell_count(type);
    }
    if (rooted) wasm_runtime_pop_local_obj_refs(env, rooted);
    if (roots != local) free(roots);
    return ok;
}

bool silk_wasm_from_cells(SilkWasmStore *store, WASMExecEnv *env,
                          const uint8_t *types, uint32_t count,
                          const uint32_t *cells, SilkWasmValue *values)
{
    uint32_t references = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (!silk_wasm_cell_count(types[i])) return type_error(store);
        references += reference_type(types[i]);
    }
    if (references && !env) {
        if (!silk_wasm_reference_context_init(store)) return false;
        env = store->reference_exec_env;
    }
    if (references) mem_allocator_enable_gc_reclaim(store->gc_heap, env);
    WASMLocalObjectRef local[16];
    WASMLocalObjectRef *roots = references > 16 ? calloc(references, sizeof(*roots)) : local;
    if (!roots) return out_of_memory(store);
    uint32_t rooted = 0;
    const uint32_t *cursor = cells;
    for (uint32_t i = 0; i < count; ++i) {
        if (reference_type(types[i])) {
            wasm_runtime_push_local_obj_ref(env, &roots[rooted]);
            memcpy(&roots[rooted++].val, cursor, sizeof(WASMObjectRef));
        }
        cursor += silk_wasm_cell_count(types[i]);
    }
    bool ok = true;
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t type = types[i];
        memset(&values[i], 0, sizeof(values[i]));
        if (reference_type(type)) {
            WASMObjectRef object;
            memcpy(&object, cells, sizeof(object));
            if (!from_reference(store, type, object, &values[i])) { ok = false; break; }
        }
        else if (type == SILK_WASM_I32 || type == SILK_WASM_F32) {
            uint32_t bits;
            memcpy(&bits, cells, sizeof(bits));
            values[i].bits = bits;
        }
        else {
            memcpy(&values[i].bits, cells, sizeof(values[i].bits));
            if (type == SILK_WASM_V128)
                memcpy(&values[i].bits_high, cells + 2, sizeof(values[i].bits_high));
        }
        cells += silk_wasm_cell_count(type);
    }
    if (rooted) wasm_runtime_pop_local_obj_refs(env, rooted);
    if (roots != local) free(roots);
    return ok;
}

void silk_wasm_visit_value(SilkWasmStore *store, uint8_t type,
                           const SilkWasmValue *value, SilkWasmVisitHandle handle,
                           SilkWasmVisitReference reference, void *context)
{
    (void)store;
    if (!reference_type(type) || !value->ref || value->ref_kind == SILK_WASM_REF_I31) return;
    if (value->ref_kind == SILK_WASM_REF_HANDLE || type == SILK_WASM_FUNCREF
        || type == SILK_WASM_EXNREF) handle(context, value->ref);
    else reference(context, value->ref);
}

bool silk_wasm_value_edge(SilkWasmHandle *owner, uint8_t type, const SilkWasmValue *value)
{
    if (!reference_type(type) || !value->ref || value->ref_kind == SILK_WASM_REF_I31) return true;
    if (value->ref_kind == SILK_WASM_REF_HANDLE || type == SILK_WASM_FUNCREF
        || type == SILK_WASM_EXNREF) return silk_wasm_edge_handle(owner, value->ref);
    return silk_wasm_edge_reference(owner, value->ref);
}

uint32_t silk_wasm_pin_cells(WASMExecEnv *env, const uint8_t *types,
                             uint32_t count, const uint32_t *cells,
                             WASMLocalObjectRef *roots)
{
    uint32_t rooted = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (reference_type(types[i])) {
            wasm_runtime_push_local_obj_ref(env, &roots[rooted]);
            memcpy(&roots[rooted++].val, cells, sizeof(WASMObjectRef));
        }
        cells += silk_wasm_cell_count(types[i]);
    }
    return rooted;
}

typedef struct ReferenceWalk {
    WASMObjectRef local_objects[32], local_seen[64];
    WASMObjectRef *objects, *seen;
    size_t count, capacity, seen_capacity;
} ReferenceWalk;

static size_t object_hash(WASMObjectRef object)
{
    uintptr_t bits = (uintptr_t)object >> 3;
    bits ^= bits >> 17;
    return (size_t)(bits * (uintptr_t)0x9e3779b1U);
}

static bool walk_add(ReferenceWalk *walk, WASMObjectRef object)
{
    if (!object || wasm_obj_is_i31_obj(object)) return true;
    size_t slot = object_hash(object) & (walk->seen_capacity - 1);
    while (walk->seen[slot]) {
        if (walk->seen[slot] == object) return true;
        slot = (slot + 1) & (walk->seen_capacity - 1);
    }
    if (walk->count == walk->capacity) {
        if (walk->capacity > SIZE_MAX / 4 / sizeof(WASMObjectRef)) return false;
        size_t capacity = walk->capacity * 2;
        WASMObjectRef *objects = malloc(capacity * sizeof(*objects));
        WASMObjectRef *seen = calloc(capacity * 2, sizeof(*seen));
        if (!objects || !seen) { free(objects); free(seen); return false; }
        memcpy(objects, walk->objects, walk->count * sizeof(*objects));
        for (size_t i = 0; i < walk->count; ++i) {
            size_t index = object_hash(objects[i]) & (capacity * 2 - 1);
            while (seen[index]) index = (index + 1) & (capacity * 2 - 1);
            seen[index] = objects[i];
        }
        if (walk->objects != walk->local_objects) free(walk->objects);
        if (walk->seen != walk->local_seen) free(walk->seen);
        walk->objects = objects;
        walk->seen = seen;
        walk->capacity = capacity;
        walk->seen_capacity = capacity * 2;
        slot = object_hash(object) & (walk->seen_capacity - 1);
        while (walk->seen[slot]) slot = (slot + 1) & (walk->seen_capacity - 1);
    }
    walk->seen[slot] = object;
    walk->objects[walk->count++] = object;
    return true;
}

static void visit_object_graph(SilkWasmStore *store, WASMObjectRef object,
                               SilkWasmHandle *root_owner, SilkWasmVisitHandle handle,
                               SilkWasmVisitReference reference, void *context)
{
    ReferenceWalk walk = { 0 };
    walk.objects = walk.local_objects;
    walk.seen = walk.local_seen;
    walk.capacity = 32;
    walk.seen_capacity = 64;
    bool ok = walk_add(&walk, object);
    for (size_t i = 0; ok && i < walk.count; ++i) {
        WASMObjectRef current = walk.objects[i];
        SilkWasmHandle *exception = find_exception(store, current);
        if (exception) { handle(context, exception); continue; }
        if (wasm_obj_is_anyref_obj(current)) {
            void *token = (void *)wasm_anyref_obj_get_value((WASMAnyrefObjectRef)current);
            if (token) reference(context, token);
            continue;
        }
        if (wasm_obj_is_func_obj(current)) {
            SilkWasmHandle *function = find_function(store, (WASMFuncObjectRef)current);
            if (!function) { type_error(store); store->reference_visit_failed = true; break; }
            handle(context, function);
            continue;
        }
        SilkWasmHandle *canonical = find_reference(store, current);
        if (canonical && canonical != root_owner) {
            handle(context, canonical);
            continue;
        }
        SilkWasmHandle *module = object_module(store, current);
        if (module) handle(context, module);
        bool compact = false;
        uint32_t count = 0, start = 0;
        uint16_t *offsets = NULL;
        if (!wasm_object_get_ref_list(current, &compact, &count, &offsets, &start)) {
            type_error(store);
            store->reference_visit_failed = true;
            break;
        }
        for (uint32_t j = 0; ok && j < count; ++j) {
            WASMObjectRef child;
            size_t offset = compact ? (size_t)start + (size_t)j * sizeof(child) : offsets[j];
            memcpy(&child, (const uint8_t *)current + offset, sizeof(child));
            ok = walk_add(&walk, child);
        }
    }
    if (!ok) { out_of_memory(store); store->reference_visit_failed = true; }
    if (walk.objects != walk.local_objects) free(walk.objects);
    if (walk.seen != walk.local_seen) free(walk.seen);
}

void silk_wasm_visit_object(SilkWasmStore *store, WASMObjectRef object,
                            SilkWasmVisitHandle handle,
                            SilkWasmVisitReference reference, void *context)
{
    visit_object_graph(store, object, NULL, handle, reference, context);
}

void silk_wasm_visit_cells(SilkWasmStore *store, uint8_t type, const uint32_t *cells,
                           SilkWasmVisitHandle handle, SilkWasmVisitReference reference,
                           void *context)
{
    if (!reference_type(type)) return;
    WASMObjectRef object;
    memcpy(&object, cells, sizeof(object));
    silk_wasm_visit_object(store, object, handle, reference, context);
}

typedef struct EdgeProjection {
    SilkWasmHandle edges;
    SilkWasmHandle *owner;
    struct EdgeProjection *next;
    bool failed;
} EdgeProjection;

static void project_handle(void *context, SilkWasmHandle *handle)
{
    EdgeProjection *projection = context;
    if (!projection->failed && !silk_wasm_edge_handle(&projection->edges, handle))
        projection->failed = true;
}

static void project_reference(void *context, void *reference)
{
    EdgeProjection *projection = context;
    if (!projection->failed && !silk_wasm_edge_reference(&projection->edges, reference))
        projection->failed = true;
}

static void visit_projection_source(SilkWasmHandle *owner, SilkWasmVisitHandle handle,
                                    SilkWasmVisitReference reference, void *context)
{
    if (owner->kind == SILK_WASM_REFERENCE)
        visit_object_graph(owner->store, owner->as.reference.object, owner,
                           handle, reference, context);
    else
        silk_wasm_resource_visit(owner, handle, reference, context);
}

static void install_projection(EdgeProjection *projection)
{
    SilkWasmHandle *owner = projection->owner, *edges = &projection->edges;
    SilkWasmEdge *old = owner->reference_edges;
    size_t count = owner->reference_edge_count, capacity = owner->reference_edge_capacity;
    owner->reference_edges = edges->edges;
    owner->reference_edge_count = edges->edge_count;
    owner->reference_edge_capacity = edges->edge_capacity;
    edges->edges = old;
    edges->edge_count = count;
    edges->edge_capacity = capacity;
}

void silk_wasm_clear_reference_edges(SilkWasmHandle *owner)
{
    SilkWasmHandle old = { 0 };
    old.store = owner->store;
    old.edges = owner->reference_edges;
    old.edge_count = owner->reference_edge_count;
    old.edge_capacity = owner->reference_edge_capacity;
    owner->reference_edges = NULL;
    owner->reference_edge_count = owner->reference_edge_capacity = 0;
    silk_wasm_clear_edges(&old);
}

bool silk_wasm_sync_edges(SilkWasmHandle *owner,
                          void (*visit)(SilkWasmHandle *, SilkWasmVisitHandle,
                                       SilkWasmVisitReference, void *))
{
    EdgeProjection projection = { 0 };
    projection.edges.store = owner->store;
    projection.owner = owner;
    owner->store->reference_visit_failed = false;
    visit(owner, project_handle, project_reference, &projection);
    bool ok = !projection.failed && !owner->store->reference_visit_failed;
    if (ok) install_projection(&projection);
    silk_wasm_clear_edges(&projection.edges);
    return ok;
}

bool silk_wasm_sync_store_edges(SilkWasmStore *store)
{
    if (store->syncing_edges) return true;
    store->syncing_edges = true;
    store->reference_visit_failed = false;
    EdgeProjection *first = NULL;
    bool ok = true;
    /* Acquire the entire replacement graph before releasing any old edge:
     * a guest can move the last reference from one resource into another. */
    for (SilkWasmHandle *owner = store->handles; owner; owner = owner->next) {
        if (owner->finalized || (owner->kind != SILK_WASM_TABLE
            && owner->kind != SILK_WASM_GLOBAL && owner->kind != SILK_WASM_REFERENCE))
            continue;
        EdgeProjection *projection = calloc(1, sizeof(*projection));
        if (!projection) { ok = out_of_memory(store); break; }
        projection->owner = owner;
        projection->edges.store = store;
        projection->next = first;
        first = projection;
        visit_projection_source(owner, project_handle, project_reference, projection);
        if (projection->failed || store->reference_visit_failed) { ok = false; break; }
    }
    if (ok)
        for (EdgeProjection *p = first; p; p = p->next) install_projection(p);
    while (first) {
        EdgeProjection *next = first->next;
        silk_wasm_clear_edges(&first->edges);
        free(first);
        first = next;
    }
    store->syncing_edges = false;
    return ok;
}

static void destroy_reference_instance(SilkWasmStore *store);

bool silk_wasm_reference_context_init(SilkWasmStore *store)
{
    if (store->reference_exec_env) return true;
    if (!store->gc_heap) {
        store->gc_heap = wasm_silk_gc_heap_new(16U * 1024U * 1024U, &store->gc_pool);
        if (!store->gc_heap) return out_of_memory(store);
    }
    SilkWasmHandle *instance = calloc(1, sizeof(*instance));
    SilkWasmHandle *module = calloc(1, sizeof(*module));
    if (!instance || !module) { free(instance); free(module); return out_of_memory(store); }
    instance->store = module->store = store;
    instance->kind = SILK_WASM_INSTANCE;
    module->kind = SILK_WASM_MODULE;
    instance->as.instance.module = module;
    /* These private shells are not JS owners or entries in the store's weak
     * handle registry. Like public instances, they borrow store->gc_heap via
     * the resource hook; their native gc_heap_pool stays NULL. The store owns
     * both allocator and pool and destroys them after all instances and envs. */
    static const uint8_t empty_module[] = { 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 };
    module->as.module.loaded_bytes = malloc(sizeof(empty_module));
    if (!module->as.module.loaded_bytes) {
        free(instance); free(module); return out_of_memory(store);
    }
    memcpy(module->as.module.loaded_bytes, empty_module, sizeof(empty_module));
    LoadArgs args = { 0 };
    module->as.module.module = wasm_load(module->as.module.loaded_bytes, sizeof(empty_module),
#if WASM_ENABLE_MULTI_MODULE != 0
                                        true,
#endif
                                        &args, store->error, sizeof(store->error));
    store->reference_instance = instance;
    if (module->as.module.module)
        instance->as.instance.instance = wasm_silk_instantiate(module->as.module.module,
            SILK_WASM_STACK_SIZE, &silk_wasm_resource_hooks, instance,
            store->error, sizeof(store->error));
    if (instance->as.instance.instance)
        store->reference_exec_env = wasm_runtime_create_exec_env(
            (wasm_module_inst_t)instance->as.instance.instance, SILK_WASM_STACK_SIZE);
    if (!store->reference_exec_env) {
        destroy_reference_instance(store);
        return out_of_memory(store);
    }
    return true;
}

static void destroy_reference_instance(SilkWasmStore *store)
{
    if (store->reference_exec_env) {
        wasm_runtime_destroy_exec_env(store->reference_exec_env);
        store->reference_exec_env = NULL;
    }
    SilkWasmHandle *instance = store->reference_instance;
    store->reference_instance = NULL;
    if (instance) {
        SilkWasmHandle *module = instance->as.instance.module;
        if (instance->as.instance.instance)
            wasm_deinstantiate(instance->as.instance.instance, false);
        if (module->as.module.module) wasm_unload(module->as.module.module);
        free(module->as.module.loaded_bytes);
        free(module);
        free(instance);
    }
}

void silk_wasm_reference_context_destroy(SilkWasmStore *store)
{
    destroy_reference_instance(store);
    if (store->gc_heap) wasm_silk_gc_heap_delete(store->gc_heap, store->gc_pool);
    store->gc_heap = store->gc_pool = NULL;
}

bool silk_wasm_reference_roots(SilkWasmStore *store, void *heap)
{
    for (SilkWasmHandle *h = store->handles; h; h = h->next) {
        if (h->finalized) continue;
        WASMObjectRef object = h->kind == SILK_WASM_REFERENCE ? h->as.reference.object
            : h->kind == SILK_WASM_EXCEPTION ? (WASMObjectRef)h->as.exception.guest
            : h->kind == SILK_WASM_FUNCTION ? (WASMObjectRef)h->as.function.reference : NULL;
        if (wasm_obj_is_created_from_heap(object) && mem_allocator_add_root(heap, object) != 0)
            return false;
    }
    if (store->reference_exec_env)
        for (WASMLocalObjectRef *root = store->reference_exec_env->cur_local_object_ref;
             root; root = root->prev)
            if (wasm_obj_is_created_from_heap(root->val)
                && mem_allocator_add_root(heap, root->val) != 0)
                return false;
    return true;
}

uint8_t silk_wasm_conversion_type(uint8_t type, const WASMRefType *reference)
{
    if ((type == VALUE_TYPE_HT_NULLABLE_REF || type == VALUE_TYPE_HT_NON_NULLABLE_REF)
        && reference && reference->ref_ht_common.heap_type < 0)
        return (uint8_t)(reference->ref_ht_common.heap_type & 0x7f);
    return type;
}

bool silk_wasm_value_matches(SilkWasmStore *store, const WASMModule *module,
                             uint8_t type, const WASMRefType *reference,
                             const SilkWasmValue *value)
{
    if (!reference_type(type)) return silk_wasm_cell_count(type) != 0;
    bool typed = type == VALUE_TYPE_HT_NULLABLE_REF || type == VALUE_TYPE_HT_NON_NULLABLE_REF;
    if (typed && !reference) return type_error(store);
    if (!value->ref && value->ref_kind != SILK_WASM_REF_I31)
        return type != VALUE_TYPE_HT_NON_NULLABLE_REF || type_error(store);
    uint8_t conversion = silk_wasm_conversion_type(type, reference);
    if (conversion == SILK_WASM_EXTERNREF) return true;
    WASMObjectRef object = NULL;
    const WASMModule *actual_module = NULL;
    const WASMType *actual_type = NULL;
    if (value->ref_kind == SILK_WASM_REF_I31) {
        int32_t integer = (int32_t)value->bits;
        if (integer < -1073741824 || integer > 1073741823) return type_error(store);
        object = (WASMObjectRef)wasm_i31_obj_new((uint32_t)integer);
    }
    else if (value->ref_kind == SILK_WASM_REF_HANDLE || type == SILK_WASM_FUNCREF
             || type == SILK_WASM_EXNREF) {
        SilkWasmHandle *handle = value->ref;
        if (handle->store != store || handle->finalized) return type_error(store);
        if (handle->kind == SILK_WASM_FUNCTION) {
            actual_module = handle->as.function.instance->as.instance.module->as.module.module;
            actual_type = (const WASMType *)handle->as.function.type;
            if (conversion == SILK_WASM_FUNCREF) return true;
        }
        else if (handle->kind == SILK_WASM_REFERENCE) {
            object = handle->as.reference.object;
            SilkWasmHandle *owner = object_module(store, object);
            if (owner) {
                actual_module = owner->as.module.module;
                actual_type = ((WASMRttTypeRef)(object->header & WASM_OBJ_HEADER_MASK))->defined_type;
            }
        }
        else if (handle->kind == SILK_WASM_EXCEPTION)
            return conversion == SILK_WASM_EXNREF || type_error(store);
        else return type_error(store);
    }
    else if (value->ref_kind == SILK_WASM_REF_HOST)
        return conversion == SILK_WASM_ANYREF || type_error(store);
    else return type_error(store);
    if (typed && reference->ref_ht_common.heap_type >= 0) {
        uint32_t index = (uint32_t)reference->ref_ht_typeidx.type_idx;
        return (module && index < module->type_count && actual_type
                && wasm_silk_type_matches(module, module->types[index], actual_module, actual_type))
            || type_error(store);
    }
    return (object && matches_reference(store, conversion, object)) || type_error(store);
}

bool silk_wasm_function_to_cells(SilkWasmStore *store, WASMExecEnv *env,
                                 const WASMModule *module, const WASMFuncType *signature,
                                 bool results, const SilkWasmValue *values, uint32_t *cells)
{
    uint32_t start = results ? signature->param_count : 0;
    uint32_t count = results ? signature->result_count : signature->param_count;
    if (!signature->ref_type_map_count)
        return silk_wasm_to_cells(store, env, signature->types + start, count, values, cells);
    uint8_t local[32];
    uint8_t *types = count > sizeof(local) ? malloc(count) : local;
    if (!types) return out_of_memory(store);
    uint32_t map = 0;
    while (map < signature->ref_type_map_count && signature->ref_type_maps[map].index < start)
        ++map;
    bool ok = true;
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t type = signature->types[start + i];
        const WASMRefType *reference = map < signature->ref_type_map_count
            && signature->ref_type_maps[map].index == start + i
                ? signature->ref_type_maps[map++].ref_type : NULL;
        if (!silk_wasm_value_matches(store, module, type, reference, &values[i])) {
            ok = false;
            break;
        }
        types[i] = silk_wasm_conversion_type(type, reference);
    }
    if (ok) ok = silk_wasm_to_cells(store, env, types, count, values, cells);
    if (types != local) free(types);
    return ok;
}

static const WASMRefType *signature_reference(const WASMFuncType *type, uint32_t index)
{
    for (uint32_t i = 0; i < type->ref_type_map_count; ++i)
        if (type->ref_type_maps[i].index == index) return type->ref_type_maps[i].ref_type;
    return NULL;
}

uint8_t silk_wasm_function_value_matches(SilkWasmHandle *function, uint32_t index,
                                      uint8_t results, const SilkWasmValue *value)
{
    WASMFuncType *type = function->as.function.type;
    if (index >= (results ? type->result_count : type->param_count))
        return type_error(function->store);
    if (results) index += type->param_count;
    return silk_wasm_value_matches(function->store,
        function->as.function.instance->as.instance.module->as.module.module,
        type->types[index], signature_reference(type, index), value);
}

uint8_t silk_wasm_invocation_value_matches(SilkWasmInvocation *invocation, uint32_t index,
                                        const SilkWasmValue *value)
{
    WASMFuncType *type = invocation->pending_type;
    if (!type || index >= type->result_count) return type_error(invocation->store);
    index += type->param_count;
    return silk_wasm_value_matches(invocation->store, invocation->pending_module,
        type->types[index], signature_reference(type, index), value);
}

struct SilkWasmTypeCache {
    SilkWasmTypeCache *next;
    WASMFuncType *signature;
    uint8_t types[];
};

uint8_t silk_wasm_js_type(const WASMModule *module, uint8_t type,
                          const WASMRefType *reference)
{
    type = silk_wasm_conversion_type(type, reference);
    if (type != VALUE_TYPE_HT_NULLABLE_REF && type != VALUE_TYPE_HT_NON_NULLABLE_REF)
        return type;
    if (!reference || !module) return 0;
    uint32_t index = (uint32_t)reference->ref_ht_typeidx.type_idx;
    if (index >= module->type_count) return 0;
    switch (module->types[index]->type_flag) {
    case WASM_TYPE_FUNC: return SILK_WASM_FUNCREF;
    case WASM_TYPE_STRUCT: return SILK_WASM_STRUCTREF;
    case WASM_TYPE_ARRAY: return SILK_WASM_ARRAYREF;
    default: return 0;
    }
}

const uint8_t *silk_wasm_js_types(SilkWasmHandle *owner, WASMFuncType *signature)
{
    if (!signature->ref_type_map_count) return signature->types;
    for (SilkWasmTypeCache *cache = owner->as.module.type_cache; cache; cache = cache->next)
        if (cache->signature == signature) return cache->types;
    uint32_t count = (uint32_t)signature->param_count + signature->result_count;
    SilkWasmTypeCache *cache = malloc(sizeof(*cache) + count);
    if (!cache) { out_of_memory(owner->store); return NULL; }
    memcpy(cache->types, signature->types, count);
    WASMModule *module = owner->as.module.module;
    for (uint32_t i = 0; i < signature->ref_type_map_count; ++i) {
        const WASMRefTypeMap *map = &signature->ref_type_maps[i];
        uint8_t type = silk_wasm_js_type(module, signature->types[map->index], map->ref_type);
        if (!type) { free(cache); type_error(owner->store); return NULL; }
        cache->types[map->index] = type;
    }
    cache->signature = signature;
    cache->next = owner->as.module.type_cache;
    owner->as.module.type_cache = cache;
    return cache->types;
}

void silk_wasm_js_types_destroy(SilkWasmHandle *owner)
{
    SilkWasmTypeCache *cache = owner->as.module.type_cache;
    owner->as.module.type_cache = NULL;
    while (cache) {
        SilkWasmTypeCache *next = cache->next;
        free(cache);
        cache = next;
    }
}
