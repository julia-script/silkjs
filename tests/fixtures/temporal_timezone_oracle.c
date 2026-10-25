/* Independent oracle: compile against the unmodified pinned QuickJS sources.
 * Emits executable Silk assertions whose expected values come only from C. */
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <ctype.h>
#include <string.h>
#include "temporal/timezone.h"

static size_t instant_count, local_count, day_count;
static void word(int64_t value) {
    uint64_t bits = (uint64_t)value;
    for (int i = 0; i < 8; ++i) printf("\\x%02x", (unsigned)((bits >> (i * 8)) & 255));
}
static void record(int op, int id, int64_t sec, int ns, int64_t a, int64_t b, int64_t c, int64_t d, int64_t e) {
    word(op); word(id); word(sec); word(ns);
    word(a); word(b); word(c); word(d); word(e);
}
static void instant(int id, int64_t sec, int ns) {
    record(0, id, sec, ns, ti_tz_offset_at_sec(id, sec),
           ti_tz_prev_offset_at_sec(id, sec), ti_tz_next_transition_sec(id, sec),
           ti_tz_next_transition_at(id, sec, ns), ti_tz_prev_transition_at(id, sec, ns));
    ++instant_count;
}
static void local(int id, int64_t sec) {
    for (int dis = 0; dis < 4; ++dis) {
        int64_t utc = 123;
        int offset = 456;
        int status = ti_tz_local_to_utc(id, sec, dis, &utc, &offset);
        record(1, id, sec, dis, status, utc, offset, 0, 0);
        ++local_count;
    }
    int64_t day = sec / 86400;
    if (sec % 86400 < 0) --day;
    day *= 86400;
    record(2, id, day, 0, ti_get_start_of_day_sec(id, day), 0, 0, 0, 0);
    ++day_count;
}
static void name(const char *s) {
    printf("  assert(tz.ti_tz_find_id(b\"%s\") == %d)\n", s, ti_tz_find_id(s));
    printf("  assert(tz.ti_tz_can_be_named(b\"%s\") == %s)\n", s, ti_tz_can_be_named(s) ? "true" : "false");
    printf("  assert(bytesEqual(tz.ti_canonicalize_timezone_alias(b\"%s\"), b\"%s\"))\n", s, ti_canonicalize_timezone_alias(s));
}
int main(void) {
    puts("import temporal_timezone as tz\nimport silk.i64\nimport silk.u8\nfn assert(ok: bool) -> () { if !ok { Intrinsic.trap(\"Timezone C contrast failed\") } }\nfn bytesEqual(a: &[u8], b: &[u8]) -> bool {\n  if a.length != b.length { return false }\n  let mut i: usize = 0\n  while i < a.length { if a[i] != b[i] { return false } i = i + 1 }\n  return true\n}\nfn names() -> () {");
    for (int i = 0; i < ti_tz_name_count; ++i) {
        name(ti_tz_names[i]);
        char lower[256];
        size_t n = strlen(ti_tz_names[i]);
        if (n >= sizeof(lower)) return 2;
        for (size_t j = 0; j <= n; ++j) lower[j] = (char)tolower((unsigned char)ti_tz_names[i][j]);
        name(lower);
    }
    const char *extra[] = {"", "Unknown/Zone", "UTC", "utc", "Asia/Calcutta", "asia/calcutta", "Asia/Kolkata", "US/Eastern", "America/New_York", "Europe/Belfast", "+01:00", "GMT", "Etc/UTC"};
    for (size_t i = 0; i < sizeof(extra)/sizeof(extra[0]); ++i) {
        name(extra[i]);
        for (size_t j = 0; j < sizeof(extra)/sizeof(extra[0]); ++j)
            printf("  assert(tz.ti_timezones_are_equal(b\"%s\", b\"%s\") == %s)\n", extra[i], extra[j], ti_timezones_are_equal(extra[i], extra[j]) ? "true" : "false");
    }
    puts("}\nfn readWord(data: &[u8], at: usize) -> i64 {\n  let mut value = u8.toI64(data[at+7])\n  if value >= 128 { value = value - 256 }\n  let mut i: usize = 7\n  while i > 0 { i = i - 1 value = value * 256 + u8.toI64(data[at+i]) }\n  return value\n}\nfn numeric() -> () {");
    printf("  let cases = b\"");
    for (int id = -1; id <= ti_tz_zone_count; ++id) {
        instant(id, 0, 0);
        local(id, 0);
        if (id < 0 || id >= ti_tz_zone_count) continue;
        const TZData *z = &ti_tz_zone_data[id];
        for (int i = 1; i < z->transition_count; ++i) {
            int64_t sec = z->transitions[i].start_sec;
            instant(id, sec - 1, 999999999);
            instant(id, sec, -1);
            instant(id, sec, 0);
            instant(id, sec, 1);
            instant(id, sec + 1, 0);
            int64_t a = sec + z->transitions[i-1].offset_sec;
            int64_t b = sec + z->transitions[i].offset_sec;
            local(id, a - 1); local(id, a); local(id, b - 1); local(id, b);
            local(id, a + (b-a)/2);
        }
        /* At INT64_MIN with negative nsec the source next-transition query
         * indexes before entry zero. Do not execute that undefined C input.
         * Equality and positive subseconds at the sentinel are defined. */
        instant(id, INT64_MIN, 0);
        instant(id, INT64_MIN, 1);
        instant(id, -8640000000000LL, 0);
        instant(id, 8640000000000LL, 999999999);
    }
    puts("\"\n  let mut at: usize = 0\n  while at < cases.length {\n    let op = readWord(cases, at)\n    let id = i64.toI32(readWord(cases, at+8))\n    let sec = readWord(cases, at+16)\n    let ns = i64.toI32(readWord(cases, at+24))\n    if op == 0 {\n      assert(tz.ti_tz_offset_at_sec(id, sec) == i64.toI32(readWord(cases, at+32)))\n      assert(tz.ti_tz_prev_offset_at_sec(id, sec) == i64.toI32(readWord(cases, at+40)))\n      assert(tz.ti_tz_next_transition_sec(id, sec) == readWord(cases, at+48))\n      assert(tz.ti_tz_next_transition_at(id, sec, ns) == readWord(cases, at+56))\n      assert(tz.ti_tz_prev_transition_at(id, sec, ns) == readWord(cases, at+64))\n    } else if op == 1 {\n      let mut utc: i64 = 123\n      let mut offset: i32 = 456\n      assert(tz.ti_tz_local_to_utc(id, sec, ns, &mut utc, &mut offset) == i64.toI32(readWord(cases, at+32)))\n      assert(utc == readWord(cases, at+40))\n      assert(offset == i64.toI32(readWord(cases, at+48)))\n    } else {\n      assert(op == 2)\n      assert(tz.ti_get_start_of_day_sec(id, sec) == readWord(cases, at+32))\n    }\n    at = at + 72\n  }\n}\npub fn main() -> i32 { names() numeric() return 0 }");
    printf("// Records: instant=%zu local=%zu start_of_day=%zu\n", instant_count, local_count, day_count);
    return 0;
}
