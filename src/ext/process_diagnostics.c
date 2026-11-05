#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L
#include "process_diagnostics.h"
#include <uv.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <limits.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <sys/resource.h>

struct message { struct message *next; uint32_t channel; size_t length; unsigned char *bytes; };
struct owner {
  struct owner *next;
  uint32_t id;
  uv_async_t *wake;
  _Atomic uint64_t requested;
  uint64_t completed;
  size_t references;
  int exited, failure;
  int inspector_wait_at_start;
  char *json;
  size_t length;
  struct message *messages, *messages_tail;
  struct message *departure;
  _Atomic uint32_t message_channels;
};
static pthread_mutex_t transport = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static struct owner *owners;
static _Thread_local struct owner *current;
static _Thread_local uint64_t serviced;
static int inspector_wait_for_new_workers;

struct text { char *bytes; size_t length, capacity; int failed; };
static void append(struct text *b, const char *s, size_t n) {
  if (b->failed) return;
  if (n > SIZE_MAX - b->length - 1) { b->failed = 1; return; }
  size_t need = b->length + n + 1;
  if (need > b->capacity) {
    size_t capacity = b->capacity ? b->capacity : 1024;
    while (capacity < need) { if (capacity > SIZE_MAX / 2) { capacity = need; break; } capacity *= 2; }
    char *p = realloc(b->bytes, capacity);
    if (!p) { b->failed = 1; return; }
    b->bytes = p; b->capacity = capacity;
  }
  memcpy(b->bytes + b->length, s, n); b->length += n; b->bytes[b->length] = 0;
}
#define LITERAL(b, s) append((b), (s), sizeof(s) - 1)
static void number(struct text *b, uint64_t n) { char digits[32]; int length = snprintf(digits, sizeof(digits), "%llu", (unsigned long long)n); append(b, digits, (size_t)length); }
static void quoted(struct text *b, const unsigned char *s, size_t n) {
  static const char hex[] = "0123456789abcdef";
  LITERAL(b, "\"");
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = s[i];
    if (c == '"' || c == '\\') { char out[2] = {'\\', (char)c}; append(b, out, 2); }
    else if (c < 32) { char out[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]}; append(b, out, 6); }
    else append(b, (const char *)&s[i], 1);
  }
  LITERAL(b, "\"");
}
static void free_message(struct message *message) {
  if (message) { free(message->bytes); free(message); }
}
static void enqueue_message(struct owner *owner, struct message *message) {
  if (owner->messages_tail) owner->messages_tail->next = message; else owner->messages = message;
  owner->messages_tail = message;
  atomic_fetch_or_explicit(&owner->message_channels, UINT32_C(1) << message->channel, memory_order_release);
  if (owner->wake) uv_async_send(owner->wake);
  pthread_cond_broadcast(&changed);
}
static struct message *lifecycle_message(uint32_t id, uint32_t kind) {
  struct message *message = calloc(1, sizeof(*message));
  if (!message) return NULL;
  message->bytes = calloc(1, 16);
  if (!message->bytes) { free(message); return NULL; }
  message->channel = 1; message->length = 16;
  for (unsigned int i = 0; i < 4; ++i) {
    message->bytes[i] = (unsigned char)(id >> (i * 8));
    message->bytes[i + 4] = (unsigned char)(kind >> (i * 8));
  }
  return message;
}
static void release_owner(struct owner *entry) {
  if (--entry->references == 0) {
    struct message *message = entry->messages;
    while (message) { struct message *next = message->next; free_message(message); message = next; }
    free_message(entry->departure); free(entry->json); free(entry);
  }
}
int silk_diagnostics_attach(uint32_t id, void *wake) {
  if (current) return EALREADY;
  struct owner *entry = calloc(1, sizeof(*entry));
  if (!entry) return ENOMEM;
  struct message *arrival = NULL;
  if (id != 0) {
    arrival = lifecycle_message(id, 5);
    entry->departure = lifecycle_message(id, 6);
    if (!arrival || !entry->departure) { free_message(arrival); free_message(entry->departure); free(entry); return ENOMEM; }
  }
  entry->id = id; entry->wake = wake; entry->references = 1;
  pthread_mutex_lock(&transport);
  entry->inspector_wait_at_start = id != 0 && inspector_wait_for_new_workers;
  entry->next = owners; owners = entry; current = entry; serviced = 0;
  if (arrival) {
    struct owner *main = owners;
    while (main && main->id != 0) main = main->next;
    if (main) enqueue_message(main, arrival); else free_message(arrival);
  }
  pthread_mutex_unlock(&transport);
  return 0;
}
void silk_diagnostics_detach(void) {
  pthread_mutex_lock(&transport);
  struct owner *entry = current;
  if (entry) {
    struct owner **link = &owners;
    while (*link && *link != entry) link = &(*link)->next;
    if (*link) *link = entry->next;
    if (entry->departure) {
      struct owner *main = owners;
      while (main && main->id != 0) main = main->next;
      if (main) enqueue_message(main, entry->departure); else free_message(entry->departure);
      entry->departure = NULL;
    }
    entry->exited = 1; entry->wake = NULL; current = NULL;
    pthread_cond_broadcast(&changed); release_owner(entry);
  }
  pthread_mutex_unlock(&transport);
}
uint32_t silk_diagnostics_owner_id(void) { return current ? current->id : UINT32_MAX; }
void silk_diagnostics_inspector_wait_set(int enabled) {
  if (!current || current->id != 0) return;
  pthread_mutex_lock(&transport);
  inspector_wait_for_new_workers = enabled != 0;
  current->inspector_wait_at_start = inspector_wait_for_new_workers;
  pthread_mutex_unlock(&transport);
}
int silk_diagnostics_inspector_wait_get(void) {
  return current ? current->inspector_wait_at_start : 0;
}
uint32_t *silk_diagnostics_owner_ids(size_t *count) {
  pthread_mutex_lock(&transport);
  *count = 0;
  for (struct owner *owner = owners; owner; owner = owner->next) if (owner->id != 0) ++*count;
  uint32_t *ids = *count ? malloc(*count * sizeof(*ids)) : NULL;
  if (ids) {
    size_t at = 0;
    for (struct owner *owner = owners; owner; owner = owner->next) if (owner->id != 0) ids[at++] = owner->id;
  }
  pthread_mutex_unlock(&transport);
  return ids;
}
uint64_t silk_diagnostics_pending(void) {
  if (!current) return 0;
  uint64_t generation = atomic_load_explicit(&current->requested, memory_order_acquire);
  return generation != serviced ? generation : 0;
}
/* Inspector/profiling use the same lifetime-protected isolate registry, but each
 * protocol owns its channel payload. Neither transport inspects JS values. */
