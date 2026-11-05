#!/usr/bin/env python3
"""Compare finalizer-visible pending exceptions at consuming property boundaries."""
import argparse
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib

from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("definePropertyValue", "setPropertyInternal/distinct-receiver",
         "setPropertyValue", "definePropertyValueValue", "getPropertyValue/coercing-key",
         "getPropertyValue/null-control", "setPropertyInternal/direct",
         "setPropertyValue/coercing-key", "definePropertyValueValue/coercing-key")
FIELDS = ("injected-failures", "last-owner-finalizations", "pending-in-finalizer",
          "pending-on-return", "operation-failed", "zero-ledger")
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes;
static unsigned armed, failures, finalized, saw_pending;
static JSClassID watch_class;
static int reject_allocation(void) {
    if (!armed) return 0;
    armed = 0; failures++; return 1;
}
static void *allocate(JSMallocState *s, size_t n) {
    if (!n || reject_allocation()) return NULL;
    Header *h = malloc(sizeof(*h) + n); if (!h) return NULL;
    h->size = n; live_count++; live_bytes += n;
    s->malloc_count++; s->malloc_size += n; return h + 1;
}
static void release(JSMallocState *s, void *p) {
    if (!p) return;
    Header *h = (Header *)p - 1;
    live_count--; live_bytes -= h->size;
    s->malloc_count--; s->malloc_size -= h->size; free(h);
}
static void *resize(JSMallocState *s, void *p, size_t n) {
    if (!p) return allocate(s, n);
    if (!n) { release(s, p); return NULL; }
    if (reject_allocation()) return NULL;
    Header *h = (Header *)p - 1; size_t old = h->size;
    Header *r = realloc(h, sizeof(*h) + n); if (!r) return NULL;
    r->size = n; live_bytes = live_bytes - old + n;
    s->malloc_size = s->malloc_size - old + n; return r + 1;
}
static size_t usable(const void *p) { return p ? ((const Header *)p - 1)->size : 0; }
static const JSMallocFunctions allocator = { allocate, release, resize, usable };
static void finalizer(JSRuntime *rt, JSValue object) {
    (void)object; finalized++;
    saw_pending |= !JS_IsUninitialized(rt->current_exception);
}
static JSValue primitive(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv) {
    (void)ctx; (void)receiver; (void)argc; (void)argv;
    return JS_NewInt32(ctx, -1);
}
static JSValue checked(JSValue value) { if (JS_IsException(value)) abort(); return value; }
static void word(uint32_t n) { for (unsigned i = 0; i < 4; i++) putchar((n >> (8 * i)) & 255); }
static void scenario(unsigned mode) {
    JSRuntime *rt = JS_NewRuntime2(&allocator, NULL); if (!rt) abort();
    JSContext *ctx = JS_NewContext(rt); if (!ctx) abort();
    JSClassDef definition = { "ConsumptionWatch", .finalizer = finalizer };
    if (JS_NewClass(rt, watch_class, &definition) < 0) abort();
    JSValue target = checked(JS_NewObjectProto(ctx, JS_NULL));
    JSValue receiver = checked(JS_NewObjectProto(ctx, JS_NULL));
    JSAtom atom = JS_NewAtom(ctx, "consumption-order-property"); if (!atom) abort();
    JSValue input = checked(JS_NewObjectProtoClass(ctx, JS_NULL, watch_class));
    if (mode == 4 || mode >= 7) {
        JSValue method = checked(JS_NewCFunction(ctx, primitive, "primitive", 1));
        if (JS_DefinePropertyValue(ctx, input, JS_ATOM_Symbol_toPrimitive, method, JS_PROP_C_W_E) < 0) abort();
    }
    failures = finalized = saw_pending = 0; armed = mode != 5;
    int failed;
    if (mode == 0) failed = JS_DefinePropertyValue(ctx, target, atom, input, JS_PROP_C_W_E) < 0;
    else if (mode == 1) failed = JS_SetPropertyInternal(ctx, target, atom, input, receiver, 0) < 0;
    else if (mode == 2) failed = JS_SetPropertyValue(ctx, target, JS_NewInt32(ctx, -1), input, 0) < 0;
    else if (mode == 3) failed = JS_DefinePropertyValueValue(ctx, target, JS_NewInt32(ctx, -1), input, JS_PROP_C_W_E) < 0;
    else if (mode == 6) failed = JS_SetPropertyInternal(ctx, target, atom, input, target, 0) < 0;
    else if (mode == 7) failed = JS_SetPropertyValue(ctx, target, input, JS_UNDEFINED, 0) < 0;
    else if (mode == 8) failed = JS_DefinePropertyValueValue(ctx, target, input, JS_UNDEFINED, JS_PROP_C_W_E) < 0;
    else {
        JSValue result = JS_GetPropertyValue(ctx, mode == 4 ? target : JS_NULL, input);
        failed = JS_IsException(result); JS_FreeValue(ctx, result);
    }
    armed = 0;
    unsigned row[] = { failures, finalized, saw_pending, JS_HasException(ctx), failed };
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, target); JS_FreeValue(ctx, receiver); JS_FreeAtom(ctx, atom);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    for (unsigned i = 0; i < 5; i++) word(row[i]);
    word(live_count == 0 && live_bytes == 0);
}
int main(void) {
    JS_NewClassID(&watch_class);
    for (unsigned mode = 0; mode < 9; mode++) scenario(mode);
    return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_vm_properties_consumption_proof as proof
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | WriterError {
  let mut system = Allocator.systemAllocatorProvider() let mut output = ByteBuffer.make()
  let mut mode: u32 = 0
  while mode < 9 {
    let row = run proof.record(mode)
    let mut field: usize = 0
    while field < 6 { run output.writeU32(row[field]) |> Effect.provideMut<Allocator>(&mut system) field = field + 1 }
    mode = mode + 1
  }
  let mut writer = StdoutWriter.make()
  run Writer.writeAll(output.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--silk", default=str(toolchain.compiler_path()))
    parser.add_argument("--stdlib", type=Path, default=toolchain.stdlib_path())
    parser.add_argument("--cc", default="cc")
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    with tempfile.TemporaryDirectory(prefix="silkjs-vm-properties-consumption-") as directory:
        temp = Path(directory)
        (temp / "oracle.c").write_text(C_SOURCE)
        process([cc, "-O2", "-std=gnu11", "-fwrapv", "-funsigned-char", "-U__SIZEOF_INT128__",
                 "-D_GNU_SOURCE", "-D__SANITIZE_ADDRESS__", '-DCONFIG_VERSION="differential"', "-I", str(reference),
                 str(temp / "oracle.c"), *(str(reference / name) for name in SUPPORT),
                 "-lm", "-lpthread", "-o", str(temp / "oracle")], 600, owner="Consumption-order C compilation")
        expected = process([str(temp / "oracle")], 600, owner="Consumption-order C oracle")
        golden = struct.pack("<54I", *([1, 1, 1, 1, 1, 1] * 5 + [0, 1, 0, 1, 1, 1] + [1, 1, 1, 1, 1, 1] * 3))
        if expected != golden:
            rows = []
            for index, name in enumerate(NAMES):
                offset = index * 24
                if offset + 24 > len(expected):
                    rows.append(f"{name}: missing record")
                    continue
                values = struct.unpack_from("<6I", expected, offset)
                rows.append(f"{name}: " + ", ".join(f"{field}={value}" for field, value in zip(FIELDS, values)))
            raise SystemExit("Pinned C did not reach the intended fault/finalizer contract:\n" + "\n".join(rows))
        shutil.copytree(ROOT / "src", temp / "src")
        (temp / "src/main.silk").write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / "silk.toml").read_text())["package"]["silk-version"]
        (temp / "silk.toml").write_text(f'[package]\nname="vm-properties-consumption-proof"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, "run", "--quiet", "--release"]
        if args.stdlib:
            command += ["--stdlib", str(args.stdlib.resolve())]
        actual = process(command, 1200, owner="Native consumption-order proof", cwd=temp)
        if len(actual) != len(expected):
            raise SystemExit(f"Native proof emitted {len(actual)} bytes; expected {len(expected)}")
        differences = []
        for row, name in enumerate(NAMES):
            observed = struct.unpack_from("<6I", actual, row * 24)
            wanted = struct.unpack_from("<6I", expected, row * 24)
            for field, label in enumerate(FIELDS):
                if observed[field] != wanted[field]:
                    differences.append(f"{name}: {label}: C={wanted[field]}, native={observed[field]}")
        if differences:
            raise SystemExit("FAIL consuming-property exception ordering\n" + "\n".join(differences))
        print(f"PASS consuming-property exception ordering: eight injected-failure consumers, null-control, zero ledgers; {pins} pinned files")


if __name__ == "__main__":
    main()
