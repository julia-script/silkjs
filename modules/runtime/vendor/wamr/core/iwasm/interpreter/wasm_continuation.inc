/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception */

static WASMFuncType *
silk_invocation_type(WASMFunctionInstance *function)
{
    return function->is_import_func ? function->u.func_import->func_type
                                    : function->u.func->func_type;
}

static void
silk_invocation_ref_flags(uint8 *flags, const uint8 *types, uint32 count)
{
#if WASM_ENABLE_GC != 0
    uint32 i, j, cells;
    for (i = 0; i < count; i++) {
        cells = wasm_value_type_cell_num(types[i]);
        for (j = 0; j < cells; j++)
            *flags++ = wasm_is_type_reftype(types[i])
                       && !wasm_is_reftype_i31ref(types[i]);
    }
#else
    (void)flags;
    (void)types;
    (void)count;
#endif
}

static void
silk_invocation_finish_native(WASMInterpInvocation *inv, const uint32 *results,
                              void *exception)
{
    WASMInterpFrame *native = inv->pending;
    WASMInterpFrame *caller = native->prev_frame;
    WASMFunctionInstance *function = native->function;
    WASMFuncType *type = silk_invocation_type(function);
    if (exception) {
        inv->exception = exception;
#if WASM_ENABLE_EXCE_HANDLING != 0
        inv->env->silk_exception = exception;
#endif
    }
    else {
        if (function->ret_cell_num)
            word_copy(caller->sp, results, function->ret_cell_num);
#if WASM_ENABLE_GC != 0
        if (caller->csp_boundary)
            silk_invocation_ref_flags((uint8 *)caller->csp_boundary
                                          + (caller->sp - caller->lp),
                                      type->types + type->param_count,
                                      type->result_count);
#endif
        caller->sp += function->ret_cell_num;
    }
    inv->pending = NULL;
    wasm_exec_env_set_cur_frame(inv->env, caller);
    wasm_exec_env_set_module_inst(inv->env,
        (WASMModuleInstanceCommon *)caller->module_inst);
    inv->env->aux_stack_boundary = caller->aux_stack_boundary;
    inv->env->aux_stack_bottom = caller->aux_stack_bottom;
    FREE_FRAME(inv->env, native);
}

static void
silk_invocation_call_native(WASMExecEnv *env, WASMFunctionInstance *function,
                            WASMInterpFrame *caller)
{
    WASMInterpInvocation *inv = env->silk_invocation;
    WASMFuncType *type = silk_invocation_type(function);
    uint32 cells = function->param_cell_num + function->ret_cell_num;
    WASMInterpFrame *native;
    uint32 *results;
    int status;
    if (cells < 2)
        cells = 2;
    native = ALLOC_FRAME(env, wasm_interp_interp_frame_size(cells), caller);
    if (!native)
        return;
    native->function = function;
    native->ip = NULL;
    native->retained_cell_num = cells;
    native->sp = native->lp + cells;
    results = native->lp + function->param_cell_num;
    memset(results, 0, (cells - function->param_cell_num) * sizeof(uint32));
#if WASM_ENABLE_GC != 0
    memset(native->sp, 0, cells);
    silk_invocation_ref_flags((uint8 *)native->sp, type->types,
                              type->param_count + type->result_count);
#endif
    wasm_exec_env_set_cur_frame(env, native);
    inv->pending = native;
    inv->exception = NULL;
    status = inv->host(inv->context, env, function, native->lp,
                       function->param_cell_num, results,
                       function->ret_cell_num, &inv->exception);
#if WASM_ENABLE_GC != 0 && WASM_ENABLE_THREAD_MGR == 0
    /* Nested host reentry may have selected a different collector context. */
    mem_allocator_enable_gc_reclaim(
        wasm_runtime_get_gc_heap_handle(env->module_inst), env);
#endif
    if (status == 1) {
        if (!wasm_interp_invocation_suspension_allowed(env)) {
            wasm_set_exception((WASMModuleInstance *)env->module_inst,
                               "host yielded across a synchronous JS boundary");
            return;
        }
        inv->status = WASM_INVOCATION_SUSPENDED;
        return;
    }
    if (status != 0 && status != 2) {
        wasm_set_exception((WASMModuleInstance *)env->module_inst,
                           "invalid continuation host callback status");
        return;
    }
    if (status == 2 && !inv->exception) {
        wasm_set_exception((WASMModuleInstance *)env->module_inst,
                           "host raised without an exception reference");
        return;
    }
    silk_invocation_finish_native(inv, results,
                                  status == 2 ? inv->exception : NULL);
}

