#include "silk_wamr_internal.h"
#include <stdio.h>
#include <string.h>

uint8_t silk_wasm_import_info(const SilkWasmHandle *handle, uint32_t index,
                           const char **module_name, uint32_t *module_length,
                           const char **name, uint32_t *name_length,
                           SilkWasmTypeInfo *type)
{
    WASMModule *module = handle->as.module.module;
    if (index >= module->import_count) return false;
    uint32_t counts[5] = { 0 };
    for (uint32_t i = 0; i < module->import_count; ++i) {
        WASMImport *import = &module->imports[i];
        uint32_t kind_index = counts[import->kind]++;
        if (import->silk_original_index != index) continue;
        *module_name = import->u.names.module_name;
        *module_length = import->silk_module_name_length;
        *name = import->u.names.field_name;
        *name_length = import->silk_field_name_length;
        return silk_wasm_type_info(handle, import->kind, kind_index, type);
    }
    return false;
}

uint8_t silk_wasm_export_info(const SilkWasmHandle *handle, uint32_t index,
                           const char **name, uint32_t *name_length,
                           SilkWasmTypeInfo *type)
{
    const SilkWasmHandle *owner = handle->kind == SILK_WASM_INSTANCE
        ? handle->as.instance.module : handle;
    WASMModule *module = owner->as.module.module;
    if (index >= module->export_count) return false;
    WASMExport *export = &module->exports[index];
    *name = export->name;
    *name_length = export->silk_name_length;
    return silk_wasm_type_info(owner, export->kind, export->index, type);
}

/* WAMR may move interned strings in its private input buffer. Custom section
 * reflection must expose the original bytes, including an untouched name
 * subsection, rather than the loader's rewritten copy. */
static const uint8_t *original_bytes(const SilkWasmHandle *handle,
                                     const void *loaded)
{
    return handle->as.module.bytes
        + ((const uint8_t *)loaded - handle->as.module.loaded_bytes);
}

static bool custom_name_matches(const SilkWasmHandle *handle,
                                 const WASMCustomSection *section,
                                 const uint8_t *name, uint32_t length)
{
    return section->name_len == length
        && (!length || !memcmp(original_bytes(handle, section->name_addr), name, length));
}

uint32_t silk_wasm_custom_count(const SilkWasmHandle *handle, const uint8_t *name,
                                uint32_t length)
{
    uint32_t count = 0;
    for (WASMCustomSection *section = handle->as.module.module->custom_section_list;
         section; section = section->next)
        if (custom_name_matches(handle, section, name, length)) ++count;
    return count;
}

const uint8_t *silk_wasm_custom(const SilkWasmHandle *handle, const uint8_t *name,
                               uint32_t name_length, uint32_t index,
                               uint32_t *length)
{
    /* The loader prepends sections; the JS API preserves binary order. */
    uint32_t count = silk_wasm_custom_count(handle, name, name_length);
    *length = 0;
    if (index >= count) return NULL;
    index = count - index - 1;
    for (WASMCustomSection *section = handle->as.module.module->custom_section_list;
         section; section = section->next) {
        if (!custom_name_matches(handle, section, name, name_length)) continue;
        if (index--) continue;
        *length = section->content_len;
        return original_bytes(handle, section->content_addr);
    }
    return NULL;
}

const char *silk_wasm_function_name(SilkWasmHandle *handle, uint32_t *length)
{
    *length = 0;
    if (handle->kind != SILK_WASM_FUNCTION) return "";
    if (!handle->as.function.name[0])
        snprintf(handle->as.function.name, sizeof(handle->as.function.name),
                 "%u", (unsigned)handle->as.function.index);
    *length = (uint32_t)strlen(handle->as.function.name);
    return handle->as.function.name;
}
