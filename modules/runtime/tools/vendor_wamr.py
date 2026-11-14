#!/usr/bin/env python3
"""Rewrites vendor/wamr: the pinned WAMR with vendor/wamr/patches applied, reduced to what builds.

    python3 tools/vendor_wamr.py [<WAMR archive> <SIMDe archive>]

Without arguments both archives are downloaded and checked against the pins below. Silk compiles
vendor/wamr itself (silk.toml, [native].sources): Silk can fetch an archive but not patch it,
hence this copy. It keeps the sources the runtime's WAMR configuration compiles on Linux and
macOS and every header they include, adds silk_target.h (the BUILD_TARGET_* define WAMR's CMake
passes, from the compiler's own macros) and writes invoke_native.c, WAMR's assembly entry for
calling native functions as top-level assembly, since Silk compiles C and not assembly.
"""
from pathlib import Path
import hashlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

COMMIT = '25bd7eb63e828e4bd242cc9b38d260b4b31c6605'
SHA256 = '4ea552d9d979f3c3d5f9e298a1594150820d2b76e8328ad68779578edea7a873'
URL = f'https://codeload.github.com/bytecodealliance/wasm-micro-runtime/tar.gz/{COMMIT}'
SIMDE_COMMIT = '71fd833d9666141edcd1d3c109a80e228303d8d7'
SIMDE_SHA256 = '72b2c14a487560b7eb203795f2c2fead5c7499662e639944cca2a9bb19f09029'
SIMDE_URL = f'https://codeload.github.com/simd-everywhere/simde/tar.gz/{SIMDE_COMMIT}'
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/wamr'
PATCHES = VENDOR / 'patches'

COMMON = '''core/shared/platform/common/posix/posix_blocking_op.c core/shared/platform/common/posix/posix_malloc.c
core/shared/platform/common/posix/posix_memmap.c core/shared/platform/common/posix/posix_sleep.c
core/shared/platform/common/posix/posix_thread.c core/shared/platform/common/posix/posix_time.c
core/shared/mem-alloc/ems/ems_alloc.c core/shared/mem-alloc/ems/ems_gc.c core/shared/mem-alloc/ems/ems_hmu.c
core/shared/mem-alloc/ems/ems_kfc.c core/shared/mem-alloc/mem_alloc.c core/shared/utils/bh_assert.c
core/shared/utils/bh_bitmap.c core/shared/utils/bh_common.c core/shared/utils/bh_hashmap.c
core/shared/utils/bh_leb128.c core/shared/utils/bh_list.c core/shared/utils/bh_log.c core/shared/utils/bh_queue.c
core/shared/utils/bh_vector.c core/shared/utils/runtime_timer.c core/iwasm/common/wasm_application.c
core/iwasm/common/wasm_blocking_op.c core/iwasm/common/wasm_c_api.c core/iwasm/common/wasm_exec_env.c
core/iwasm/common/wasm_loader_common.c core/iwasm/common/wasm_memory.c core/iwasm/common/wasm_native.c
core/iwasm/common/wasm_runtime_common.c core/iwasm/common/wasm_shared_memory.c
core/iwasm/interpreter/wasm_interp_classic.c core/iwasm/interpreter/wasm_loader.c
core/iwasm/interpreter/wasm_runtime.c core/iwasm/common/gc/gc_common.c core/iwasm/common/gc/gc_object.c
core/iwasm/common/gc/gc_type.c'''.split()
SYSTEMS = {
    'linux': (['core/shared/platform/linux/platform_init.c'], ['-DBH_PLATFORM_LINUX', '-DWASM_HAVE_MREMAP=1', '-D_GNU_SOURCE']),
    'darwin': (['core/shared/platform/darwin/platform_init.c', 'core/shared/platform/common/memory/mremap.c'], ['-DBH_PLATFORM_DARWIN']),
}
DEFINES = '''-DBH_ENABLE_GC_CORRUPTION_CHECK=0 -DBH_FREE=wasm_runtime_free -DBH_MALLOC=wasm_runtime_malloc
-DWASM_DISABLE_HW_BOUND_CHECK=1 -DWASM_DISABLE_STACK_HW_BOUND_CHECK=1 -DWASM_DISABLE_WAKEUP_BLOCKING_OP=0
-DWASM_DISABLE_WRITE_GS_BASE=0 -DWASM_ENABLE_AOT_INTRINSICS=0 -DWASM_ENABLE_BULK_MEMORY=1
-DWASM_ENABLE_CUSTOM_NAME_SECTION=1 -DWASM_ENABLE_EXCE_HANDLING=1 -DWASM_ENABLE_EXTENDED_CONST_EXPR=1
-DWASM_ENABLE_FAST_INTERP=0 -DWASM_ENABLE_GC=1 -DWASM_ENABLE_INTERP=1 -DWASM_ENABLE_LOAD_CUSTOM_SECTION=1
-DWASM_ENABLE_MEMORY64=1 -DWASM_ENABLE_MINI_LOADER=0 -DWASM_ENABLE_MULTI_MEMORY=1 -DWASM_ENABLE_MULTI_MODULE=1
-DWASM_ENABLE_QUICK_AOT_ENTRY=0 -DWASM_ENABLE_REF_TYPES=1 -DWASM_ENABLE_SHARED_MEMORY=1
-DWASM_ENABLE_SHRUNK_MEMORY=1 -DWASM_ENABLE_SIMD=1 -DWASM_ENABLE_SIMDE=1 -DWASM_ENABLE_TAGS=1
-DWASM_ENABLE_TAIL_CALL=1 -DWASM_GLOBAL_HEAP_SIZE=10485760'''.split()
# WAMR's include directories, in the order its CMake gives them; the platform's comes from SYSTEMS.
INCLUDES = ['core/iwasm/interpreter', 'core/iwasm/common/gc', 'core/iwasm/include', 'PLATFORM',
            'core/shared/platform/include', 'core/shared/mem-alloc', 'core/iwasm/common', 'core/shared/utils']
