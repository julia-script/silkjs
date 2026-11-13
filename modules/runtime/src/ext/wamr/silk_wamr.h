#ifndef SILK_WAMR_H
#define SILK_WAMR_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SilkWasmStore SilkWasmStore;
typedef struct SilkWasmHandle SilkWasmHandle;
typedef struct SilkWasmInvocation SilkWasmInvocation;

enum SilkWasmKind {
    SILK_WASM_MODULE = 0, SILK_WASM_INSTANCE = 1,
    SILK_WASM_FUNCTION = 2, SILK_WASM_MEMORY = 3,
    SILK_WASM_TABLE = 4, SILK_WASM_GLOBAL = 5,
    SILK_WASM_TAG = 6, SILK_WASM_EXCEPTION = 7, SILK_WASM_REFERENCE = 8
};
enum SilkWasmType {
    SILK_WASM_I32 = 0x7f, SILK_WASM_I64 = 0x7e,
    SILK_WASM_F32 = 0x7d, SILK_WASM_F64 = 0x7c,
    SILK_WASM_V128 = 0x7b, SILK_WASM_FUNCREF = 0x70,
    SILK_WASM_EXTERNREF = 0x6f, SILK_WASM_ANYREF = 0x6e,
    SILK_WASM_EQREF = 0x6d, SILK_WASM_I31REF = 0x6c,
    SILK_WASM_STRUCTREF = 0x6b, SILK_WASM_ARRAYREF = 0x6a,
    SILK_WASM_EXNREF = 0x69, SILK_WASM_NULLREF = 0x71,
    SILK_WASM_NULLEXTERNREF = 0x72, SILK_WASM_NULLFUNCREF = 0x73,
    SILK_WASM_NULLEXNREF = 0x74
};
enum SilkWasmStatus {
    SILK_WASM_OK = 0, SILK_WASM_YIELD = 1, SILK_WASM_THROW = 2,
    SILK_WASM_OOM = 3, SILK_WASM_TYPE_ERROR = 4,
    SILK_WASM_RANGE_ERROR = 5, SILK_WASM_COMPILE_ERROR = 6,
    SILK_WASM_LINK_ERROR = 7, SILK_WASM_RUNTIME_ERROR = 8,
    SILK_WASM_SUSPEND_ERROR = 9
};
enum SilkWasmReferenceKind {
    SILK_WASM_REF_HOST = 0, SILK_WASM_REF_HANDLE = 1,
    SILK_WASM_REF_I31 = 2
};
/* Numeric lanes contain their original bits. A HOST reference is an opaque
 * host token; HANDLE is a canonical native owner; I31 carries signed bits. */
typedef struct SilkWasmValue {
    uint64_t bits;
    void *ref;
    uint64_t bits_high;
    uint32_t ref_kind;
} SilkWasmValue;
typedef struct SilkWasmTypeInfo {
    uint32_t kind;
    uint32_t value_type;
    uint64_t minimum;
    uint64_t maximum;
    uint8_t has_maximum;
    uint8_t shared;
    uint8_t address64;
    uint8_t mutable_;
    uint32_t parameter_count;
    uint32_t result_count;
    const uint8_t *types;
} SilkWasmTypeInfo;
typedef struct SilkWasmImport {
    SilkWasmHandle *handle;
    void *callable;
    SilkWasmValue value;
    uint8_t suspending;
} SilkWasmImport;
typedef struct SilkWasmCompileOptions {
    const uint8_t *constants;
    uint32_t constants_length;
    uint8_t js_string;
    uint8_t has_constants;
} SilkWasmCompileOptions;
typedef struct SilkWasmCallbacks {
    int (*call)(void *context, SilkWasmInvocation *invocation, void *callable,
                uint8_t suspending, const uint8_t *types, uint32_t argc,
                const SilkWasmValue *arguments, uint32_t result_count,
                SilkWasmValue *results, SilkWasmHandle **exception);
    void (*memory_grown)(void *context, SilkWasmHandle *memory,
                         uint64_t previous_pages);
    void (*retain_reference)(void *context, void *reference);
    void (*release_reference)(void *context, void *reference);
    uint8_t (*handle_created)(void *context, SilkWasmHandle *handle);
    void (*retain_handle)(void *context, SilkWasmHandle *handle);
    void (*release_handle)(void *context, SilkWasmHandle *handle);
    SilkWasmHandle *(*raise)(void *context, int kind, const char *message);
    uint32_t (*shared_wait)(void *context, uint8_t *data, uint64_t capacity,
                            uint64_t offset, uint64_t expected, int64_t timeout_ns,
                            uint8_t is_i64);
    uint32_t (*shared_notify)(void *context, uint8_t *address, uint32_t count);
    uint8_t (*interrupt)(void *context);
} SilkWasmCallbacks;
typedef void (*SilkWasmVisitHandle)(void *context, SilkWasmHandle *handle);
typedef void (*SilkWasmVisitReference)(void *context, void *reference);

