#include "silk_wamr_types.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if WASM_ENABLE_GC != 0
#include "gc_type.h"

/* Group references are compared by their de Bruijn position, not by module
 * type index. Dependencies outside a group enter this workset. Keeping each
 * pair once avoids exponential revisits of shared type DAGs and uses no C
 * recursion, including for adversarially deep but valid modules. */
typedef struct TypePair {
    const WASMType *expected;
    const WASMType *actual;
} TypePair;

enum { INLINE_PAIRS = 16 };
typedef struct TypeWork {
    const WASMModule *expected_module;
    const WASMModule *actual_module;
    TypePair *pairs;
    size_t *buckets;
    size_t count;
    size_t capacity;
    void *allocation;
    TypePair inline_pairs[INLINE_PAIRS];
    size_t inline_buckets[INLINE_PAIRS * 2];
} TypeWork;

static size_t
pair_hash(const WASMType *expected, const WASMType *actual)
{
    uintptr_t first = (uintptr_t)expected >> 3;
    uintptr_t second = (uintptr_t)actual >> 3;
    first ^= first >> 17;
    second ^= second >> 11;
    return (size_t)(first * (uintptr_t)0x9e3779b1U
                    ^ second * (uintptr_t)0x85ebca6bU);
}

static size_t
pair_bucket(const TypeWork *work, const WASMType *expected,
            const WASMType *actual)
{
    size_t mask = work->capacity * 2 - 1;
    size_t bucket = pair_hash(expected, actual) & mask;
    while (work->buckets[bucket]) {
        const TypePair *pair = &work->pairs[work->buckets[bucket] - 1];
        if (pair->expected == expected && pair->actual == actual)
            break;
        bucket = (bucket + 1) & mask;
    }
    return bucket;
}

static bool
work_grow(TypeWork *work)
{
    size_t capacity, bytes, index;
    TypePair *pairs;
    size_t *buckets;
    void *allocation;
    if (work->capacity > SIZE_MAX / 2)
        return false;
    capacity = work->capacity * 2;
    if (capacity > SIZE_MAX / (sizeof(TypePair) + 2 * sizeof(size_t)))
        return false;
    bytes = capacity * (sizeof(TypePair) + 2 * sizeof(size_t));
    allocation = malloc(bytes);
    if (!allocation)
        return false;
    pairs = allocation;
    buckets = (size_t *)(pairs + capacity);
    memcpy(pairs, work->pairs, work->count * sizeof(TypePair));
    memset(buckets, 0, capacity * 2 * sizeof(size_t));
    free(work->allocation);
    work->allocation = allocation;
    work->pairs = pairs;
    work->buckets = buckets;
    work->capacity = capacity;
    for (index = 0; index < work->count; index++) {
        size_t bucket = pair_bucket(work, pairs[index].expected,
                                    pairs[index].actual);
        buckets[bucket] = index + 1;
    }
    return true;
}

static const WASMType *
group_member(const WASMModule *module, const WASMType *type, uint32 index)
{
    if (index >= type->rec_count)
        return NULL;
    /* A standalone synthesized signature need not have a module type table. */
    if (type->rec_count == 1)
        return type;
    if (!module || type->rec_begin_type_idx >= module->type_count
        || index >= module->type_count - type->rec_begin_type_idx)
        return NULL;
    return module->types[type->rec_begin_type_idx + index];
}

static bool
add_types(TypeWork *work, const WASMType *expected, const WASMType *actual)
{
    size_t bucket;
    if (expected == actual)
        return true;
    if (!expected || !actual || !expected->rec_count
        || expected->rec_count != actual->rec_count
        || expected->rec_idx != actual->rec_idx
        || expected->type_flag != actual->type_flag
        || expected->is_sub_final != actual->is_sub_final)
        return false;
    expected = group_member(work->expected_module, expected, 0);
    actual = group_member(work->actual_module, actual, 0);
    if (!expected || !actual)
        return false;
    bucket = pair_bucket(work, expected, actual);
    if (work->buckets[bucket])
        return true;
    if (work->count == work->capacity) {
        if (!work_grow(work))
            return false;
        bucket = pair_bucket(work, expected, actual);
    }
    work->pairs[work->count].expected = expected;
    work->pairs[work->count].actual = actual;
    work->buckets[bucket] = ++work->count;
    return true;
}

static bool
inside_group(const WASMType *group, uint32 index)
{
    return index >= group->rec_begin_type_idx
           && index - group->rec_begin_type_idx < group->rec_count;
}

static bool
indices_equal(TypeWork *work, const WASMType *expected_group,
               uint32 expected_index, const WASMType *actual_group,
               uint32 actual_index)
{
    bool expected_local = inside_group(expected_group, expected_index);
    bool actual_local = inside_group(actual_group, actual_index);
    if (expected_local || actual_local)
        return expected_local && actual_local
               && expected_index - expected_group->rec_begin_type_idx
                      == actual_index - actual_group->rec_begin_type_idx;
    if (!work->expected_module || !work->actual_module
        || expected_index >= work->expected_module->type_count
        || actual_index >= work->actual_module->type_count)
        return false;
    return add_types(work, work->expected_module->types[expected_index],
                     work->actual_module->types[actual_index]);
}

