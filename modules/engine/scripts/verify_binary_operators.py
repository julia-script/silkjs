#!/usr/bin/env python3
"""Compare pinned original-C binary slow paths with native consuming operators.

The unmodified QuickJS source runs twice: once with platform libm and once with
the separately pinned original OpenLibm e_pow.c. Native must match the latter
byte-for-byte; platform power contrasts additionally require independent bounded
mathematical evidence. All non-power fields and records remain byte exact.
Only its active left stack slot is inspected/freed after success: the popped right
slot is stale, not an owner. Native right is independently required to be Undefined.
Records preserve exact tags, Float64 bits (including NaNs), signed limbs, strings,
errors, callback/finalizer order and surviving reference counts. Zero-budget cases
exercise actual direct-malloc refusal, including immediate BigInt promotions.

python3 scripts/verify_binary_operators.py QUICKJS
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bigint_coercions import TEXTS, HEAPS, BITS, KINDS as BASE_KINDS, leaves
from verify_unary_operators import C_SOURCE as UNARY_C, SILK_SOURCE as UNARY_SILK
from verify_number_power import prepare_fdlibm, bounded_contrast, REVISION, SOURCE_SHA256
import toolchain

ROOT = Path(__file__).resolve().parents[1]
OPERATIONS = 12
FAMILIES = 10
# Reuse all unary primitive families except its intentionally oversized stored
# integer; binary size limits are reached by enormous shift/exponent operands.
EXTRAS = [(-2147483648, True), (0, True), (1, True), (2, True), (31, True),
          (32, True), (-32, True), (-1, False), (1, False), (2, False)]
FLAT_LENGTHS = [512, 513, 8192, 8193]
KINDS = BASE_KINDS + len(EXTRAS) + len(FLAT_LENGTHS)
HEAP_ZERO = len(TEXTS)
HEAP_ONE = HEAP_ZERO + 1
FLOAT_ZERO = len(TEXTS) + len(HEAPS)
INT_ZERO = BASE_KINDS - 8
SHORT_MINUS_ONE = BASE_KINDS - 5
SHORT_MAX = BASE_KINDS - 4
SHORT_MIN, SHORT_ZERO, SHORT_ONE, SHORT_TWO, SHORT_31, SHORT_32, SHORT_NEG32, INT_MINUS_ONE, INT_ONE, INT_TWO = range(BASE_KINDS, BASE_KINDS + len(EXTRAS))
FLAT_512, FLAT_513, FLAT_8192, FLAT_8193 = range(BASE_KINDS + len(EXTRAS), KINDS)
RIGHTS = [INT_ZERO, INT_MINUS_ONE, INT_TWO, FLOAT_ZERO + BITS.index(0x8000000000000000),
          FLOAT_ZERO + BITS.index(0x7ff0000000000000), SHORT_ZERO, SHORT_MINUS_ONE,
          SHORT_TWO, SHORT_31, SHORT_32, SHORT_NEG32, HEAP_ONE,
          0, 3, BASE_KINDS - 2, FLAT_512, FLAT_513]
CALLBACK_PAIRS = [(INT_TWO, INT_ONE), (HEAP_ONE, SHORT_TWO), (0, INT_TWO),
                  (HEAP_ONE, INT_TWO), (INT_TWO, HEAP_ONE)]
# op,left-kind,right-kind: every operation with a heap operand, then immediate
# promotions and string conversion/concatenation. No allocation-count equivalence
# is assumed beyond zero; native multi-budget cleanup is covered in the unit suite.
FAULT_ROWS = [(op, HEAP_ONE + 10, SHORT_TWO) for op in range(OPERATIONS)] + [
    (0, SHORT_MAX, SHORT_ONE), (1, SHORT_MIN, SHORT_ONE),
    (2, SHORT_MAX, SHORT_TWO), (3, SHORT_MIN, SHORT_MINUS_ONE),
    (4, SHORT_MIN, SHORT_MINUS_ONE), (5, SHORT_TWO, SHORT_32),
    (9, SHORT_MAX, SHORT_ONE), (10, SHORT_MAX, SHORT_MINUS_ONE),
    (0, 3, INT_TWO), (0, 3, HEAP_ONE)]
# Unique preallocated left: empty/short/8192/8193 boundaries, flat versus rope
# right, and exactly enough allocation budget for the final rope node only.
STRING_ROWS = [(0, FLAT_513, 0), (0, FLAT_513, 1), (1, FLAT_513, 1),
               (8192, 3, 0), (8193, 3, 1), (1, BASE_KINDS - 2, 1),
               (8193, BASE_KINDS - 2, 1), (0, BASE_KINDS - 2, 0), (8193, 0, 0)]
PRIMITIVE_COUNT = KINDS * len(RIGHTS) * OPERATIONS
REVERSED_COUNT = KINDS * OPERATIONS
CALLBACK_COUNT = FAMILIES * FAMILIES * len(CALLBACK_PAIRS) * OPERATIONS
ALIAS_COUNT = FAMILIES * len(CALLBACK_PAIRS) * OPERATIONS
COUNT = PRIMITIVE_COUNT + REVERSED_COUNT + CALLBACK_COUNT + ALIAS_COUNT + len(FAULT_ROWS) + len(STRING_ROWS)

# The embedding supplies registered callback classes and a tracked allocator only.
C_SOURCE = UNARY_C.partition('static JSValue leaf')[0].replace(
    'static void text(JSValue v){JSString*s=JS_VALUE_GET_STRING(v);emit(s->len);for(int i=0;i<s->len;i++)emit(string_get(s,i));}',
    'static void text(JSValue v){unsigned n=JS_VALUE_GET_TAG(v)==JS_TAG_STRING?JS_VALUE_GET_STRING(v)->len:JS_VALUE_GET_STRING_ROPE(v)->len;emit(n);for(unsigned i=0;i<n;i++)emit(string_rope_get(v,i));}'
).replace(
    'if(s->len!=6)abort();for(int i=0;i<6;i++)if(string_get(s,i)!="number"[i])abort();events[event_count++]=1001;',
    'if(s->len==7){for(int i=0;i<7;i++)if(string_get(s,i)!="default"[i])abort();events[event_count++]=1000;}else{if(s->len!=6)abort();for(int i=0;i<6;i++)if(string_get(s,i)!="number"[i])abort();events[event_count++]=1001;}'
) + r'''
static JSValue leaf(JSContext*ctx,int kind){ @C_LEAVES@ abort(); }
static void value(JSValue v){
 int tag=JS_VALUE_GET_NORM_TAG(v);emit(tag);
 if(tag==JS_TAG_INT)emit(JS_VALUE_GET_INT(v));
 else if(tag==JS_TAG_SHORT_BIG_INT){emit(1);emit(JS_VALUE_GET_SHORT_BIG_INT(v));}
 else if(tag==JS_TAG_BIG_INT){JSBigInt*p=JS_VALUE_GET_PTR(v);emit(p->len);for(int i=0;i<p->len;i++)emit(p->tab[i]);}
 else if(tag==JS_TAG_FLOAT64)wide(float64_as_uint64(JS_VALUE_GET_FLOAT64(v)));
 else if(JS_IsString(v))text(v);
}
static int apply(JSContext*ctx,JSValue*slots,int op){
 static const OPCodeEnum arithmetic[]={OP_sub,OP_mul,OP_div,OP_mod,OP_pow};
 static const OPCodeEnum logic[]={OP_and,OP_or,OP_xor,OP_shl,OP_sar};
 if(op==0)return js_add_slow(ctx,slots+2);
 if(op<6)return js_binary_arith_slow(ctx,slots+2,arithmetic[op-1]);
 if(op<11)return js_binary_logic_slow(ctx,slots+2,logic[op-6]);
 return js_shr_slow(ctx,slots+2);
}
static void run_case(JSContext*ctx,int lf,int rf,int lk,int rk,int op,int alias){
 event_count=finalized_count=0;
 JSValue first=leaf(ctx,lk),second=leaf(ctx,rk);
 int first_root=rc(first),second_root=rc(second);
 JSValue a=make(ctx,lf,first,second),b=alias?JS_DupValue(ctx,a):make(ctx,rf,second,first);
 int a_before=rc(a),b_before=rc(b),first_before=rc(first),second_before=rc(second);
 JSValue slots[2]={JS_DupValue(ctx,a),JS_DupValue(ctx,b)};
 int r=apply(ctx,slots,op);emit(r<0);value(slots[0]);
 // Success pops right without clearing its stale bits. Do not inspect or free it.
 if(r<0&&JS_VALUE_GET_TAG(slots[1])!=JS_TAG_UNDEFINED)abort();
 if(r<0){JSValue pending=JS_GetException(ctx);if(JS_IsObject(pending)){
  JSValue proto=checked(JS_GetPrototype(ctx,pending));int kind=JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_RANGE_ERROR])?1:JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR])?2:0;if(!kind)abort();emit(kind);JS_FreeValue(ctx,proto);
  JSValue message=checked(JS_GetPropertyStr(ctx,pending,"message"));text(message);JS_FreeValue(ctx,message);
 }else{emit(3);emit(JS_SameValue(ctx,pending,first));emit(JS_SameValue(ctx,pending,second));}JS_FreeValue(ctx,pending);}
 emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
 emit(rc(a)-a_before);emit(rc(b)-b_before);emit(rc(first)-first_before);emit(rc(second)-second_before);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,a);JS_FreeValue(ctx,b);
 emit(rc(first)-first_root);emit(rc(second)-second_root);
 emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);
 JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);flush();
}
static void fault_case(JSContext*ctx,int op,int lk,int rk){
 JSValue a=leaf(ctx,lk),b=leaf(ctx,rk);
 JSValue slots[2]={JS_DupValue(ctx,a),JS_DupValue(ctx,b)};
 allocation_budget=0;int r=apply(ctx,slots,op);allocation_budget=-1;
 if(r>=0)abort();emit(1);value(slots[0]);
 if(JS_VALUE_GET_TAG(slots[1])!=JS_TAG_UNDEFINED)abort();
 emit(rc(a));emit(rc(b));JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,a);JS_FreeValue(ctx,b);flush();
}
static void string_case(JSContext*ctx,int len,int rk,int budget){
 JSString*p=js_alloc_string(ctx,len+1024,0);if(!p)abort();p->len=len;memset(p->u.str8,120,len);p->u.str8[len]=0;
 uintptr_t before=(uintptr_t)p;JSValue slots[2]={JS_MKPTR(JS_TAG_STRING,p),leaf(ctx,rk)};
 allocation_budget=budget;int r=apply(ctx,slots,0);allocation_budget=-1;
 emit(r<0);value(slots[0]);int same=0,head=0;
 if(r<0){if(JS_VALUE_GET_TAG(slots[1])!=JS_TAG_UNDEFINED)abort();JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);}
 else{same=(uintptr_t)JS_VALUE_GET_PTR(slots[0])==before;if(JS_VALUE_GET_TAG(slots[0])==JS_TAG_STRING_ROPE){JSStringRope*rope=JS_VALUE_GET_STRING_ROPE(slots[0]);head=(uintptr_t)JS_VALUE_GET_PTR(rope->left)==before;}}
 emit(same);emit(head);JS_FreeValue(ctx,slots[0]);flush();
}
int main(void){JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();word(@COUNT@);
 const int rights[]={@RIGHTS@};const int pairs[][2]={@PAIRS@};const int faults[][3]={@FAULTS@};
 const int strings[][3]={@STRINGS@};
 for(int k=0;k<@KINDS@;k++)for(unsigned r=0;r<sizeof(rights)/sizeof(*rights);r++)for(int op=0;op<12;op++)run_case(ctx,0,0,k,rights[r],op,0);
 for(int k=0;k<@KINDS@;k++)for(int op=0;op<12;op++)run_case(ctx,0,0,SHORT_TWO,k,op,0);
 for(int lf=0;lf<10;lf++){
  for(int rf=0;rf<10;rf++)for(unsigned p=0;p<sizeof(pairs)/sizeof(*pairs);p++)for(int op=0;op<12;op++)run_case(ctx,lf,rf,pairs[p][0],pairs[p][1],op,0);
  for(unsigned p=0;p<sizeof(pairs)/sizeof(*pairs);p++)for(int op=0;op<12;op++)run_case(ctx,lf,lf,pairs[p][0],pairs[p][1],op,1);
 }
 for(unsigned i=0;i<sizeof(faults)/sizeof(*faults);i++)fault_case(ctx,faults[i][0],faults[i][1],faults[i][2]);
 for(unsigned i=0;i<sizeof(strings)/sizeof(*strings);i++)string_case(ctx,strings[i][0],strings[i][1],strings[i][2]);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;}
'''

# Shared primitive leaf constructors and byte encoders do not calculate outputs.
SILK_SOURCE = UNARY_SILK.partition('unsafe effect fn runCase')[0].replace(
    'js_unary_operators_test_support as unarySupport', 'js_binary_operators_test_support as binarySupport').replace(
    '    _ => ()\n  }\n}\n', '    _ => ()\n  }\n  if input.isString() { run text(&mut out, input) }\n}\n') + r'''
unsafe effect fn runCase(out: &mut ByteBuffer, hooks: &mut Hooks, memory: &AllocationObserver,
  ctx: *mut HeapHeader, lf: u32, rf: u32, lk: u32, rk: u32, op: u32, alias: bool) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(ctx) hooks.clear()
  let first = run unsafe leaf(rt, lk) let second = run unsafe leaf(rt, rk)
  let firstRoot = unsafe rc(first) let secondRoot = unsafe rc(second)
  let a = run unsafe transitions.make(&mut hooks, memory, ctx, lf, first, second)
  let mut b = ValueBits.Undefined
  if alias { b = unsafe a.retained() }
  else { b = run unsafe transitions.make(&mut hooks, memory, ctx, rf, second, first) }
  let aBefore = unsafe rc(a) let bBefore = unsafe rc(b)
  let firstBefore = unsafe rc(first) let secondBefore = unsafe rc(second)
  let mut left = unsafe a.retained() let mut right = unsafe b.retained()
  let outcome = run Effect.result(unsafe binarySupport.apply(&mut hooks, ctx, &mut left, &mut right, op))
  let mut failed: u32 = 0
  match &outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { .. } => { failed = 1 }
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
  }
  if right.tag() != 3 { trap() }
  run out.writeU32(failed) run unsafe dump(&mut out, left)
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
  run out.writeU32(signed(unsafe rc(a) - aBefore)) run out.writeU32(signed(unsafe rc(b) - bBefore))
  run out.writeU32(signed(unsafe rc(first) - firstBefore)) run out.writeU32(signed(unsafe rc(second) - secondBefore))
  unsafe gc.release(&mut hooks, rt, left) unsafe gc.release(&mut hooks, rt, a) unsafe gc.release(&mut hooks, rt, b)
  run out.writeU32(signed(unsafe rc(first) - firstRoot)) run out.writeU32(signed(unsafe rc(second) - secondRoot))
  run out.writeU32(usize.toU32(hooks.finalizedCount)) i = 0
  while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
  unsafe gc.release(&mut hooks, rt, first) unsafe gc.release(&mut hooks, rt, second)
}
effect fn faultCase(out: &mut ByteBuffer, op: u32, lk: u32, rk: u32) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make()
  run unsafe fixture.prepareErrors(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let a = run unsafe leaf(rt, lk) |> Effect.provideMut<Allocator>(&mut memory)
  let b = run unsafe leaf(rt, rk) |> Effect.provideMut<Allocator>(&mut memory)
  let mut left = unsafe a.retained() let mut right = unsafe b.retained()
  let mut fault = FaultAllocator { parent: move memory, remaining: 0 }
  let outcome = run Effect.result(unsafe binarySupport.apply(&mut hooks, ctx, &mut left, &mut right, op)) |> Effect.provideMut<Allocator>(&mut fault)
  match move outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => trap()
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { error } => match move error {
      OutOfMemoryError allocation => ()
      JsException signal => ()
      StringLengthError length => { fail move length }
    }
  }
  if right.tag() != 3 { trap() }
  run out.writeU32(1) run unsafe dump(&mut out, left)
  run out.writeU32(signed(unsafe rc(a))) run out.writeU32(signed(unsafe rc(b)))
  if unsafe exceptions.has(rt) { let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending) }
  unsafe gc.release(&mut hooks, rt, left) unsafe gc.release(&mut hooks, rt, a) unsafe gc.release(&mut hooks, rt, b)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
  if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
}
import js_strings { StringBuilder }
import js_string_types { RopeString, stringReference }
effect fn stringCase(out: &mut ByteBuffer, length: usize, rk: u32, budget: usize) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make()
  run unsafe fixture.prepareErrors(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let mut builder = StringBuilder.make()
  run builder.reserve(length + 1024, false) |> Effect.provideMut<Allocator>(&mut memory)
  run builder.fill(120, length) |> Effect.provideMut<Allocator>(&mut memory)
  let mut left = run builder.finish() |> Effect.provideMut<Allocator>(&mut memory)
  let before = Pointer.address(stringReference(left))
  let mut right = run unsafe leaf(rt, rk) |> Effect.provideMut<Allocator>(&mut memory)
  let mut fault = FaultAllocator { parent: move memory, remaining: budget }
  let outcome = run Effect.result(unsafe binarySupport.apply(&mut hooks, ctx, &mut left, &mut right, 0)) |> Effect.provideMut<Allocator>(&mut fault)
  let mut failed: u32 = 0 let mut same: u32 = 0 let mut head: u32 = 0
  match move outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => {
      if Pointer.address(stringReference(left)) == before { same = 1 }
      if left.tag() == -6 {
        let anchor = () let rope = unsafe HeapCell.payload<RopeString, ()>(&anchor, stringReference(left))
        if Pointer.address(stringReference(rope.left)) == before { head = 1 }
      }
    }
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { error } => {
      failed = 1
      match move error {
        OutOfMemoryError allocation => ()
        JsException signal => ()
        StringLengthError lengthError => { fail move lengthError }
      }
    }
  }
  if right.tag() != 3 { trap() }
  run out.writeU32(failed) run unsafe dump(&mut out, left)
  run out.writeU32(same) run out.writeU32(head)
  if unsafe exceptions.has(rt) { let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending) }
  unsafe gc.release(&mut hooks, rt, left)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
  if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
}
effect fn flush(out: &ByteBuffer) -> () ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
  let mut size = ByteBuffer.make() run size.writeU32(usize.toU32(out.length() / 4))
  run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice())
}
struct Pair { left: u32, right: u32 }
struct Fault { op: u32, left: u32, right: u32 }
struct StringCase { length: usize, right: u32, budget: usize }
effect fn probe(memory: &AllocationObserver) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError | WriterError ? &mut Allocator | &mut Writer {
  let rt = run runtime.allocateRuntimeStorage(0) let ctx = run unsafe runtime.allocateContextStorage(rt)
  run unsafe fixture.register(rt) let mut hooks = Hooks.make() hooks.collect = true
  run unsafe fixture.prepareErrors(&mut hooks, memory, ctx)
  let mut header = ByteBuffer.make() run header.writeU32(@COUNT@) run Writer.writeAll(header.asSlice())
  let rights: [u32; @RIGHT_COUNT@] = [@RIGHTS@]
  let pairs = [@SILK_PAIRS@] let faults = [@SILK_FAULTS@]
  let strings = [@SILK_STRINGS@]
  let mut out = ByteBuffer.make() let mut kind: u32 = 0
  while kind < @KINDS@ {
    let mut r: usize = 0
    while r < rights.length {
      let mut op: u32 = 0
      while op < 12 {
        out.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, 0, 0, kind, rights[r], op, false)
        run flush(&out) op = op + 1
      }
      r = r + 1
    }
    kind = kind + 1
  }
  kind = 0
  while kind < @KINDS@ {
    let mut op: u32 = 0
    while op < 12 {
      out.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, 0, 0, @SHORT_TWO@, kind, op, false)
      run flush(&out) op = op + 1
    }
    kind = kind + 1
  }
  let mut lf: u32 = 0
  while lf < 10 {
    let mut rf: u32 = 0
    while rf < 10 {
      let mut p: usize = 0
      while p < pairs.length {
        let mut op: u32 = 0
        while op < 12 {
          out.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, lf, rf, pairs[p].left, pairs[p].right, op, false)
          run flush(&out) op = op + 1
        }
        p = p + 1
      }
      rf = rf + 1
    }
    let mut p: usize = 0
    while p < pairs.length {
      let mut op: u32 = 0
      while op < 12 {
        out.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, lf, lf, pairs[p].left, pairs[p].right, op, true)
        run flush(&out) op = op + 1
      }
      p = p + 1
    }
    lf = lf + 1
  }
  let mut f: usize = 0
  while f < faults.length {
    out.clear() run faultCase(&mut out, faults[f].op, faults[f].left, faults[f].right) run flush(&out)
    f = f + 1
  }
  let mut s: usize = 0
  while s < strings.length {
    out.clear() run stringCase(&mut out, strings[s].length, strings[s].right, strings[s].budget) run flush(&out)
    s = s + 1
  }
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt)
}
''' + UNARY_SILK[UNARY_SILK.index('pub effect fn main()'):]


def corpus():
    c, silk = leaves()
    for index, (number, big) in enumerate(EXTRAS, BASE_KINDS):
        c += f'\nif(kind=={index})return ' + (f'__JS_NewShortBigInt(ctx,{number});' if big else f'JS_NewInt32(ctx,{number});')
        literal = '-2147483647 - 1' if number == -2147483648 else str(number)
        silk += f'\nif kind == {index} {{ return ValueBits.' + ('ShortBigInt' if big else 'Int') + f' {{ value: {literal} }} }}'
    for index, length in enumerate(FLAT_LENGTHS, BASE_KINDS + len(EXTRAS)):
        c += f'\nif(kind=={index}){{char bytes[{length}];memset(bytes,120,sizeof(bytes));return checked(JS_NewStringLen(ctx,bytes,sizeof(bytes)));}}'
        silk += f'\nif kind == {index} {{ let bytes: [u8; {length}] = [120; {length}] return run Strings.fromLatin1(&bytes) }}'
    return c, silk


def labels():
    for kind in range(KINDS):
        for right in RIGHTS:
            for op in range(OPERATIONS):
                yield f'primitive left={kind} right={right} op={op}'
    for kind in range(KINDS):
        for op in range(OPERATIONS):
            yield f'reversed left={SHORT_TWO} right={kind} op={op}'
    for lf in range(FAMILIES):
        for rf in range(FAMILIES):
            for lk, rk in CALLBACK_PAIRS:
                for op in range(OPERATIONS):
                    yield f'callbacks families={lf},{rf} leaves={lk},{rk} op={op}'
        for lk, rk in CALLBACK_PAIRS:
            for op in range(OPERATIONS):
                yield f'aliased family={lf} leaves={lk},{rk} op={op}'
    for op, lk, rk in FAULT_ROWS:
        yield f'zero-budget leaves={lk},{rk} op={op}'
    for length, rk, budget in STRING_ROWS:
        yield f'unique-string length={length} right={rk} budget={budget}'
    yield 'teardown'


def records(data):
    if len(data) < 4:
        raise SystemExit('Empty binary oracle output')
    count, = struct.unpack_from('<I', data)
    if count != COUNT:
        raise SystemExit(f'Wrong binary record count: {count}, expected {COUNT}')
    offset, result = 4, []
    for _ in range(count + 1):
        if offset + 4 > len(data):
            raise SystemExit('Truncated binary record header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated binary record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if offset != len(data) or result[-1] != (0, 0):
        raise SystemExit('Nonzero binary teardown ledger or trailing bytes')
    return result

# Interposition is confined to the second C executable. Include math.h before
# the macro so system declarations remain untouched. QuickJS itself, and the
# separately compiled fdlibm source, are never patched.
POWER_PREFIX = r'''
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
extern double silkjs_fdlibm_pow(double,double);
static FILE *power_trace;
static uint64_t power_x,power_y;
static unsigned power_calls;
static double oracle_pow(double x,double y){
 memcpy(&power_x,&x,8);memcpy(&power_y,&y,8);power_calls++;
 return silkjs_fdlibm_pow(x,y);
}
#define pow oracle_pow
'''


def fdlibm_source(source, trace):
    flush = 'static void flush(void){'
    main = 'int main(void){'
    if source.count(flush) != 1 or source.count(main) != 1:
        raise SystemExit('Binary C trace integration point changed')
    source = source.replace(flush, flush +
        'if(fprintf(power_trace,"%u %016llx %016llx\\n",power_calls,'
        '(unsigned long long)power_x,(unsigned long long)power_y)<0)abort();'
        'power_calls=0;power_x=power_y=0;')
    source = source.replace(main, main +
        f'power_trace=fopen({json.dumps(str(trace))},"w");if(!power_trace)abort();')
    return POWER_PREFIX + source


def compare_references(original, platform, actual, traces):
    native_records, original_records, platform_records = records(actual), records(original), records(platform)
    if len(traces) != len(original_records):
        raise SystemExit('Wrong binary power trace count')
    contrasts = []
    for index, (expected, host, native, label, trace) in enumerate(zip(
            original_records, platform_records, native_records, labels(), traces)):
        if expected != native:
            raise SystemExit(f'Binary fdlibm fidelity mismatch {index} ({label}):\nC={expected}\nSilk={native}')
        if host == expected:
            continue
        # Only successful Float64 exponentiation's two payload words may differ.
        # Preserve errors, tags, callbacks, owners, finalizers and every other bit.
        if (not label.endswith('op=5') or len(expected) < 4 or
                expected[:2] != (0, 8) or host[:2] != expected[:2] or
                len(host) != len(expected) or host[4:] != expected[4:] or trace[0] != 1):
            raise SystemExit(f'Unexplained binary platform mismatch {index} ({label}):\n'
                             f'fdlibm={expected}\nplatform={host}; pow trace={trace}')
        original_bits = expected[2] | expected[3] << 32
        platform_bits = host[2] | host[3] << 32
        try:
            evidence = bounded_contrast(trace[1], trace[2], original_bits, platform_bits)
        except (ValueError, ArithmeticError) as error:
            raise SystemExit(f'Unexplained binary platform power {index} ({label}): {error}; '
                             f'fdlibm={original_bits:#018x} platform={platform_bits:#018x}') from error
        contrasts.append(f'{label}: {evidence}')
    return contrasts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--fdlibm-source', type=Path,
                        help='Optional offline pinned e_pow.c (SHA256 verified); otherwise fetched')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    c_leaves, silk_leaves = corpus()
    replacements = {'@COUNT@': str(COUNT), '@KINDS@': str(KINDS), '@C_LEAVES@': c_leaves,
                    '@SILK_LEAVES@': silk_leaves, '@RIGHTS@': ','.join(map(str, RIGHTS)),
                    '@RIGHT_COUNT@': str(len(RIGHTS)), '@SHORT_TWO@': str(SHORT_TWO),
                    '@PAIRS@': ','.join('{%d,%d}' % pair for pair in CALLBACK_PAIRS),
                    '@FAULTS@': ','.join('{%d,%d,%d}' % row for row in FAULT_ROWS),
                    '@STRINGS@': ','.join('{%d,%d,%d}' % row for row in STRING_ROWS),
                    '@SILK_STRINGS@': ','.join('StringCase { length: %d, right: %d, budget: %d }' % row for row in STRING_ROWS),
                    '@SILK_PAIRS@': ','.join('Pair { left: %d, right: %d }' % pair for pair in CALLBACK_PAIRS),
                    '@SILK_FAULTS@': ','.join('Fault { op: %d, left: %d, right: %d }' % row for row in FAULT_ROWS)}
    c_source, silk_source = C_SOURCE.replace('SHORT_TWO', str(SHORT_TWO)), SILK_SOURCE
    for token, replacement in replacements.items():
        c_source, silk_source = c_source.replace(token, replacement), silk_source.replace(token, replacement)
    with tempfile.TemporaryDirectory(prefix='silkjs-binary-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        # Direct-malloc profile exposes refusal to the host allocator. This is not
        # an AddressSanitizer run and deliberately does not instrument the binary.
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Binary C compilation')
        expected = process([str(temp / 'oracle')], 1200, owner='Binary C oracle')
        fdlibm_object = prepare_fdlibm(temp, cc, args.fdlibm_source)
        trace_path = temp / 'power-trace.txt'
        (temp / 'fdlibm-oracle.c').write_text(fdlibm_source(c_source, trace_path))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-fno-fast-math', '-ffp-contract=off', '-fno-builtin-pow',
                 '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'fdlibm-oracle.c'), str(fdlibm_object),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'fdlibm-oracle')],
                600, owner='Binary fdlibm C compilation')
        original = process([str(temp / 'fdlibm-oracle')], 1200, owner='Binary fdlibm C oracle')
        traces = [tuple(int(word, 16) if index else int(word) for index, word in enumerate(line.split()))
                  for line in trace_path.read_text().splitlines()]
        if any(len(trace) != 3 for trace in traces):
            raise SystemExit('Malformed binary power trace')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="binary-operators-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native binary oracle', cwd=temp)
        contrasts = compare_references(original, expected, actual, traces)
        for contrast in contrasts:
            print(contrast)
        nan_count = sum('pow-platform/nan-representation' in entry for entry in contrasts)
        print(f'PASS binary: {COUNT} exact native/fdlibm consuming operations plus exact teardown; '
              f'{COUNT - len(contrasts)} exact platform operations; '
              f'{len(contrasts) - nan_count} bounded finite power contrasts; {nan_count} NaN representation contrasts; '
              f'{KINDS} primitives, {FAMILIES} callback families, {len(FAULT_ROWS)} zero-budget refusals, '
              f'{len(STRING_ROWS)} unique-string identity cases; exact tags/limbs/strings/errors/owners and zero ledgers; '
              f'{pins} pinned QuickJS files; OpenLibm={REVISION} source-SHA256={SOURCE_SHA256}; '
              f'native-SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