static void
silk_invocation_release_frames(WASMInterpInvocation *inv)
{
    WASMInterpFrame *frame = wasm_exec_env_get_cur_frame(inv->env);
    while (frame) {
        WASMInterpFrame *previous = frame->prev_frame;
        wasm_exec_env_set_cur_frame(inv->env, previous);
        wasm_exec_env_set_module_inst(inv->env,
            (WASMModuleInstanceCommon *)inv->module);
        FREE_FRAME(inv->env, frame);
        frame = previous;
    }
    wasm_exec_env_set_cur_frame(inv->env, NULL);
    inv->entry = inv->pending = NULL;
    if (inv->dispatch_owner) {
        wasm_silk_instance_release(inv->dispatch_owner);
        inv->dispatch_owner = NULL;
    }
}

static bool
silk_invocation_frame_at(WASMInterpFrame **cursor,
                         WASMInterpInvocationFrame *out)
{
    WASMInterpFrame *frame = *cursor;
    while (frame) {
        WASMInterpFrame *next = frame->prev_frame;
        if (frame->function && !frame->function->is_import_func && frame->ip) {
            const uint8 *start = wasm_loader_instruction_start(
                frame->function->u.func, frame->ip);
            if (start) {
                out->function = frame->function;
                out->instruction = start;
                *cursor = next;
                return true;
            }
        }
        frame = next;
    }
    *cursor = NULL;
    return false;
}

static void
silk_invocation_record_trap(WASMInterpInvocation *inv)
{
    WASMInterpFrame *cursor = wasm_exec_env_get_cur_frame(inv->env);
    WASMInterpInvocationFrame frame;
    uint32 count = 0, i = 0;
    if (inv->trap_frames) {
        wasm_runtime_free(inv->trap_frames);
        inv->trap_frames = NULL;
    }
    inv->trap_frame_count = 0;
    while (silk_invocation_frame_at(&cursor, &frame))
        count++;
    if (!count)
        return;
    inv->trap_frames = wasm_runtime_malloc(count * sizeof(frame));
    if (!inv->trap_frames)
        return;
    cursor = wasm_exec_env_get_cur_frame(inv->env);
    while (i < count && silk_invocation_frame_at(&cursor, &frame))
        inv->trap_frames[i++] = frame;
    inv->trap_frame_count = i;
}

bool
wasm_interp_invocation_frame(const WASMInterpInvocation *inv, uint32 index,
                             WASMInterpInvocationFrame *out)
{
    WASMInterpFrame *cursor;
    if (inv->status != WASM_INVOCATION_RUNNING) {
        if (inv->status != WASM_INVOCATION_THREW
            || index >= inv->trap_frame_count)
            return false;
        *out = inv->trap_frames[index];
        return true;
    }
    cursor = wasm_exec_env_get_cur_frame(inv->env);
    do {
        if (!silk_invocation_frame_at(&cursor, out))
            return false;
    } while (index--);
    return true;
}

static WASMInterpInvocationStatus
silk_invocation_run(WASMInterpInvocation *inv)
{
    WASMExecEnv *env = inv->env;
    WASMModuleInstance *module = (WASMModuleInstance *)env->module_inst;
    char previous_exception[128] = { 0 };
    WASMModuleInstance *exception_owner = module;
    bool had_exception = wasm_copy_exception(module, previous_exception);
    wasm_set_exception(module, NULL);
    wasm_exec_env_set_thread_info(env);
#if WASM_ENABLE_GC != 0 && WASM_ENABLE_THREAD_MGR == 0
    mem_allocator_enable_gc_reclaim(
        wasm_runtime_get_gc_heap_handle(env->module_inst), env);
#endif
    inv->status = WASM_INVOCATION_RUNNING;
    wasm_interp_call_func_bytecode(module, env, inv->function, inv->entry);
    module = (WASMModuleInstance *)env->module_inst;
    if (wasm_copy_exception(module, inv->trap)) {
        inv->status = WASM_INVOCATION_THREW;
        wasm_set_exception(module, NULL);
        silk_invocation_record_trap(inv);
    }
#if WASM_ENABLE_EXCE_HANDLING != 0
    else if (env->silk_exception) {
        inv->exception = env->silk_exception;
        inv->status = WASM_INVOCATION_THREW;
    }
#endif
    else if (inv->status != WASM_INVOCATION_SUSPENDED) {
        if (inv->function->ret_cell_num)
            word_copy(inv->results, inv->entry->lp,
                      inv->function->ret_cell_num);
        inv->exception = NULL;
        inv->status = WASM_INVOCATION_COMPLETED;
    }
    if (inv->status != WASM_INVOCATION_SUSPENDED)
        silk_invocation_release_frames(inv);
    if (had_exception)
        wasm_set_exception(exception_owner, previous_exception);
    return inv->status;
}

