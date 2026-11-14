/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception */
#ifndef WASM_CONTINUATION_INTERNAL_H
#define WASM_CONTINUATION_INTERNAL_H
#include "wasm_continuation.h"

struct WASMInterpInvocation {
    WASMInterpInvocation *next;
    WASMExecEnv *env;
    WASMModuleInstance *module;
    WASMModuleInstance *dispatch_owner;
    WASMFunctionInstance *function;
    WASMInterpFrame *entry;
    WASMInterpFrame *pending;
    WASMInterpHostCall host;
    void *context;
    void *exception;
    uint32 *results;
    WASMInterpInvocationStatus status;
    bool allow_suspend;
    bool boundary_allows_suspend;
    bool resuming;
    char trap[128];
    /* The frames a trap unwound, innermost first, kept until free or the next
       run: the frame chain itself is released when the run ends. */
    WASMInterpInvocationFrame *trap_frames;
    uint32 trap_frame_count;
};

static os_thread_local_attribute WASMInterpInvocation *silk_invocations;
static void silk_invocation_call_native(WASMExecEnv *, WASMFunctionInstance *,
                                        WASMInterpFrame *);
static bool silk_invocation_gc_roots(void *heap);


#if !defined(OS_ENABLE_HW_BOUND_CHECK) \
    || WASM_CPU_SUPPORTS_UNALIGNED_ADDR_ACCESS == 0 \
    || WASM_ENABLE_BULK_MEMORY != 0
#define SILK_RELOAD_MEMORY_SIZE() \
    linear_mem_size = memory ? GET_LINEAR_MEMORY_SIZE(memory) : 0
#else
#define SILK_RELOAD_MEMORY_SIZE() (void)0
#endif
#if WASM_ENABLE_MEMORY64 != 0
#define SILK_RELOAD_MEMORY_WIDTH() \
    is_memory64 = memory ? memory->is_memory64 : false
#else
#define SILK_RELOAD_MEMORY_WIDTH() (void)0
#endif
#if WASM_ENABLE_MULTI_MEMORY != 0
#define SILK_RELOAD_MEMORY_INDEX() memidx_cached = (uint32)-1
#else
#define SILK_RELOAD_MEMORY_INDEX() (void)0
#endif
#if (!defined(OS_ENABLE_HW_BOUND_CHECK) \
     || WASM_CPU_SUPPORTS_UNALIGNED_ADDR_ACCESS == 0) \
    && WASM_CONFIGURABLE_BOUNDS_CHECKS != 0
#define SILK_RELOAD_BOUNDS() \
    disable_bounds_checks = !wasm_runtime_is_bounds_checks_enabled( \
        (WASMModuleInstanceCommon *)module)
#else
#define SILK_RELOAD_BOUNDS() (void)0
#endif
#if defined(os_writegsbase)
#define SILK_RELOAD_SEGMENT() \
    do { if (memory) os_writegsbase(memory->memory_data); } while (0)
#else
#define SILK_RELOAD_SEGMENT() (void)0
#endif

#if WASM_ENABLE_INSTRUCTION_METERING != 0
#define SILK_SYNC_METERING() \
    exec_env->instructions_to_execute = instructions_left
#else
#define SILK_SYNC_METERING() (void)0
#endif

#define SILK_RELOAD_MODULE(owner) \
    do { \
        module = (owner); \
        wasm_exec_env_set_module_inst(exec_env, \
            (WASMModuleInstanceCommon *)module); \
        wasm_types = (WASMFuncType **)module->module->types; \
        globals = module->e->globals; \
        memory = wasm_get_default_memory(module); \
        SILK_RELOAD_MEMORY_SIZE(); \
        SILK_RELOAD_MEMORY_WIDTH(); \
        SILK_RELOAD_MEMORY_INDEX(); \
        SILK_RELOAD_BOUNDS(); \
        SILK_RELOAD_SEGMENT(); \
    } while (0)
#define SILK_RECOVER_MODULE() \
    do { \
        if (frame->module_inst != module) { \
            SILK_RELOAD_MODULE(frame->module_inst); \
        } \
        exec_env->aux_stack_boundary = frame->aux_stack_boundary; \
        exec_env->aux_stack_bottom = frame->aux_stack_bottom; \
    } while (0)
#endif
