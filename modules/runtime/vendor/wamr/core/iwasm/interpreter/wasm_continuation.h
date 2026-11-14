/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception */
#ifndef WASM_CONTINUATION_H
#define WASM_CONTINUATION_H

#include "wasm_interp.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WASMInterpInvocation WASMInterpInvocation;
typedef enum WASMInterpInvocationStatus {
    WASM_INVOCATION_NEW = 0,
    WASM_INVOCATION_RUNNING = 1,
    WASM_INVOCATION_SUSPENDED = 2,
    WASM_INVOCATION_COMPLETED = 3,
    WASM_INVOCATION_THREW = 4,
    WASM_INVOCATION_CANCELLED = 5
} WASMInterpInvocationStatus;

/* 0: results written, 1: yielded, 2: exception written. Exception is a
 * GC-managed Wasm exnref, never a raw engine pointer. Argument and result
 * storage belongs to the invocation and survives a yield. */
typedef int (*WASMInterpHostCall)(
    void *context, struct WASMExecEnv *env,
    struct WASMFunctionInstance *function, const uint32 *arguments,
    uint32 argument_cells, uint32 *results, uint32 result_cells,
    void **exception);
typedef void (*WASMInterpRootVisitor)(void *reference, void *context);

/* Invocation lifetime is confined to its creating runtime thread. The host
 * owns the instance's imported JS roots until free. Each invocation has an
 * independent exec env; synchronous reentry must create another invocation.
 * Start/resume select this env as the shared-heap collector context. Before
 * returning to JS, and before free, the adapter must restore its stable store
 * reference exec env as collector context. */
WASMInterpInvocation *wasm_interp_invocation_create(
    struct WASMModuleInstance *module, struct WASMFunctionInstance *function,
    uint32 stack_size, WASMInterpHostCall host, void *context,
    bool allow_suspend);
WASMInterpInvocationStatus wasm_interp_invocation_start(
    WASMInterpInvocation *invocation, const uint32 *arguments, uint32 cells);
WASMInterpInvocationStatus wasm_interp_invocation_resume(
    WASMInterpInvocation *invocation, const uint32 *results, uint32 cells,
    void *exception);
WASMInterpInvocationStatus wasm_interp_invocation_status(
    const WASMInterpInvocation *invocation);
const uint32 *wasm_interp_invocation_results(
    const WASMInterpInvocation *invocation, uint32 *cells);
void *wasm_interp_invocation_exception(const WASMInterpInvocation *invocation);
const char *wasm_interp_invocation_trap(const WASMInterpInvocation *invocation);
struct WASMExecEnv *wasm_interp_invocation_exec_env(
    WASMInterpInvocation *invocation);
void wasm_interp_invocation_visit_roots(WASMInterpInvocation *invocation,
                                       WASMInterpRootVisitor visit,
                                       void *context);
/* A Wasm function frame: its function and the start of the instruction it is
   in (the trapping instruction, or the call it waits in). */
typedef struct WASMInterpInvocationFrame {
    struct WASMFunctionInstance *function;
    const uint8 *instruction;
} WASMInterpInvocationFrame;
/* The index-th Wasm function frame from the innermost one, skipping host and
   import frames: of the live frame chain while the invocation runs (inside a
   host call), else of the trap that ended its last run. False past the last. */
bool wasm_interp_invocation_frame(const WASMInterpInvocation *invocation,
                                  uint32 index,
                                  WASMInterpInvocationFrame *frame);
/* Invalid on a RUNNING invocation. SUSPENDED invocations are cancelled. */
void wasm_interp_invocation_free(WASMInterpInvocation *invocation);

/* JS boundary guard: the adapter restores the previous value after a
 * synchronous host call. A false guard requires the adapter to return a real
 * SuspendError exnref (status 2), rather than status 1. */
bool wasm_interp_invocation_suspension_allowed(struct WASMExecEnv *env);
bool wasm_interp_invocation_set_suspend_allowed(struct WASMExecEnv *env,
                                                bool allowed);
void *wasm_interp_invocation_take_exception(struct WASMExecEnv *env);

#ifdef __cplusplus
}
#endif
#endif
