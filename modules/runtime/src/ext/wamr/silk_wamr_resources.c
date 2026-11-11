#include "silk_wamr_internal.h"
#include "mem_alloc.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define SILK_WASM_TABLE_CAPACITY UINT32_C(10000000)

static bool resource_error(SilkWasmStore *store, int kind, const char *text)
{
    silk_wasm_set_error(store, kind, text);
    return false;
}

static uint64_t memory_bytes(WASMMemoryInstance *memory)
{
    return __atomic_load_n(&memory->memory_data_size, __ATOMIC_ACQUIRE);
}

static bool backing_grow(WASMMemoryInstance *memory, uint32_t delta,
                          uint32_t *previous)
{
    SilkWasmBacking *backing = memory->silk_owner;
    os_mutex_lock(&backing->lock);
    uint32_t old = __atomic_load_n(&memory->cur_page_count, __ATOMIC_RELAXED);
    *previous = old;
    if (delta > memory->max_page_count - old) {
        os_mutex_unlock(&backing->lock);
        return false;
    }
    uint64_t bytes = (uint64_t)(old + delta) * memory->num_bytes_per_page;
    /* The complete virtual extent was zero initialized before publication.
     * In particular shared growth never races a memset with atomic clients. */
    memory->memory_data_end = memory->memory_data + bytes;
    __atomic_store_n(&memory->memory_data_size, bytes, __ATOMIC_RELEASE);
    __atomic_store_n(&memory->cur_page_count, old + delta, __ATOMIC_RELEASE);
    os_mutex_unlock(&backing->lock);
    return true;
}

static void backing_grown(WASMMemoryInstance *memory, uint32_t old)
{
    SilkWasmBacking *backing = memory->silk_owner;
    /* Realm-local observers never become part of the transferable lease.
     * A foreign worker refreshes its shared buffer length on its next getter. */
    for (SilkWasmStore *store = silk_wasm_thread_stores(); store;
         store = store->next_thread_store) {
        if (store->closed) continue;
        for (SilkWasmMemoryObserver *it = store->memory_observers; it; it = it->next) {
            if (!it->handle->finalized && it->handle->as.memory.backing == backing)
                store->callbacks.memory_grown(store->context, it->handle, old);
        }
    }
}

uint64_t silk_wamr_shared_capacity(WASMMemoryInstance *memory)
{
    SilkWasmBacking *backing = memory->silk_owner;
    return backing ? backing->capacity : memory_bytes(memory);
}

void silk_wasm_backing_retain(void *value)
{
    SilkWasmBacking *backing = value;
    atomic_fetch_add_explicit(&backing->references, 1, memory_order_relaxed);
}

void silk_wasm_backing_release(void *value)
{
    SilkWasmBacking *backing = value;
    if (!backing || atomic_fetch_sub_explicit(&backing->references, 1,
                                              memory_order_acq_rel) != 1)
        return;
    os_mutex_destroy(&backing->lock);
    os_munmap(backing->data, (size_t)backing->capacity);
    free(backing->memory);
    free(backing);
}

static SilkWasmHandle *memory_handle(SilkWasmStore *store, SilkWasmBacking *backing)
{
    SilkWasmHandle *handle = silk_wasm_new_handle(store, SILK_WASM_MEMORY);
    if (!handle) return NULL;
    silk_wasm_backing_retain(backing);
    handle->as.memory.backing = backing;
    SilkWasmMemoryObserver *observer = &handle->as.memory.observer;
    observer->handle = handle;
    observer->next = store->memory_observers;
    store->memory_observers = observer;
    if (!silk_wasm_publish(handle)) {
        silk_wasm_free(handle);
        return NULL;
    }
    return handle;
}