WASMInterpInvocation *
wasm_interp_invocation_create(WASMModuleInstance *module,
                              WASMFunctionInstance *function,
                              uint32 stack_size, WASMInterpHostCall host,
                              void *context, bool allow_suspend)
{
    WASMInterpInvocation *inv;
    WASMExecEnv *env;
    if (!module || !function || !host || !stack_size)
        return NULL;
    inv = wasm_runtime_malloc(sizeof(*inv)
                              + function->ret_cell_num * sizeof(uint32));
    if (!inv)
        return NULL;
    memset(inv, 0, sizeof(*inv)
                   + function->ret_cell_num * sizeof(uint32));
    env = wasm_exec_env_create_internal((WASMModuleInstanceCommon *)module,
                                        stack_size);
    if (!env) {
        wasm_runtime_free(inv);
        return NULL;
    }
    inv->env = env;
    inv->module = module;
    inv->function = function;
    inv->host = host;
    inv->context = context;
    inv->results = (uint32 *)(inv + 1);
    inv->allow_suspend = allow_suspend;
    inv->boundary_allows_suspend = true;
    env->silk_invocation = inv;
    env->aux_stack_bottom = module->module->aux_stack_bottom;
    env->aux_stack_boundary = env->aux_stack_bottom - module->module->aux_stack_size;
    wasm_silk_instance_retain(module);
    inv->next = silk_invocations;
    silk_invocations = inv;
    return inv;
}

WASMInterpInvocationStatus
wasm_interp_invocation_start(WASMInterpInvocation *inv,
                             const uint32 *arguments, uint32 cells)
{
    WASMInterpFrame *entry, *out;
    uint32 result_cells;
    if (inv->status != WASM_INVOCATION_NEW)
        return inv->status;
    if (cells != inv->function->param_cell_num || (cells && !arguments)) {
        snprintf(inv->trap, sizeof(inv->trap), "invalid invocation arguments");
        inv->status = WASM_INVOCATION_THREW;
        return inv->status;
    }
    result_cells = inv->function->ret_cell_num;
    if (result_cells < 2)
        result_cells = 2;
    entry = ALLOC_FRAME(inv->env, wasm_interp_interp_frame_size(result_cells),
                        NULL);
    if (!entry) {
        wasm_copy_exception(inv->module, inv->trap);
        wasm_set_exception(inv->module, NULL);
        inv->status = WASM_INVOCATION_THREW;
        return inv->status;
    }
    entry->function = NULL;
    entry->ip = NULL;
    entry->sp = entry->sp_bottom = entry->lp;
    entry->sp_boundary = entry->lp + result_cells;
    entry->csp = entry->csp_bottom = entry->csp_boundary =
        (WASMBranchBlock *)entry->sp_boundary;
    memset(entry->lp, 0, result_cells * sizeof(uint32));
#if WASM_ENABLE_GC != 0
    memset(entry->csp_boundary, 0, result_cells);
#endif
    inv->entry = entry;
    wasm_exec_env_set_cur_frame(inv->env, entry);
    out = wasm_exec_env_wasm_stack_top(inv->env);
    if ((uint8 *)(out->lp + cells) > inv->env->wasm_stack.top_boundary) {
        snprintf(inv->trap, sizeof(inv->trap), "wasm operand stack overflow");
        inv->status = WASM_INVOCATION_THREW;
        silk_invocation_release_frames(inv);
        return inv->status;
    }
    if (cells)
        word_copy(out->lp, arguments, cells);
    return silk_invocation_run(inv);
}

WASMInterpInvocationStatus
wasm_interp_invocation_resume(WASMInterpInvocation *inv, const uint32 *results,
                              uint32 cells, void *exception)
{
    if (inv->status != WASM_INVOCATION_SUSPENDED)
        return inv->status;
    if (!exception && (cells != inv->pending->function->ret_cell_num
                       || (cells && !results))) {
        snprintf(inv->trap, sizeof(inv->trap), "invalid invocation results");
        inv->status = WASM_INVOCATION_THREW;
        silk_invocation_release_frames(inv);
        return inv->status;
    }
    silk_invocation_finish_native(inv, results, exception);
    inv->resuming = true;
    return silk_invocation_run(inv);
}

WASMInterpInvocationStatus
wasm_interp_invocation_status(const WASMInterpInvocation *inv)
{
    return inv->status;
}

const uint32 *
wasm_interp_invocation_results(const WASMInterpInvocation *inv, uint32 *cells)
{
    *cells = inv->status == WASM_INVOCATION_COMPLETED
                 ? inv->function->ret_cell_num : 0;
    return inv->status == WASM_INVOCATION_COMPLETED ? inv->results : NULL;
}

void *
wasm_interp_invocation_exception(const WASMInterpInvocation *inv)
{
    return inv->exception;
}

const char *
wasm_interp_invocation_trap(const WASMInterpInvocation *inv)
{
    return inv->trap[0] ? inv->trap : NULL;
}

WASMExecEnv *
wasm_interp_invocation_exec_env(WASMInterpInvocation *inv)
{
    return inv->env;
}