SilkWasmStore *silk_wasm_open(const SilkWasmCallbacks *, void *context);
void silk_wasm_close(SilkWasmStore *);
int silk_wasm_error_kind(const SilkWasmStore *);
const char *silk_wasm_error(const SilkWasmStore *);
SilkWasmHandle *silk_wasm_last_exception(SilkWasmStore *);
uint32_t silk_wasm_kind(const SilkWasmHandle *);
void *silk_wasm_get_host(const SilkWasmHandle *);
void silk_wasm_set_host(SilkWasmHandle *, void *host);
void silk_wasm_free(SilkWasmHandle *);
void silk_wasm_visit(SilkWasmHandle *, SilkWasmVisitHandle,
                     SilkWasmVisitReference, void *context);

SilkWasmHandle *silk_wasm_compile(SilkWasmStore *, const uint8_t *, uint64_t,
                                 const SilkWasmCompileOptions *);
uint32_t silk_wasm_import_builtin(const SilkWasmHandle *, uint32_t index);
const uint8_t *silk_wasm_module_serialize(SilkWasmHandle *, uint64_t *length);
SilkWasmHandle *silk_wasm_module_deserialize(SilkWasmStore *, const uint8_t *, uint64_t);
uint8_t silk_wasm_string_array_length(SilkWasmHandle *, uint32_t *length);
uint8_t silk_wasm_string_array_get(SilkWasmHandle *, uint32_t index, uint32_t *value);
uint8_t silk_wasm_string_array_set(SilkWasmHandle *, uint32_t index, uint32_t value);
const uint8_t *silk_wasm_module_bytes(SilkWasmHandle *, uint64_t *length);
uint32_t silk_wasm_import_count(const SilkWasmHandle *);
uint32_t silk_wasm_export_count(const SilkWasmHandle *);
uint8_t silk_wasm_import_info(const SilkWasmHandle *, uint32_t index,
                           const char **module, uint32_t *module_length,
                           const char **name, uint32_t *name_length,
                           SilkWasmTypeInfo *type);
uint8_t silk_wasm_export_info(const SilkWasmHandle *, uint32_t index,
                           const char **name, uint32_t *name_length,
                           SilkWasmTypeInfo *type);
uint32_t silk_wasm_custom_count(const SilkWasmHandle *, const uint8_t *name,
                                uint32_t name_length);
const uint8_t *silk_wasm_custom(const SilkWasmHandle *, const uint8_t *name,
                               uint32_t name_length, uint32_t index,
                               uint32_t *length);
SilkWasmHandle *silk_wasm_instantiate(SilkWasmHandle *,
                                     const SilkWasmImport *, uint32_t count);
SilkWasmHandle *silk_wasm_export(SilkWasmHandle *, uint32_t index);
uint8_t silk_wasm_function_type(SilkWasmHandle *, SilkWasmTypeInfo *);
uint8_t silk_wasm_type(SilkWasmHandle *, SilkWasmTypeInfo *);
uint8_t silk_wasm_check_import(SilkWasmHandle *, uint32_t, const SilkWasmImport *);
uint8_t silk_wasm_function_value_matches(SilkWasmHandle *, uint32_t index,
                                      uint8_t results, const SilkWasmValue *);
uint8_t silk_wasm_invocation_value_matches(SilkWasmInvocation *, uint32_t index,
                                        const SilkWasmValue *);
/* frame: the engine's current StackFrame when the call is made; stack traces
   show this invocation's Wasm frames above it (silk_wasm_frame). Zero: none. */
SilkWasmInvocation *silk_wasm_call(SilkWasmHandle *, const SilkWasmValue *,
                                  uint32_t count, uint8_t promising, uintptr_t frame);
int silk_wasm_invocation_status(SilkWasmInvocation *);
int silk_wasm_resume(SilkWasmInvocation *, const SilkWasmValue *,
                     uint32_t count, SilkWasmHandle *exception, uintptr_t frame);
/* One Wasm function frame of a stack trace, as V8 writes it. Strings are
   borrowed from the module and not NUL-terminated; a null name has none. */