SilkWasmHandle *silk_wasm_memory(SilkWasmStore *store, uint64_t initial,
                                 uint64_t maximum, uint8_t has_maximum,
                                 uint8_t shared, uint8_t address64)
{
    uint64_t limit = address64 ? UINT64_C(262144) : UINT64_C(65536);
    if (!has_maximum) maximum = limit;
    if (initial > maximum || maximum > limit || (shared && !has_maximum)) {
        resource_error(store, SILK_WASM_RANGE_ERROR, "Invalid WebAssembly memory limits");
        return NULL;
    }
    uint64_t capacity = maximum * SILK_WASM_PAGE_SIZE;
    if (capacity > SIZE_MAX) {
        resource_error(store, SILK_WASM_RANGE_ERROR, "WebAssembly memory exceeds address space");
        return NULL;
    }
    SilkWasmBacking *backing = calloc(1, sizeof(*backing));
    WASMMemoryInstance *memory = calloc(1, sizeof(*memory));
    if (!backing || !memory) {
        free(backing); free(memory);
        resource_error(store, SILK_WASM_OOM, "Out of memory");
        return NULL;
    }
    if (os_mutex_init(&backing->lock) != 0) {
        free(memory); free(backing);
        resource_error(store, SILK_WASM_OOM, "Cannot create memory lock");
        return NULL;
    }
    backing->data = os_mmap(NULL, (size_t)(capacity ? capacity : 8),
                            MMAP_PROT_READ | MMAP_PROT_WRITE, 0,
                            os_get_invalid_handle());
    if (!backing->data) {
        os_mutex_destroy(&backing->lock); free(memory); free(backing);
        resource_error(store, SILK_WASM_OOM, "Cannot reserve WebAssembly memory");
        return NULL;
    }
    atomic_init(&backing->references, 1);
    backing->memory = memory;
    backing->capacity = capacity ? capacity : 8;
    backing->maximum = maximum;
    backing->has_maximum = has_maximum;
    memory->module_type = Wasm_Module_Bytecode;
    memory->is_shared_memory = shared;
    memory->is_memory64 = address64;
    memory->ref_count = shared ? 1 : 0;
    memory->num_bytes_per_page = (uint32_t)SILK_WASM_PAGE_SIZE;
    memory->cur_page_count = (uint32_t)initial;
    memory->max_page_count = (uint32_t)maximum;
    memory->memory_data = backing->data;
    memory->memory_data_size = initial * SILK_WASM_PAGE_SIZE;
    memory->memory_data_end = backing->data + memory->memory_data_size;
    memory->heap_data = memory->heap_data_end = backing->data;
    memory->silk_owner = backing;
    memory->silk_grow = backing_grow;
    memory->silk_grown = backing_grown;
    SilkWasmHandle *handle = memory_handle(store, backing);
    silk_wasm_backing_release(backing);
    return handle;
}

SilkWasmHandle *silk_wasm_memory_from_backing(SilkWasmStore *store, void *value)
{
    SilkWasmBacking *backing = value;
    if (!backing || !backing->memory->is_shared_memory) {
        resource_error(store, SILK_WASM_TYPE_ERROR, "Only shared memory can cross workers");
        return NULL;
    }
    /* Structured cloning creates a new Memory identity, not a new backing.
     * Each handle owns its own JS wrapper and cached buffer snapshot. */
    return memory_handle(store, backing);
}

uint8_t *silk_wasm_memory_data(SilkWasmHandle *handle)
{ return handle->as.memory.backing->memory->memory_data; }
uint64_t silk_wasm_memory_size(SilkWasmHandle *handle)
{ return memory_bytes(handle->as.memory.backing->memory); }
uint64_t silk_wasm_memory_capacity(SilkWasmHandle *handle)
{ return handle->as.memory.backing->capacity; }
uint8_t silk_wasm_memory_shared(SilkWasmHandle *handle)
{ return handle->as.memory.backing->memory->is_shared_memory != 0; }
void *silk_wasm_memory_backing(SilkWasmHandle *handle)
{ return handle->as.memory.backing; }
uint8_t silk_wasm_memory_grow(SilkWasmHandle *handle, uint64_t delta, uint64_t *previous)
{
    WASMMemoryInstance *memory = handle->as.memory.backing->memory;
    uint32_t old;
    if (delta > UINT32_MAX
        || !wasm_silk_memory_grow_with_previous(memory, (uint32_t)delta, &old))
        return resource_error(handle->store, SILK_WASM_RANGE_ERROR,
                              "WebAssembly memory growth failed");
    *previous = old;
    return true;
}

uint8_t silk_wasm_address64(SilkWasmHandle *handle)
{
    return handle->kind == SILK_WASM_MEMORY
        ? handle->as.memory.backing->memory->is_memory64 != 0
        : handle->as.table.address64;
}

