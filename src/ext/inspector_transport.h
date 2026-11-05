#ifndef SILK_INSPECTOR_TRANSPORT_H
#define SILK_INSPECTOR_TRANSPORT_H
#include <stddef.h>
#include <stdint.h>

/* Native bytes only. The owner must keep wake (an optional uv_async_t) alive
 * until destroy. No callback enters JS and no JS/engine value may be passed.
 * create/start/stop/destroy/url are owner-thread lifecycle operations. All other
 * operations are thread-safe while the handle lives. destroy requires callers
 * to have retired their references; stop joins the I/O thread before returning.
 * start accepts numeric bind addresses or localhost; empty means 127.0.0.1.
 * errno-style results: 0 success; EINVAL, ENOMEM, ENOBUFS, ENOTCONN, etc.
 */
typedef struct silk_inspector silk_inspector;
typedef struct silk_inspector_packet silk_inspector_packet;
enum { SILK_INSPECTOR_OPEN = 1, SILK_INSPECTOR_MESSAGE = 2, SILK_INSPECTOR_CLOSE = 3 };
enum { SILK_INSPECTOR_ROUTE_RESPONSE = 4, SILK_INSPECTOR_OWNER_ATTACHED = 5,
       SILK_INSPECTOR_OWNER_DETACHED = 6 };
silk_inspector *silk_inspector_create(void *wake);
int silk_inspector_start(silk_inspector *, const unsigned char *host, size_t length, uint16_t port);
void silk_inspector_stop(silk_inspector *);
void silk_inspector_destroy(silk_inspector *);
/* Copies at most capacity bytes, without terminator; returns full URL length.
 * Returns 0 when not listening. URL is immutable until owner start/stop. */
size_t silk_inspector_url(silk_inspector *, unsigned char *buffer, size_t capacity);
/* pending is a single atomic load, including when the endpoint is disabled.
 * take transfers ownership, and unlocks before returning. data is borrowed
 * only until packet_free. Empty OPEN/CLOSE packets have length zero. */
int silk_inspector_pending(silk_inspector *);
silk_inspector_packet *silk_inspector_take(silk_inspector *);
uint32_t silk_inspector_packet_kind(const silk_inspector_packet *);
uint64_t silk_inspector_packet_connection(const silk_inspector_packet *);
const unsigned char *silk_inspector_packet_data(const silk_inspector_packet *);
size_t silk_inspector_packet_length(const silk_inspector_packet *);
void silk_inspector_packet_free(silk_inspector_packet *);
/* Wait returns 1 pending, 0 timeout/stopped. timeout_ms < 0 waits indefinitely.
 * Caller must pump packets and implement Runtime.runIfWaitingForDebugger; a
 * mere WebSocket connection is not a debugger-resume request. */
int silk_inspector_wait(silk_inspector *, int32_t timeout_ms);
/* send copies bytes before returning. Connection zero broadcasts to all
 * currently connected WebSockets. disconnect requires a nonzero connection.
 * Accepted output is asynchronous; closure may race delivery. */
int silk_inspector_send(silk_inspector *, uint64_t connection, const unsigned char *, size_t length);
int silk_inspector_disconnect(silk_inspector *, uint64_t connection);
/* Cross-isolate sessions share the diagnostics/worker owner registry (channel
 * 1), not a second isolate registry. Main owner ID is 0. The sender supplies its
 * worker ID and an owner-local nonzero session ID; route replies to source.
 * OPEN=1/REQUEST=2/CLOSE=3 match network kinds; RESPONSE=4 is route-only. The
 * adapter authenticates its own owner ID, and retires sessions on worker exit.
 * Registry-generated OWNER_ATTACHED=5/OWNER_DETACHED=6 have source=worker ID,
 * session=0 and empty body. They are receive-only, not accepted by route_send.
 * route_take transfers a diagnostics-owned packet with a 16-byte native
 * envelope; length receives the BODY length. Accessors borrow until route_free.
 * No intermediate heap allocation or JS pointers cross the registry lock.
 * route_wait waits the shared diagnostics mailbox, not network packets. When
 * pumping both sources use a bounded wait (e.g. 10ms), never an indefinite wait
 * on just one queue. Registration must precede use, detach follows destruction.
 */
int silk_inspector_route_send(uint32_t target, uint32_t source, uint64_t session,
                              uint32_t kind, const unsigned char *bytes, size_t length);
int silk_inspector_route_pending(void);
unsigned char *silk_inspector_route_take(size_t *length);
uint32_t silk_inspector_route_source(const unsigned char *packet);
uint32_t silk_inspector_route_kind(const unsigned char *packet);
uint64_t silk_inspector_route_session(const unsigned char *packet);
const unsigned char *silk_inspector_route_data(const unsigned char *packet);
void silk_inspector_route_free(unsigned char *packet);
int silk_inspector_route_wait(uint32_t timeout_ms);
#endif
