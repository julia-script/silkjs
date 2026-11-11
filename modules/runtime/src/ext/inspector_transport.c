#define _POSIX_C_SOURCE 200809L
#include "inspector_transport.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#define MAX_CLIENTS 64
#define HTTP_LIMIT 8192
#define MESSAGE_LIMIT (1024u * 1024u)
#define QUEUE_LIMIT (8u * 1024u * 1024u)
#define OUTPUT_LIMIT (4u * 1024u * 1024u)
#define PACKET_LIMIT 4096

struct silk_inspector_packet {
    struct silk_inspector_packet *next;
    uint64_t connection;
    size_t length;
    uint32_t kind;
    unsigned char bytes[];
};
typedef struct output {
    struct output *next;
    size_t length, offset;
    unsigned char bytes[];
} output;
typedef struct client {
    int fd, websocket, closing, dead, fragmented;
    uint64_t id, deadline;
    unsigned char *input, *fragment;
    size_t input_length, input_capacity, fragment_length, fragment_capacity;
    output *first, *last;
    size_t output_bytes;
    silk_inspector_packet *close_packet;
} client;
struct silk_inspector {
    pthread_mutex_t mutex;
    pthread_cond_t changed;
    pthread_t thread;
    int running, listener, notify[2], stopped;
    _Atomic int pending;
    int stopping;
    void *wake;
    silk_inspector_packet *first, *last, *out_first, *out_last;
    size_t in_bytes, out_bytes, in_count, out_count;
    uint64_t next_connection;
    char uuid[37], url[320], authority[280], browser[64];
    uint16_t port;
    client clients[MAX_CLIENTS];
};

static uint64_t milliseconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}
static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) return errno;
#ifdef SO_NOSIGPIPE
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) < 0 && errno != ENOTSOCK) return errno;
#endif
    return 0;
}
static ssize_t socket_write(int fd, const void *data, size_t length) {
#ifdef MSG_NOSIGNAL
    return send(fd, data, length, MSG_NOSIGNAL);
#else
    return send(fd, data, length, 0);
#endif
}
static silk_inspector_packet *packet(uint32_t kind, uint64_t id, const unsigned char *bytes, size_t length) {
    if (length > MESSAGE_LIMIT) return NULL;
    silk_inspector_packet *p = malloc(sizeof(*p) + length);
    if (!p) return NULL;
    p->next = NULL; p->kind = kind; p->connection = id; p->length = length;
    if (length) memcpy(p->bytes, bytes, length);
    return p;
}
static void notify_io(silk_inspector *s) {
    unsigned char byte = 1;
    ssize_t ignored;
    do { ignored = write(s->notify[1], &byte, 1); } while (ignored < 0 && errno == EINTR);
}
/* Close events use a slot reserved at upgrade, so overload cannot lose teardown.
 * The queue lock is never held across owner/JS code. */
