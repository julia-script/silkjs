/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception */
#ifndef WASM_SILK_EH_H
#define WASM_SILK_EH_H
#include "../interpreter/wasm_runtime.h"
#include "gc/gc_object.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Installed before starting execution; callbacks must not suspend. make roots
 * its inputs during allocation and attaches a managed payload-reference graph
 * to the returned wrapper's silk_exception_refs field. inspect returns borrowed
 * immutable cells whose lifetime is the wrapper's lifetime. Tag identity is
 * store-wide, including imported aliases and JSTag. */
typedef struct WASMSilkExceptionHooks {
    WASMExternrefObjectRef (*make)(WASMExecEnv *, void *tag_identity,
                                   WASMFuncType *, const uint32 *cells);
    bool (*inspect)(WASMExecEnv *, WASMExternrefObjectRef,
                    void **tag_identity, WASMFuncType **type,
                    const uint32 **cells);
    void *(*tag_identity)(WASMExecEnv *, WASMModuleInstance *, uint32 tag_index);
} WASMSilkExceptionHooks;
void wasm_silk_set_exception_hooks(const WASMSilkExceptionHooks *hooks);
extern WASMSilkExceptionHooks wasm_silk_exception_hooks;
#ifdef __cplusplus
}
#endif
#endif
