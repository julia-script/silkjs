#!/usr/bin/env python3
"""Original pinned QuickJS C/native primitive coercion differential (no C binding).

python3 scripts/verify_primitive_coercions.py QUICKJS

Five operations cover consuming Number/Numeric, borrowed/consuming ToString and
borrowed ToPropertyKey. Fixtures include every non-object tag, retained aliases,
UTF16/ropes, decimal/radix syntax, IEEE boundaries and shortest formatting. Error
records compare the actual C TypeError prototype and exact message to the native
typed diagnostic. NaN payloads alone are canonicalized. Both processes assert
independent allocation ledgers after full teardown. Fault injection belongs to
the permanent native tests, not cross-language allocation-threshold comparisons.
"""
import argparse
from dataclasses import dataclass
import hashlib
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib

from verify_strings import ROOT, SUPPORT, executable_path, validate_pins, process
from verify_primitives import C_SOURCE as PRIMITIVE_C, SILK_SOURCE as PRIMITIVE_SILK
from verify_primitives import u32, wide, float_bits, signed_limbs, number_corpus
import toolchain

# Reuse the established binary fixture decoders only, never primitive operations
# or expected outputs. Explicit boundaries fail loudly if that fixture ABI moves.
def fixture_prefix(source, boundary):
    if source.count(boundary) != 1:
        raise RuntimeError(f'primitive fixture boundary changed: {boundary}')
    return source.split(boundary)[0]

C_SOURCE = fixture_prefix(PRIMITIVE_C, 'static void equality(') + r'''
#include <stddef.h>
typedef union MemoryHeader { max_align_t align; size_t size; } MemoryHeader;
static size_t live_count, live_bytes;
static void *tracked_malloc(JSMallocState *s,size_t n) {
    if(!n) return NULL;
    MemoryHeader *h=malloc(sizeof(*h)+n); if(!h) return NULL;
    h->size=n; live_count++; live_bytes+=n; s->malloc_count++; s->malloc_size+=n;
    return h+1;
}
static void tracked_free(JSMallocState *s,void *p) {
    if(!p) return;
    MemoryHeader *h=(MemoryHeader *)p-1;
    live_count--; live_bytes-=h->size; s->malloc_count--; s->malloc_size-=h->size;
    free(h);
}
static void *tracked_realloc(JSMallocState *s,void *p,size_t n) {
    if(!p) return tracked_malloc(s,n);
    if(!n) { tracked_free(s,p); return NULL; }
    MemoryHeader *h=(MemoryHeader *)p-1; size_t old=h->size;
    h=realloc(h,sizeof(*h)+n); if(!h) return NULL;
    h->size=n; live_bytes=live_bytes-old+n; s->malloc_size=s->malloc_size-old+n;
    return h+1;
}
static size_t tracked_size(const void *p) { return p?((const MemoryHeader *)p-1)->size:0; }
static uint64_t output[65536]; static unsigned output_count;
static void emit(uint64_t v) { if(output_count==65536) die("record overflow"); output[output_count++]=v; }
static void flush_record(void) { put32(output_count); for(unsigned i=0;i<output_count;i++) put64(output[i]); output_count=0; }
static int rc(JSValue v) { return JS_VALUE_HAS_REF_COUNT(v)?js_rc(JS_VALUE_GET_PTR(v))->ref_count:0; }
static void text(JSValue v) {
    JSString *s=JS_VALUE_GET_STRING(v); emit(s->len);
    for(unsigned i=0;i<s->len;i++) emit(string_get(s,i));
}
static void describe(JSContext *ctx,JSValue v,JSValue original) {
    int tag=JS_VALUE_GET_NORM_TAG(v); emit((int64_t)tag);
    switch(tag) {
    case JS_TAG_INT: emit((int64_t)JS_VALUE_GET_INT(v)); break;
    case JS_TAG_FLOAT64: { double d=JS_VALUE_GET_FLOAT64(v); emit(isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d)); break; }
    case JS_TAG_STRING: text(v); emit(JS_VALUE_GET_TAG(original)==JS_TAG_STRING && JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(original)); break;
    case JS_TAG_SYMBOL: emit(JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(original)); break;
    case JS_TAG_SHORT_BIG_INT: emit((int64_t)JS_VALUE_GET_SHORT_BIG_INT(v)); break;
    case JS_TAG_BIG_INT: {
        JSBigInt *b=JS_VALUE_GET_PTR(v); emit(b->len); for(unsigned i=0;i<b->len;i++) emit(b->tab[i]);
        emit(JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(original)); break;
    }
    case JS_TAG_EXCEPTION: break;
    default: die("unexpected result tag");
    }
}
static void operate(JSContext *ctx,JSValue original,unsigned op) {
    int before=rc(original); JSValue result;
    if(op==0 || op==1) result=JS_ToNumberHintFree(ctx,JS_DupValue(ctx,original),op==0?TON_FLAG_NUMBER:TON_FLAG_NUMERIC);
    else if(op==2) result=JS_ToString(ctx,original);
    else if(op==3) result=JS_ToStringFree(ctx,JS_DupValue(ctx,original));
    else if(op==4) result=JS_ToPropertyKey(ctx,original);
    else { die("operation"); return; }
    if(JS_IsException(result) && !JS_IsException(original)) {
        JSValue error=JS_GetException(ctx), proto=JS_GetPrototype(ctx,error);
        emit(JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR])?1:2);
        JSValue message=checked(JS_GetPropertyStr(ctx,error,"message"));
        text(message); JS_FreeValue(ctx,message); JS_FreeValue(ctx,proto); JS_FreeValue(ctx,error);
    } else { emit(0); describe(ctx,result,original); }
    JS_FreeValue(ctx,result);
    emit((int64_t)(rc(original)-before));
    // Check retained source content, not only the result. Linearization may
    // replace rope children, but may neither consume nor change the root value.
    if(JS_IsString(original)) {
        JSValue alias=checked(JS_ToString(ctx,original)); text(alias); JS_FreeValue(ctx,alias);
    }
    flush_record();
}
int main(void) {
    JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};
    JSRuntime *rt=JS_NewRuntime2(&mf,NULL); if(!rt) die("runtime allocation");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context allocation");
    unsigned n=word(); JSValue *pool=malloc((n?n:1)*sizeof(*pool)); if(!pool) die("pool allocation");
    for(unsigned i=0;i<n;i++) { pool[i]=value(ctx,pool,i); if(JS_IsObject(pool[i])) die("primitive precondition"); }
    unsigned count=word(); put32(count+1);
    for(fixture=0;fixture<count;fixture++) { unsigned op=byte(),index=word(); if(index>=n) die("pool index"); operate(ctx,pool[index],op); }
    if(getchar()!=EOF) die("trailing input");
    for(unsigned i=n;i>0;i--) JS_FreeValue(ctx,pool[i-1]); free(pool);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    emit(live_count); emit(live_bytes); flush_record();
    if(live_count || live_bytes) die("post-teardown allocation leak");
    return 0;
}
'''

