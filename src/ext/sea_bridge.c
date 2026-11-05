/* Silk SEA v1: LC_NOTE owner SILKJS_SEA, immutable file-backed payload.
 * A state and every exposed ArrayBuffer hold independent mapping references. */
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#endif

typedef struct SilkSea {
  size_t references;
  void *mapping;
  size_t mapping_size;
  unsigned char *bytes;
  size_t length;
  uint32_t manifest_length;
  int status;
} SilkSea;
static pthread_mutex_t sea_lock = PTHREAD_MUTEX_INITIALIZER;
static SilkSea *sea_shared;
static const char sea_owner[16] = "SILKJS_SEA";

static void sea_load(SilkSea *sea) {
#ifdef __APPLE__
  const struct mach_header_64 *header = (const void *)_dyld_get_image_header(0);
  if (!header || header->magic != MH_MAGIC_64) return;
  const unsigned char *command = (const void *)(header + 1);
  const unsigned char *end = command + header->sizeofcmds;
  uint64_t offset = 0, length = 0;
  int found = 0;
  for (uint32_t i = 0; i < header->ncmds; i++) {
    if ((size_t)(end - command) < sizeof(struct load_command)) { sea->status = -EINVAL; return; }
    const struct load_command *load = (const void *)command;
    if (load->cmdsize < sizeof(*load) || load->cmdsize > (size_t)(end - command)) { sea->status = -EINVAL; return; }
    if (load->cmd == LC_NOTE && load->cmdsize >= sizeof(struct note_command)) {
      const struct note_command *note = (const void *)command;
      if (!memcmp(note->data_owner, sea_owner, sizeof(sea_owner))) {
        if (found++) { sea->status = -EINVAL; return; }
        offset = note->offset; length = note->size;
      }
    }
    command += load->cmdsize;
  }
  if (!found) return;
  sea->status = -EINVAL;
  if (length < 16 || length > SIZE_MAX || offset > INT64_MAX || length > INT64_MAX - offset) return;
  uint32_t capacity = 0;
  _NSGetExecutablePath(NULL, &capacity);
  char *path = malloc(capacity);
  if (!path) { sea->status = -ENOMEM; return; }
  if (_NSGetExecutablePath(path, &capacity)) { free(path); return; }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  free(path);
  if (fd < 0) { sea->status = -errno; return; }
  struct stat statbuf;
  if (fstat(fd, &statbuf)) { sea->status = -errno; close(fd); return; }
  if (statbuf.st_size < 0 || offset + length > (uint64_t)statbuf.st_size) { close(fd); return; }
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0) { close(fd); return; }
  uint64_t start = offset - offset % (uint64_t)page;
  size_t delta = (size_t)(offset - start);
  if (length > SIZE_MAX - delta) { close(fd); return; }
  size_t extent = delta + (size_t)length;
  void *mapping = mmap(NULL, extent, PROT_READ, MAP_PRIVATE, fd, (off_t)start);
  int saved = errno;
  close(fd);
  if (mapping == MAP_FAILED) { sea->status = -saved; return; }
  unsigned char *bytes = (unsigned char *)mapping + delta;
  uint32_t manifest = (uint32_t)bytes[8] | (uint32_t)bytes[9] << 8 |
                      (uint32_t)bytes[10] << 16 | (uint32_t)bytes[11] << 24;
  if (memcmp(bytes, "SILKSEA1", 8) || bytes[12] || bytes[13] || bytes[14] || bytes[15] ||
      manifest > length - 16) { munmap(mapping, extent); return; }
  sea->mapping = mapping; sea->mapping_size = extent;
  sea->bytes = bytes; sea->length = (size_t)length;
  sea->manifest_length = manifest; sea->status = 1;
#else
  (void)sea; /* No supported injected executable format on this platform. */
#endif
}
void *silk_sea_open(void) {
  pthread_mutex_lock(&sea_lock);
  if (!sea_shared) {
    sea_shared = calloc(1, sizeof(*sea_shared));
    if (sea_shared) sea_load(sea_shared);
  }
  SilkSea *sea = sea_shared;
  if (sea) sea->references++;
  pthread_mutex_unlock(&sea_lock);
  return sea;
}
void silk_sea_retain(void *owner) {
  pthread_mutex_lock(&sea_lock);
  ((SilkSea *)owner)->references++;
  pthread_mutex_unlock(&sea_lock);
}
void silk_sea_release(void *owner) {
  if (!owner) return;
  pthread_mutex_lock(&sea_lock);
  SilkSea *sea = owner;
  if (--sea->references == 0) {
    if (sea->mapping) munmap(sea->mapping, sea->mapping_size);
    sea_shared = NULL;
    free(sea);
  }
  pthread_mutex_unlock(&sea_lock);
}
int silk_sea_status(void *owner) { return ((SilkSea *)owner)->status; }
size_t silk_sea_length(void *owner) { return ((SilkSea *)owner)->length; }
size_t silk_sea_manifest_length(void *owner) { return ((SilkSea *)owner)->manifest_length; }
void *silk_sea_range(void *owner, size_t offset, size_t length) {
  SilkSea *sea = owner;
  if (sea->status != 1 || offset > sea->length || length > sea->length - offset) return NULL;
  return sea->bytes + offset;
}
