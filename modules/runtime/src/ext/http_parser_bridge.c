/* llhttp 9.4.3 adapter. Parsing and framing remain entirely in llhttp.
 * This translation unit owns C layout knowledge; the runtime owner is Silk. */
#include <stdlib.h>
#include "llhttp.h"

typedef struct {
  llhttp_t parser;
  const unsigned char* position;
} SilkHTTPParser;

extern int silkHTTPParserEvent(void* owner, int event,
                               const unsigned char* data, size_t length,
                               const unsigned char* position);

/* api.c alone is compiled with these internal symbols renamed. The wrappers
 * retain llhttp's exact callback cursor; no framing code or vendor file changes. */
#define POSITION(name) \
  extern int silk_llhttp_base_##name(llhttp_t*, const char*, const char*); \
  int llhttp__##name(llhttp_t* parser, const char* p, const char* endp) { \
    ((SilkHTTPParser*) parser)->position = (const unsigned char*) p; \
    return silk_llhttp_base_##name(parser, p, endp); \
  }
POSITION(on_message_begin)
POSITION(on_header_value_complete)
POSITION(on_headers_complete)
POSITION(on_message_complete)
POSITION(on_chunk_header)
POSITION(on_chunk_complete)

#define EVENT(name, number) \
  static int name(llhttp_t* parser) { \
    return silkHTTPParserEvent(parser->data, number, NULL, 0, \
                               ((SilkHTTPParser*) parser)->position); \
  }
#define DATA(name, number) \
  static int name(llhttp_t* parser, const char* data, size_t length) { \
    const unsigned char* end = (const unsigned char*) data + length; \
    ((SilkHTTPParser*) parser)->position = end; \
    return silkHTTPParserEvent(parser->data, number, \
                               (const unsigned char*) data, length, end); \
  }
EVENT(message_begin, 0)
DATA(url, 1)
DATA(status, 2)
DATA(header_field, 3)
DATA(header_value, 4)
EVENT(header_value_complete, 6)
EVENT(headers_complete, 7)
DATA(body, 8)
EVENT(message_complete, 9)
EVENT(chunk_header, 10)
EVENT(chunk_complete, 11)
DATA(chunk_extension_name, 12)
DATA(chunk_extension_value, 13)

static const llhttp_settings_t settings = {
  .on_message_begin = message_begin,
  .on_url = url,
  .on_status = status,
  .on_header_field = header_field,
  .on_header_value = header_value,
  .on_header_value_complete = header_value_complete,
  .on_headers_complete = headers_complete,
  .on_body = body,
  .on_message_complete = message_complete,
  .on_chunk_header = chunk_header,
  .on_chunk_complete = chunk_complete,
  .on_chunk_extension_name = chunk_extension_name,
  .on_chunk_extension_value = chunk_extension_value,
};

void* silk_http_parser_new(void* owner) {
  llhttp_t* parser = calloc(1, sizeof(SilkHTTPParser));
  if (parser != NULL) {
    llhttp_init(parser, HTTP_REQUEST, &settings);
    parser->data = owner;
  }
  return parser;
}

void silk_http_parser_initialize(llhttp_t* parser, int type, unsigned flags) {
  void* owner = parser->data;
  llhttp_init(parser, (llhttp_type_t) type, &settings);
  parser->data = owner;
  parser->lenient_flags = (uint16_t) flags;
  ((SilkHTTPParser*) parser)->position = NULL;
}

void silk_http_parser_free(llhttp_t* parser) { free(parser); }

void silk_http_parser_set_upgrade(llhttp_t* parser, int upgrade) {
  parser->upgrade = upgrade != 0;
}

void silk_http_parser_error(llhttp_t* parser, int kind) {
  switch (kind) {
    case 1:
      llhttp_set_error_reason(parser, "HPE_HEADER_OVERFLOW:Header overflow");
      break;
    case 2:
      llhttp_set_error_reason(parser,
          "HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow");
      break;
    default:
      llhttp_set_error_reason(parser, "HPE_JS_EXCEPTION:JS Exception");
      break;
  }
}

_Static_assert(HPE_USER == 24 && HPE_PAUSED == 21 && HPE_PAUSED_UPGRADE == 22,
               "Update the pinned Silk HTTP parser error ABI");