static bool reference_type(uint32_t type)
{
    /* Globals and tables accept the same GC reference types as guest values. */
    return type <= UINT8_MAX && wasm_is_type_reftype((uint8_t)type);
}

SilkWasmHandle *silk_wasm_table(SilkWasmStore *store, uint32_t element,
                                uint64_t initial, uint64_t maximum,
                                uint8_t has_maximum, const SilkWasmValue *value,
                                uint8_t address64)
{
    if (!has_maximum) maximum = address64 ? UINT64_MAX : UINT32_MAX;
    if (!reference_type(element) || initial > maximum
        || initial > SILK_WASM_TABLE_CAPACITY || (!address64 && maximum > UINT32_MAX)) {
        resource_error(store, SILK_WASM_RANGE_ERROR, "Invalid WebAssembly table limits");
        return NULL;
    }
    uint8_t type = (uint8_t)element;
    table_elem_type_t cell = 0;
    if (!silk_wasm_to_cells(store, NULL, &type, 1, value, (uint32_t *)&cell))
        return NULL;
    SilkWasmHandle *handle = silk_wasm_new_handle(store, SILK_WASM_TABLE);
    if (!handle) return NULL;
    handle->as.table.element = element;
    handle->as.table.has_maximum = has_maximum;
    handle->as.table.address64 = address64;
    handle->as.table.maximum = maximum;
    uint32_t capacity = maximum < SILK_WASM_TABLE_CAPACITY
        ? (uint32_t)maximum : SILK_WASM_TABLE_CAPACITY;
    handle->as.table.table = wasm_silk_table_new(type, address64,
                                (uint32_t)initial, capacity, cell);
    if (!handle->as.table.table) {
        resource_error(store, SILK_WASM_OOM, "Cannot allocate WebAssembly table");
        silk_wasm_free(handle);
        return NULL;
    }
    if (!silk_wasm_sync_edges(handle, silk_wasm_resource_visit)
        || !silk_wasm_publish(handle)) {
        silk_wasm_free(handle);
        return NULL;
    }
    return handle;
}

uint64_t silk_wasm_table_size(SilkWasmHandle *handle)
{ return handle->as.table.table->cur_size; }

uint8_t silk_wasm_table_get(SilkWasmHandle *handle, uint64_t index, SilkWasmValue *value)
{
    WASMTableInstance *table = handle->as.table.table;
    if (index >= table->cur_size)
        return resource_error(handle->store, SILK_WASM_RANGE_ERROR, "Table index out of bounds");
    uint8_t type = silk_wasm_conversion_type((uint8_t)handle->as.table.element,
                                             table->elem_ref_type.elem_ref_type);
    return silk_wasm_from_cells(handle->store, NULL, &type, 1,
                                (const uint32_t *)&table->elems[index], value);
}

uint8_t silk_wasm_table_set(SilkWasmHandle *handle, uint64_t index,
                         const SilkWasmValue *value)
{
    WASMTableInstance *table = handle->as.table.table;
    if (index >= table->cur_size)
        return resource_error(handle->store, SILK_WASM_RANGE_ERROR, "Table index out of bounds");
    uint8_t type = (uint8_t)handle->as.table.element;
    if (!silk_wasm_value_matches(handle->store, handle->as.table.type_module,
            type, table->elem_ref_type.elem_ref_type, value)) return false;
    type = silk_wasm_conversion_type(type, table->elem_ref_type.elem_ref_type);
    table_elem_type_t cell = 0, old = table->elems[index];
    if (!silk_wasm_to_cells(handle->store, NULL, &type, 1, value, (uint32_t *)&cell))
        return false;
    table->elems[index] = cell;
    if (!silk_wasm_sync_edges(handle, silk_wasm_resource_visit)) {
        table->elems[index] = old;
        return false;
    }
    return true;
}