typedef struct SilkWasmFrame {
    uint32_t function_index, offset;
    const char *url; size_t url_length;
    const char *name; size_t name_length;
    const char *module; size_t module_length;
} SilkWasmFrame;
/* The index-th Wasm frame, innermost first, of the invocation entered from
   StackFrame `frame` while it runs, or of the trap it ended with. 1 when
   written, 0 past the last. The engine's foreign frame source signature. */
int silk_wasm_frame(void *opaque, uintptr_t frame, uint32_t index, SilkWasmFrame *out);
/* The response URL a streaming compile had: the module's script name. */
uint8_t silk_wasm_module_set_url(SilkWasmHandle *, const uint8_t *url, uint32_t length);
const SilkWasmValue *silk_wasm_results(SilkWasmInvocation *, uint32_t *count);
SilkWasmHandle *silk_wasm_thrown(SilkWasmInvocation *);
void silk_wasm_invocation_free(SilkWasmInvocation *);
void silk_wasm_invocation_visit(SilkWasmInvocation *, SilkWasmVisitHandle,
                                SilkWasmVisitReference, void *context);
void *silk_wasm_invocation_host(SilkWasmInvocation *);
void silk_wasm_invocation_set_host(SilkWasmInvocation *, void *);
int silk_wasm_invocation_error_kind(SilkWasmInvocation *);
const char *silk_wasm_invocation_error(SilkWasmInvocation *);
uint8_t silk_wasm_suspension_allowed(SilkWasmInvocation *);
void silk_wasm_invocation_fail(SilkWasmInvocation *, int kind, const char *message);
SilkWasmHandle *silk_wasm_promising(SilkWasmHandle *);
uint8_t silk_wasm_function_promising(SilkWasmHandle *);
SilkWasmHandle *silk_wasm_function_source(SilkWasmHandle *);

SilkWasmHandle *silk_wasm_memory(SilkWasmStore *, uint64_t initial,
                                uint64_t maximum, uint8_t has_maximum,
                                uint8_t shared, uint8_t address64);
uint8_t *silk_wasm_memory_data(SilkWasmHandle *);
uint64_t silk_wasm_memory_size(SilkWasmHandle *);
uint64_t silk_wasm_memory_capacity(SilkWasmHandle *);
uint8_t silk_wasm_memory_shared(SilkWasmHandle *);
uint8_t silk_wasm_memory_grow(SilkWasmHandle *, uint64_t delta, uint64_t *previous);
void *silk_wasm_memory_backing(SilkWasmHandle *);
void silk_wasm_backing_retain(void *);
void silk_wasm_backing_release(void *);
uint8_t silk_wasm_address64(SilkWasmHandle *);
const char *silk_wasm_function_name(SilkWasmHandle *, uint32_t *length);
SilkWasmHandle *silk_wasm_memory_from_backing(SilkWasmStore *, void *);
SilkWasmHandle *silk_wasm_table(SilkWasmStore *, uint32_t element,
                               uint64_t initial, uint64_t maximum,
                               uint8_t has_maximum, const SilkWasmValue *,
                               uint8_t address64);
uint64_t silk_wasm_table_size(SilkWasmHandle *);
uint8_t silk_wasm_table_get(SilkWasmHandle *, uint64_t index, SilkWasmValue *);
uint8_t silk_wasm_table_set(SilkWasmHandle *, uint64_t index, const SilkWasmValue *);
uint8_t silk_wasm_table_grow(SilkWasmHandle *, uint64_t delta,
                         const SilkWasmValue *, uint64_t *previous);
SilkWasmHandle *silk_wasm_global(SilkWasmStore *, uint32_t type, uint8_t mutable_,
                                const SilkWasmValue *);
uint8_t silk_wasm_global_get(SilkWasmHandle *, SilkWasmValue *);
uint8_t silk_wasm_global_set(SilkWasmHandle *, const SilkWasmValue *);
uint32_t silk_wasm_value_type(SilkWasmHandle *);
SilkWasmHandle *silk_wasm_tag(SilkWasmStore *, const uint8_t *, uint32_t count);
uint8_t silk_wasm_tag_value_matches(SilkWasmHandle *, uint32_t index,
                                  const SilkWasmValue *);
SilkWasmHandle *silk_wasm_exception(SilkWasmHandle *tag,
                                   const SilkWasmValue *, uint32_t count);
uint8_t silk_wasm_exception_is(SilkWasmHandle *, SilkWasmHandle *tag);
uint8_t silk_wasm_exception_get(SilkWasmHandle *, SilkWasmHandle *tag,
                             uint32_t index, SilkWasmValue *);
uint32_t silk_wasm_tag_count(SilkWasmHandle *);
const uint8_t *silk_wasm_tag_types(SilkWasmHandle *);

#ifdef __cplusplus
}
#endif
#endif
