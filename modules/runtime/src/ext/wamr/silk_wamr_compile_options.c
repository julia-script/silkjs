#include "silk_wamr_internal.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* These ids are private to the native/facade builtin resolver. */
enum { ORDINARY, STRING_CONSTANT, CAST, TEST, FROM_CHAR_CODE, FROM_CODE_POINT,
       CHAR_CODE_AT, CODE_POINT_AT, LENGTH, CONCAT, SUBSTRING, EQUALS, COMPARE,
       FROM_CHAR_CODE_ARRAY, INTO_CHAR_CODE_ARRAY };
static const char *const names[] = {
    NULL, NULL, "cast", "test", "fromCharCode", "fromCodePoint",
    "charCodeAt", "codePointAt", "length", "concat", "substring", "equals",
    "compare", "fromCharCodeArray", "intoCharCodeArray"
};

static bool bytes_equal(const char *a, uint32_t length, const void *b, size_t size)
{ return length == size && (!size || !memcmp(a, b, size)); }

/* Node 24.22.2's CompileTimeImports::has_string_constants compares uint8_t
 * module bytes with plain std::string chars after integer promotion:
 * deps/v8/src/wasm/wasm-features.h. Preserve the target's char signedness
 * and length-delimited embedded NULs, rather than using bytewise equality. */
static bool constants_namespace_equal(const char *name, uint32_t length,
                                      const uint8_t *option, uint32_t option_length)
{
    if (length != option_length) return false;
    for (uint32_t i = 0; i < length; ++i) {
        if ((uint8_t)name[i] != ((const char *)option)[i]) return false;
    }
    return true;
}

static const WASMRefType *reference_type(const WASMFuncType *type, uint32_t index)
{
    for (uint32_t i = 0; i < type->ref_type_map_count; ++i)
        if (type->ref_type_maps[i].index == index)
            return type->ref_type_maps[i].ref_type;
    return NULL;
}

static bool extern_type(uint8_t type, const WASMRefType *reference, bool nullable)
{
    if (type == VALUE_TYPE_EXTERNREF) return nullable;
    return reference && reference->ref_ht_common.heap_type == HEAP_TYPE_EXTERN
        && reference->ref_ht_common.nullable == nullable;
}

static bool i16_array(const WASMModule *module, const WASMFuncType *type,
                      uint32_t index)
{
    const WASMRefType *reference = reference_type(type, index);
    if (!reference || reference->ref_ht_typeidx.type_idx < 0
        || (uint32_t)reference->ref_ht_typeidx.type_idx >= module->type_count)
        return false;
    WASMType *base = module->types[reference->ref_ht_typeidx.type_idx];
    if (base->type_flag != WASM_TYPE_ARRAY || !base->is_sub_final
        || base->parent_type || base->rec_count != 1) return false;
    WASMArrayType *array = (WASMArrayType *)base;
    return array->elem_type == PACKED_TYPE_I16 && array->elem_flags == 1;
}

/* V8's imported-strings signatures require exact nullable extern parameters
 * and non-nullable extern results, not merely assignable reference types. */
static bool signature(const WASMModule *module, const WASMFuncType *type, uint32_t id)
{
    static const char *const signatures[] = {
        NULL, NULL, "re", "ri", "ie", "ie", "rii", "rii", "ri", "rre",
        "riie", "rri", "rri", "aiie", "raii"
    };
    const char *sig = signatures[id];
    uint32_t argc = (uint32_t)strlen(sig) - 1;
    if (type->param_count != argc || type->result_count != 1) return false;
    for (uint32_t i = 0; i <= argc; ++i) {
        switch (sig[i]) {
        case 'i': if (type->types[i] != VALUE_TYPE_I32) return false; break;
        case 'a': if (!i16_array(module, type, i)) return false; break;
        default:
            if (!extern_type(type->types[i], reference_type(type, i), sig[i] == 'r'))
                return false;
        }
    }
    return true;
}

bool silk_wasm_compile_options_init(SilkWasmHandle *handle,
                                    const SilkWasmCompileOptions *options)
{
    WASMModule *module = handle->as.module.module;
    if (!options || (!options->js_string && !options->has_constants)) return true;
    handle->as.module.options = *options;
    handle->as.module.options.constants = NULL;
    if (options->has_constants && options->constants_length) {
        uint8_t *copy = malloc(options->constants_length);
        if (!copy) goto oom;
        memcpy(copy, options->constants, options->constants_length);
        handle->as.module.options.constants = copy;
    }
    if (module->import_count) {
        handle->as.module.compile_imports = calloc(module->import_count, 1);
        if (!handle->as.module.compile_imports) goto oom;
    }
    /* WAMR groups imports by kind. Retain the first error in binary order
     * without allocating a second import-index table. */
    uint32_t first_error = UINT32_MAX;
    for (uint32_t i = 0; i < module->import_count; ++i) {
        WASMImport *import = &module->imports[i];
        uint32_t original = import->silk_original_index;
        if (original >= first_error) continue;
        char error[256];
        if (options->has_constants
            && constants_namespace_equal(import->u.names.module_name,
                                         import->silk_module_name_length,
                                         options->constants, options->constants_length)) {
            WASMGlobalImport *global = &import->u.global;
            if (import->kind != IMPORT_KIND_GLOBAL || global->type.is_mutable
                || !(extern_type(global->type.val_type, global->ref_type, true)
                     || extern_type(global->type.val_type, global->ref_type, false))) {
                snprintf(error, sizeof(error), "String constant import #%u \"%.*s\" must be an immutable global subtyping externref",
                         original, (int)(import->silk_field_name_length > 100 ? 100 : import->silk_field_name_length),
                         import->u.names.field_name);
                silk_wasm_set_error(handle->store, SILK_WASM_COMPILE_ERROR, error);
                first_error = original;
                continue;
            }
            handle->as.module.compile_imports[original] = STRING_CONSTANT;
        }
        if (!options->js_string || import->kind != IMPORT_KIND_FUNC
            || !bytes_equal(import->u.names.module_name, import->silk_module_name_length,
                            "wasm:js-string", sizeof("wasm:js-string") - 1)) continue;
        for (uint32_t id = CAST; id <= INTO_CHAR_CODE_ARRAY; ++id) {
            if (!bytes_equal(import->u.names.field_name, import->silk_field_name_length,
                             names[id], strlen(names[id]))) continue;
            if (!signature(module, import->u.function.func_type, id)) {
                snprintf(error, sizeof(error), "Imported builtin function \"wasm:js-string\" \"%s\" has incorrect signature", names[id]);
                silk_wasm_set_error(handle->store, SILK_WASM_COMPILE_ERROR, error);
                first_error = original;
                break;
            }
            handle->as.module.compile_imports[original] = (uint8_t)id;
            break;
        }
    }
    return first_error == UINT32_MAX;
oom:
    silk_wasm_set_error(handle->store, SILK_WASM_OOM, "Cannot allocate WebAssembly compile options");
    return false;
}