SILK_SOURCE = fixture_prefix(PRIMITIVE_SILK, 'effect fn equality(') + r'''
import silk.core.result { Result }
import runtime_memory { RuntimeAllocator }
import js_primitive_coercions as coercion
import js_primitive_coercions { NumberHint, CoercionError }
unsafe fn rc(v:ValueBits)->i32 {
  match v.heapReference() {
    Option<*mut HeapHeader>.None => { return 0 }
    Option<*mut HeapHeader>.Some { value:node } => {
      let anchor=() let header=unsafe Pointer.borrow<(),HeapHeader>(&anchor,node)
      return header.referenceCount
    }
  }
}
effect fn text(out:&mut ByteBuffer,v:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU64(usize.toU64(Strings.length(v))) let mut i:usize=0
  while i<Strings.length(v) { run out.writeU64(u32.toU64(u16.toU32(Strings.codeUnit(v,i)))) i=i+1 }
}
fn sameReference(a:ValueBits,b:ValueBits)->bool {
  match a.heapReference() {
    Option<*mut HeapHeader>.Some { value:left } => {
      match b.heapReference() {
        Option<*mut HeapHeader>.Some { value:right } => { return Pointer.address(left)==Pointer.address(right) }
        _ => { return false }
      }
    }
    _ => { return false }
  }
}
effect fn describe(out:&mut ByteBuffer,v:ValueBits,original:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU64(bits(i32.toI64(v.tag())))
  match v {
    ValueBits.Int { value:n } => { run out.writeU64(bits(i32.toI64(n))) }
    ValueBits.Float64 { value:n } => { run scalar(&mut out,n) }
    ValueBits.ShortBigInt { value:n } => { run out.writeU64(bits(i32.toI64(n))) }
    ValueBits.String { .. } => { run text(&mut out,v) run out.writeU64(flag(original.tag()==-7 && sameReference(v,original))) }
    ValueBits.Symbol { .. } => { run out.writeU64(flag(sameReference(v,original))) }
    ValueBits.BigInt { reference } => {
      let anchor=() let b=unsafe HeapCell.payload<BigInt,()>(&anchor,reference)
      run out.writeU64(usize.toU64(b.length())) let mut i:usize=0
      while i<b.length() { run out.writeU64(u32.toU64(b.limbs()[i])) i=i+1 }
      run out.writeU64(flag(sameReference(v,original)))
    }
    ValueBits.Exception => ()
    _ => { trap() }
  }
}
unsafe effect fn convert(hooks:&mut Hooks,rt:*mut HeapHeader,table:&AtomTable,v:ValueBits,op:u8)->ValueBits
  ! OutOfMemoryError | StringLengthError | BigIntError | CoercionError ? &mut Allocator {
  if op==0 { return run unsafe coercion.toNumberFree(&mut hooks,rt,unsafe v.retained(),NumberHint.Number) }
  if op==1 { return run unsafe coercion.toNumberFree(&mut hooks,rt,unsafe v.retained(),NumberHint.Numeric) }
  if op==2 { return run unsafe coercion.toString(table,v) }
  if op==3 { return run unsafe coercion.toStringFree(&mut hooks,rt,table,unsafe v.retained()) }
  if op==4 { return run unsafe coercion.toPropertyKey(table,v) }
  return trap()
}
unsafe effect fn operate(out:&mut ByteBuffer,hooks:&mut Hooks,rt:*mut HeapHeader,table:&AtomTable,original:ValueBits,op:u8)->()
  ! OutOfMemoryError | StringLengthError | BigIntError ? &mut Allocator {
  let before=unsafe rc(original)
  let result=run Effect.result(unsafe convert(&mut hooks,rt,table,original,op))
  match move result {
    Result<ValueBits,OutOfMemoryError | StringLengthError | BigIntError | CoercionError>.Success { value:v } => {
      run out.writeU64(0) run describe(&mut out,v,original) unsafe gc.release(&mut hooks,rt,v)
    }
    Result<ValueBits,OutOfMemoryError | StringLengthError | BigIntError | CoercionError>.Failure { error } => {
      match move error {
        CoercionError diagnostic => {
          run out.writeU64(1) let message=diagnostic.message() run out.writeU64(usize.toU64(message.length))
          let mut i:usize=0 while i<message.length { run out.writeU64(u32.toU64(u8.toU32(message[i]))) i=i+1 }
        }
        OutOfMemoryError allocation => { fail move allocation }
        StringLengthError length => { fail move length }
        BigIntError integer => { fail move integer }
      }
    }
  }
  run out.writeU64(bits(i32.toI64(unsafe rc(original)-before)))
  if original.isString() { run text(&mut out,original) }
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | BigIntError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let mut table=run AtomTable.make()
  let rt=run runtime.allocateRuntimeStorage(2097152) let realm=run unsafe runtime.allocateContextStorage(rt)
  let mut hooks=Hooks {} let mut pool=List<ValueBits>.make() let size=input.word() let mut i:u32=0
  while i<size {
    let next=run value(&mut input,&pool,&mut table,realm)
    if next.isObject() { trap() }
    if next.tag()==-2 || next.tag()==-3 {
      match next.heapReference() { Option<*mut HeapHeader>.Some { value:node } => { unsafe gc.publish(rt,node) } _ => { trap() } }
    }
    run pool.append(next) i=i+1
  }
  let count=input.word() let mut header=ByteBuffer.make() run header.writeU32(count+1) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut length=ByteBuffer.make() i=0
  while i<count {
    let op=input.byte() let index=u32.toUsize(input.word())
    out.clear() length.clear() run unsafe operate(&mut out,&mut hooks,rt,&table,pool.get(index),op)
    run length.writeU32(usize.toU32(out.length()/8)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
  if input.at!=input.data.length { trap() }
  let mut remaining=pool.length()
  while remaining!=0 { remaining=remaining-1 unsafe gc.release(&mut hooks,rt,pool.get(remaining)) }
  pool.clear() unsafe gc.releaseHeader(&mut hooks,rt,realm) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | BigIntError | WriterError {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut memory) |> Effect.provideMut<Writer>(&mut writer)
  if observer.stats().allocationCount!=0 || observer.stats().usedBytes!=0 { trap() }
  let mut allocator=Allocator.systemAllocatorProvider() let mut footer=ByteBuffer.make()
  run footer.writeU32(2) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU64(usize.toU64(observer.stats().allocationCount)) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU64(usize.toU64(observer.stats().usedBytes)) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(footer.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''

@dataclass(frozen=True)
class Case:
    op: int
    label: str
    index: int

    def wire(self):
        return bytes((self.op,)) + u32(self.index)


def fixtures(seed, random_cases):
    pool = []

    def add(label, kind, payload=b''):
        pool.append((label, bytes((kind,)) + payload))
        return len(pool) - 1

    def latin(text):
        return add(repr(text), 9, u32(len(text)) + text)

    def utf16(units):
        return add('utf16:' + repr(units[:20]), 10, u32(len(units)) + b''.join(u32(n) for n in units))

    for n in (-2147483648, -1, 0, 1, 2147483647):
        add(f'int:{n}', 0, u32(n))
        add(f'catch:{n}', 6, u32(n))
        add(f'short-bigint:{n}', 8, u32(n))
    for kind in (3, 4, 5, 7, 13, 16, 17):
        add(f'tag:{kind}', kind)
    add('false', 2, b'\0')
    add('true', 2, b'\1')
    for n in (0, 1, -1, 2147483648, -2147483649, 9007199254740993, 10**100, -(10**100), 2**1024 + 1):
        limbs = signed_limbs(n)
        index = add(f'heap-bigint:{n}', 14, u32(len(limbs)) + b''.join(u32(v) for v in limbs))
        add(f'alias:{index}', 15, u32(index))
    # Every binary exponent and both signs, plus independent seeded raw IEEE bits.
    for bits in number_corpus(seed, random_cases):
        add(f'float:{bits:016x}', 1, wide(bits))
    syntax = [b'', b' ', b'\t\r\n\v\f', b'0', b'-0', b'+0', b'077', b'08', b'09',
              b'.5', b'-.5', b'1.', b'1.e2', b'1e', b'1e+', b'1e-', b'1e+  ', b'.', b'+', b'-',
              b'Infinity', b'-Infinity', b'+Infinity', b'infinity', b'Inf', b'NaN', b'-NaN',
              b'0x', b'0b', b'0o', b'0x10', b'0XfF', b'0b101', b'0B101', b'0o777', b'0O77',
              b'+0x10', b'-0x10', b'+0b1', b'-0o1', b'0x1.8', b'0x1p4', b'0b1e2', b'0o8',
              b'1_0', b'0x1_f', b'0_1', b'1n', b'1.0n', b'1e2n', b'0x1n',
              b'\0', b'0\0', b'1\0 ', b'\0 1', b'1 2', b'1e9999999999999999999999999999',
              b'-1e-999999999999999999999999999', b'0e9999999999999999999999',
              b'2.4703282292062327e-324', b'2.4703282292062328e-324',
              b'2.2250738585072012e-308', b'2.2250738585072013e-308',
              b'1.7976931348623157e308', b'1.7976931348623158e308', b'1.7976931348623159e308',
              b'9007199254740993', b'9007199254740995', b'0x20000000000001', b'0x20000000000003']
    for text in syntax:
        latin(text)
        utf16(list(text))
    for whitespace in (9, 10, 11, 12, 13, 32, 0xa0, 0x1680, *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff):
        utf16([whitespace, 45, 48, whitespace])
    for nonspace in (0, 0x85, 0x180e, 0x200b, 0xd800, 0xdc00, 0xffff):
        utf16([nonspace, 49])
        utf16([49, nonspace])
    for radix, prefix in ((2, b'0b'), (8, b'0o'), (16, b'0x')):
        for exponent in (31, 32, 52, 53, 54, 63, 64, 127, 1023, 1024, 1100):
            for delta in (-1, 0, 1, 3):
                n = (1 << exponent) + delta
                digits = {2: lambda: bin(n)[2:], 8: lambda: oct(n)[2:], 16: lambda: hex(n)[2:]}[radix]()
                latin(prefix + digits.encode())
    rng = random.Random(seed)
    for _ in range(random_cases):
        digits = ''.join(str(rng.randrange(10)) for _ in range(rng.randrange(1, 150)))
        split = rng.randrange(len(digits) + 1)
        text = rng.choice(('', '+', '-')) + digits[:split] + '.' + digits[split:] + 'e' + str(rng.randrange(-500, 500))
        latin(text.encode())
    for left, right in ((b'  -0', [0x2007] * 513), (b'0x', list(b'20000000000001')), (b'1e', list(b'+2')), (b'1', [0, 32]), (b'9' * 1024, [32] * 513)):
        a, b = latin(left), utf16(right)
        rope = add('rope:' + repr(left[:20]), 11, u32(a) + u32(b))
        add(f'rope-alias:{rope}', 15, u32(rope))
    cases = [Case(op, f'{name} operation={op}', index) for index, (name, _) in enumerate(pool) for op in range(5)]
    return pool, cases


def records(data, cases, owner):
    """Decode self-delimiting records without deriving fixtures from either output."""
    at = 0

    def take(n):
        nonlocal at
        if n > len(data) - at:
            raise SystemExit(f'{owner}: truncated record at byte {at}')
        result = data[at:at+n]
        at += n
        return result

    count, = struct.unpack('<I', take(4))
    if count != len(cases):
        raise SystemExit(f'{owner}: {count} records, expected {len(cases)}')
    output = []
    for case in cases:
        length, = struct.unpack('<I', take(4))
        if length < 2 or length > 65536:
            raise SystemExit(f'{owner}: invalid field count {length}: {case.label}')
        output.append(struct.unpack(f'<{length}Q', take(length * 8)))
    if at != len(data):
        raise SystemExit(f'{owner}: trailing output at byte {at}')
    return output


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('upstream', type=Path)
    ap.add_argument('--silk', default=str(toolchain.compiler_path()))
    ap.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    ap.add_argument('--cc', default='cc')
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--random-cases', type=int, default=512)
    ap.add_argument('--seed', type=lambda n: int(n, 0), default=0x434f4552)
    args = ap.parse_args()
    if args.timeout <= 0 or args.random_cases < 0:
        ap.error('timeout must be positive and random-cases nonnegative')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
    pool, operations = fixtures(args.seed, args.random_cases)
    cases = operations + [Case(5, 'post-teardown allocation ledger', 0)]
    data = u32(len(pool)) + b''.join(v for _, v in pool) + u32(len(operations)) + b''.join(c.wire() for c in operations)
    print(f'Pins={pins}; values={len(pool)}; operations={len(operations)}; seed={args.seed:#x}', flush=True)
    with tempfile.TemporaryDirectory(prefix='silkjs-primitive-coercions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], args.timeout, owner='C coercion build')
        expected_bytes = process([str(temp / 'oracle')], args.timeout, owner='C coercion oracle', data=data)
        expected = records(expected_bytes, cases, 'C coercion oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'silk.toml').write_text(f'[package]\nname="primitive-coercion-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        literal = 'b"' + ''.join(f'\\x{b:02x}' for b in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        command = [silk, 'run', '--quiet', '--release']
        if stdlib:
            command += ['--stdlib', str(stdlib)]
        actual_bytes = process(command, args.timeout, owner='native coercion oracle', cwd=temp)
        actual = records(actual_bytes, cases, 'native coercion oracle')
        failures = 0
        for index, (case, want, got) in enumerate(zip(cases, expected, actual, strict=True)):
            if want == got:
                continue
            failures += 1
            if failures <= 20:
                print(f'MISMATCH {index}: {case.label}\n  C={want}\n  native={got}')
        print(f'Input SHA256={hashlib.sha256(data).hexdigest()}')
        print(f'C SHA256={hashlib.sha256(expected_bytes).hexdigest()}; native SHA256={hashlib.sha256(actual_bytes).hexdigest()}')
        if failures:
            raise SystemExit(f'FAIL: {failures} records differ')
        print(f'PASS: {len(operations)} original-C/native coercions and both post-teardown ledgers')


if __name__ == '__main__':
    main()