uint8_t silk_wasm_table_grow(SilkWasmHandle *handle, uint64_t delta,
                          const SilkWasmValue *value, uint64_t *previous)
{
    WASMTableInstance *table = handle->as.table.table;
    *previous = table->cur_size;
    if (delta > UINT32_MAX || delta > table->max_size - table->cur_size)
        return resource_error(handle->store, SILK_WASM_RANGE_ERROR, "WebAssembly table growth failed");
    uint8_t type = (uint8_t)handle->as.table.element;
    if (!silk_wasm_value_matches(handle->store, handle->as.table.type_module,
            type, table->elem_ref_type.elem_ref_type, value)) return false;
    type = silk_wasm_conversion_type(type, table->elem_ref_type.elem_ref_type);
    table_elem_type_t cell = 0;
    if (!silk_wasm_to_cells(handle->store, NULL, &type, 1, value, (uint32_t *)&cell))
        return false;
    if (!wasm_silk_table_grow(table, (uint32_t)delta, cell)) return false;
    if (!silk_wasm_sync_edges(handle, silk_wasm_resource_visit)) {
        table->cur_size = (uint32_t)*previous;
        return false;
    }
    return true;
}

SilkWasmHandle *silk_wasm_global(SilkWasmStore *store, uint32_t type, uint8_t mutable_,
                                 const SilkWasmValue *value)
{
    if (type != SILK_WASM_I32 && type != SILK_WASM_I64
        && type != SILK_WASM_F32 && type != SILK_WASM_F64 && !reference_type(type)) {
        resource_error(store, SILK_WASM_TYPE_ERROR, "Invalid global value type");
        return NULL;
    }
    SilkWasmHandle *handle = silk_wasm_new_handle(store, SILK_WASM_GLOBAL);
    if (!handle) return NULL;
    handle->as.global.type = type;
    handle->as.global.mutable_ = mutable_;
    uint8_t byte_type = (uint8_t)type;
    if (!silk_wasm_to_cells(store, NULL, &byte_type, 1, value,
                            (uint32_t *)handle->as.global.cells)
        || !silk_wasm_sync_edges(handle, silk_wasm_resource_visit)
        || !silk_wasm_publish(handle)) {
        silk_wasm_free(handle);
        return NULL;
    }
    return handle;
}

uint8_t silk_wasm_global_get(SilkWasmHandle *handle, SilkWasmValue *value)
{
    uint8_t type = silk_wasm_conversion_type((uint8_t)handle->as.global.type,
                                             handle->as.global.ref_type);
    return silk_wasm_from_cells(handle->store, NULL, &type, 1,
                                (const uint32_t *)handle->as.global.cells, value);
}

uint8_t silk_wasm_global_set(SilkWasmHandle *handle, const SilkWasmValue *value)
{
    if (!handle->as.global.mutable_)
        return resource_error(handle->store, SILK_WASM_TYPE_ERROR, "Immutable WebAssembly global");
    uint32_t cells[4] = { 0 }, old[4];
    uint8_t type = (uint8_t)handle->as.global.type;
    if (!silk_wasm_value_matches(handle->store, handle->as.global.type_module,
            type, handle->as.global.ref_type, value)) return false;
    type = silk_wasm_conversion_type(type, handle->as.global.ref_type);
    if (!silk_wasm_to_cells(handle->store, NULL, &type, 1, value, cells)) return false;
    memcpy(old, handle->as.global.cells, sizeof(old));
    memcpy(handle->as.global.cells, cells, sizeof(cells));
    if (!silk_wasm_sync_edges(handle, silk_wasm_resource_visit)) {
        memcpy(handle->as.global.cells, old, sizeof(old));
        return false;
    }
    return true;
}

uint32_t silk_wasm_value_type(SilkWasmHandle *handle)
{
    return handle->kind == SILK_WASM_GLOBAL
        ? silk_wasm_js_type(handle->as.global.type_module,
                            (uint8_t)handle->as.global.type, handle->as.global.ref_type)
        : silk_wasm_js_type(handle->as.table.type_module,
                            (uint8_t)handle->as.table.element,
                            handle->as.table.table->elem_ref_type.elem_ref_type);
}

