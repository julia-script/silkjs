/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 * Classic structured exception handling. All transfers preserve the managed
 * exception object, so catch_ref, legacy rethrow and suspended catches retain
 * both native identity and the GC-traced reference payload.
 */
#define SILK_PUSH_EXCEPTION_PAYLOAD()                                      \
    do {                                                                   \
        uint32 silk_i, silk_cell = 0;                                       \
        word_copy(frame_sp, silk_cells, silk_type->param_cell_num);          \
        CLEAR_FRAME_REF(frame_sp, silk_type->param_cell_num);                \
        for (silk_i = 0; silk_i < silk_type->param_count; silk_i++) {          \
            uint8 silk_t = silk_type->types[silk_i];                         \
            uint32 silk_n = wasm_value_type_cell_num(silk_t);                \
            if (wasm_is_type_reftype(silk_t)                                 \
                && !wasm_is_reftype_i31ref(silk_t))                          \
                memset(FRAME_REF(frame_sp + silk_cell), 1, silk_n);          \
            silk_cell += silk_n;                                           \
        }                                                                  \
        frame_sp += silk_type->param_cell_num;                              \
    } while (0)

            HANDLE_OP(WASM_OP_TRY_TABLE)
            {
                value_type = *frame_ip++;
                if (value_type == REF_TYPE_HT_NULLABLE
                    || value_type == REF_TYPE_HT_NON_NULLABLE)
                    skip_leb(frame_ip);
                param_cell_num = 0;
                cell_num = wasm_value_type_cell_num(value_type);
                goto silk_enter_try_table;
            }
            HANDLE_OP(EXT_OP_TRY_TABLE)
            {
                read_leb_uint32(frame_ip, frame_ip_end, type_index);
                param_cell_num = wasm_types[type_index]->param_cell_num;
                cell_num = wasm_types[type_index]->ret_cell_num;
            silk_enter_try_table:
                {
                    uint8 *handlers = frame_ip;
                    uint32 handler_count, handler_index;
                    read_leb_uint32(frame_ip, frame_ip_end, handler_count);
                    for (handler_index = 0; handler_index < handler_count;
                         handler_index++) {
                        uint8 kind = *frame_ip++;
                        if (kind < 2)
                            skip_leb(frame_ip);
                        skip_leb(frame_ip);
                    }
                    if (!wasm_loader_find_block_addr(
                            exec_env, SILK_BLOCK_CACHE(), SILK_BLOCK_CACHE_MASK,
                            frame_ip, frame_ip_end, LABEL_TYPE_BLOCK,
                            &else_addr, &end_addr)) {
                        wasm_set_exception(module, "invalid try_table boundary");
                        goto got_exception;
                    }
                    PUSH_CSP(LABEL_TYPE_TRY_TABLE, param_cell_num, cell_num,
                             end_addr);
                    (frame_csp - 1)->silk_handlers = handlers;
                    HANDLE_OP_END();
                }
            }
            HANDLE_OP(WASM_OP_RETHROW)
            {
                read_leb_uint32(frame_ip, frame_ip_end, depth);
                exec_env->silk_exception =
                    (frame_csp - depth - 1)->silk_caught_exception;
                goto silk_throw_pending;
            }
            HANDLE_OP(WASM_OP_THROW_REF)
            {
                exec_env->silk_exception = POP_REF();
                if (!exec_env->silk_exception) {
                    wasm_set_exception(module, "null exception reference");
                    goto got_exception;
                }
                goto silk_throw_pending;
            }
            HANDLE_OP(WASM_OP_THROW)
            {
                WASMFuncType *type;
                read_leb_uint32(frame_ip, frame_ip_end, type_index);
                type = module->e->tags[type_index].is_import_tag
                           ? module->e->tags[type_index].u.tag_import->tag_type
                           : module->e->tags[type_index].u.tag->tag_type;
                /* Keep arguments in the scanned operand stack until make has
                 * allocated and rooted its managed payload graph. */
                SYNC_ALL_TO_FRAME();
                exec_env->silk_exception = wasm_silk_exception_hooks.make(
                    exec_env,
                    wasm_silk_exception_hooks.tag_identity(exec_env, module,
                                                           type_index),
                    type, frame_sp - type->param_cell_num);
                if (!exec_env->silk_exception)
                    goto got_exception;
                frame_sp -= type->param_cell_num;
                CLEAR_FRAME_REF(frame_sp, type->param_cell_num);
                goto silk_throw_pending;
            }
            {
            silk_throw_pending:
                {
                    WASMExternrefObjectRef silk_exception =
                        (WASMExternrefObjectRef)exec_env->silk_exception;
                    WASMFuncType *silk_type;
                    const uint32 *silk_cells;
                    void *silk_tag;
                    WASMBranchBlock *silk_block = frame_csp;
                    if (!wasm_silk_exception_hooks.inspect(
                            exec_env, silk_exception, &silk_tag, &silk_type,
                            &silk_cells)) {
                        wasm_set_exception(module, "invalid exception reference");
                        goto got_exception;
                    }
                    while (silk_block > frame->csp_bottom) {
                        silk_block--;
                        if (silk_block->label_type == LABEL_TYPE_TRY_TABLE) {
                            uint8 *cursor = silk_block->silk_handlers;
                            uint32 n, k;
                            read_leb_uint32(cursor, frame_ip_end, n);
                            for (k = 0; k < n; k++) {
                                uint8 kind = *cursor++;
                                uint32 tag = 0, target;
                                if (kind < 2)
                                    read_leb_uint32(cursor, frame_ip_end, tag);
                                read_leb_uint32(cursor, frame_ip_end, target);
                                if (kind < 2
                                    && wasm_silk_exception_hooks.tag_identity(
                                           exec_env, module, tag) != silk_tag)
                                    continue;
                                /* Catch labels are relative to the surrounding
                                 * context, excluding this try_table label. */
                                depth = (uint32)(frame_csp - silk_block) + target;
                                WASMBranchBlock *destination =
                                    frame_csp - depth - 1;
                                CLEAR_FRAME_REF(destination->frame_sp,
                                                frame_sp - destination->frame_sp);
                                frame_sp = destination->frame_sp;
                                if (kind < 2)
                                    SILK_PUSH_EXCEPTION_PAYLOAD();
                                if (kind & 1)
                                    PUSH_REF(silk_exception);
                                exec_env->silk_exception = NULL;
                                goto label_pop_csp_n;
                            }
                        }
                        else if (silk_block->label_type == LABEL_TYPE_TRY) {
                            uint8 *cursor = silk_block->silk_handlers;
                            for (;;) {
                                uint8 *handler_end, *unused_else;
                                uint8 kind;
                                uint32 tag = 0;
                                if (!wasm_loader_find_block_addr(
                                        exec_env, SILK_BLOCK_CACHE(),
                                        SILK_BLOCK_CACHE_MASK, cursor, frame_ip_end, LABEL_TYPE_TRY,
                                        &unused_else, &handler_end)) {
                                    wasm_set_exception(module,
                                                       "invalid catch boundary");
                                    goto got_exception;
                                }
                                kind = *handler_end;
                                cursor = handler_end + 1;
                                if (kind == WASM_OP_END)
                                    break;
                                if (kind == WASM_OP_DELEGATE) {
                                    uint32 target;
                                    read_leb_uint32(cursor, frame_ip_end, target);
                                    silk_block -= target;
                                    break;
                                }
                                if (kind == WASM_OP_CATCH) {
                                    read_leb_uint32(cursor, frame_ip_end, tag);
                                    if (wasm_silk_exception_hooks.tag_identity(
                                            exec_env, module, tag) != silk_tag)
                                        continue;
                                }
                                CLEAR_FRAME_REF(silk_block->frame_sp,
                                                frame_sp - silk_block->frame_sp);
                                frame_sp = silk_block->frame_sp;
                                frame_csp = silk_block + 1;
                                silk_block->label_type = kind == WASM_OP_CATCH
                                                             ? LABEL_TYPE_CATCH
                                                             : LABEL_TYPE_CATCH_ALL;
                                silk_block->silk_caught_exception = silk_exception;
                                if (kind == WASM_OP_CATCH)
                                    SILK_PUSH_EXCEPTION_PAYLOAD();
                                frame_ip = cursor;
                                exec_env->silk_exception = NULL;
                                goto silk_catch_ready;
                            }
                        }
                        else if (silk_block->label_type == LABEL_TYPE_FUNCTION) {
                            /* return_func restores the caller and re-enters
                             * this dispatcher, or leaves pending for the host. */
                            goto return_func;
                        }
                    }
                    wasm_set_exception(module, "invalid exception control stack");
                    goto got_exception;
                }
            }
            silk_catch_ready:
                HANDLE_OP_END();
#undef SILK_PUSH_EXCEPTION_PAYLOAD