static int incoming(silk_inspector *s, silk_inspector_packet *p, int reserved) {
    pthread_mutex_lock(&s->mutex);
    if (!reserved && (s->in_count >= PACKET_LIMIT || s->in_bytes + p->length > QUEUE_LIMIT)) {
        pthread_mutex_unlock(&s->mutex); free(p); return ENOBUFS;
    }
    if (s->last) s->last->next = p; else s->first = p;
    s->last = p; s->in_bytes += p->length; s->in_count++;
    atomic_store_explicit(&s->pending, 1, memory_order_release);
    pthread_cond_broadcast(&s->changed);
    /* wake lifetime is owned by the isolate and extends beyond stop/join. */
    if (s->wake) silk_runtime_wake(s->wake);
    pthread_mutex_unlock(&s->mutex);
    return 0;
}
static int append_output(client *c, const unsigned char *prefix, size_t prefix_length,
                         const unsigned char *bytes, size_t length) {
    size_t total = prefix_length + length;
    if (total > OUTPUT_LIMIT - c->output_bytes) return ENOBUFS;
    output *p = malloc(sizeof(*p) + total);
    if (!p) return ENOMEM;
    p->next = NULL; p->offset = 0; p->length = total;
    if (prefix_length) memcpy(p->bytes, prefix, prefix_length);
    if (length) memcpy(p->bytes + prefix_length, bytes, length);
    if (c->last) c->last->next = p; else c->first = p;
    c->last = p; c->output_bytes += total;
    return 0;
}
static int frame(client *c, unsigned opcode, const unsigned char *bytes, size_t length) {
    unsigned char header[10]; size_t n;
    header[0] = (unsigned char)(0x80 | opcode);
    if (length < 126) { header[1] = (unsigned char)length; n = 2; }
    else if (length <= 65535) { header[1] = 126; header[2] = length >> 8; header[3] = length; n = 4; }
    else { header[1] = 127; for (unsigned i = 0; i < 8; i++) header[2+i] = (unsigned char)((uint64_t)length >> (56 - i*8)); n = 10; }
    return append_output(c, header, n, bytes, length);
}
static void close_frame(client *c, unsigned code) {
    unsigned char bytes[2] = { (unsigned char)(code >> 8), (unsigned char)code };
    if (!c->closing && frame(c, 8, bytes, 2)) c->dead = 1;
    c->closing = 1; c->deadline = milliseconds() + 1000;
}
static void retire(silk_inspector *s, client *c) {
    close(c->fd);
    free(c->input); free(c->fragment);
    while (c->first) { output *next = c->first->next; free(c->first); c->first = next; }
    if (c->close_packet) incoming(s, c->close_packet, 1);
    memset(c, 0, sizeof(*c)); c->fd = -1;
}
static int reserve(unsigned char **bytes, size_t *capacity, size_t need, size_t limit) {
    if (need > limit) return ENOBUFS;
    if (*capacity >= need) return 0;
    size_t next = *capacity ? *capacity * 2 : 4096;
    if (next < need) next = need;
    if (next > limit) next = limit;
    unsigned char *p = realloc(*bytes, next);
    if (!p) return ENOMEM;
    *bytes = p; *capacity = next; return 0;
}
static int utf8(const unsigned char *p, size_t n) {
    size_t i = 0;
    while (i < n) {
        unsigned a = p[i++], value, count, minimum;
        if (a < 128) continue;
        if (a >= 0xc2 && a <= 0xdf) { value = a & 31; count = 1; minimum = 0x80; }
        else if (a >= 0xe0 && a <= 0xef) { value = a & 15; count = 2; minimum = 0x800; }
        else if (a >= 0xf0 && a <= 0xf4) { value = a & 7; count = 3; minimum = 0x10000; }
        else return 0;
        if (count > n - i) return 0;
        while (count--) { unsigned b = p[i++]; if ((b & 0xc0) != 0x80) return 0; value = (value << 6) | (b & 63); }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return 0;
    }
    return 1;
}
static int valid_close(unsigned code) {
    return (code >= 3000 && code <= 4999) ||
           (code >= 1000 && code <= 1014 && code != 1004 && code != 1005 && code != 1006);
}
static void websocket_input(silk_inspector *s, client *c) {
    size_t consumed = 0;
    while (!c->closing && c->input_length - consumed >= 2) {
        unsigned char *p = c->input + consumed;
        unsigned opcode = p[0] & 15, fin = p[0] & 128;
        uint64_t length = p[1] & 127;
        size_t header = 2, available = c->input_length - consumed;
        if ((p[0] & 112) || !(p[1] & 128) ||
            (opcode != 0 && opcode != 1 && opcode != 2 && opcode != 8 && opcode != 9 && opcode != 10)) { close_frame(c, 1002); break; }
        if (length == 126) {
            if (available < 4) break;
            length = ((uint64_t)p[2] << 8) | p[3]; header = 4;
            if (length < 126) { close_frame(c, 1002); break; }
        } else if (length == 127) {
            if (available < 10) break;
            length = 0; for (unsigned i = 0; i < 8; i++) length = (length << 8) | p[2+i];
            header = 10;
            if (length < 65536 || (p[2] & 128)) { close_frame(c, 1002); break; }
        }
        if ((opcode >= 8 && (!fin || length > 125)) ||
            (opcode == 0 && !c->fragmented) || ((opcode == 1 || opcode == 2) && c->fragmented)) { close_frame(c, 1002); break; }
        if (opcode == 2) { close_frame(c, 1003); break; }
        if (length > MESSAGE_LIMIT || (opcode < 8 && length > MESSAGE_LIMIT - c->fragment_length)) { close_frame(c, 1009); break; }
        if (available < header + 4 + (size_t)length) break;
        unsigned char *mask = p + header, *body = mask + 4;
        for (size_t i = 0; i < (size_t)length; i++) body[i] ^= mask[i & 3];
        consumed += header + 4 + (size_t)length;
        if (opcode == 8) {
            if (length == 1 || (length >= 2 && !valid_close(((unsigned)body[0] << 8) | body[1]))) { close_frame(c, 1002); break; }
            if (length >= 2 && !utf8(body + 2, (size_t)length - 2)) { close_frame(c, 1007); break; }
            if (frame(c, 8, body, (size_t)length)) c->dead = 1;
            c->closing = 1; c->deadline = milliseconds() + 1000;
        } else if (opcode == 9) { if (frame(c, 10, body, (size_t)length)) c->dead = 1; }
        else if (opcode != 10) {
            const unsigned char *message = body; size_t message_length = (size_t)length;
            if (!fin || c->fragmented) {
                if (reserve(&c->fragment, &c->fragment_capacity, c->fragment_length + (size_t)length, MESSAGE_LIMIT)) { close_frame(c, 1011); break; }
                if (length) memcpy(c->fragment + c->fragment_length, body, (size_t)length);
                c->fragment_length += (size_t)length; c->fragmented = !fin;
                if (!fin) continue;
                message = c->fragment; message_length = c->fragment_length;
            }
            if (!utf8(message, message_length)) { close_frame(c, 1007); break; }
            silk_inspector_packet *event = packet(SILK_INSPECTOR_MESSAGE, c->id, message, message_length);
            if (!event || incoming(s, event, 0)) { close_frame(c, 1011); break; }
            c->fragment_length = 0; c->fragmented = 0;
        }
    }
    if (consumed) { c->input_length -= consumed; memmove(c->input, c->input + consumed, c->input_length); }
}