void silk_wasm_resource_visit(SilkWasmHandle *owner, SilkWasmVisitHandle handle,
                              SilkWasmVisitReference reference, void *context)
{
    if (owner->kind == SILK_WASM_TABLE && owner->as.table.table) {
        WASMTableInstance *table = owner->as.table.table;
        uint8_t type = silk_wasm_conversion_type((uint8_t)owner->as.table.element,
                                                 table->elem_ref_type.elem_ref_type);
        for (uint32_t i = 0; i < table->cur_size; ++i)
            silk_wasm_visit_cells(owner->store, type,
                                  (const uint32_t *)&table->elems[i],
                                  handle, reference, context);
    } else if (owner->kind == SILK_WASM_GLOBAL) {
        uint8_t type = silk_wasm_conversion_type((uint8_t)owner->as.global.type,
                                                 owner->as.global.ref_type);
        silk_wasm_visit_cells(owner->store, type,
                              (const uint32_t *)owner->as.global.cells,
                              handle, reference, context);
    }
}

void silk_wasm_resource_destroy(SilkWasmHandle *handle)
{
    if (handle->kind == SILK_WASM_MEMORY && handle->as.memory.backing) {
        SilkWasmBacking *backing = handle->as.memory.backing;
        SilkWasmMemoryObserver **link = &handle->store->memory_observers;
        while (*link && *link != &handle->as.memory.observer) link = &(*link)->next;
        if (*link) *link = (*link)->next;
        handle->as.memory.backing = NULL;
        silk_wasm_backing_release(backing);
    } else if (handle->kind == SILK_WASM_TABLE) {
        wasm_silk_table_delete(handle->as.table.table);
        handle->as.table.table = NULL;
    }
}

bool silk_wasm_resource_type(SilkWasmHandle *handle, SilkWasmTypeInfo *info)
{
    memset(info, 0, sizeof(*info));
    info->kind = handle->kind;
    if (handle->kind == SILK_WASM_MEMORY) {
        SilkWasmBacking *backing = handle->as.memory.backing;
        info->minimum = memory_bytes(backing->memory) / SILK_WASM_PAGE_SIZE;
        info->maximum = backing->maximum;
        info->has_maximum = backing->has_maximum;
        info->shared = backing->memory->is_shared_memory != 0;
        info->address64 = backing->memory->is_memory64 != 0;
    } else if (handle->kind == SILK_WASM_TABLE) {
        info->value_type = silk_wasm_value_type(handle);
        info->minimum = handle->as.table.table->cur_size;
        info->maximum = handle->as.table.maximum;
        info->has_maximum = handle->as.table.has_maximum;
        info->address64 = handle->as.table.address64;
    } else if (handle->kind == SILK_WASM_GLOBAL) {
        info->value_type = silk_wasm_value_type(handle);
        info->mutable_ = handle->as.global.mutable_;
    } else return false;
    return true;
}

static SilkWasmHandle *instance_owner(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = wasm_silk_context(instance);
    owner->as.instance.instance = instance;
    return owner;
}

static bool bind_edge(SilkWasmHandle *owner, SilkWasmHandle **slot,
                       SilkWasmHandle *resource)
{
    if (!resource || !silk_wasm_edge_handle(owner, resource)) return false;
    *slot = resource;
    return true;
}

static WASMMemoryInstance *bind_memory(WASMModuleInstance *instance, uint32_t index,
                                       bool imported, uint32_t page_bytes,
                                       uint32_t initial, uint32_t maximum,
                                       uint32_t flags)
{
    SilkWasmHandle *owner = instance_owner(instance), *resource;
    if (page_bytes != SILK_WASM_PAGE_SIZE) {
        resource_error(owner->store, SILK_WASM_LINK_ERROR, "Unexpected WebAssembly page size");
        return NULL;
    }
    if (imported) {
        WASMImport *decl = &instance->module->import_memories[index];
        resource = owner->as.instance.imports[decl->silk_original_index].handle;
        if (!resource || resource->kind != SILK_WASM_MEMORY) goto mismatch;
        SilkWasmTypeInfo type;
        silk_wasm_resource_type(resource, &type);
        if (type.minimum < initial || type.shared != !!(flags & SHARED_MEMORY_FLAG)
            || type.address64 != !!(flags & MEMORY64_FLAG)
            || ((flags & MAX_PAGE_COUNT_FLAG)
                && (!type.has_maximum || type.maximum > maximum))) goto mismatch;
    } else {
        resource = silk_wasm_memory(owner->store, initial, maximum,
                    !!(flags & MAX_PAGE_COUNT_FLAG), !!(flags & SHARED_MEMORY_FLAG),
                    !!(flags & MEMORY64_FLAG));
    }
    if (!bind_edge(owner, &owner->as.instance.memories[index], resource)) return NULL;
    return resource->as.memory.backing->memory;
mismatch:
    resource_error(owner->store, SILK_WASM_LINK_ERROR, "Incompatible memory import");
    return NULL;
}

