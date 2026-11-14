/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception */
#if WASM_ENABLE_EXCE_HANDLING != 0 && WASM_ENABLE_GC != 0
static WASMRefType *
silk_eh_ref_type(WASMRefTypeMap *maps, uint32 count, uint32 index)
{
    uint32 i;
    for (i = 0; i < count; i++)
        if (maps[i].index == index)
            return maps[i].ref_type;
    return NULL;
}

static bool
silk_eh_check_target(WASMModule *module, BranchBlock *target,
                     WASMFuncType *tag, uint8 kind,
                     char *error_buf, uint32 error_buf_size)
{
    uint8 *types;
    WASMRefTypeMap *maps;
    uint32 map_count, arity, i, base = 0;
    uint32 payload_count = kind < 2 ? tag->param_count : 0;
    WASMRefType exn_type;
    if (target->label_type == LABEL_TYPE_LOOP)
        arity = block_type_get_param_types(&target->block_type, &types,
                                           &maps, &map_count);
    else {
        arity = block_type_get_result_types(&target->block_type, &types,
                                            &maps, &map_count);
        if (!target->block_type.is_value_type)
            base = target->block_type.u.type->param_count;
    }
    if (arity != payload_count + (kind & 1))
        goto mismatch;
    wasm_set_refheaptype_common(&exn_type.ref_ht_common, false, HEAP_TYPE_EXN);
    for (i = 0; i < arity; i++) {
        uint8 source_type = i < payload_count ? tag->types[i]
                                              : REF_TYPE_HT_NON_NULLABLE;
        WASMRefType *source_ref = i < payload_count
            ? silk_eh_ref_type(tag->ref_type_maps, tag->ref_type_map_count, i)
            : &exn_type;
        WASMRefType *target_ref = silk_eh_ref_type(maps, map_count, base + i);
        if (!wasm_reftype_is_subtype_of(source_type, source_ref, types[i],
                                        target_ref, module->types,
                                        module->type_count))
            goto mismatch;
    }
    return true;
mismatch:
    set_error_buf(error_buf, error_buf_size, "catch target type mismatch");
    return false;
}
#endif
