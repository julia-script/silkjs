/* The libuv header owns the platform errno values and canonical messages. */
#include <uv.h>

struct SilkUtilityError {
  int code;
  const char *name;
  const char *message;
};

static const struct SilkUtilityError errors[] = {
#define SILK_UTILITY_ERROR(name, message) { UV_##name, #name, message },
  UV_ERRNO_MAP(SILK_UTILITY_ERROR)
#undef SILK_UTILITY_ERROR
};

int silk_util_error_count(void) {
  return (int)(sizeof(errors) / sizeof(errors[0]));
}
int silk_util_error_code(int index) { return errors[index].code; }
const char *silk_util_error_name(int index) { return errors[index].name; }
const char *silk_util_error_message(int index) { return errors[index].message; }