void silk_wasm_compile_options_destroy(SilkWasmHandle *handle)
{
    free((void *)handle->as.module.options.constants);
    free(handle->as.module.compile_imports);
    free(handle->as.module.serialized);
}

uint32_t silk_wasm_import_builtin(const SilkWasmHandle *handle, uint32_t index)
{
    return index < handle->as.module.module->import_count && handle->as.module.compile_imports
        ? handle->as.module.compile_imports[index] : ORDINARY;
}

/* A private, versioned worker-clone envelope. Public compile never accepts it. */
static const uint8_t clone_magic[8] = { 'S', 'I', 'L', 'K', 'W', 'A', 'S', 1 };
static uint32_t read32(const uint8_t *p)
{ return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void write32(uint8_t *p, uint32_t value)
{ for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(value >> (i * 8)); }

const uint8_t *silk_wasm_module_serialize(SilkWasmHandle *handle, uint64_t *length)
{
    if (!handle->as.module.serialized) {
        const SilkWasmCompileOptions *options = &handle->as.module.options;
        uint64_t size = UINT64_C(20) + options->constants_length + handle->as.module.length;
        if (size > SIZE_MAX) goto oom;
        uint8_t *bytes = malloc((size_t)size);
        if (!bytes) goto oom;
        memcpy(bytes, clone_magic, 8);
        write32(bytes + 8, (options->js_string ? 1 : 0) | (options->has_constants ? 2 : 0));
        write32(bytes + 12, options->constants_length);
        write32(bytes + 16, handle->as.module.length);
        if (options->constants_length)
            memcpy(bytes + 20, options->constants, options->constants_length);
        memcpy(bytes + 20 + options->constants_length, handle->as.module.bytes, handle->as.module.length);
        handle->as.module.serialized = bytes;
        handle->as.module.serialized_length = size;
    }
    *length = handle->as.module.serialized_length;
    return handle->as.module.serialized;
oom:
    *length = 0;
    silk_wasm_set_error(handle->store, SILK_WASM_OOM, "Cannot serialize WebAssembly module");
    return NULL;
}

SilkWasmHandle *silk_wasm_module_deserialize(SilkWasmStore *store,
                                            const uint8_t *bytes, uint64_t length)
{
    if (length < 20 || memcmp(bytes, clone_magic, 8)) goto invalid;
    uint32_t flags = read32(bytes + 8), constants = read32(bytes + 12), wasm = read32(bytes + 16);
    if ((flags & ~3U) || (!(flags & 2) && constants)
        || UINT64_C(20) + constants + wasm != length) goto invalid;
    SilkWasmCompileOptions options = { bytes + 20, constants, (flags & 1) != 0, (flags & 2) != 0 };
    return silk_wasm_compile(store, bytes + 20 + constants, wasm, &options);
invalid:
    silk_wasm_set_error(store, SILK_WASM_COMPILE_ERROR, "Invalid serialized WebAssembly module");
    return NULL;
}

static WASMArrayObjectRef array_object(SilkWasmHandle *handle)
{
    if (!handle || handle->kind != SILK_WASM_REFERENCE
        || !wasm_obj_is_array_obj(handle->as.reference.object)) return NULL;
    WASMArrayObjectRef array = (WASMArrayObjectRef)handle->as.reference.object;
    return wasm_array_obj_elem_size_log(array) == 1 ? array : NULL;
}

uint8_t silk_wasm_string_array_length(SilkWasmHandle *handle, uint32_t *length)
{
    WASMArrayObjectRef array = array_object(handle);
    if (!array) return false;
    *length = wasm_array_obj_length(array);
    return true;
}
uint8_t silk_wasm_string_array_get(SilkWasmHandle *handle, uint32_t index, uint32_t *value)
{
    WASMArrayObjectRef array = array_object(handle);
    if (!array || index >= wasm_array_obj_length(array)) return false;
    WASMValue result;
    wasm_array_obj_get_elem(array, index, false, &result);
    *value = result.u32;
    return true;
}
uint8_t silk_wasm_string_array_set(SilkWasmHandle *handle, uint32_t index, uint32_t value)
{
    WASMArrayObjectRef array = array_object(handle);
    if (!array || index >= wasm_array_obj_length(array)) return false;
    WASMValue input = { 0 };
    input.u32 = value & 0xffff;
    wasm_array_obj_set_elem(array, index, &input);
    return true;
}