TARGETS = [('__x86_64__', 'BUILD_TARGET_X86_64', 'invokeNative_em64_simd.s'),
           ('__aarch64__', 'BUILD_TARGET_AARCH64', 'invokeNative_aarch64_simd.s')]


def fetched(url, digest, given):
    data = Path(given).read_bytes() if given else urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f'checksum mismatch: {given or url}')
    return data


def unpack(data, directory):
    directory.mkdir()
    archive = directory / 'archive.tar.gz'
    archive.write_bytes(data)
    with tarfile.open(archive) as packed:
        packed.extractall(directory, filter='data')
    return next(p for p in directory.iterdir() if p.is_dir())


def main():
    given = sys.argv[1:3] if len(sys.argv) >= 3 else [None, None]
    compiler = shutil.which('clang') or sys.exit('vendoring needs clang on PATH')
    with tempfile.TemporaryDirectory() as work:
        wamr = unpack(fetched(URL, SHA256, given[0]), Path(work) / 'wamr')
        simde = unpack(fetched(SIMDE_URL, SIMDE_SHA256, given[1]), Path(work) / 'simde')
        for patch in sorted(PATCHES.glob('*.patch')):
            subprocess.run(['patch', '-p1', '--batch', '--no-backup-if-mismatch', '-i', str(patch)], cwd=wamr, check=True, stdout=subprocess.DEVNULL)
        keep = {'LICENSE', 'ATTRIBUTIONS.md'}
        for system, (sources, defines) in SYSTEMS.items():
            platform = 'core/shared/platform/' + system
            includes = [platform if i == 'PLATFORM' else i for i in INCLUDES]
            for source in COMMON + sources + ['core/iwasm/common/arch/invokeNative_general.c']:
                keep.add(source)
                result = subprocess.run([compiler, '-MM', '-std=gnu11', *DEFINES, *defines, '-DBUILD_TARGET_X86_64',
                                         *('-I' + str(wamr / i) for i in includes), '-I' + str(simde),
                                         '-I' + str(ROOT / 'src/ext/wamr'), str(wamr / source)],
                                        check=True, capture_output=True, text=True)
                for word in result.stdout.replace('\\\n', ' ').split()[1:]:
                    path = Path(word).resolve()
                    if path.is_relative_to(wamr.resolve()):
                        keep.add(path.relative_to(wamr.resolve()).as_posix())
        keep.discard('core/iwasm/common/arch/invokeNative_general.c')
        for kept in [p for p in VENDOR.iterdir() if p.name != 'patches']:
            shutil.rmtree(kept) if kept.is_dir() else kept.unlink()
        for name in sorted(keep):
            destination = VENDOR / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            text = (wamr / name).read_bytes()
            if name.endswith('/platform_internal.h') or name == 'core/config.h':
                text = b'#include "silk_target.h"\n' + text
            destination.write_bytes(text)
        (VENDOR / 'core/shared/platform/include/silk_target.h').write_text(
            '/* What WAMR\'s CMake passes as -DBUILD_TARGET_<arch>, for the target being compiled. */\n'
            '#ifndef SILK_TARGET_H\n#define SILK_TARGET_H\n'
            + ''.join(f'#if defined({macro}) && !defined({target})\n#define {target}\n#endif\n' for macro, target, _ in TARGETS)
            + '#endif\n')
        arms = []
        for macro, target, assembly in TARGETS:
            for apple in (False, True):
                flags = ['-DBH_PLATFORM_DARWIN'] if apple else []
                text = subprocess.run([compiler, '-E', '-P', '-x', 'assembler-with-cpp', *flags,
                                       str(wamr / 'core/iwasm/common/arch' / assembly)],
                                      check=True, capture_output=True, text=True).stdout
                if apple:
                    # Mach-O only lets a conditional branch reach an assembler-local (L-prefixed) label.
                    for label in re.findall(r'(?m)^\s*(\w+):', text):
                        if not label.startswith('_'):
                            text = re.sub(rf'\b{label}\b', 'L' + label, text)
                lines = ''.join('    "' + line.replace('\\', '\\\\').replace('"', '\\"') + '\\n"\n'
                                for line in text.splitlines() if line.strip())
                condition = f'defined({macro}) && ' + ('defined(__APPLE__)' if apple else '!defined(__APPLE__)')
                arms.append(f'#{"if" if not arms else "elif"} {condition}\n__asm__(\n{lines});\n')
        (VENDOR / 'invoke_native.c').write_text(
            '/* Generated by tools/vendor_wamr.py from WAMR\'s core/iwasm/common/arch assembly. */\n'
            + ''.join(arms) + '#else\n#error "No WAMR native call entry for this target"\n#endif\n')
    print(f'vendor/wamr: {len(keep)} files')


if __name__ == '__main__':
    main()
