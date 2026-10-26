#!/usr/bin/env python3
"""Compare real consuming QuickJS unary operators with native Silk, never linked.

Exact tags, Float64 bits, signed limbs, errors, callback/finalizer order, refcount
transitions and both postfix slots are recorded. Forced heap-small and maximum
stored-limb inputs exercise compaction and kernel RangeError. Separate zero-budget
allocation cases compare surviving owners and partial outputs (native OOM effects
versus source pending OOM are intentionally represented by the same failure bit).
Both programs require zero allocation/byte ledgers at teardown.

python3 scripts/verify_unary_operators.py QUICKJS
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bigint_coercions import C_EMBEDDING, SILK_SOURCE as BIGINT_SILK, KINDS as BASE_KINDS, leaves
import toolchain

ROOT = Path(__file__).resolve().parents[1]
OPERATIONS = 7
FAMILIES = 10
KINDS = BASE_KINDS + 2
FAULTS = 7
COUNT = KINDS * FAMILIES * OPERATIONS + FAULTS

# Only shared host-class embedding and primitive fixtures are reused; the C side
# invokes the pinned consuming operators themselves, not a numeric reimplementation.
C_SOURCE = C_EMBEDDING.replace('static size_t live_count,live_bytes;',
    'static size_t live_count,live_bytes;static int allocation_budget=-1;').replace(
    'if(!n)return NULL;Header*h=malloc',
    'if(!n)return NULL;if(allocation_budget==0)return NULL;if(allocation_budget>0)allocation_budget--;Header*h=malloc').replace(
    'Header*h=(Header*)p-1;size_t old=h->size;h=realloc',
    'if(allocation_budget==0)return NULL;if(allocation_budget>0)allocation_budget--;Header*h=(Header*)p-1;size_t old=h->size;h=realloc').replace(
    'out[2048]', 'out[140000]').replace('used==2048', 'used==140000') + r'''
static JSValue leaf(JSContext*ctx,int kind){
 @C_LEAVES@
 abort();
}
static void value(JSValue v){
 int tag=JS_VALUE_GET_NORM_TAG(v);emit(tag);
 if(tag==JS_TAG_INT)emit(JS_VALUE_GET_INT(v));
 else if(tag==JS_TAG_SHORT_BIG_INT){emit(1);emit(JS_VALUE_GET_SHORT_BIG_INT(v));}
 else if(tag==JS_TAG_BIG_INT){JSBigInt*p=JS_VALUE_GET_PTR(v);emit(p->len);for(int i=0;i<p->len;i++)emit(p->tab[i]);}
 else if(tag==JS_TAG_FLOAT64)wide(float64_as_uint64(JS_VALUE_GET_FLOAT64(v)));
}
static int apply(JSContext*ctx,JSValue*slots,int op){
 switch(op){
 case 0:return js_unary_arith_slow(ctx,slots+1,OP_plus);
 case 1:return js_unary_arith_slow(ctx,slots+1,OP_neg);
 case 2:return js_unary_arith_slow(ctx,slots+1,OP_inc);
 case 3:return js_unary_arith_slow(ctx,slots+1,OP_dec);
 case 4:return js_not_slow(ctx,slots+1);
 case 5:return js_post_inc_slow(ctx,slots+1,OP_post_inc);
 case 6:return js_post_inc_slow(ctx,slots+1,OP_post_dec);
 default:abort();}
}
static void run_case(JSContext*ctx,int family,int kind,int op){
 event_count=finalized_count=0;JSValue first=leaf(ctx,kind),second=kind%2?JS_NewInt32(ctx,7):JS_DupValue(ctx,first);
 int first_root=rc(first),second_root=rc(second);
 JSValue input=make(ctx,family,first,second);
 int input_before=rc(input),first_before=rc(first),second_before=rc(second);
 JSValue slots[2]={JS_DupValue(ctx,input),JS_UNDEFINED};int r=apply(ctx,slots,op);
 emit(r<0);value(slots[0]);value(slots[1]);
 if(r<0){JSValue pending=JS_GetException(ctx);if(JS_IsObject(pending)){
  JSValue proto=checked(JS_GetPrototype(ctx,pending));int kind=JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_RANGE_ERROR])?1:JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR])?2:0;if(!kind)abort();emit(kind);JS_FreeValue(ctx,proto);
  JSValue message=checked(JS_GetPropertyStr(ctx,pending,"message"));text(message);JS_FreeValue(ctx,message);
 }else{emit(3);emit(JS_SameValue(ctx,pending,first));emit(JS_SameValue(ctx,pending,second));}JS_FreeValue(ctx,pending);}
 emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
 emit(rc(input)-input_before);emit(rc(first)-first_before);emit(rc(second)-second_before);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);JS_FreeValue(ctx,input);
 emit(rc(first)-first_root);emit(rc(second)-second_root);
 emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);
 JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);flush();
}
static void fault_case(JSContext*ctx,int op){
 JSValue root=checked(JS_NewBigUint64(ctx,UINT64_MAX));
 JSValue slots[2]={JS_DupValue(ctx,root),JS_UNDEFINED};allocation_budget=0;
 int r=apply(ctx,slots,op);allocation_budget=-1;
 if(r>=0)abort();emit(1);value(slots[0]);value(slots[1]);emit(rc(root));
 JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);JS_FreeValue(ctx,root);flush();
}
int main(void){JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();word(@COUNT@);
 for(int family=0;family<10;family++)for(int kind=0;kind<@KINDS@;kind++)for(int op=0;op<7;op++)run_case(ctx,family,kind,op);
 for(int op=0;op<7;op++)fault_case(ctx,op);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;}
'''

# The shared prefix provides only imports, primitive leaves and byte encoders.
# Our dump includes Int payloads and raw NaN bits (the coercion oracle intentionally
# canonicalizes its floating diagnostics, which is insufficient for unary plus).
SILK_SOURCE = BIGINT_SILK.partition('struct Outputs')[0] + r'''
import silk.list { List }
import js_heap { HeapKind }
import js_unary_operators_test_support as unarySupport
import js_array_storage_test_support { FaultAllocator }
unsafe effect fn dump(out: &mut ByteBuffer, input: ValueBits) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(signed(input.tag()))
  match input {
    ValueBits.Int { value: integer } => { run out.writeU32(signed(integer)) }
    ValueBits.ShortBigInt { value: small } => { run out.writeU32(1) run out.writeU32(signed(small)) }
    ValueBits.BigInt { reference: node } => {
      let anchor = () let big = unsafe HeapCell.payload<BigInt, ()>(&anchor, node)
      run out.writeU32(usize.toU32(big.length())) let mut i: usize = 0
      while i < big.length() { run out.writeU32(big.limb(i)) i = i + 1 }
    }
    ValueBits.Float64 { value: number } => { run wide(&mut out, f64.toBits(number)) }
    _ => ()
  }
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
  let mut old = unsafe input.retained() let mut next = ValueBits.Undefined
  let outcome = run Effect.result(unsafe unarySupport.apply(&mut hooks, ctx, &mut old, &mut next, op))
  let mut failed: u32 = 0
  match &outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { .. } => { failed = 1 }
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
  }
  run out.writeU32(failed) run unsafe dump(&mut out, old) run unsafe dump(&mut out, next)
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
  unsafe gc.release(&mut hooks, rt, old) unsafe gc.release(&mut hooks, rt, next) unsafe gc.release(&mut hooks, rt, input)
  run out.writeU32(signed(unsafe rc(first) - firstRoot)) run out.writeU32(signed(unsafe rc(second) - secondRoot))
  run out.writeU32(usize.toU32(hooks.finalizedCount)) i = 0
  while i < hooks.finalizedCount { run out.writeU32(hooks.finalized[i]) i = i + 1 }
  unsafe gc.release(&mut hooks, rt, first) unsafe gc.release(&mut hooks, rt, second)
}
effect fn faultCase(out: &mut ByteBuffer, op: u32) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
  let rt = run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx = run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks = Hooks.make()
  run unsafe fixture.prepareErrors(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let root = run bigint.newBigUint64(0xffffffffffffffff) |> Effect.provideMut<Allocator>(&mut memory)
  let mut old = unsafe root.retained() let mut next = ValueBits.Undefined
  let mut fault = FaultAllocator { parent: move memory, remaining: 0 }
  let outcome = run Effect.result(unsafe unarySupport.apply(&mut hooks, ctx, &mut old, &mut next, op)) |> Effect.provideMut<Allocator>(&mut fault)
  match move outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => trap()
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { error } => match move error {
      OutOfMemoryError allocation => ()
      JsException signal => ()
      StringLengthError length => { fail move length }
    }
  }
  run out.writeU32(1) run unsafe dump(&mut out, old) run unsafe dump(&mut out, next) run out.writeU32(signed(unsafe rc(root)))
  if unsafe exceptions.has(rt) { let pending = unsafe exceptions.take(rt) unsafe gc.release(&mut hooks, rt, pending) }
  unsafe gc.release(&mut hooks, rt, old) unsafe gc.release(&mut hooks, rt, next) unsafe gc.release(&mut hooks, rt, root)
  unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut fault)
  if observer.stats().usedBytes != 0 || observer.stats().allocationCount != 0 { trap() }
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
      while op < 7 {
        out.clear() length.clear() run unsafe runCase(&mut out, &mut hooks, memory, ctx, family, kind, op)
        run length.writeU32(usize.toU32(out.length() / 4)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice())
        op = op + 1
      }
      kind = kind + 1
    }
    family = family + 1
  }
  let mut faultOp: u32 = 0
  while faultOp < 7 {
    out.clear() length.clear() run faultCase(&mut out, faultOp)
    run length.writeU32(usize.toU32(out.length() / 4)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice())
    faultOp = faultOp + 1
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
  run footer.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
  run footer.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(footer.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def corpus():
    c, silk = leaves()
    c += f'\nif(kind=={BASE_KINDS})return __JS_NewShortBigInt(ctx,INT32_MIN);'
    silk += f'\nif kind == {BASE_KINDS} {{ return ValueBits.ShortBigInt {{ value: -2147483647 - 1 }} }}'
    c += f'\nif(kind=={BASE_KINDS + 1}){{JSBigInt*p=js_bigint_new(ctx,32768);if(!p)abort();memset(p->tab,0,32768*sizeof(js_limb_t));p=js_bigint_extend(ctx,p,1);if(!p)abort();return JS_MKPTR(JS_TAG_BIG_INT,p);}}'
    silk += f'\nif kind == {BASE_KINDS + 1} {{ let mut words = List<u32>.make() let mut i: usize = 0 while i < 32768 {{ run words.append(0) i = i + 1 }} run words.append(1) let big = run BigInt.fromOwnedLimbs(move words) return ValueBits.BigInt {{ reference: run HeapCell.allocate(HeapKind.BigInt, move big) }} }}'
    return c, silk


def records(data):
    if len(data) < 4:
        raise SystemExit('Empty unary oracle output')
    count, = struct.unpack_from('<I', data)
    if count != COUNT:
        raise SystemExit(f'Wrong unary record count: {count}, expected {COUNT}')
    offset, result = 4, []
    for _ in range(count + 1):
        if offset + 4 > len(data):
            raise SystemExit('Truncated unary record header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated unary record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if offset != len(data) or result[-1] != (0, 0):
        raise SystemExit('Nonzero unary teardown ledger or trailing bytes')
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
    c_leaves, silk_leaves = corpus()
    replacements = {'@COUNT@': str(COUNT), '@KINDS@': str(KINDS), '@C_LEAVES@': c_leaves, '@SILK_LEAVES@': silk_leaves}
    c_source, silk_source = C_SOURCE, SILK_SOURCE
    for token, replacement in replacements.items():
        c_source, silk_source = c_source.replace(token, replacement), silk_source.replace(token, replacement)
    with tempfile.TemporaryDirectory(prefix='silkjs-unary-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        # Source arena allocations bypass the host fault budget. Select its
        # direct-malloc profile, without AddressSanitizer instrumentation.
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Unary C compilation')
        expected = process([str(temp / 'oracle')], 1200, owner='Unary C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="unary-operators-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native unary oracle', cwd=temp)
        expected_records, actual_records = records(expected), records(actual)
        for index, (left, right) in enumerate(zip(expected_records, actual_records)):
            if left != right:
                label = 'teardown' if index == COUNT else (f'fault operation={index - KINDS * FAMILIES * OPERATIONS}'
                    if index >= KINDS * FAMILIES * OPERATIONS else
                    f'family={index // (OPERATIONS * KINDS)}, kind={index // OPERATIONS % KINDS}, operation={index % OPERATIONS}')
                raise SystemExit(f'Unary mismatch {index} ({label}):\nC={left}\nSilk={right}')
        print(f'PASS unary: {COUNT} consuming operations, {KINDS} primitives, {FAMILIES} callback families, '
              f'{FAULTS} allocation refusals; exact tags/bits/limbs/errors/partial outputs/owners and zero ledgers; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