static WASMTableInstance *bind_table(WASMModuleInstance *instance, uint32_t index,
                                     bool imported, const WASMTableInstance *decl)
{
    SilkWasmHandle *owner = instance_owner(instance), *resource;
    WASMTableType *type = imported
        ? &instance->module->import_tables[index].u.table.table_type
        : &instance->module->tables[index - instance->module->import_table_count].table_type;
    if (imported) {
        WASMImport *import = &instance->module->import_tables[index];
        resource = owner->as.instance.imports[import->silk_original_index].handle;
        if (!resource || resource->kind != SILK_WASM_TABLE) goto mismatch;
        WASMTableInstance *actual = resource->as.table.table;
        if (!wasm_silk_reftype_matches(instance->module, decl->elem_type,
                    decl->elem_ref_type.elem_ref_type,
                    resource->as.table.type_module, actual->elem_type,
                    actual->elem_ref_type.elem_ref_type)
            || !wasm_silk_reftype_matches(resource->as.table.type_module,
                    actual->elem_type, actual->elem_ref_type.elem_ref_type,
                    instance->module, decl->elem_type,
                    decl->elem_ref_type.elem_ref_type)
            || actual->is_table64 != decl->is_table64
            || actual->cur_size < decl->cur_size
            || ((type->flags & MAX_TABLE_SIZE_FLAG)
                && (!resource->as.table.has_maximum
                    || resource->as.table.maximum > type->silk_declared_maximum)))
            goto mismatch;
    } else {
        resource = silk_wasm_new_handle(owner->store, SILK_WASM_TABLE);
        if (!resource) return NULL;
        resource->as.table.element = decl->elem_type;
        resource->as.table.has_maximum = !!(type->flags & MAX_TABLE_SIZE_FLAG);
        resource->as.table.address64 = decl->is_table64;
        resource->as.table.type_module = instance->module;
        resource->as.table.maximum = type->silk_declared_maximum;
        uint32_t capacity = decl->max_size < SILK_WASM_TABLE_CAPACITY
            ? decl->max_size : SILK_WASM_TABLE_CAPACITY;
        resource->as.table.table = wasm_silk_table_new(decl->elem_type,
                    decl->is_table64, decl->cur_size, capacity, NULL_REF);
        if (!resource->as.table.table) {
            resource_error(owner->store, SILK_WASM_OOM, "Cannot allocate WebAssembly table");
            silk_wasm_free(resource);
            return NULL;
        }
        resource->as.table.table->elem_ref_type = decl->elem_ref_type;
        if (!silk_wasm_edge_handle(resource, owner->as.instance.module)
            || !silk_wasm_publish(resource)) {
            if (!resource->published) silk_wasm_free(resource);
            return NULL;
        }
    }
    if (!bind_edge(owner, &owner->as.instance.tables[index], resource)) return NULL;
    return resource->as.table.table;
mismatch:
    resource_error(owner->store, SILK_WASM_LINK_ERROR, "Incompatible table import");
    return NULL;
}