int silk_diagnostics_message_pending(uint32_t channel) {
  return current && channel < 32 &&
    (atomic_load_explicit(&current->message_channels, memory_order_acquire) & (UINT32_C(1) << channel)) != 0;
}
int silk_diagnostics_post_parts(uint32_t target, uint32_t channel, const unsigned char *prefix, size_t prefix_length, const unsigned char *bytes, size_t length) {
  if (channel >= 32 || (length && !bytes) || (prefix_length && !prefix)) return EINVAL;
  if (prefix_length > SIZE_MAX - length) return ENOMEM;
  size_t total = prefix_length + length;
  struct message *message = malloc(sizeof(*message));
  if (!message) return ENOMEM;
  message->bytes = malloc(total ? total : 1);
  if (!message->bytes) { free(message); return ENOMEM; }
  if (prefix_length) memcpy(message->bytes, prefix, prefix_length);
  if (length) memcpy(message->bytes + prefix_length, bytes, length);
  message->next = NULL; message->channel = channel; message->length = total;
  pthread_mutex_lock(&transport);
  struct owner *owner = owners;
  while (owner && owner->id != target) owner = owner->next;
  if (!owner) { pthread_mutex_unlock(&transport); free(message->bytes); free(message); return ESRCH; }
  enqueue_message(owner, message);
  pthread_mutex_unlock(&transport);
  return 0;
}
int silk_diagnostics_post(uint32_t target, uint32_t channel, const unsigned char *bytes, size_t length) {
  return silk_diagnostics_post_parts(target, channel, NULL, 0, bytes, length);
}
unsigned char *silk_diagnostics_take(uint32_t channel, size_t *length) {
  *length = 0;
  if (!silk_diagnostics_message_pending(channel)) return NULL;
  pthread_mutex_lock(&transport);
  struct message *prior = NULL, *message = current->messages;
  while (message && message->channel != channel) { prior = message; message = message->next; }
  if (!message) { pthread_mutex_unlock(&transport); return NULL; }
  if (prior) prior->next = message->next; else current->messages = message->next;
  if (current->messages_tail == message) current->messages_tail = prior;
  struct message *remaining = current->messages;
  while (remaining && remaining->channel != channel) remaining = remaining->next;
  if (!remaining) atomic_fetch_and_explicit(&current->message_channels, ~(UINT32_C(1) << channel), memory_order_release);
  pthread_mutex_unlock(&transport);
  unsigned char *bytes = message->bytes; *length = message->length; free(message);
  return bytes;
}
int silk_diagnostics_wait(uint32_t timeout_ms) {
  if (!current) return 0;
  struct timespec until; clock_gettime(CLOCK_REALTIME, &until);
  until.tv_sec += timeout_ms / 1000; until.tv_nsec += (long)(timeout_ms % 1000) * 1000000;
  if (until.tv_nsec >= 1000000000) { ++until.tv_sec; until.tv_nsec -= 1000000000; }
  pthread_mutex_lock(&transport);
  int ready;
  for (;;) {
    ready = atomic_load_explicit(&current->message_channels, memory_order_acquire) != 0 || silk_diagnostics_pending() != 0;
    if (ready || pthread_cond_timedwait(&changed, &transport, &until) == ETIMEDOUT) break;
  }
  pthread_mutex_unlock(&transport);
  return ready;
}
struct walk { struct text *text; int first; };
static void resource(uv_handle_t *h, void *opaque) {
  struct walk *walk = opaque; struct text *b = walk->text;
  if (!walk->first) LITERAL(b, ","); walk->first = 0;
  const char *type = uv_handle_type_name(uv_handle_get_type(h));
  LITERAL(b, "{\"type\":"); quoted(b, (const unsigned char *)(type ? type : "unknown"), strlen(type ? type : "unknown"));
  LITERAL(b, ",\"is_active\":"); append(b, uv_is_active(h) ? "true" : "false", uv_is_active(h) ? 4 : 5);
  LITERAL(b, ",\"is_referenced\":"); append(b, uv_has_ref(h) ? "true" : "false", uv_has_ref(h) ? 4 : 5);
  LITERAL(b, ",\"is_closing\":"); append(b, uv_is_closing(h) ? "true" : "false", uv_is_closing(h) ? 4 : 5);
  char address[32]; int length = snprintf(address, sizeof(address), "%p", (void *)h);
  LITERAL(b, ",\"address\":"); quoted(b, (const unsigned char *)address, (size_t)length);
  uv_os_fd_t fd;
  if (uv_fileno(h, &fd) == 0) { LITERAL(b, ",\"fd\":"); number(b, (uint64_t)fd); }
  LITERAL(b, "}");
}
static void publish(uint64_t generation, struct text *text, int failure) {
  pthread_mutex_lock(&transport);
  if (current && generation == atomic_load_explicit(&current->requested, memory_order_relaxed)) {
    free(current->json); current->json = text ? text->bytes : NULL;
    current->length = text ? text->length : 0;
    current->failure = failure; current->completed = generation; serviced = generation;
    if (text) text->bytes = NULL;
    pthread_cond_broadcast(&changed);
  }
  pthread_mutex_unlock(&transport);
  if (text) free(text->bytes);
}
void silk_diagnostics_failed(uint64_t generation, int reason) { publish(generation, NULL, reason ? reason : EIO); }
void silk_diagnostics_publish(uint64_t generation, void *loop, const unsigned char *stack, size_t length, size_t heap, size_t external) {
  if (!current) return;
  struct text b = {0};
  LITERAL(&b, "{\"header\":{\"threadId\":"); number(&b, current->id);
  LITERAL(&b, ",\"event\":\"Worker diagnostic snapshot\",\"trigger\":\"GetReport\"},\"javascriptStack\":{\"message\":\"JavaScript Callstack\",\"stack\":[");
  size_t start = 0; int first = 1;
  for (size_t i = 0; i <= length; ++i) {
    if (i != length && stack[i] != '\n') continue;
    size_t end = i;
    while (start < end && (stack[start] == ' ' || stack[start] == '\t')) ++start;
    if (end > start) { if (!first) LITERAL(&b, ","); quoted(&b, stack + start, end - start); first = 0; }
    start = i + 1;
  }
  LITERAL(&b, "],\"errorProperties\":{}},\"javascriptHeap\":{\"totalMemory\":"); number(&b, heap);
  LITERAL(&b, ",\"usedMemory\":"); number(&b, heap);
  LITERAL(&b, ",\"externalMemory\":"); number(&b, external);
  LITERAL(&b, ",\"arrayBuffers\":"); number(&b, external);
  LITERAL(&b, "},\"libuv\":["); struct walk walk = {&b, 1}; uv_walk(loop, resource, &walk);
  LITERAL(&b, "],\"silkjs\":{\"snapshotStatus\":\"available\",\"heapAccounting\":\"live allocator charges, not V8 arenas\"}}");
  if (b.failed) { free(b.bytes); silk_diagnostics_failed(generation, ENOMEM); }
  else publish(generation, &b, 0);
}
struct request { struct owner *owner; uint64_t generation; };
unsigned char *silk_diagnostics_workers(size_t *length) {
  *length = 0;
  pthread_mutex_lock(&transport);
  size_t count = 0;
  for (struct owner *p = owners; p; p = p->next) if (p != current && p->id != 0) ++count;
  struct request *requests = count ? calloc(count, sizeof(*requests)) : NULL;
  if (count && !requests) { pthread_mutex_unlock(&transport); return NULL; }
  size_t at = 0;
  for (struct owner *p = owners; p; p = p->next) {
    if (p == current || p->id == 0) continue;
    uint64_t generation = atomic_load_explicit(&p->requested, memory_order_relaxed);
    if (generation == p->completed) { ++generation; atomic_store_explicit(&p->requested, generation, memory_order_release); }
    ++p->references; requests[at++] = (struct request){p, generation};
    if (p->wake) uv_async_send(p->wake);
  }
  if (count) pthread_cond_broadcast(&changed);
  struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 1;
  for (;;) {
    int pending = 0;
    for (size_t i = 0; i < count; ++i) if (!requests[i].owner->exited && requests[i].owner->completed < requests[i].generation) { pending = 1; break; }
    if (!pending || pthread_cond_timedwait(&changed, &transport, &until) == ETIMEDOUT) break;
  }
  struct text b = {0}; LITERAL(&b, "[");
  for (size_t i = 0; i < count; ++i) {
    struct owner *p = requests[i].owner;
    if (i) LITERAL(&b, ",");
    if (p->completed >= requests[i].generation && !p->failure && p->json) append(&b, p->json, p->length);
    else {
      LITERAL(&b, "{\"header\":{\"threadId\":"); number(&b, p->id);
      LITERAL(&b, "},\"silkjs\":{\"snapshotStatus\":\"unavailable\",\"reason\":");
      const char *reason = p->exited ? "worker exited during collection" : p->completed < requests[i].generation ? "owner thread did not reach a safe point within 1000ms" : "owner snapshot allocation failed";
      quoted(&b, (const unsigned char *)reason, strlen(reason)); LITERAL(&b, "}}");
    }
    release_owner(p);
  }
  pthread_mutex_unlock(&transport); free(requests); LITERAL(&b, "]");
  if (b.failed) { free(b.bytes); return NULL; }
  *length = b.length; return (unsigned char *)b.bytes;
}
void silk_diagnostics_release(void *bytes) { free(bytes); }

