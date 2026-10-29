#!/usr/bin/env python3
"""Native/C BigInt value-boundary differential, never linked together.

Exercises genuine short and forced heap-small values, signed/unsigned constructors,
complete strings, strict/constructor coercion, native getters/callable closures,
mutation and thrown values, mod64/Ext and saturated/checked128 failure halves.
Records include exact tags/limbs, errors, callback/finalizer order and reference
counts. Both processes independently require zero allocation and byte ledgers.

python3 scripts/verify_bigint_coercions.py QUICKJS
"""
import argparse
import hashlib
import math
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
TEXTS = ['', ' \t\r\n', '-0', '+42', '00017', '-2147483649', '0xff', '0B101',
         '0o777', '-0x1', '+0b1', '1n', '1_0', '1.0', '1e2', 'Infinity',
         'NaN', '7\0x', '\0', '\ufeff\u202842\u2007', '\u180e1', '0x', '0o8',
         '18446744073709551617', '170141183460469231731687303715884105728',
         '-170141183460469231731687303715884105729']
HEAPS = ['0', '1', '-1', '2147483647', '-2147483648', '2147483648', '-2147483649',
         '9223372036854775807', '9223372036854775808', '-9223372036854775809',
         '18446744073709551615', '18446744073709551616',
         '170141183460469231731687303715884105727', '-170141183460469231731687303715884105728',
         '170141183460469231731687303715884105728', '-170141183460469231731687303715884105729',
         str(2**256 + 123), str(-(2**256) - 123)]
BITS = [0, 1, 0x8000000000000000, 0x7ff0000000000000, 0xfff0000000000000,
        0x7ff8000000000000, 0xfff8000000000042]
for number in (0.5, 1.5, 2.0, 2**31-1, 2**31, 2**32, 2**53, 2**63, 2**64, 2**127, 2**128, 1.7976931348623157e308):
    for adjacent in (math.nextafter(float(number), -math.inf), float(number), math.nextafter(float(number), math.inf)):
        for sign in (1, -1):
            BITS.append(struct.unpack('<Q', struct.pack('<d', sign * adjacent))[0])
BITS = list(dict.fromkeys(BITS))
KINDS = len(TEXTS) + len(HEAPS) + len(BITS) + 12
OPERATIONS = 14
FAMILIES = 10
COUNT = KINDS * OPERATIONS * FAMILIES

# These are the same real registered host classes used by the integer oracle.
# Reuse its embedding, not its conversions or expected results. The explicit
# boundaries keep this harness independent of its case count and numeric model.
from verify_integer_coercions import C_SOURCE as INTEGER_C
import toolchain
C_EMBEDDING = INTEGER_C.partition('static const uint64_t bits[]')[0]

