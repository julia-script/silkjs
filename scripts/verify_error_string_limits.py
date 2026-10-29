#!/usr/bin/env python3
"""Exercise backtrace string overflow with the same reduced limit in C and Silk.

The pinned upstream remains untouched. Only the string-length constant becomes
63 in isolated copies, allowing a real three-frame trace to cross the boundary
without multi-gigabyte allocations. Algorithm code and inputs are unchanged.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union Header { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;
static void *tracked_malloc(JSMallocState*s,size_t n){if(!n)return NULL;Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void tracked_free(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *tracked_realloc(JSMallocState*s,void*p,size_t n){if(!p)return tracked_malloc(s,n);if(!n){tracked_free(s,p);return NULL;}Header*h=(Header*)p-1;size_t old=h->size;h=realloc(h,sizeof(*h)+n);if(!h)return NULL;h->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return h+1;}
static size_t tracked_size(const void*p){return p?((const Header*)p-1)->size:0;}
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static JSValue native(JSContext*c,JSValueConst t,int n,JSValueConst*a){return JS_UNDEFINED;}
static void text(JSValueConst v){JSString*s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));}
static JSValue raised(JSContext*ctx,const char*fmt,...){va_list ap;va_start(ap,fmt);JS_ThrowError2(ctx,JS_TYPE_ERROR,fmt,ap,TRUE);va_end(ap);return JS_GetException(ctx);}
int main(void){
 JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};
 JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 for(int variant=0;variant<4;variant++){
 JSValue function=checked(JS_NewCFunction(ctx,native,"",0));JSStackFrame frames[3]={0};
 if(variant){uint16_t name[16];int length=variant==2?14:16;
  for(int i=0;i<length;i++)name[i]=variant==1?0x4e00:variant==2?(i%2?0xde00:0xd83d):0xd800;
  if(JS_DefinePropertyValue(ctx,function,JS_ATOM_name,checked(js_new_string16_len(ctx,name,length)),JS_PROP_CONFIGURABLE)<0)abort();}
 for(int i=0;i<3;i++){frames[i].cur_func=function;frames[i].prev_frame=i?&frames[i-1]:NULL;}
 for(int count=1;count<=3;count++){
  rt->current_stack_frame=&frames[count-1];
  /* Suppress recursive trace construction in the error raised by string overflow. */
  rt->in_out_of_memory=TRUE;@CREATE_ERROR@
  JSProperty*slot;JSShapeProperty*shape=find_own_property(&slot,JS_VALUE_GET_OBJ(error),JS_ATOM_stack);
  word(variant);word(count);word(shape!=NULL);if(!shape)abort();word(JS_VALUE_GET_NORM_TAG(slot->u.value));
  if(JS_IsString(slot->u.value))text(slot->u.value);else word(0);
  word(JS_HasException(ctx));
  if(JS_HasException(ctx)){
   JSValue pending=JS_GetException(ctx),proto=checked(JS_GetPrototype(ctx,pending));
   if(!JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_INTERNAL_ERROR]))abort();word(JS_INTERNAL_ERROR);
   JSValue message=checked(JS_GetPropertyStr(ctx,pending,"message"));text(message);
   JS_FreeValue(ctx,message);JS_FreeValue(ctx,proto);JS_FreeValue(ctx,pending);
  }
  rt->in_out_of_memory=FALSE;rt->current_stack_frame=NULL;JS_FreeValue(ctx,error);
 }
 JS_FreeValue(ctx,function);
 }
 for(int malformed=0;malformed<2;malformed++){
  char message[65];for(int i=0;i<64;i++)message[i]=malformed?0x80:i%2?0xa9:0xc3;message[64]=0;
  rt->in_out_of_memory=TRUE;JSValue error=raised(ctx,"%s",message);
  JSValue text_value=JS_GetPropertyStr(ctx,error,"message");
  /* The data slot may contain JS_EXCEPTION without throwing on property read. */
  word(JS_VALUE_GET_NORM_TAG(text_value));if(JS_IsString(text_value))text(text_value);else word(0);
  JS_FreeValue(ctx,text_value);JS_FreeValue(ctx,error);rt->in_out_of_memory=FALSE;
 }
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);
 if(live_count||live_bytes)abort();return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.i32
import silk.num.u16
import silk.collections.slice { Slice }
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_core_types { StackFrame, PropertySlot }
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringLengthError }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_runtime as runtime
import js_gc as gc
import js_errors as errors
import js_errors_test_support as fixture
@HOOKS_IMPORT@
import js_backtrace_test_support as frames
import js_atom_data as atoms
import js_array_storage_test_support { trap }
fn signed(value: i32) -> u32 {
 if value < 0 { return i32.toU32(-(value + 1)) ^ 0xffffffff } return i32.toU32(value)
}
effect fn text(out: &mut ByteBuffer, value: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(usize.toU32(Strings.length(value))) let mut index: usize = 0
 while index < Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value,index))) index = index + 1 }
}
effect fn probe(memory: &AllocationObserver) -> ()
 ! OutOfMemoryError | StringLengthError | JsException | WriterError ? &mut Allocator | &mut Writer {
 let rt = run runtime.allocateRuntimeStorage(0) let ctx = run unsafe runtime.allocateContextStorage(rt)
 let mut hooks = @MAKE_HOOKS@ run unsafe fixture.prepare(&mut hooks,memory,ctx)
 let mut out = ByteBuffer.make() let mut variant: u32 = 0
 while variant < 4 {
 let function = run unsafe frames.native(&mut hooks,memory,ctx,ValueBits.Null)
 if variant != 0 {
  let mut units: [u16; 16] = [0xd800; 16] let mut length: usize = 16 let mut at: usize = 0
  if variant == 2 { length = 14 }
  while at < length {
   if variant == 1 { units[at] = 0x4e00 }
   else if variant == 2 { if at % 2 == 0 { units[at] = 0xd83d } else { units[at] = 0xde00 } }
   at = at + 1
  }
  let name = run Strings.fromUtf16(Slice.view<u16>(&units,0,length))
  run unsafe frames.add(&mut hooks,rt,function,atoms.JS_ATOM_name,1,PropertySlot.Value { value: name })
 }
 let mut first = run frames.frame(function) let mut second = run frames.frame(function) let mut third = run frames.frame(function)
 second.previous = Pointer.fromMutRef<StackFrame>(&mut first)
 third.previous = Pointer.fromMutRef<StackFrame>(&mut second)
 let mut count: u32 = 1
 while count <= 3 {
  let mut frame = Pointer.fromMutRef<StackFrame>(&mut first)
  if count == 2 { frame = Pointer.fromMutRef<StackFrame>(&mut second) }
  else if count == 3 { frame = Pointer.fromMutRef<StackFrame>(&mut third) }
  unsafe frames.publish(rt,frame) unsafe fixture.setOom(rt,true)
 @CREATE_ERROR@
  let stack = unsafe fixture.property(error,atoms.JS_ATOM_stack)
  run out.writeU32(variant) run out.writeU32(count) if !stack.present { trap() } run out.writeU32(1) run out.writeU32(signed(stack.value.tag()))
  if stack.value.isString() { run text(&mut out,stack.value) } else { run out.writeU32(0) }
  if unsafe exceptions.has(rt) {
   run out.writeU32(1) let pending = unsafe exceptions.take(rt)
   let kind = unsafe fixture.prototypeIndex(ctx,pending) if kind != 6 { trap() } run out.writeU32(kind)
   let message = unsafe fixture.property(pending,atoms.JS_ATOM_message) run text(&mut out,message.value)
   unsafe gc.release(&mut hooks,rt,pending)
  } else { run out.writeU32(0) }
  unsafe fixture.setOom(rt,false) unsafe frames.publish(rt,Pointer.null<StackFrame>())
  unsafe gc.release(&mut hooks,rt,error) count = count + 1
 }
 unsafe gc.release(&mut hooks,rt,function) variant = variant + 1
 }
 let mut malformed: u32 = 0
 while malformed < 2 {
  let mut bytes: [u8; 64] = [0x80; 64] let mut at: usize = 0
  if malformed == 0 {
   while at < 64 { if at % 2 == 0 { bytes[at] = 0xc3 } else { bytes[at] = 0xa9 } at = at + 1 }
  }
  unsafe fixture.setOom(rt,true)
  let error = run unsafe fixture.capture(&mut hooks,memory,ctx,fixture.kind(4),&bytes,2)
  let message = unsafe fixture.property(error,atoms.JS_ATOM_message)
  run out.writeU32(signed(message.value.tag()))
  if message.value.isString() { run text(&mut out,message.value) } else { run out.writeU32(0) }
  unsafe gc.release(&mut hooks,rt,error) unsafe fixture.setOom(rt,false) malformed = malformed + 1
 }
 run Writer.writeAll(out.asSlice())
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let mut writer = StdoutWriter.make()
 run probe(&observer) |> Effect.provideMut<Allocator>(&mut memory) |> Effect.provideMut<Writer>(&mut writer)
 if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
 let mut output = ByteBuffer.make() let mut allocator = Allocator.systemAllocatorProvider()
 run output.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run output.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run Writer.writeAll(output.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''


def changed_limit(source, original, replacement):
    if source.count(original) != 1:
        raise SystemExit('String limit fixture no longer matches the declared constant')
    return source.replace(original, replacement)


def records(data):
    if len(data) % 4:
        raise SystemExit('Partial string-limit output word')
    words = struct.unpack(f'<{len(data)//4}I', data)
    offset = 0

    def take(count):
        nonlocal offset
        if offset + count > len(words):
            raise SystemExit('Truncated string-limit record')
        result = words[offset:offset + count]
        offset += count
        return result

    def text():
        return take(take(1)[0])

    frames = []
    for _ in range(12):
        variant, count, present, tag = take(4)
        units = text()
        pending = None
        if take(1)[0]:
            pending = (take(1)[0], text())
        frames.append((variant, count, present, tag, units, pending))
    messages = [(take(1)[0], text()) for _ in range(2)]
    if take(2) != (0, 0) or offset != len(words):
        raise SystemExit('Nonzero string-limit ledger or trailing data')
    return frames, messages


def compare(expected, actual, factory_only):
    c_frames, c_messages = records(expected)
    native_frames, native_messages = records(actual)
    if c_messages != native_messages:
        raise SystemExit(f'UTF8 decoding mismatch: C={c_messages}, native={native_messages}')
    names = ['<anonymous>', '\u4e00' * 16, '\ud83d\ude00' * 7, '\ud800' * 16]
    matched, guarded = 2, 0
    for index, (c, native) in enumerate(zip(c_frames, native_frames)):
        variant, count = index // 3, index % 3 + 1
        if c[:3] != (variant, count, 1) or native[:3] != c[:3]:
            raise SystemExit(f'Wrong string-limit frame identity: C={c}, native={native}')
        if c == native:
            matched += 1
            continue
        # JS_NewStringLen checks only its initial ASCII run. Its non-ASCII
        # capacity hint bypasses JS_STRING_LEN_MAX, including for UTF16 output.
        # Observe that upstream behavior explicitly; Silk keeps its declared cap.
        full_text = tuple(map(ord, ('    at ' + names[variant] + ' (native)\n') * count))
        pending = None if factory_only else (6, tuple(map(ord, 'string too long')))
        if (variant == 0 or len(full_text) <= 63
                or c != (variant, count, 1, 0xfffffff9, full_text, None)
                or native != (variant, count, 1, 6, (), pending)):
            raise SystemExit(f'String-limit mismatch: C={c}, native={native}')
        guarded += 1
    if (matched, guarded) != (9, 5):
        raise SystemExit(f'Wrong matched/guarded case counts: {matched}/{guarded}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--factory-only', action='store_true',
                        help='exercise explicit fresh-Error traces without the property-definition host')
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    if args.factory_only:
        c_create = 'JSValue error=raised(ctx,"probe");'
        native_create = 'let error = run unsafe fixture.capture(&mut hooks,memory,ctx,fixture.kind(4),b"probe",2)'
        hooks_import, make_hooks = 'import js_coercions_test_support { Hooks }', 'Hooks.make()'
    else:
        c_create = 'JSValue error=checked(JS_NewError(ctx));build_backtrace(ctx,error,NULL,0,0,0);'
        native_create = ('let error = run unsafe errors.newError(&mut hooks,memory,ctx) '
                         'run unsafe errors.buildBacktrace(&mut hooks,memory,ctx,error,Option<ValueBits>.none(),0,0,0)')
        hooks_import, make_hooks = 'import js_errors_test_support { Hooks }', 'Hooks.make(memory)'
    with tempfile.TemporaryDirectory(prefix='silkjs-error-string-limits-') as directory:
        temp = Path(directory).resolve()
        (temp / 'quickjs.c').write_text(changed_limit((upstream / 'quickjs.c').read_text(),
            '#define JS_STRING_LEN_MAX ((1 << 30) - 1)', '#define JS_STRING_LEN_MAX 63'))
        (temp / 'oracle.c').write_text(C_SOURCE.replace('@CREATE_ERROR@', c_create))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="bounded-limit"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Bounded string-limit C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Bounded string-limit C consumer')
        shutil.copytree(ROOT / 'src', temp / 'src')
        native_limit = temp / 'src/js_string_types.silk'
        native_limit.write_text(changed_limit(native_limit.read_text(),
            'pub const STRING_LENGTH_MAX: usize = 1073741823', 'pub const STRING_LENGTH_MAX: usize = 63'))
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('@CREATE_ERROR@', native_create)
            .replace('@HOOKS_IMPORT@', hooks_import).replace('@MAKE_HOOKS@', make_hooks))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="error-string-limits"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Bounded string-limit native consumer', cwd=temp)
        compare(expected, actual, args.factory_only)
        print(f'PASS error string limit: 9 matching cases, 5 explicit upstream-cap-bypass contrasts; '
              f'parameterized limit63; {pins} original source pins; both teardown ledgers zero; '
              f'C_SHA256={hashlib.sha256(expected).hexdigest()}; native_SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