bool
wasm_interp_invocation_suspension_allowed(WASMExecEnv *env)
{
    WASMInterpInvocation *inv = env->silk_invocation;
    return inv && inv->allow_suspend && inv->boundary_allows_suspend;
}

bool
wasm_interp_invocation_set_suspend_allowed(WASMExecEnv *env, bool allowed)
{
    WASMInterpInvocation *inv = env->silk_invocation;
    bool previous = inv && inv->boundary_allows_suspend;
    if (inv)
        inv->boundary_allows_suspend = allowed;
    return previous;
}

void *
wasm_interp_invocation_take_exception(WASMExecEnv *env)
{
    WASMInterpInvocation *inv = env->silk_invocation;
    void *exception = inv ? inv->exception : NULL;
    if (inv)
        inv->exception = NULL;
    return exception;
}

void
wasm_interp_invocation_visit_roots(WASMInterpInvocation *inv,
                                  WASMInterpRootVisitor visit, void *context)
{
#if WASM_ENABLE_GC != 0
    WASMInterpFrame *frame;
    WASMFuncType *type;
    WASMLocalObjectRef *local;
    uint32 i, offset;
    for (local = inv->env->cur_local_object_ref; local; local = local->prev)
        if (local->val)
            visit(local->val, context);
    if (inv->exception)
        visit(inv->exception, context);
#if WASM_ENABLE_EXCE_HANDLING != 0
    if (inv->env->silk_exception && inv->env->silk_exception != inv->exception)
        visit(inv->env->silk_exception, context);
#endif
    for (frame = wasm_exec_env_get_cur_frame(inv->env); frame;
         frame = frame->prev_frame) {
        uint8 *flags = get_frame_ref(frame);
        if (!flags)
            continue;
        for (i = 0; i < (uint32)(frame->sp - frame->lp); i++) {
            if (flags[i]) {
                visit(GET_REF_FROM_ADDR(frame->lp + i), context);
                i += sizeof(uintptr_t) / sizeof(uint32) - 1;
            }
        }
#if WASM_ENABLE_EXCE_HANDLING != 0
        if (frame->function && !frame->function->is_import_func) {
            WASMBranchBlock *block;
            for (block = frame->csp_bottom; block < frame->csp; block++)
                if (block->silk_caught_exception)
                    visit(block->silk_caught_exception, context);
        }
#endif
    }
    if (inv->status == WASM_INVOCATION_COMPLETED) {
        type = silk_invocation_type(inv->function);
        offset = 0;
        for (i = 0; i < type->result_count; i++) {
            uint8 value_type = type->types[type->param_count + i];
            if (wasm_is_type_reftype(value_type)
                && !wasm_is_reftype_i31ref(value_type))
                visit(GET_REF_FROM_ADDR(inv->results + offset), context);
            offset += wasm_value_type_cell_num(value_type);
        }
    }
#else
    (void)inv;
    (void)visit;
    (void)context;
#endif
}

#if WASM_ENABLE_GC != 0
typedef struct SilkInvocationRootContext {
    void *heap;
    bool ok;
} SilkInvocationRootContext;

static void
silk_invocation_mark_root(void *reference, void *context)
{
    SilkInvocationRootContext *roots = context;
    if (roots->ok && mem_allocator_contains_gc_object(roots->heap, reference)
        && wasm_obj_is_created_from_heap(reference)
        && mem_allocator_add_root(roots->heap, reference))
        roots->ok = false;
}
#endif

static bool
silk_invocation_gc_roots(void *heap)
{
#if WASM_ENABLE_GC != 0
    WASMInterpInvocation *inv;
    SilkInvocationRootContext roots = { heap, true };
    for (inv = silk_invocations; inv && roots.ok; inv = inv->next)
        wasm_interp_invocation_visit_roots(inv, silk_invocation_mark_root, &roots);
    return roots.ok;
#else
    (void)heap;
    return true;
#endif
}

void
wasm_interp_invocation_free(WASMInterpInvocation *inv)
{
    WASMInterpInvocation **link;
    if (!inv)
        return;
    bh_assert(inv->status != WASM_INVOCATION_RUNNING);
    if (inv->status == WASM_INVOCATION_RUNNING)
        return;
    for (link = &silk_invocations; *link && *link != inv;
         link = &(*link)->next) {}
    bh_assert(*link == inv);
    if (*link != inv)
        return;
    *link = inv->next;
    inv->status = WASM_INVOCATION_CANCELLED;
    silk_invocation_release_frames(inv);
    inv->env->silk_invocation = NULL;
    wasm_exec_env_destroy_internal(inv->env);
    wasm_silk_instance_release(inv->module);
    if (inv->trap_frames)
        wasm_runtime_free(inv->trap_frames);
    wasm_runtime_free(inv);
}