C_SOURCE = C_EMBEDDING + r'''
static JSValue leaf(JSContext*ctx,int kind){
 @C_LEAVES@
 abort();
}
static const uint64_t seeds[]={0,1,UINT64_MAX,INT32_MAX,UINT64_C(0xffffffff80000000),UINT64_C(2147483648),UINT64_C(0xffffffff7fffffff),INT64_MAX,UINT64_C(0x8000000000000000),UINT64_C(0x100000000),UINT64_C(0x123456789abcdef0)};
static void value(JSValue v){
 int tag=JS_VALUE_GET_NORM_TAG(v);emit(tag);
 if(tag==JS_TAG_SHORT_BIG_INT){emit(1);emit(JS_VALUE_GET_SHORT_BIG_INT(v));}
 else if(tag==JS_TAG_BIG_INT){JSBigInt*p=JS_VALUE_GET_PTR(v);emit(p->len);for(int i=0;i<p->len;i++)emit(p->tab[i]);}
 else if(tag==JS_TAG_FLOAT64){wide(number(JS_VALUE_GET_FLOAT64(v)));}
}
static void run_case(JSContext*ctx,int family,int kind,int op){
 event_count=finalized_count=0;JSValue first=leaf(ctx,kind),second=kind%2?JS_NewInt32(ctx,7):JS_DupValue(ctx,first);
 int first_root=rc(first),second_root=rc(second);
 JSValue input=make(ctx,family,first,second),result=JS_EXCEPTION;
 int input_before=rc(input),first_before=rc(first),second_before=rc(second);
 uint64_t lo=91,hi=92;int64_t signed_out=93;int r=0;
 uint64_t seed=seeds[kind%(sizeof(seeds)/sizeof(*seeds))],high=kind%3==0?-(seed>>63):kind%3==1?0:seed;
 switch(op){
 case 0:result=JS_ToBigInt(ctx,input);break;
 case 1:result=JS_ToBigIntFree(ctx,JS_DupValue(ctx,input));break;
 case 2:result=JS_ToBigIntCtorFree(ctx,JS_DupValue(ctx,input));break;
 case 3:r=JS_ToBigInt64(ctx,&signed_out,input);lo=signed_out;break;
 case 4:r=JS_ToBigInt64Free(ctx,&signed_out,JS_DupValue(ctx,input));lo=signed_out;break;
 case 5:r=JS_ToBigInt128Sat(ctx,&lo,&hi,input);break;
 case 6:r=JS_ToBigInt128SatFree(ctx,&lo,&hi,JS_DupValue(ctx,input));break;
 case 7:r=JS_ToBigInt128(ctx,&lo,&hi,input);break;
 case 8:r=JS_ToInt64Ext(ctx,&signed_out,input);lo=signed_out;break;
 case 9:result=JS_IsString(input)?JS_StringToBigInt(ctx,JS_DupValue(ctx,input)):JS_ToBigInt(ctx,input);break;
 case 10:result=JS_IsString(input)?JS_StringToBigIntErr(ctx,JS_DupValue(ctx,input)):JS_ToBigInt(ctx,input);break;
 case 11:result=JS_NewBigInt64(ctx,(int64_t)seed);break;
 case 12:result=JS_NewBigUint64(ctx,seed);break;
 case 13:result=JS_NewBigInt128(ctx,seed,high);break;
 default:abort();}
 if(op<3||op>=9)r=JS_IsException(result)?-1:0;
 emit(r<0);emit(r<0?0:r);wide(lo);wide(hi);value(result);
 emit(JS_VALUE_HAS_REF_COUNT(result)&&JS_VALUE_HAS_REF_COUNT(input)&&JS_VALUE_GET_PTR(result)==JS_VALUE_GET_PTR(input));
 if(r<0){JSValue pending=JS_GetException(ctx);if(JS_IsObject(pending)){
  JSValue proto=checked(JS_GetPrototype(ctx,pending));int kind=JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_RANGE_ERROR])?1:JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR])?2:JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_SYNTAX_ERROR])?4:0;if(!kind)abort();emit(kind);JS_FreeValue(ctx,proto);
  JSValue message=checked(JS_GetPropertyStr(ctx,pending,"message"));text(message);JS_FreeValue(ctx,message);
 }else{emit(3);emit(JS_SameValue(ctx,pending,first));emit(JS_SameValue(ctx,pending,second));}JS_FreeValue(ctx,pending);}
 emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
 emit(rc(input)-input_before);emit(rc(first)-first_before);emit(rc(second)-second_before);
 JS_FreeValue(ctx,result);JS_FreeValue(ctx,input);emit(rc(first)-first_root);emit(rc(second)-second_root);
 emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);flush();
}
int main(void){JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();word(@COUNT@);
 for(int family=0;family<10;family++)for(int kind=0;kind<@KINDS@;kind++)for(int op=0;op<14;op++)run_case(ctx,family,kind,op);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.core.result { Result }
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.num.u16
import silk.num.u32
import silk.num.u64
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState }
import js_value { ValueBits }
import js_runtime as runtime
import js_gc as gc
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_bigint { BigInt, BigIntError }
import js_bigint_coercions as bigint
import js_bigint_coercions_test_support as support
import js_primitives as primitive
import js_primitives { EqualityMode }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_coercion_host { CoercionHooks }
import js_coercions_test_support as fixture
import js_coercions_test_support { Hooks }
import js_integer_coercions_test_support as transitions
import js_atom_data as atoms
import js_array_storage_test_support { trap }
unsafe fn rc(value: ValueBits) -> i32 {
  match value.heapReference() {
    Option<*mut HeapHeader>.None => { return 0 }
    Option<*mut HeapHeader>.Some { value: node } => {
      let anchor = () let header = unsafe Pointer.borrow<(), HeapHeader>(&anchor, node)
      return header.referenceCount
    }
  }
}
fn signed(value: i32) -> u32 {
  if value < 0 { return i32.toU32(-(value + 1)) ^ 0xffffffff }
  return i32.toU32(value)
}
fn signedWide(value: i64) -> u64 {
  if value < 0 { return i64.toU64(-(value + 1)) ^ 0xffffffffffffffff }
  return i64.toU64(value)
}
fn fromBits(value: u64) -> i64 {
  if (value & 0x8000000000000000) != 0 { return -1 - u64.toI64(value ^ 0xffffffffffffffff) }
  return u64.toI64(value)
}
effect fn wide(out: &mut ByteBuffer, value: u64) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(u64.toU32(value & 0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(value, 32)))
}
effect fn text(out: &mut ByteBuffer, value: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i: usize = 0
  while i < Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value, i))) i = i + 1 }
}
unsafe effect fn leaf(rt: *mut HeapHeader, kind: u32) -> ValueBits
  ! OutOfMemoryError | StringLengthError | BigIntError ? &mut Allocator {
 @SILK_LEAVES@
 return trap()
}
unsafe effect fn value(out: &mut ByteBuffer, input: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(signed(input.tag()))
  match input {
    ValueBits.ShortBigInt { value: small } => { run out.writeU32(1) run out.writeU32(signed(small)) }
    ValueBits.BigInt { reference: node } => {
      let anchor = () let big = unsafe HeapCell.payload<BigInt, ()>(&anchor, node)
      run out.writeU32(usize.toU32(big.length())) let mut i: usize = 0
      while i < big.length() { run out.writeU32(big.limb(i)) i = i + 1 }
    }
    ValueBits.Float64 { value: number } => {
      let mut bits = f64.toBits(number)
      if f64.isNaN(number) { bits = 0x7ff8000000000000 }
      run wide(&mut out, bits)
    }
    _ => ()
  }
}
struct Outputs { low: u64, high: u64, signedValue: i64, flag: i32, result: ValueBits }
unsafe effect fn convert(hooks: &mut Hooks, ctx: *mut HeapHeader, input: ValueBits,
  op: u32, kind: u32, out: &mut Outputs) -> ()
  ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  let seeds: [u64; 11] = [0,1,0xffffffffffffffff,2147483647,0xffffffff80000000,2147483648,0xffffffff7fffffff,0x7fffffffffffffff,0x8000000000000000,0x100000000,0x123456789abcdef0]
  let seed = seeds[u32.toUsize(kind % 11)] let mut high = seed
  if kind % 3 == 0 { high = 0 if (seed & 0x8000000000000000) != 0 { high = 0xffffffffffffffff } }
  else if kind % 3 == 1 { high = 0 }
  if op == 0 { out.result = run unsafe bigint.toBigInt(&mut hooks, ctx, input) }
  else if op == 1 { out.result = run unsafe bigint.toBigIntFree(&mut hooks, ctx, unsafe input.retained()) }
  else if op == 2 { out.result = run unsafe bigint.toBigIntCtorFree(&mut hooks, ctx, unsafe input.retained()) }
  else if op == 3 { run unsafe bigint.toBigInt64(&mut hooks, ctx, &mut out.signedValue, input) }
  else if op == 4 { run unsafe bigint.toBigInt64Free(&mut hooks, ctx, &mut out.signedValue, unsafe input.retained()) }
  else if op == 5 { out.flag = run unsafe bigint.toBigInt128Sat(&mut hooks, ctx, &mut out.low, &mut out.high, input) }
  else if op == 6 { out.flag = run unsafe bigint.toBigInt128SatFree(&mut hooks, ctx, &mut out.low, &mut out.high, unsafe input.retained()) }
  else if op == 7 { run unsafe bigint.toBigInt128(&mut hooks, ctx, &mut out.low, &mut out.high, input) }
  else if op == 8 { run unsafe bigint.toInt64Ext(&mut hooks, ctx, &mut out.signedValue, input) }
  else if op == 9 && input.isString() { out.result = run unsafe bigint.stringToBigInt(&mut hooks, ctx, unsafe input.retained()) }
  else if op == 10 && input.isString() { out.result = run unsafe bigint.stringToBigIntErr(&mut hooks, ctx, unsafe input.retained()) }
  else if op == 9 || op == 10 { out.result = run unsafe bigint.toBigInt(&mut hooks, ctx, input) }
  else if op == 11 { out.result = run bigint.newBigInt64(fromBits(seed)) }
  else if op == 12 { out.result = run bigint.newBigUint64(seed) }
  else if op == 13 { out.result = run bigint.newBigInt128(seed, high) }
  else { trap() }
}
unsafe effect fn runCase(out: &mut ByteBuffer, hooks: &mut Hooks, memory: &AllocationObserver,
  ctx: *mut HeapHeader, family: u32, kind: u32, op: u32) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx) hooks.clear()
  let first = run unsafe leaf(rt, kind) let mut second = ValueBits.Int { value: 7 }
  if (kind & 1) == 0 { second = unsafe first.retained() }
  let firstRoot = unsafe rc(first) let secondRoot = unsafe rc(second)
  let input = run unsafe transitions.make(&mut hooks, memory, ctx, family, first, second)
  let inputBefore = unsafe rc(input) let firstBefore = unsafe rc(first) let secondBefore = unsafe rc(second)
  let mut outputs = Outputs { low: 91, high: 92, signedValue: 93, flag: 0, result: ValueBits.Exception }
  let outcome = run Effect.result(unsafe convert(&mut hooks, ctx, input, op, kind, &mut outputs))
  let mut failed: u32 = 0
  match &outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { .. } => { failed = 1 }
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
  }
  if op == 3 || op == 4 || op == 8 { outputs.low = signedWide(outputs.signedValue) }
  run out.writeU32(failed) run out.writeU32(signed(outputs.flag))
  run wide(&mut out, outputs.low) run wide(&mut out, outputs.high) run unsafe value(&mut out, outputs.result)
  let mut identical: u32 = 0
  if outputs.result.tag() < 0 && input.tag() < 0 {
    if Pointer.address(support.heapReference(outputs.result)) == Pointer.address(support.heapReference(input)) { identical = 1 }
  }
  run out.writeU32(identical)
  match move outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { error } => match move error {
      JsException signal => {
        let pending = unsafe exceptions.take(rt)
        if pending.isObject() {
          let errorKind = unsafe support.errorKind(ctx, pending)
          if errorKind == 0 { trap() }
          run out.writeU32(errorKind)
          let message = StringOwner.adopt(run unsafe hooks.getProperty(ctx, pending, atoms.JS_ATOM_message))
          run text(&mut out, message.get())
        } else {
          run out.writeU32(3) let mut sameFirst: u32 = 0 let mut sameSecond: u32 = 0
          if unsafe primitive.equal(pending, first, EqualityMode.SameValue) { sameFirst = 1 }
          if unsafe primitive.equal(pending, second, EqualityMode.SameValue) { sameSecond = 1 }
          run out.writeU32(sameFirst) run out.writeU32(sameSecond)
        }
        unsafe gc.release(&mut hooks, rt, pending)
      }
      OutOfMemoryError allocation => { fail move allocation }
      StringLengthError length => { fail move length }
    }
  }
  run out.writeU32(usize.toU32(hooks.eventCount)) let mut i: usize = 0
  while i < hooks.eventCount { run out.writeU32(hooks.events[i]) i = i + 1 }
  run out.writeU32(signed(unsafe rc(input) - inputBefore))
  run out.writeU32(signed(unsafe rc(first) - firstBefore)) run out.writeU32(signed(unsafe rc(second) - secondBefore))
  unsafe gc.release(&mut hooks, rt, outputs.result) unsafe gc.release(&mut hooks, rt, input)
  run out.writeU32(signed(unsafe rc(first) - firstRoot)) run out.writeU32(signed(unsafe rc(second) - secondRoot))
  run out.writeU32(usize.toU32(hooks.finalizedCount)) i = 0
  while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
  unsafe gc.release(&mut hooks, rt, first) unsafe gc.release(&mut hooks, rt, second)
}
effect fn probe(memory: &AllocationObserver) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError | WriterError ? &mut Allocator | &mut Writer {
  let rt = run runtime.allocateRuntimeStorage(0) let ctx = run unsafe runtime.allocateContextStorage(rt)
  run unsafe fixture.register(rt) let mut hooks = Hooks.make() hooks.collect = true
  run unsafe fixture.prepareErrors(&mut hooks, memory, ctx)
  let mut header = ByteBuffer.make() run header.writeU32(@COUNT@) run Writer.writeAll(header.asSlice())
  let mut out = ByteBuffer.make() let mut length = ByteBuffer.make() let mut family: u32 = 0
  while family < 10 {
    let mut kind: u32 = 0
    while kind < @KINDS@ {
      let mut op: u32 = 0
      while op < 14 {
        out.clear() length.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, family, kind, op)
        run length.writeU32(usize.toU32(out.length() / 4)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice())
        op = op + 1
      }
      kind = kind + 1
    }
    family = family + 1
  }
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt)
}
pub effect fn main() -> i32
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError | WriterError {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let mut writer = StdoutWriter.make()
  run probe(&observer) |> Effect.provideMut<Allocator>(&mut memory) |> Effect.provideMut<Writer>(&mut writer)
  if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
  let mut allocator = Allocator.systemAllocatorProvider() let mut footer = ByteBuffer.make()
  run footer.writeU32(2) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU32(usize.toU32(observer.stats().allocationCount)) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU32(usize.toU32(observer.stats().usedBytes)) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(footer.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def leaves():
    c, silk = [], []
    def add(c_expression, silk_expression):
        index = len(c)
        c.append(f'if(kind=={index}){{{c_expression}}}')
        silk.append(f'if kind == {index} {{ {silk_expression} }}')
    for text in TEXTS:
        data = text.encode('utf-8')
        escaped = ''.join(f'\\x{byte:02x}' for byte in data)
        native = f'return run Strings.fromUtf8(b"{escaped}")'
        if not data:
            # JS_NewStringLen("") returns the runtime's cached atom. Distinct
            # literal constructions must alias, not merely have equal contents.
            native = ('let anchor = () let state = unsafe HeapCell.payload<RuntimeState, ()>(&anchor, rt) '
                      'return state.atoms.emptyString()')
        add(f'return checked(JS_NewStringLen(ctx,"{escaped}",{len(data)}));', native)
    for text in HEAPS:
        # js_atof may compact; deliberately force a heap header for short values.
        add(f'JSValue v=checked(JS_StringToBigIntErr(ctx,JS_NewString(ctx,"{text}")));'
            'if(JS_VALUE_GET_TAG(v)==JS_TAG_SHORT_BIG_INT){JSBigInt*p=js_bigint_new_si64(ctx,JS_VALUE_GET_SHORT_BIG_INT(v));if(!p)abort();return JS_MKPTR(JS_TAG_BIG_INT,p);}return v;',
            f'return run support.heapInteger(b"{text}")')
    for bits in BITS:
        add(f'JSFloat64Union u={{.u64=UINT64_C(0x{bits:016x})}};return __JS_NewFloat64(ctx,u.d);',
            f'return ValueBits.Float64 {{ value: f64.fromBits(0x{bits:016x}) }}')
    for c_value, silk_value in [('JS_UNDEFINED', 'ValueBits.Undefined'), ('JS_NULL', 'ValueBits.Null'),
                               ('JS_FALSE', 'ValueBits.Bool { value: false }'), ('JS_TRUE', 'ValueBits.Bool { value: true }'),
                               ('JS_NewInt32(ctx,0)', 'ValueBits.Int { value: 0 }'),
                               ('JS_NewInt32(ctx,INT32_MIN)', 'ValueBits.Int { value: -2147483647 - 1 }'),
                               ('JS_NewInt32(ctx,INT32_MAX)', 'ValueBits.Int { value: 2147483647 }'),
                               ('JS_NewBigInt64(ctx,-1)', 'ValueBits.ShortBigInt { value: -1 }'),
                               ('JS_NewBigInt64(ctx,INT32_MAX)', 'ValueBits.ShortBigInt { value: 2147483647 }')]:
        add(f'return {c_value};', f'return {silk_value}')
    add('return checked(JS_NewSymbol(ctx,"bigint-symbol",FALSE));',
        'let description = StringOwner.adopt(run Strings.fromLatin1(b"bigint-symbol")) '
        'let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt) '
        'return run state.atoms.uniqueSymbol(Option<ValueBits>.some(description.get()))')
    for prefix in ('42', '42n'):
        add('char pad[513];memset(pad,32,sizeof(pad));'
            f'return checked(JS_ConcatString(ctx,JS_NewString(ctx,"{prefix}"),JS_NewStringLen(ctx,pad,sizeof(pad))));',
            'let pad: [u8; 513] = [32; 513] '
            f'let left = StringOwner.adopt(run Strings.fromLatin1(b"{prefix}")) '
            'let right = StringOwner.adopt(run Strings.fromLatin1(&pad)) '
            'return run Strings.concat(left.get(), right.get())')
    if len(c) != KINDS:
        raise ValueError('BigInt corpus count mismatch')
    return '\n'.join(c), '\n'.join(silk)


def records(data):
    if len(data) < 4:
        raise SystemExit('Empty BigInt oracle output')
    count, = struct.unpack_from('<I', data)
    if count != COUNT:
        raise SystemExit(f'Wrong BigInt record count: {count}, expected {COUNT}')
    offset, result = 4, []
    for _ in range(count + 1):
        if offset + 4 > len(data):
            raise SystemExit('Truncated BigInt record header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated BigInt record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if offset != len(data) or result[-1] != (0, 0):
        raise SystemExit('Nonzero BigInt teardown ledger or trailing bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_leaves, silk_leaves = leaves()
    replacements = {'@COUNT@': str(COUNT), '@KINDS@': str(KINDS), '@C_LEAVES@': c_leaves, '@SILK_LEAVES@': silk_leaves}
    c_source, silk_source = C_SOURCE, SILK_SOURCE
    for token, replacement in replacements.items():
        c_source, silk_source = c_source.replace(token, replacement), silk_source.replace(token, replacement)
    with tempfile.TemporaryDirectory(prefix='silkjs-bigint-coercions-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='BigInt coercions C compilation')
        expected = process([str(temp / 'oracle')], 1200, owner='BigInt coercions C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="bigint-coercions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native BigInt coercions oracle', cwd=temp)
        expected_records, actual_records = records(expected), records(actual)
        for index, (left, right) in enumerate(zip(expected_records, actual_records)):
            if left != right:
                label = 'teardown' if index == COUNT else f'family={index // (OPERATIONS * KINDS)}, kind={index // OPERATIONS % KINDS}, operation={index % OPERATIONS}'
                raise SystemExit(f'BigInt coercion mismatch {index} ({label}):\nC={left}\nSilk={right}')
        print(f'PASS BigInt coercions: {COUNT} operations, {KINDS} primitives, {FAMILIES} actual callback families; '
              f'exact tags/limbs/errors/partial outputs/owners and both zero ledgers; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