static int token(const char *value, const char *expected) {
    size_t expected_length = strlen(expected);
    while (*value) {
        while (*value == ' ' || *value == '\t' || *value == ',') value++;
        const char *start = value;
        while (*value && *value != ',') value++;
        const char *end = value;
        while (end > start && (end[-1] == ' ' || end[-1] == '\t')) end--;
        if ((size_t)(end - start) == expected_length && !strncasecmp(start, expected, expected_length)) return 1;
    }
    return 0;
}
/* Like Node's IsAllowedHost: only localhost or IP literals can pass Host, with
 * any port. There is deliberately no DNS resolution of an attacker-controlled
 * Host or Origin. */
static int safe_authority(const char *authority) {
    char host[256]; const char *end, *port_text = NULL; size_t length;
    if (*authority == '[') {
        end = strchr(authority + 1, ']'); if (!end) return 0;
        length = (size_t)(end - authority - 1); if (length >= sizeof(host)) return 0;
        memcpy(host, authority + 1, length); host[length] = 0;
        struct in6_addr address; if (inet_pton(AF_INET6, host, &address) != 1) return 0;
        if (end[1] == ':') port_text = end + 2; else if (end[1]) return 0;
    } else {
        end = strchr(authority, ':'); length = end ? (size_t)(end-authority) : strlen(authority);
        if (!length || length >= sizeof(host)) return 0;
        memcpy(host, authority, length); host[length] = 0;
        struct in_addr address;
        if (strcasecmp(host, "localhost") && inet_pton(AF_INET, host, &address) != 1) return 0;
        if (end) port_text = end + 1;
    }
    if (!port_text) return 1;
    if (!*port_text) return 0;
    unsigned value = 0;
    for (; *port_text; port_text++) { if (*port_text < '0' || *port_text > '9') return 0; value = value * 10 + (unsigned)(*port_text-'0'); if (value > 65535) return 0; }
    return 1;
}
static int safe_origin(const char *origin, const char *host) {
    if (!origin) return 1;
    if (!strcmp(origin, "devtools://devtools") || !strcmp(origin, "chrome-devtools://devtools")) return 1;
    const char *authority;
    if (!strncmp(origin, "http://", 7)) authority = origin + 7;
    else if (!strncmp(origin, "https://", 8)) authority = origin + 8;
    else return 0;
    return !strcasecmp(authority, host) && safe_authority(authority);
}
static void http_reply(client *c, unsigned status, const char *reason, const char *body) {
    char header[256];
    int n = snprintf(header, sizeof(header), "HTTP/1.1 %u %s\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: %zu\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n", status, reason, strlen(body));
    if (n < 0 || (size_t)n >= sizeof(header) || append_output(c, (const unsigned char *)header, (size_t)n, (const unsigned char *)body, strlen(body))) c->dead = 1;
    c->closing = 1; c->deadline = milliseconds() + 1000;
}
/* Like Node's inspector_socket.cc, any non-empty key is answered: the accept
 * value is derived from the key text without decoding it. */
