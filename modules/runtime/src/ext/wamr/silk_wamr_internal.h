#ifndef SILK_WAMR_INTERNAL_H
#define SILK_WAMR_INTERNAL_H
#include "silk_wamr.h"
#include "wasm_runtime.h"
#include "wasm_continuation.h"
#include "gc_object.h"
#include "wasm_silk_eh.h"
#include <stdatomic.h>

#define SILK_WASM_PAGE_SIZE UINT64_C(65536)
#define SILK_WASM_STACK_SIZE (1024U * 1024U)

typedef struct SilkWasmMemoryObserver {
    struct SilkWasmMemoryObserver *next;
    SilkWasmHandle *handle;
} SilkWasmMemoryObserver;
typedef struct SilkWasmBacking {
    atomic_uint references;
    WASMMemoryInstance *memory;
    uint8_t *data;
    uint64_t capacity;
    bool has_maximum;
    uint64_t maximum;
    korp_mutex lock;
} SilkWasmBacking;
typedef struct SilkWasmEdge {
    SilkWasmHandle *handle;
    void *reference;
} SilkWasmEdge;
typedef struct SilkWasmTypeCache SilkWasmTypeCache;
struct SilkWasmHandle {
    SilkWasmStore *store;
    SilkWasmHandle *next;
    SilkWasmHandle **previous;
    void *host;
    uint32_t kind;
    bool published;
    bool finalized;
    size_t incoming_edges;
    SilkWasmEdge *edges;
    size_t edge_count;
    size_t edge_capacity;
    SilkWasmEdge *reference_edges;
    size_t reference_edge_count;
    size_t reference_edge_capacity;
    union {
        struct {
            WASMModule *module;
            uint8_t *bytes, *loaded_bytes;
            uint32_t length;
            SilkWasmCompileOptions options;
            uint8_t *compile_imports, *serialized;
            uint64_t serialized_length;
            SilkWasmTypeCache *type_cache;
            /* Stack trace identity (silk_wamr_frames.c), made on first use. */
            char *frame_url;
            uint8_t *frame_module_name;
            uint32_t frame_url_length, frame_module_name_length;
            bool frame_described;
        } module;
        struct {
            WASMModuleInstance *instance;
            SilkWasmHandle *module;
            SilkWasmImport *imports;
            WASMFunctionImport *function_imports;
            uint32_t import_count;
            SilkWasmHandle **functions, **memories, **tables, **globals, **tags;
            uint32_t function_count, memory_count, table_count, global_count, tag_count;
            uint32_t native_references;
        } instance;
        struct { SilkWasmHandle *instance; SilkWasmHandle *source; uint32_t index; WASMFuncType *type; WASMFuncObjectRef reference; bool promising; char name[11]; } function;
        struct { SilkWasmBacking *backing; SilkWasmMemoryObserver observer; } memory;
        struct { WASMTableInstance *table; uint32_t element; bool has_maximum; bool address64; const WASMModule *type_module; uint64_t maximum; } table;
        struct { uint8_t cells[16]; uint32_t type; bool mutable_; const WASMModule *type_module; const WASMRefType *ref_type; } global;
        struct { WASMFuncType *type; bool owns_type; const WASMModule *type_module; uint8_t *js_types; } tag;
        struct {
            SilkWasmHandle *tag;
            SilkWasmValue *values;
            uint32_t count;
            uint32_t *cells;
            WASMExternrefObjectRef guest;
        } exception;
        struct { WASMObjectRef object; SilkWasmHandle *module; } reference;
    } as;
};
struct SilkWasmStore {
    SilkWasmCallbacks callbacks;
    void *context;
    SilkWasmHandle *handles;
    SilkWasmHandle *last_exception;
    SilkWasmInvocation *invocations;
    SilkWasmStore *next_thread_store;
    SilkWasmStore **previous_thread_store;
    SilkWasmMemoryObserver *memory_observers;
    void *gc_heap;
    void *gc_pool;
    SilkWasmHandle *reference_instance;
    WASMExecEnv *reference_exec_env;
    bool syncing_edges;
    bool reference_visit_failed;
    bool closed;
    size_t handle_count;
    int error_kind;
    char error[512];
};
struct SilkWasmInvocation {
    SilkWasmStore *store;
    SilkWasmInvocation *next;
    SilkWasmInvocation **previous;
    SilkWasmHandle *function;
    WASMInterpInvocation *invocation;
    SilkWasmHandle roots;
    SilkWasmValue *host_arguments;
    SilkWasmValue *host_results;
    uint32_t host_argument_capacity;
    uint32_t host_result_capacity;
    WASMFuncType *pending_type;
    const WASMModule *pending_module;
    SilkWasmValue *results;
    uint32_t result_count;
    SilkWasmHandle *exception;
    void *host;
    /* The engine StackFrame this invocation was entered from, while it runs
       and after a trap until free; zero otherwise (silk_wasm_frame). */
    uintptr_t frame;
    int status;
    int error_kind;
    char error[512];
};

