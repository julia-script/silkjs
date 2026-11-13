cmake_minimum_required(VERSION 3.20)
project(silk_wamr LANGUAGES C ASM)

if(NOT DEFINED WAMR_ROOT_DIR OR NOT EXISTS "${WAMR_ROOT_DIR}/core/iwasm/interpreter/wasm_continuation.h")
    message(FATAL_ERROR "WAMR_ROOT_DIR must be the source tree returned by tools/prepare_wamr.py")
endif()
if(NOT DEFINED SIMDE_SOURCE_DIR OR NOT EXISTS "${SIMDE_SOURCE_DIR}/simde/wasm/simd128.h")
    message(FATAL_ERROR "SIMDE_SOURCE_DIR must be the pinned source tree prepared by tools/prepare_wamr.py")
endif()

if(APPLE)
    set(WAMR_BUILD_PLATFORM darwin)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(WAMR_BUILD_PLATFORM linux)
else()
    message(FATAL_ERROR "Silk native WAMR embedding requires a supported POSIX platform")
endif()

set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 0)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)
set(WAMR_BUILD_MINI_LOADER 0)
set(WAMR_BUILD_GC 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_EXCE_HANDLING 1)
set(WAMR_BUILD_SIMD 1)
set(WAMR_BUILD_SIMDE 1)
set(WAMR_BUILD_MULTI_MODULE 1)
set(WAMR_BUILD_MULTI_MEMORY 1)
set(WAMR_BUILD_SHARED_MEMORY 1)
set(WAMR_BUILD_MEMORY64 1)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_TAIL_CALL 1)
set(WAMR_BUILD_EXTENDED_CONST_EXPR 1)
set(WAMR_BUILD_LOAD_CUSTOM_SECTION 1)
set(WAMR_BUILD_CUSTOM_NAME_SECTION 1)
set(WAMR_BUILD_THREAD_MGR 0)
set(WAMR_BUILD_LIB_PTHREAD 0)
set(WAMR_BUILD_LIB_WASI_THREADS 0)
set(WAMR_BUILD_LIBC_BUILTIN 0)
set(WAMR_BUILD_LIBC_WASI 0)
set(WAMR_BUILD_LIBC_UVWASI 0)
set(WAMR_BUILD_LIBC_EMCC 0)
set(WAMR_BUILD_DEBUG_INTERP 0)
set(WAMR_BUILD_WASM_C_API 0)
set(WAMR_BUILD_STRINGREF 0)
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
set(WAMR_DISABLE_STACK_HW_BOUND_CHECK 1)

include("${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake")
add_library(silk_wamr STATIC
    ${WAMR_RUNTIME_LIB_SOURCE}
    silk_wamr.c
    silk_wamr_calls.c
    silk_wamr_frames.c
    silk_wamr_compile_options.c
    silk_wamr_exceptions.c
    silk_wamr_instances.c
    silk_wamr_metadata.c
    silk_wamr_resources.c
    silk_wamr_types.c
    silk_wamr_values.c
)
set_target_properties(silk_wamr PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES POSITION_INDEPENDENT_CODE YES)
target_include_directories(silk_wamr PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
find_package(Threads REQUIRED)
target_link_libraries(silk_wamr PUBLIC Threads::Threads m)
