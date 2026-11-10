#ifndef SILK_WAMR_TYPES_H
#define SILK_WAMR_TYPES_H

#include "wasm.h"

/* The actual definition must equal, or explicitly derive from, the expected
 * closed recursive type. Each index is resolved in its own module. */
bool wasm_silk_func_type_matches(const WASMModule *expected_module,
                                 const WASMFuncType *expected_type,
                                 const WASMModule *actual_module,
                                 const WASMFuncType *actual_type);

#if WASM_ENABLE_GC != 0
bool wasm_silk_type_matches(const WASMModule *expected_module,
                            const WASMType *expected_type,
                            const WASMModule *actual_module,
                            const WASMType *actual_type);

bool wasm_silk_reftype_matches(const WASMModule *expected_module,
                               uint8 expected_type,
                               const WASMRefType *expected_reference,
                               const WASMModule *actual_module,
                               uint8 actual_type,
                               const WASMRefType *actual_reference);
#endif

#endif