static const WASMRefType *
next_reference(uint8 type, uint32 index, const WASMRefTypeMap *maps,
               uint32 count, uint32 *cursor)
{
    if (!wasm_is_type_multi_byte_type(type))
        return NULL;
    if (*cursor >= count || maps[*cursor].index != index)
        return NULL;
    return maps[(*cursor)++].ref_type;
}

static bool
value_equal(TypeWork *work, const WASMType *expected_group,
             uint8 expected, const WASMRefType *expected_reference,
             const WASMType *actual_group, uint8 actual,
             const WASMRefType *actual_reference)
{
    bool expected_multi = wasm_is_type_multi_byte_type(expected);
    bool actual_multi = wasm_is_type_multi_byte_type(actual);
    int32 expected_heap, actual_heap;
    bool expected_nullable, actual_nullable;
    if (!expected_multi && !actual_multi)
        return expected == actual;
    if ((expected_multi && !expected_reference)
        || (actual_multi && !actual_reference))
        return false;
    if (!wasm_is_type_reftype(expected) || !wasm_is_type_reftype(actual))
        return false;
    expected_nullable = !expected_multi || expected == REF_TYPE_HT_NULLABLE;
    actual_nullable = !actual_multi || actual == REF_TYPE_HT_NULLABLE;
    if (expected_nullable != actual_nullable)
        return false;
    expected_heap = expected_multi
                        ? expected_reference->ref_ht_common.heap_type
                        : (int32)expected - REF_TYPE_FUNCREF + HEAP_TYPE_FUNC;
    actual_heap = actual_multi
                      ? actual_reference->ref_ht_common.heap_type
                      : (int32)actual - REF_TYPE_FUNCREF + HEAP_TYPE_FUNC;
    if (expected_heap < 0 || actual_heap < 0)
        return expected_heap == actual_heap;
    return indices_equal(work, expected_group, (uint32)expected_heap,
                         actual_group, (uint32)actual_heap);
}

static bool
body_equal(TypeWork *work, const WASMType *expected, const WASMType *actual)
{
    uint32 index, expected_cursor = 0, actual_cursor = 0;
    if (expected->type_flag == WASM_TYPE_FUNC) {
        const WASMFuncType *first = (const WASMFuncType *)expected;
        const WASMFuncType *second = (const WASMFuncType *)actual;
        uint32 count = (uint32)first->param_count + first->result_count;
        if (first->param_count != second->param_count
            || first->result_count != second->result_count)
            return false;
        for (index = 0; index < count; index++) {
            const WASMRefType *first_ref = next_reference(
                first->types[index], index, first->ref_type_maps,
                first->ref_type_map_count, &expected_cursor);
            const WASMRefType *second_ref = next_reference(
                second->types[index], index, second->ref_type_maps,
                second->ref_type_map_count, &actual_cursor);
            if (!value_equal(work, expected, first->types[index], first_ref,
                             actual, second->types[index], second_ref))
                return false;
        }
        return true;
    }
    if (expected->type_flag == WASM_TYPE_STRUCT) {
        const WASMStructType *first = (const WASMStructType *)expected;
        const WASMStructType *second = (const WASMStructType *)actual;
        if (first->field_count != second->field_count)
            return false;
        for (index = 0; index < first->field_count; index++) {
            const WASMRefType *first_ref = next_reference(
                first->fields[index].field_type, index, first->ref_type_maps,
                first->ref_type_map_count, &expected_cursor);
            const WASMRefType *second_ref = next_reference(
                second->fields[index].field_type, index, second->ref_type_maps,
                second->ref_type_map_count, &actual_cursor);
            if (first->fields[index].field_flags != second->fields[index].field_flags
                || !value_equal(work, expected, first->fields[index].field_type,
                                first_ref, actual, second->fields[index].field_type,
                                second_ref))
                return false;
        }
        return true;
    }
    if (expected->type_flag == WASM_TYPE_ARRAY) {
        const WASMArrayType *first = (const WASMArrayType *)expected;
        const WASMArrayType *second = (const WASMArrayType *)actual;
        return first->elem_flags == second->elem_flags
               && value_equal(work, expected, first->elem_type,
                              first->elem_ref_type, actual, second->elem_type,
                              second->elem_ref_type);
    }
    return false;
}

static bool
group_equal(TypeWork *work, const WASMType *expected_group,
             const WASMType *actual_group)
{
    uint32 index;
    if (expected_group->rec_count != actual_group->rec_count)
        return false;
    for (index = 0; index < expected_group->rec_count; index++) {
        const WASMType *expected = group_member(work->expected_module,
                                               expected_group, index);
        const WASMType *actual = group_member(work->actual_module,
                                             actual_group, index);
        if (!expected || !actual || expected->type_flag != actual->type_flag
            || expected->is_sub_final != actual->is_sub_final
            || expected->rec_idx != actual->rec_idx
            || expected->rec_count != actual->rec_count)
            return false;
        if (expected->parent_type || actual->parent_type) {
            if (!expected->parent_type || !actual->parent_type)
                return false;
            if (inside_group(expected, expected->parent_type_idx)
                || inside_group(actual, actual->parent_type_idx)) {
                if (!indices_equal(work, expected, expected->parent_type_idx,
                                   actual, actual->parent_type_idx))
                    return false;
            }
            else if (!add_types(work, expected->parent_type, actual->parent_type))
                return false;
        }
        if (!body_equal(work, expected, actual))
            return false;
    }
    return true;
}