static uint8_t *bind_global(WASMModuleInstance *instance, uint32_t index,
                            bool imported, const WASMGlobalInstance *decl)
{
    SilkWasmHandle *owner = instance_owner(instance), *resource = NULL;
    if (imported) {
        WASMImport *import = &instance->module->import_globals[index];
        SilkWasmImport *value = &owner->as.instance.imports[import->silk_original_index];
        resource = value->handle;
        if (resource) {
            if (resource->kind != SILK_WASM_GLOBAL
                || resource->as.global.mutable_ != decl->is_mutable) goto mismatch;
            if (wasm_is_type_reftype(decl->type)) {
                if (!wasm_silk_reftype_matches(instance->module, decl->type,
                        decl->ref_type, resource->as.global.type_module,
                        (uint8_t)resource->as.global.type, resource->as.global.ref_type))
                    goto mismatch;
                if (decl->is_mutable
                    && !wasm_silk_reftype_matches(resource->as.global.type_module,
                        (uint8_t)resource->as.global.type, resource->as.global.ref_type,
                        instance->module, decl->type, decl->ref_type))
                    goto mismatch;
            } else if (resource->as.global.type != decl->type) goto mismatch;
        } else {
            if (decl->is_mutable) goto mismatch;
            if (!silk_wasm_value_matches(owner->store, instance->module,
                    decl->type, decl->ref_type, &value->value)) goto mismatch;
            resource = silk_wasm_new_handle(owner->store, SILK_WASM_GLOBAL);
            if (!resource) return NULL;
            resource->as.global.type = decl->type;
            resource->as.global.type_module = instance->module;
            resource->as.global.ref_type = decl->ref_type;
            uint8_t conversion = silk_wasm_conversion_type(decl->type, decl->ref_type);
            if (!silk_wasm_to_cells(owner->store, NULL, &conversion, 1,
                    &value->value, (uint32_t *)resource->as.global.cells)
                || !silk_wasm_edge_handle(resource, owner->as.instance.module)
                || !silk_wasm_sync_edges(resource, silk_wasm_resource_visit)
                || !silk_wasm_publish(resource)) {
                if (!resource->published) silk_wasm_free(resource);
                return NULL;
            }
        }
    } else {
        resource = silk_wasm_new_handle(owner->store, SILK_WASM_GLOBAL);
        if (!resource) return NULL;
        resource->as.global.type = decl->type;
        resource->as.global.mutable_ = decl->is_mutable;
        resource->as.global.type_module = instance->module;
        resource->as.global.ref_type = decl->ref_type;
        memcpy(resource->as.global.cells, instance->global_data + decl->data_offset,
               wasm_value_type_size(decl->type));
        if (!silk_wasm_edge_handle(resource, owner->as.instance.module)
            || !silk_wasm_sync_edges(resource, silk_wasm_resource_visit)
            || !silk_wasm_publish(resource)) {
            if (!resource->published) silk_wasm_free(resource);
            return NULL;
        }
    }
    if (!bind_edge(owner, &owner->as.instance.globals[index], resource)) return NULL;
    return resource->as.global.cells;
mismatch:
    resource_error(owner->store, SILK_WASM_LINK_ERROR, "Incompatible global import");
    return NULL;
}

static void *bind_tag(WASMModuleInstance *instance, uint32_t index)
{
    SilkWasmHandle *owner = instance_owner(instance);
    if (owner->as.instance.tags[index]) return owner->as.instance.tags[index];
    SilkWasmHandle *tag;
    if (index < instance->module->import_tag_count) {
        WASMImport *decl = &instance->module->import_tags[index];
        tag = owner->as.instance.imports[decl->silk_original_index].handle;
        if (!tag || tag->kind != SILK_WASM_TAG) {
            resource_error(owner->store, SILK_WASM_LINK_ERROR, "Incompatible tag import");
            return NULL;
        }
        WASMFuncType *expected = decl->u.tag.tag_type;
        if (!wasm_silk_func_type_matches(instance->module, expected,
                                        tag->as.tag.type_module, tag->as.tag.type)
            || !wasm_silk_func_type_matches(tag->as.tag.type_module,
                                            tag->as.tag.type,
                                            instance->module, expected)) {
            resource_error(owner->store, SILK_WASM_LINK_ERROR, "Incompatible tag signature");
            return NULL;
        }
    } else {
        tag = silk_wasm_tag_from_guest(owner, index,
                instance->module->tags[index - instance->module->import_tag_count]->tag_type);
    }
    return bind_edge(owner, &owner->as.instance.tags[index], tag) ? tag : NULL;
}