#define KEY_LIMIT 128
static int valid_key(const char *key) {
    size_t length = strlen(key);
    return length > 0 && length <= KEY_LIMIT;
}
static void http_input(silk_inspector *s, client *c) {
    size_t end = 0;
    for (size_t i = 3; i < c->input_length; i++) if (!memcmp(c->input + i - 3, "\r\n\r\n", 4)) { end = i + 1; break; }
    if (!end) { if (c->input_length >= HTTP_LIMIT) http_reply(c, 431, "Request Header Fields Too Large", "{}"); return; }
    if (end > HTTP_LIMIT) { http_reply(c, 431, "Request Header Fields Too Large", "{}"); return; }
    char text[HTTP_LIMIT + 1]; memcpy(text, c->input, end); text[end] = 0;
    for (size_t i = 0; i < end; i++) if (!text[i] || (unsigned char)text[i] == 127 || ((unsigned char)text[i] < 32 && text[i] != '\r' && text[i] != '\n' && text[i] != '\t')) { http_reply(c, 400, "Bad Request", "{}"); return; }
    char *line = strstr(text, "\r\n"); if (!line) { http_reply(c, 400, "Bad Request", "{}"); return; }
    *line = 0;
    char *path = text + 4, *version;
    if (strncmp(text, "GET ", 4) || !(version = strchr(path, ' ')) || strcmp(version, " HTTP/1.1")) { http_reply(c, 400, "Bad Request", "{}"); return; }
    *version = 0;
    char *host = NULL, *origin = NULL, *upgrade = NULL, *connection = NULL, *key = NULL, *ws_version = NULL;
    int invalid = 0;
    for (char *cursor = line + 2; *cursor; ) {
        char *next = strstr(cursor, "\r\n"); if (!next) { invalid = 1; break; }
        if (next == cursor) break;
        *next = 0;
        char *colon = strchr(cursor, ':');
        if (!colon || colon == cursor) { invalid = 1; break; }
        for (char *p = cursor; p < colon; p++) if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("!#$%&'*+-.^_`|~", *p))) invalid = 1;
        *colon = 0; char *value = colon + 1;
        while (*value == ' ' || *value == '\t') value++;
        char *last = next; while (last > value && (last[-1] == ' ' || last[-1] == '\t')) *--last = 0;
        for (char *p = value; *p; p++) if (*p == '\r' || *p == '\n') invalid = 1;
        char **field = NULL;
        if (!strcasecmp(cursor, "Host")) field = &host;
        else if (!strcasecmp(cursor, "Origin")) field = &origin;
        else if (!strcasecmp(cursor, "Upgrade")) field = &upgrade;
        else if (!strcasecmp(cursor, "Connection")) field = &connection;
        else if (!strcasecmp(cursor, "Sec-WebSocket-Key")) field = &key;
        else if (!strcasecmp(cursor, "Sec-WebSocket-Version")) field = &ws_version;
        else if (!strcasecmp(cursor, "Transfer-Encoding") || (!strcasecmp(cursor, "Content-Length") && strcmp(value, "0"))) invalid = 1;
        if (field) { if (*field) invalid = 1; *field = value; }
        cursor = next + 2;
    }
    if (invalid || !host) { http_reply(c, 400, "Bad Request", "{}"); return; }
    if (!safe_authority(host) || !safe_origin(origin, host)) { http_reply(c, 403, "Forbidden", "{}"); return; }
    /* As Node's inspector_socket_server.cc: the listing names the endpoint by the
     * Host the client used, and anything else that is not a WebSocket upgrade of
     * the target path gets Node's plain-text refusal. */
    if (!strcmp(path, "/json") || !strcmp(path, "/json/list")) {
        char body[1600];
        snprintf(body, sizeof(body), "[ {\n  \"description\": \"node.js instance\",\n  \"devtoolsFrontendUrl\": \"devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=%s/%s\",\n  \"devtoolsFrontendUrlCompat\": \"devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=%s/%s\",\n  \"faviconUrl\": \"https://nodejs.org/static/images/favicons/favicon.ico\",\n  \"id\": \"%s\",\n  \"title\": \"node[%d]\",\n  \"type\": \"node\",\n  \"url\": \"\",\n  \"webSocketDebuggerUrl\": \"ws://%s/%s\"\n} ]\n\n", host, s->uuid, host, s->uuid, s->uuid, (int)getpid(), host, s->uuid);
        http_reply(c, 200, "OK", body); return;
    }
    if (!strcmp(path, "/json/version")) {
        char body[160];
        snprintf(body, sizeof(body), "{\"Browser\":\"%s\",\"Protocol-Version\":\"1.1\"}", s->browser);
        http_reply(c, 200, "OK", body); return;
    }
    if (!strncmp(path, "/json/activate/", 15) && !strcmp(path + 15, s->uuid)) { http_reply(c, 200, "OK", "Target activated"); return; }
    if (path[0] != '/' || strcmp(path + 1, s->uuid) || !upgrade || strcasecmp(upgrade, "websocket") || !connection || !token(connection, "upgrade") || !key || !valid_key(key) || !ws_version || strcmp(ws_version, "13")) { http_reply(c, 400, "Bad Request", "WebSockets request was expected\r\n"); return; }
    unsigned char digest[EVP_MAX_MD_SIZE], accept[64]; unsigned digest_length = 0;
    size_t key_length = strlen(key);
    char challenge[KEY_LIMIT + 36]; memcpy(challenge, key, key_length); memcpy(challenge + key_length, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", 36);
    if (!EVP_Digest(challenge, key_length + 36, digest, &digest_length, EVP_sha1(), NULL) || digest_length != 20) { http_reply(c, 500, "Internal Server Error", "{}"); return; }
    EVP_EncodeBlock(accept, digest, 20);
    silk_inspector_packet *opened = packet(SILK_INSPECTOR_OPEN, c->id, NULL, 0);
    silk_inspector_packet *closed = packet(SILK_INSPECTOR_CLOSE, c->id, NULL, 0);
    if (!opened || !closed) { free(opened); free(closed); http_reply(c, 503, "Service Unavailable", "{}"); return; }
    char response[256]; int n = snprintf(response, sizeof(response), "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept);
    if (append_output(c, NULL, 0, (const unsigned char *)response, (size_t)n)) { free(opened); free(closed); c->dead = 1; return; }
    if (incoming(s, opened, 0)) { free(closed); c->dead = 1; return; }
    c->websocket = 1; c->deadline = 0; c->close_packet = closed;
    c->input_length -= end; memmove(c->input, c->input + end, c->input_length);
    websocket_input(s, c);
}

static void read_client(silk_inspector *s, client *c) {
    /* Bound work per ready connection so one peer cannot starve discovery. */
    size_t budget = 65536;
    while (budget && !c->dead && !c->closing) {
        size_t limit = c->websocket ? MESSAGE_LIMIT + 14 : HTTP_LIMIT;
        size_t wanted = limit - c->input_length;
        if (wanted > 16384) wanted = 16384;
        if (wanted > budget) wanted = budget;
        if (!wanted || reserve(&c->input, &c->input_capacity, c->input_length + wanted, limit)) { if (c->websocket) close_frame(c, 1009); else http_reply(c, 431, "Request Header Fields Too Large", "{}"); break; }
        ssize_t n = recv(c->fd, c->input + c->input_length, wanted, 0);
        if (n < 0) { if (errno == EINTR) continue; if (errno != EAGAIN && errno != EWOULDBLOCK) c->dead = 1; break; }
        if (!n) { c->dead = 1; break; }
        c->input_length += (size_t)n; budget -= (size_t)n;
        if (c->websocket) websocket_input(s, c); else http_input(s, c);
    }
}
static void write_client(client *c) {
    size_t budget = 65536;
    while (c->first && budget) {
        output *p = c->first;
        size_t length = p->length - p->offset; if (length > budget) length = budget;
        ssize_t n = socket_write(c->fd, p->bytes + p->offset, length);
        if (n < 0) { if (errno == EINTR) continue; if (errno != EAGAIN && errno != EWOULDBLOCK) c->dead = 1; break; }
        if (!n) { c->dead = 1; break; }
        p->offset += (size_t)n; c->output_bytes -= (size_t)n; budget -= (size_t)n;
        if (p->offset == p->length) { c->first = p->next; if (!c->first) c->last = NULL; free(p); }
    }
    if (c->closing && !c->first) c->dead = 1;
}
static void accept_clients(silk_inspector *s) {
    for (unsigned attempt = 0; attempt < MAX_CLIENTS; attempt++) {
        int fd = accept(s->listener, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; break; }
        if (nonblocking(fd)) { close(fd); continue; }
        unsigned index; for (index = 0; index < MAX_CLIENTS && s->clients[index].fd >= 0; index++) {}
        if (index == MAX_CLIENTS || s->next_connection == UINT64_MAX) { close(fd); continue; }
        client *c = &s->clients[index]; c->fd = fd; c->id = ++s->next_connection; c->deadline = milliseconds() + 5000;
    }
}
static int process_output(silk_inspector *s) {
    pthread_mutex_lock(&s->mutex);
    silk_inspector_packet *p = s->out_first;
    s->out_first = s->out_last = NULL; s->out_bytes = s->out_count = 0;
    int stopping = s->stopping;
    pthread_mutex_unlock(&s->mutex);
    while (p) {
        silk_inspector_packet *next = p->next;
        for (unsigned i = 0; i < MAX_CLIENTS; i++) {
            client *c = &s->clients[i];
            if (c->fd < 0 || !c->websocket || c->closing || (p->connection && p->connection != c->id)) continue;
            if (p->kind == SILK_INSPECTOR_CLOSE) close_frame(c, 1000);
            else if (frame(c, 1, p->bytes, p->length)) close_frame(c, 1011);
        }
        free(p); p = next;
    }
    return stopping;
}
static void *io_thread(void *opaque) {
    silk_inspector *s = opaque;
    for (;;) {
        if (process_output(s)) break;
        struct pollfd descriptors[MAX_CLIENTS + 2]; int indexes[MAX_CLIENTS + 2];
        nfds_t count = 2;
        descriptors[0] = (struct pollfd){ s->notify[0], POLLIN, 0 };
        descriptors[1] = (struct pollfd){ s->listener, POLLIN, 0 };
        uint64_t now = milliseconds();
        for (unsigned i = 0; i < MAX_CLIENTS; i++) {
            client *c = &s->clients[i];
            if (c->fd < 0) continue;
            if (c->dead || (c->deadline && now >= c->deadline)) { retire(s, c); continue; }
            descriptors[count] = (struct pollfd){ c->fd, (short)((c->closing ? 0 : POLLIN) | (c->first ? POLLOUT : 0)), 0 };
            indexes[count++] = (int)i;
        }
        int result = poll(descriptors, count, 250);
        if (result < 0) { if (errno == EINTR) continue; break; }
        if (descriptors[0].revents) { unsigned char buffer[256]; while (read(s->notify[0], buffer, sizeof(buffer)) > 0) {} }
        if (descriptors[1].revents & POLLIN) accept_clients(s);
        for (nfds_t i = 2; i < count; i++) {
            client *c = &s->clients[indexes[i]];
            if (descriptors[i].revents & POLLIN) read_client(s, c);
            if (!c->dead && (descriptors[i].revents & POLLOUT)) write_client(c);
            if (descriptors[i].revents & (POLLERR | POLLHUP | POLLNVAL)) c->dead = 1;
            if (c->dead) retire(s, c);
        }
    }
    for (unsigned i = 0; i < MAX_CLIENTS; i++) if (s->clients[i].fd >= 0) retire(s, &s->clients[i]);
    pthread_mutex_lock(&s->mutex); s->stopped = 1; pthread_cond_broadcast(&s->changed); pthread_mutex_unlock(&s->mutex);
    return NULL;
}

silk_inspector *silk_inspector_create(void *wake) {
    silk_inspector *s = calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->listener = s->notify[0] = s->notify[1] = -1; s->wake = wake; s->stopped = 1;
    for (unsigned i = 0; i < MAX_CLIENTS; i++) s->clients[i].fd = -1;
    if (pthread_mutex_init(&s->mutex, NULL)) { free(s); return NULL; }
    if (pthread_cond_init(&s->changed, NULL)) { pthread_mutex_destroy(&s->mutex); free(s); return NULL; }
    atomic_init(&s->pending, 0);
    return s;
}
int silk_inspector_start(silk_inspector *s, const unsigned char *host, size_t length, uint16_t port, const unsigned char *browser, size_t browser_length) {
    if (!s || length >= 256 || (length && !host)) return EINVAL;
    /* The /json/version Browser: printable ASCII without quotes or backslashes. */
    if (browser_length >= sizeof(s->browser) || (browser_length && !browser)) return EINVAL;
    for (size_t i = 0; i < browser_length; i++) if (browser[i] < 32 || browser[i] > 126 || browser[i] == '"' || browser[i] == '\\') return EINVAL;
    if (browser_length) memcpy(s->browser, browser, browser_length);
    s->browser[browser_length] = 0;
    if (s->running) return EALREADY;
    char address[256]; if (length) memcpy(address, host, length); address[length] = 0;
    if (length && memchr(host, 0, length)) return EINVAL;
    if (!length || !strcmp(address, "localhost")) strcpy(address, "127.0.0.1");
    struct sockaddr_storage storage; memset(&storage, 0, sizeof(storage));
    socklen_t address_length; int family;
    struct sockaddr_in *v4 = (struct sockaddr_in *)&storage;
    struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&storage;
    if (inet_pton(AF_INET, address, &v4->sin_addr) == 1) { family = AF_INET; v4->sin_family = AF_INET; v4->sin_port = htons(port); address_length = sizeof(*v4); }
    else if (inet_pton(AF_INET6, address, &v6->sin6_addr) == 1) { family = AF_INET6; v6->sin6_family = AF_INET6; v6->sin6_port = htons(port); address_length = sizeof(*v6); }
    else return EINVAL;
    unsigned char random[16]; if (RAND_bytes(random, sizeof(random)) != 1) return EIO;
    random[6] = (random[6] & 15) | 64; random[8] = (random[8] & 63) | 128;
    snprintf(s->uuid, sizeof(s->uuid), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", random[0], random[1], random[2], random[3], random[4], random[5], random[6], random[7], random[8], random[9], random[10], random[11], random[12], random[13], random[14], random[15]);
    int fd = socket(family, SOCK_STREAM, 0); if (fd < 0) return errno;
    int error = nonblocking(fd), one = 1;
    if (!error && setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) error = errno;
    if (!error && bind(fd, (struct sockaddr *)&storage, address_length) < 0) error = errno;
    if (!error && listen(fd, 32) < 0) error = errno;
    if (!error && getsockname(fd, (struct sockaddr *)&storage, &address_length) < 0) error = errno;
    if (error) { close(fd); return error; }
    s->port = ntohs(family == AF_INET ? v4->sin_port : v6->sin6_port);
    snprintf(s->authority, sizeof(s->authority), family == AF_INET ? "%s:%u" : "[%s]:%u", address, s->port);
    snprintf(s->url, sizeof(s->url), "ws://%s/%s", s->authority, s->uuid);
    if (pipe(s->notify) < 0) { error = errno; close(fd); s->url[0] = 0; return error; }
    error = nonblocking(s->notify[0]); if (!error) error = nonblocking(s->notify[1]);
    if (error) { close(fd); close(s->notify[0]); close(s->notify[1]); s->notify[0] = s->notify[1] = -1; s->url[0] = 0; return error; }
    s->listener = fd;
    pthread_mutex_lock(&s->mutex); s->stopping = 0; s->stopped = 0; pthread_mutex_unlock(&s->mutex);
    error = pthread_create(&s->thread, NULL, io_thread, s);
    if (error) { close(fd); close(s->notify[0]); close(s->notify[1]); s->listener = s->notify[0] = s->notify[1] = -1; s->url[0] = 0; s->stopped = 1; return error; }
    s->running = 1;
    return 0;
}
void silk_inspector_stop(silk_inspector *s) {
    if (!s || !s->running) return;
    pthread_mutex_lock(&s->mutex); s->stopping = 1; notify_io(s); pthread_cond_broadcast(&s->changed); pthread_mutex_unlock(&s->mutex);
    pthread_join(s->thread, NULL);
    pthread_mutex_lock(&s->mutex);
    close(s->listener); close(s->notify[0]); close(s->notify[1]);
    s->listener = s->notify[0] = s->notify[1] = -1; s->running = 0; s->url[0] = 0;
    while (s->out_first) { silk_inspector_packet *next = s->out_first->next; free(s->out_first); s->out_first = next; }
    s->out_last = NULL; s->out_count = s->out_bytes = 0;
    pthread_mutex_unlock(&s->mutex);
}
void silk_inspector_destroy(silk_inspector *s) {
    if (!s) return;
    silk_inspector_stop(s);
    while (s->first) { silk_inspector_packet *next = s->first->next; free(s->first); s->first = next; }
    pthread_cond_destroy(&s->changed); pthread_mutex_destroy(&s->mutex); free(s);
}
size_t silk_inspector_url(silk_inspector *s, unsigned char *buffer, size_t capacity) {
    if (!s || !s->running) return 0;
    size_t length = strlen(s->url); if (capacity > length) capacity = length;
    if (capacity && buffer) memcpy(buffer, s->url, capacity);
    return length;
}
int silk_inspector_pending(silk_inspector *s) { return s ? atomic_load_explicit(&s->pending, memory_order_acquire) : 0; }
silk_inspector_packet *silk_inspector_take(silk_inspector *s) {
    if (!silk_inspector_pending(s)) return NULL;
    pthread_mutex_lock(&s->mutex);
    silk_inspector_packet *p = s->first;
    if (p) { s->first = p->next; if (!s->first) s->last = NULL; s->in_bytes -= p->length; s->in_count--; p->next = NULL; }
    atomic_store_explicit(&s->pending, s->first != NULL, memory_order_release);
    pthread_mutex_unlock(&s->mutex);
    return p;
}
uint32_t silk_inspector_packet_kind(const silk_inspector_packet *p) { return p ? p->kind : 0; }
uint64_t silk_inspector_packet_connection(const silk_inspector_packet *p) { return p ? p->connection : 0; }
const unsigned char *silk_inspector_packet_data(const silk_inspector_packet *p) { return p ? p->bytes : NULL; }
size_t silk_inspector_packet_length(const silk_inspector_packet *p) { return p ? p->length : 0; }
void silk_inspector_packet_free(silk_inspector_packet *p) { free(p); }
int silk_inspector_wait(silk_inspector *s, int32_t timeout_ms) {
    if (!s) return 0;
    struct timespec until;
    if (timeout_ms >= 0) {
        clock_gettime(CLOCK_REALTIME, &until);
        until.tv_sec += timeout_ms / 1000; until.tv_nsec += (long)(timeout_ms % 1000) * 1000000;
        if (until.tv_nsec >= 1000000000) { until.tv_sec++; until.tv_nsec -= 1000000000; }
    }
    pthread_mutex_lock(&s->mutex);
    while (!s->first && !s->stopped && !s->stopping) {
        int error = timeout_ms < 0 ? pthread_cond_wait(&s->changed, &s->mutex) : pthread_cond_timedwait(&s->changed, &s->mutex, &until);
        if (error) break;
    }
    int result = s->first != NULL;
    pthread_mutex_unlock(&s->mutex); return result;
}
static int outgoing(silk_inspector *s, uint32_t kind, uint64_t connection, const unsigned char *bytes, size_t length) {
    if (!s || length > MESSAGE_LIMIT || (length && !bytes)) return EINVAL;
    silk_inspector_packet *p = packet(kind, connection, bytes, length); if (!p) return ENOMEM;
    pthread_mutex_lock(&s->mutex);
    int error = 0;
    if (s->stopped || s->stopping) error = ENOTCONN;
    else if (s->out_count >= PACKET_LIMIT || length > QUEUE_LIMIT - s->out_bytes) error = ENOBUFS;
    if (!error) {
        if (s->out_last) s->out_last->next = p; else s->out_first = p;
        s->out_last = p; s->out_count++; s->out_bytes += length; notify_io(s);
    }
    pthread_mutex_unlock(&s->mutex);
    if (error) free(p);
    return error;
}
int silk_inspector_send(silk_inspector *s, uint64_t connection, const unsigned char *bytes, size_t length) {
    if (length > MESSAGE_LIMIT || (length && (!bytes || !utf8(bytes, length)))) return EINVAL;
    return outgoing(s, SILK_INSPECTOR_MESSAGE, connection, bytes, length);
}
int silk_inspector_disconnect(silk_inspector *s, uint64_t connection) {
    if (!connection) return EINVAL;
    return outgoing(s, SILK_INSPECTOR_CLOSE, connection, NULL, 0);
}
