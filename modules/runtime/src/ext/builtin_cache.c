/* The built-in modules' bytecode and the build identity, as weak defaults.
 *
 * tools/build.py links a second object defining these again: the bytecode the runtime itself
 * writes right after its first link, and the identity of everything the build read (tools/embed.py,
 * cache_build_identity). A program built by a plain `silk build`, such as one that embeds the
 * runtime, keeps these: an empty cache, so built-ins compile from source, and an identity taken
 * from the executable file, so caches written by another build of it are never read. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifdef SILK_BUILTIN_CACHE_FILE
static const unsigned char cache[] = {
#embed SILK_BUILTIN_CACHE_FILE if_empty(0)
};
const unsigned char *silk_builtin_cache_data(void) { return cache; }
size_t silk_builtin_cache_length(void) { return sizeof cache; }
#else
__attribute__((weak)) const unsigned char *silk_builtin_cache_data(void) { return (const unsigned char *)""; }
__attribute__((weak)) size_t silk_builtin_cache_length(void) { return 0; }
#endif

#ifdef SILK_BUILD_IDENTITY
const unsigned char *silk_build_identity(void) { return (const unsigned char *)SILK_BUILD_IDENTITY; }
#else
static char identity[65];
static pthread_once_t identity_once = PTHREAD_ONCE_INIT;

static uint64_t mix(uint64_t hash, uint64_t value) {
  for (int i = 0; i < 8; i++) { hash ^= (value >> (i * 8)) & 0xff; hash *= 0x100000001b3ull; }
  return hash;
}

/* The executable's size, modification time and file identity, which change with every build of
 * it; a process that cannot read them gets one of its own, which no other process shares. */
static void compute_identity(void) {
  char path[4096] = {0};
  struct stat info;
  int found = 0;
#ifdef __APPLE__
  uint32_t size = sizeof path;
  found = _NSGetExecutablePath(path, &size) == 0 && stat(path, &info) == 0;
#else
  found = stat("/proc/self/exe", &info) == 0;
#endif
  uint64_t values[6] = {0};
  if (found) {
    values[0] = (uint64_t)info.st_size; values[1] = (uint64_t)info.st_ino; values[2] = (uint64_t)info.st_dev;
#ifdef __APPLE__
    values[3] = (uint64_t)info.st_mtimespec.tv_sec; values[4] = (uint64_t)info.st_mtimespec.tv_nsec;
#else
    values[3] = (uint64_t)info.st_mtim.tv_sec; values[4] = (uint64_t)info.st_mtim.tv_nsec;
#endif
  } else {
    values[0] = (uint64_t)getpid(); values[1] = (uint64_t)(uintptr_t)&info; values[5] = 1;
  }
  for (int part = 0; part < 4; part++) {
    uint64_t hash = 0xcbf29ce484222325ull ^ (uint64_t)part;
    for (int i = 0; i < 6; i++) hash = mix(hash, values[i]);
    snprintf(identity + part * 16, 17, "%016llx", (unsigned long long)hash);
  }
}

__attribute__((weak)) const unsigned char *silk_build_identity(void) {
  pthread_once(&identity_once, compute_identity);
  return (const unsigned char *)identity;
}
#endif
