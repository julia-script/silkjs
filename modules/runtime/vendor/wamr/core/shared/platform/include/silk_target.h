/* What WAMR's CMake passes as -DBUILD_TARGET_<arch>, for the target being compiled. */
#ifndef SILK_TARGET_H
#define SILK_TARGET_H
#if defined(__x86_64__) && !defined(BUILD_TARGET_X86_64)
#define BUILD_TARGET_X86_64
#endif
#if defined(__aarch64__) && !defined(BUILD_TARGET_AARCH64)
#define BUILD_TARGET_AARCH64
#endif
#endif