static void retain_instance(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = instance_owner(instance);
    if (owner->as.instance.native_references++ == 0)
        owner->store->callbacks.retain_handle(owner->store->context, owner);
}
static void release_instance(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = instance_owner(instance);
    if (--owner->as.instance.native_references == 0)
        owner->store->callbacks.release_handle(owner->store->context, owner);
}
static bool keep_instance(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = instance_owner(instance);
    return (owner->published && !owner->finalized)
        || owner->as.instance.native_references != 0;
}
static void destroy_instance_binding(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = wasm_silk_context(instance);
    owner->as.instance.instance = NULL;
    /* The native owner destructor releases its edge vector after this returns. */
}
static bool function_owner(WASMModuleInstance *instance, uint32_t index,
                           WASMModuleInstance **target, uint32_t *target_index)
{
    SilkWasmHandle *owner = instance_owner(instance);
    if (index < instance->module->import_function_count) {
        WASMImport *decl = &instance->module->import_functions[index];
        SilkWasmHandle *function = owner->as.instance.imports[decl->silk_original_index].handle;
        if (function && function->kind == SILK_WASM_FUNCTION) {
            *target = function->as.function.instance->as.instance.instance;
            *target_index = function->as.function.index;
            return *target != NULL;
        }
    }
    *target = instance;
    *target_index = index;
    return true;
}
static bool function_ref(WASMModuleInstance *instance, uint32_t index,
                          WASMFuncObjectRef *reference)
{
    SilkWasmHandle *owner = instance_owner(instance);
    *reference = NULL;
    if (index < instance->module->import_function_count) {
        WASMImport *decl = &instance->module->import_functions[index];
        SilkWasmHandle *function = owner->as.instance.imports[decl->silk_original_index].handle;
        if (function && function->kind == SILK_WASM_FUNCTION) {
            SilkWasmValue value = { .ref = function, .ref_kind = SILK_WASM_REF_HANDLE };
            uint8_t type = SILK_WASM_FUNCREF;
            return silk_wasm_to_cells(owner->store, NULL, &type, 1, &value,
                                      (uint32_t *)reference);
        }
    }
    return true;
}
static void *store_heap(WASMModuleInstance *instance)
{
    SilkWasmStore *store = instance_owner(instance)->store;
    if (!store->gc_heap)
        store->gc_heap = wasm_silk_gc_heap_new(16U * 1024U * 1024U, &store->gc_pool);
    return store->gc_heap;
}

static bool add_root(void *heap, void *object)
{
    return !object || !wasm_obj_is_created_from_heap(object)
        || (mem_allocator_contains_gc_object(heap, object)
            && mem_allocator_add_root(heap, object) == 0);
}

static bool store_roots(WASMModuleInstance *instance, void *heap)
{
    SilkWasmStore *store = instance_owner(instance)->store;
    for (SilkWasmHandle *owner = store->handles; owner; owner = owner->next) {
        if (owner->finalized) continue;
        if (owner->kind == SILK_WASM_INSTANCE && owner->as.instance.instance) {
            if (!wasm_silk_traverse_instance_roots(owner->as.instance.instance, heap))
                return false;
        } else if (owner->kind == SILK_WASM_TABLE && owner->as.table.table) {
            WASMTableInstance *table = owner->as.table.table;
            for (uint32_t i = 0; i < table->cur_size; ++i)
                if (!add_root(heap, (void *)table->elems[i])) return false;
        } else if (owner->kind == SILK_WASM_GLOBAL
                   && wasm_is_type_reftype((uint8_t)owner->as.global.type)) {
            void *reference;
            memcpy(&reference, owner->as.global.cells, sizeof(reference));
            if (!add_root(heap, reference)) return false;
        } else if (owner->kind == SILK_WASM_EXCEPTION && owner->as.exception.guest) {
            if (!add_root(heap, owner->as.exception.guest)) return false;
        }
    }
    return silk_wasm_reference_roots(store, heap)
        && silk_wasm_invocation_roots(store, heap);
}

static bool check_interrupt(WASMModuleInstance *instance)
{
    SilkWasmHandle *owner = wasm_silk_context(instance);
    SilkWasmStore *store = owner->store;
    return store->callbacks.interrupt
        && store->callbacks.interrupt(store->context) != 0;
}

const WASMSilkResourceHooks silk_wasm_resource_hooks = {
    .memory = bind_memory,
    .table = bind_table,
    .global = bind_global,
    .function = silk_wasm_bind_function,
    .tag = bind_tag,
    .retain = retain_instance,
    .release = release_instance,
    .keep_alive = keep_instance,
    .destroy = destroy_instance_binding,
    .function_owner = function_owner,
    .function_ref = function_ref,
    .gc_heap = store_heap,
    .gc_roots = store_roots,
    .interrupt = check_interrupt
};