void silk_wasm_set_error(SilkWasmStore *, int, const char *);
SilkWasmHandle *silk_wasm_new_handle(SilkWasmStore *, uint32_t);
SilkWasmStore *silk_wasm_thread_stores(void);
bool silk_wasm_publish(SilkWasmHandle *);
bool silk_wasm_edge_handle(SilkWasmHandle *, SilkWasmHandle *);
bool silk_wasm_edge_reference(SilkWasmHandle *, void *);
void silk_wasm_clear_edges(SilkWasmHandle *);
void silk_wasm_destroy_resource(SilkWasmHandle *);
void silk_wasm_module_frames_destroy(SilkWasmHandle *);
bool silk_wasm_compile_options_init(SilkWasmHandle *, const SilkWasmCompileOptions *);
void silk_wasm_compile_options_destroy(SilkWasmHandle *);
bool silk_wasm_type_info(const SilkWasmHandle *, uint8_t kind, uint32_t index,
                         SilkWasmTypeInfo *);
WASMFuncType *silk_wasm_function_signature(WASMModule *, uint32_t);
SilkWasmHandle *silk_wasm_instance_function(SilkWasmHandle *, uint32_t);
bool silk_wasm_bind_function(WASMModuleInstance *, uint32_t, WASMFunctionInstance *);
bool silk_wasm_invocation_roots(SilkWasmStore *, void *);
uint32_t silk_wasm_cell_count(uint8_t);
bool silk_wasm_to_cells(SilkWasmStore *, WASMExecEnv *, const uint8_t *,
                        uint32_t, const SilkWasmValue *, uint32_t *);
bool silk_wasm_from_cells(SilkWasmStore *, WASMExecEnv *, const uint8_t *,
                          uint32_t, const uint32_t *, SilkWasmValue *);
bool silk_wasm_value_matches(SilkWasmStore *, const WASMModule *, uint8_t,
                             const WASMRefType *, const SilkWasmValue *);
bool silk_wasm_function_to_cells(SilkWasmStore *, WASMExecEnv *,
                                 const WASMModule *, const WASMFuncType *, bool,
                                 const SilkWasmValue *, uint32_t *);
uint8_t silk_wasm_conversion_type(uint8_t, const WASMRefType *);
uint8_t silk_wasm_js_type(const WASMModule *, uint8_t, const WASMRefType *);
const uint8_t *silk_wasm_js_types(SilkWasmHandle *, WASMFuncType *);
void silk_wasm_js_types_destroy(SilkWasmHandle *);
void silk_wasm_visit_cells(SilkWasmStore *, uint8_t, const uint32_t *,
                           SilkWasmVisitHandle, SilkWasmVisitReference, void *);
void silk_wasm_visit_object(SilkWasmStore *, WASMObjectRef,
                            SilkWasmVisitHandle, SilkWasmVisitReference, void *);
uint32_t silk_wasm_pin_cells(WASMExecEnv *, const uint8_t *, uint32_t,
                             const uint32_t *, WASMLocalObjectRef *);
bool silk_wasm_value_edge(SilkWasmHandle *, uint8_t, const SilkWasmValue *);
void silk_wasm_visit_value(SilkWasmStore *, uint8_t, const SilkWasmValue *,
                           SilkWasmVisitHandle, SilkWasmVisitReference, void *);
bool silk_wasm_sync_edges(SilkWasmHandle *,
                          void (*)(SilkWasmHandle *, SilkWasmVisitHandle,
                                   SilkWasmVisitReference, void *));
bool silk_wasm_sync_store_edges(SilkWasmStore *);
void silk_wasm_clear_reference_edges(SilkWasmHandle *);
bool silk_wasm_reference_context_init(SilkWasmStore *);
void silk_wasm_reference_context_destroy(SilkWasmStore *);
bool silk_wasm_reference_roots(SilkWasmStore *, void *);
void silk_wasm_resource_visit(SilkWasmHandle *, SilkWasmVisitHandle,
                              SilkWasmVisitReference, void *);
void silk_wasm_resource_destroy(SilkWasmHandle *);
bool silk_wasm_resource_type(SilkWasmHandle *, SilkWasmTypeInfo *);
extern const WASMSilkResourceHooks silk_wasm_resource_hooks;
SilkWasmHandle *silk_wasm_tag_from_guest(SilkWasmHandle *, uint32_t,
                                       WASMFuncType *);
void silk_wasm_exception_destroy(SilkWasmHandle *);
void *silk_wasm_exception_to_guest(SilkWasmStore *, WASMExecEnv *,
                                  SilkWasmHandle *);
SilkWasmHandle *silk_wasm_exception_from_guest(SilkWasmStore *, WASMExecEnv *,
                                             void *);
extern const WASMSilkExceptionHooks silk_wasm_exception_hooks;
#endif
