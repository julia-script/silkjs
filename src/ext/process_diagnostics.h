#ifndef SILK_PROCESS_DIAGNOSTICS_H
#define SILK_PROCESS_DIAGNOSTICS_H
#include <stddef.h>
#include <stdint.h>
/* All registration/publication calls are owner-thread only. No JS pointer crosses
 * this transport. Request results are malloc-owned UTF-8 and freed by release. */
int silk_diagnostics_attach(uint32_t id, void *wake);
void silk_diagnostics_detach(void);
uint32_t silk_diagnostics_owner_id(void);
/* malloc-owned worker IDs. NULL with nonzero count means allocation failure. */
uint32_t *silk_diagnostics_owner_ids(size_t *count);
/* Only owner0 changes policy; workers read their immutable attach-time snapshot. */
void silk_diagnostics_inspector_wait_set(int enabled);
int silk_diagnostics_inspector_wait_get(void);
uint64_t silk_diagnostics_pending(void);
void silk_diagnostics_publish(uint64_t generation, void *loop, const unsigned char *stack,
                              size_t length, size_t heap, size_t external);
void silk_diagnostics_failed(uint64_t generation, int reason);
unsigned char *silk_diagnostics_workers(size_t *length);
void silk_diagnostics_release(void *bytes);
/* Channel 1: inspector; channel 2: profiling. All payloads are copied bytes. */
int silk_diagnostics_post(uint32_t target, uint32_t channel, const unsigned char *bytes, size_t length);
int silk_diagnostics_post_parts(uint32_t target, uint32_t channel, const unsigned char *prefix,
                                size_t prefix_length, const unsigned char *bytes, size_t length);
unsigned char *silk_diagnostics_take(uint32_t channel, size_t *length);
int silk_diagnostics_message_pending(uint32_t channel);
int silk_diagnostics_wait(uint32_t timeout_ms);
void silk_diagnostics_setting(uint32_t field, const unsigned char *value, size_t length, int enabled);
/* Uses only pre-existing configuration, stack storage, and POSIX syscalls. No JS,
 * malloc, stdio, symbolizer, or another thread's heap is touched. */
void silk_diagnostics_fatal(const char *location, size_t location_length,
                            const char *message, size_t message_length);
#endif