static bool
closed_type_equal(const WASMModule *expected_module, const WASMType *expected,
                   const WASMModule *actual_module, const WASMType *actual)
{
    TypeWork work;
    size_t cursor;
    bool equal;
    if (expected == actual)
        return true;
    work.expected_module = expected_module;
    work.actual_module = actual_module;
    work.pairs = work.inline_pairs;
    work.buckets = work.inline_buckets;
    work.count = 0;
    work.capacity = INLINE_PAIRS;
    work.allocation = NULL;
    memset(work.inline_buckets, 0, sizeof(work.inline_buckets));
    equal = add_types(&work, expected, actual);
    for (cursor = 0; equal && cursor < work.count; cursor++) {
        /* Adding dependencies may grow and move the workset. */
        const WASMType *first = work.pairs[cursor].expected;
        const WASMType *second = work.pairs[cursor].actual;
        equal = group_equal(&work, first, second);
    }
    free(work.allocation);
    return equal;
}

bool
wasm_silk_type_matches(const WASMModule *expected_module, const WASMType *expected,
                       const WASMModule *actual_module, const WASMType *actual)
{
    if (!expected || !actual || expected->type_flag != actual->type_flag
        || actual->inherit_depth < expected->inherit_depth)
        return false;
    /* Subtyping of defined types is declared, not inferred from a coincidental
     * match of parameter/field layouts. Validation has checked variance on each
     * parent edge. Equal closed types necessarily have equal ancestry depth. */
    while (actual->inherit_depth > expected->inherit_depth) {
        const WASMType *parent = actual->parent_type;
        if (!parent || parent->inherit_depth >= actual->inherit_depth)
            return false;
        actual = parent;
    }
    return closed_type_equal(expected_module, expected, actual_module, actual);
}

bool
wasm_silk_reftype_matches(const WASMModule *expected_module, uint8 expected_type,
                          const WASMRefType *expected_reference,
                          const WASMModule *actual_module, uint8 actual_type,
                          const WASMRefType *actual_reference)
{
    bool expected_multi = wasm_is_type_multi_byte_type(expected_type);
    bool actual_multi = wasm_is_type_multi_byte_type(actual_type);
    bool expected_indexed, actual_indexed;
    const WASMModule *index_module;
    if ((expected_multi && !expected_reference)
        || (actual_multi && !actual_reference))
        return false;
    expected_indexed = expected_multi
                       && expected_reference->ref_ht_common.heap_type >= 0;
    actual_indexed = actual_multi
                     && actual_reference->ref_ht_common.heap_type >= 0;
    if (expected_indexed
        && (!expected_module
            || (uint32)expected_reference->ref_ht_typeidx.type_idx
                   >= expected_module->type_count))
        return false;
    if (actual_indexed
        && (!actual_module
            || (uint32)actual_reference->ref_ht_typeidx.type_idx
                   >= actual_module->type_count))
        return false;
    if (expected_indexed && actual_indexed) {
        if (actual_type == REF_TYPE_HT_NULLABLE
            && expected_type == REF_TYPE_HT_NON_NULLABLE)
            return false;
        return wasm_silk_type_matches(
            expected_module,
            expected_module->types[expected_reference->ref_ht_typeidx.type_idx],
            actual_module,
            actual_module->types[actual_reference->ref_ht_typeidx.type_idx]);
    }
    /* At most one side now contains an index. WAMR's abstract heap lattice and
     * nullability rules can therefore safely use that side's module table. */
    index_module = expected_indexed ? expected_module
                   : actual_indexed ? actual_module : NULL;
    return wasm_reftype_is_subtype_of(
        actual_type, actual_reference, expected_type, expected_reference,
        index_module ? index_module->types : NULL,
        index_module ? index_module->type_count : 0);
}
#endif

bool
wasm_silk_func_type_matches(const WASMModule *expected_module,
                            const WASMFuncType *expected_type,
                            const WASMModule *actual_module,
                            const WASMFuncType *actual_type)
{
    if (!expected_type || !actual_type)
        return false;
#if WASM_ENABLE_GC != 0
    return wasm_silk_type_matches(expected_module, &expected_type->base_type,
                                 actual_module, &actual_type->base_type);
#else
    (void)expected_module;
    (void)actual_module;
    return expected_type == actual_type
           || (expected_type->param_count == actual_type->param_count
               && expected_type->result_count == actual_type->result_count
               && memcmp(expected_type->types, actual_type->types,
                         (size_t)expected_type->param_count
                             + expected_type->result_count) == 0);
#endif
}