/* Fatal reporting intentionally does not inspect a potentially corrupt heap. */
static pthread_mutex_t settings_lock = PTHREAD_MUTEX_INITIALIZER;
static _Atomic int fatal_enabled;
static atomic_flag fatal_active = ATOMIC_FLAG_INIT;
static char report_directory[PATH_MAX], report_filename[PATH_MAX];
static int path_invalid;
static unsigned long fatal_sequence;
static _Thread_local int fatal_io_error;
void silk_diagnostics_setting(uint32_t field, const unsigned char *value, size_t length, int enabled) {
  if (field == 3) { atomic_store_explicit(&fatal_enabled, enabled, memory_order_release); return; }
  if (field > 1) return;
  pthread_mutex_lock(&settings_lock);
  char *destination = field == 0 ? report_directory : report_filename;
  /* Preserve an explicit failure marker rather than writing to a truncated path. */
  if (length >= PATH_MAX) { destination[0] = 0; path_invalid |= 1 << field; }
  else { if (length) memcpy(destination, value, length); destination[length] = 0; path_invalid &= ~(1 << field); }
  pthread_mutex_unlock(&settings_lock);
}
static int raw_write(int fd, const char *bytes, size_t length) {
  while (length) { ssize_t n = write(fd, bytes, length); if (n < 0 && errno == EINTR) continue; if (n <= 0) { fatal_io_error = errno ? errno : EIO; return -1; } bytes += n; length -= (size_t)n; }
  return 0;
}
#define RAW(fd, s) raw_write((fd), (s), sizeof(s) - 1)
static void raw_number(int fd, uint64_t value) {
  char bytes[32]; size_t at = sizeof(bytes);
  do { bytes[--at] = (char)('0' + value % 10); value /= 10; } while (value);
  raw_write(fd, bytes + at, sizeof(bytes) - at);
}
static void raw_seconds(int fd, const struct timeval *value) {
  raw_number(fd, (uint64_t)value->tv_sec); RAW(fd, ".");
  char fraction[6]; unsigned long micros = (unsigned long)value->tv_usec;
  for (size_t i = sizeof(fraction); i > 0; --i) { fraction[i - 1] = (char)('0' + micros % 10); micros /= 10; }
  raw_write(fd, fraction, sizeof(fraction));
}
static void raw_string(int fd, const char *bytes, size_t length) {
  static const char hex[] = "0123456789abcdef"; RAW(fd, "\"");
  for (size_t i = 0; i < length; ++i) {
    unsigned char c = (unsigned char)bytes[i];
    if (c == '"' || c == '\\') { char escaped[2] = {'\\', (char)c}; raw_write(fd, escaped, 2); }
    else if (c < 32) { char escaped[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]}; raw_write(fd, escaped, 6); }
    else raw_write(fd, bytes + i, 1);
  }
  RAW(fd, "\"");
}
static size_t path_number(char *path, size_t at, uint64_t value) {
  char bytes[32]; size_t index = sizeof(bytes);
  do { bytes[--index] = (char)('0' + value % 10); value /= 10; } while (value);
  size_t count = sizeof(bytes) - index; memcpy(path + at, bytes + index, count); return at + count;
}
void silk_diagnostics_fatal(const char *location, size_t location_length, const char *message, size_t message_length) {
  if (!atomic_load_explicit(&fatal_enabled, memory_order_acquire) || atomic_flag_test_and_set_explicit(&fatal_active, memory_order_acquire)) return;
  int fd = -1; char path[PATH_MAX]; size_t used = 0;
  if (pthread_mutex_trylock(&settings_lock) != 0) {
    RAW(2, "Fatal diagnostic report configuration unavailable (concurrent update); writing to stderr\n"); fd = 2;
  } else {
    const char *directory_text = report_directory, *filename_text = report_filename;
    if (path_invalid) RAW(2, "Cannot write fatal diagnostic report: configured path exceeds PATH_MAX\n");
    else if (!strcmp(filename_text, "stdout")) fd = 1;
    else if (!strcmp(filename_text, "stderr")) fd = 2;
    else {
      size_t directory = strlen(directory_text), filename = strlen(filename_text);
      if (directory + (directory ? 1 : 0) + (filename ? filename + 1 : 128) > sizeof(path)) RAW(2, "Cannot write fatal diagnostic report: combined path exceeds PATH_MAX\n");
      else {
        if (directory) { memcpy(path, directory_text, directory); used = directory; path[used++] = '/'; }
        if (filename) { memcpy(path + used, filename_text, filename); used += filename; }
        else {
          memcpy(path + used, "report.fatal.", 13); used += 13;
          used = path_number(path, used, (uint64_t)getpid()); path[used++] = '.';
          used = path_number(path, used, current ? current->id : 0); path[used++] = '.';
          used = path_number(path, used, ++fatal_sequence); memcpy(path + used, ".json", 5); used += 5;
        }
        path[used] = 0; fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0666);
        if (fd < 0) { RAW(2, "Failed to open fatal diagnostic report: "); raw_write(2, path, used); RAW(2, " errno="); raw_number(2, (uint64_t)errno); RAW(2, "\n"); }
      }
    }
    pthread_mutex_unlock(&settings_lock);
  }
  if (fd >= 0) {
    fatal_io_error = 0;
    RAW(fd, "{\"header\":{\"reportVersion\":5,\"event\":\"FatalError\",\"trigger\":\"FatalError\",\"processId\":"); raw_number(fd, (uint64_t)getpid());
    RAW(fd, ",\"threadId\":"); raw_number(fd, current ? current->id : 0);
    RAW(fd, ",\"filename\":"); if (used) raw_string(fd, path, used); else RAW(fd, "null");
    RAW(fd, "},\"silkjs\":{\"engine\":\"SilkJS\",\"fatalLocation\":"); raw_string(fd, location ? location : "", location ? location_length : 0);
    RAW(fd, ",\"fatalMessage\":"); raw_string(fd, message ? message : "", message ? message_length : 0);
    RAW(fd, ",\"unavailable\":{\"javascriptStack\":\"fatal path cannot safely inspect the JS heap\",\"javascriptHeap\":\"fatal path cannot safely inspect allocator state\",\"workers\":\"fatal path cannot wait for other isolates\",\"libuv\":\"fatal path cannot safely walk the event loop\",\"nativeStack\":\"allocation-free symbolization unavailable\"}}");
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
      RAW(fd, ",\"resourceUsage\":{\"userCpuSeconds\":"); raw_seconds(fd, &usage.ru_utime);
      RAW(fd, ",\"kernelCpuSeconds\":"); raw_seconds(fd, &usage.ru_stime);
      RAW(fd, ",\"maxRss\":");
#ifdef __APPLE__
      raw_number(fd, (uint64_t)usage.ru_maxrss);
#else
      raw_number(fd, (uint64_t)usage.ru_maxrss * 1024);
#endif
      RAW(fd, "}");
    } else RAW(fd, ",\"resourceUsageUnavailable\":\"getrusage failed\"");
    RAW(fd, "}\n");
    if (fd > 2 && close(fd) != 0) fatal_io_error = errno;
    if (fatal_io_error) {
      int error = fatal_io_error;
      RAW(2, "Failed to complete fatal diagnostic report: errno="); raw_number(2, (uint64_t)error); RAW(2, "\n");
    }
  }
  atomic_flag_clear_explicit(&fatal_active, memory_order_release);
}
