/* The built-in modules' bytecode, produced by the runtime itself right after its
 * first link (tools/build.py) and linked into the final executable. Without
 * SILK_BUILTIN_CACHE_FILE the cache is empty and built-ins compile from source. */
#include <stddef.h>

#ifdef SILK_BUILTIN_CACHE_FILE
static const unsigned char cache[] = {
#embed SILK_BUILTIN_CACHE_FILE if_empty(0)
};
const unsigned char *silk_builtin_cache_data(void) { return cache; }
size_t silk_builtin_cache_length(void) { return sizeof cache; }
#else
const unsigned char *silk_builtin_cache_data(void) { return (const unsigned char *)""; }
size_t silk_builtin_cache_length(void) { return 0; }
#endif
