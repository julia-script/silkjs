#!/usr/bin/env python3
"""Differential-test native primitive kernels against original pinned QuickJS C32.

python3 scripts/verify_primitives.py QUICKJS

The C executable includes the original quickjs.c, calls its original functions,
and is never linked into Silk. Pin validation includes transitive local headers.
Both executables receive identical generated inputs, never each other's outputs.
All 2048 binary64 exponent fields, both signs, low/high mantissa boundaries,
subnormals, signaling/quiet NaN payloads, ties, conversion thresholds and seeded
random bits are mandatory/default fixtures. Every numeric input exercises every
already-coerced Number kernel and both source-specific clamp operations.

ValueBits fixtures use real native string/rope/symbol/BigInt/heap payloads. The full
ordered cross-product tests all three equality modes and both truthiness results,
including internal tags, exception sentinels, identity versus content, HTMLDDA,
and signed normalized 32-bit BigInt limb boundaries. Empty internal bytecode and
module payloads test ONLY tag behavior, not compilation or interpretation. They
are valid typed owned storage, not an interpreter or an expected-value model.

Outputs preserve integer and finite/infinite/zero floating bits exactly. Numeric
failure records distinguish success, RangeError, and other exceptions (which
must fail comparison); undefined output parameters are zeroed only on failure.
NaN results alone are canonicalized. This does not test JS object coercion,
allocator failure, alternate floating rounding modes, or the execution of code.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib

from verify_strings import ROOT, SUPPORT, executable_path, validate_pins, records, process
import toolchain

NUMERIC_FIELDS = ('int32', 'int64', 'integer.bits', 'int32.saturated',
                  'int64.saturated', 'int64.saturation-flags', 'uint8.clamped',
                  'array-length.status', 'array-length.value', 'index.status',
                  'index.value', 'length', 'safe-integer')
CLAMP_FIELDS = ('int32.clamped', 'int64.clamped')
VALUE_FIELDS = ('strict', 'SameValue', 'SameValueZero', 'left.boolean', 'right.boolean')
OPS = ('numeric', 'clamps', 'values', 'float-equality')

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || JS_SHORT_BIG_INT_BITS != 32
#error The primitive oracle requires the pinned 32-bit BigInt profile
#endif
static unsigned fixture;
static void die(const char *s) { fprintf(stderr,"primitive oracle fixture %u: %s\n",fixture,s); exit(1); }
static unsigned byte(void) { int c=getchar(); if(c==EOF) die("truncated input"); return c; }
static uint32_t word(void) { uint32_t v=0; for(unsigned i=0;i<4;i++) v|=(uint32_t)byte()<<(8*i); return v; }
static uint64_t wide(void) { uint64_t lo=word(); return lo|((uint64_t)word()<<32); }
static double number(void) { JSFloat64Union u; u.u64=wide(); return u.d; }
static void put32(uint32_t v) { for(unsigned i=0;i<4;i++) putchar((v>>(8*i))&255); }
static void put64(uint64_t v) { put32(v); put32(v>>32); }
static void scalar(double d) { put64(isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d)); }
static JSValue checked(JSValue v) { if(JS_IsException(v)) die("fixture allocation/compilation failed"); return v; }
static void ok(int status) { if(status) die("unexpected numeric conversion exception"); }
/* Status 1 is specifically RangeError, not merely any thrown exception. */
static unsigned status(JSContext *ctx,int result) {
    if(result==0) return 0;
    JSValue error=JS_GetException(ctx);
    JSValue prototype=JS_GetPrototype(ctx,error);
    unsigned code=JS_StrictEq(ctx,prototype,ctx->native_error_proto[JS_RANGE_ERROR])?1:2;
    JS_FreeValue(ctx,prototype); JS_FreeValue(ctx,error); return code;
}
static JSValue flat(JSContext *ctx,unsigned kind) {
    unsigned n=word();
    if(kind==9) {
        uint8_t *s=malloc(n?n:1); if(!s) die("adapter OOM");
        for(unsigned i=0;i<n;i++) s[i]=byte();
        JSValue v=js_new_string8_len(ctx,(const char *)s,n); free(s); return checked(v);
    }
    uint16_t *s=malloc((n?n:1)*sizeof(*s)); if(!s) die("adapter OOM");
    for(unsigned i=0;i<n;i++) s[i]=word();
    JSValue v=js_new_string16_len(ctx,s,n); free(s); return checked(v);
}
static JSValue value(JSContext *ctx,JSValue *pool,unsigned count) {
    unsigned kind=byte();
    switch(kind) {
    case 0: return JS_NewInt32(ctx,(int32_t)word());
    case 1: return __JS_NewFloat64(ctx,number());
    case 2: return JS_NewBool(ctx,byte());
    case 3: return JS_NULL;
    case 4: return JS_UNDEFINED;
    case 5: return JS_UNINITIALIZED;
    case 6: return JS_NewCatchOffset(ctx,(int32_t)word());
    case 7: return JS_EXCEPTION;
    case 8: return __JS_NewShortBigInt(ctx,(int32_t)word());
    case 9: case 10: return flat(ctx,kind);
    case 11: {
        unsigned a=word(),b=word(); if(a>=count || b>=count) die("rope index");
        return checked(js_new_string_rope(ctx,JS_DupValue(ctx,pool[a]),JS_DupValue(ctx,pool[b])));
    }
    case 12: {
        JSValue v=checked(JS_NewObject(ctx)); JS_VALUE_GET_OBJ(v)->is_HTMLDDA=byte()!=0; return v;
    }
    case 13: return checked(JS_NewSymbol(ctx,"same-description",FALSE));
    case 14: {
        unsigned n=word(); if(!n || n>32768) die("BigInt length");
        JSBigInt *p=js_bigint_new(ctx,n); if(!p) die("BigInt allocation");
        for(unsigned i=0;i<n;i++) p->tab[i]=word();
        /* Inputs are canonical signed limbs; preserve the heap tag even for 0. */
        return JS_MKPTR(JS_TAG_BIG_INT,p);
    }
    case 15: {
        unsigned i=word(); if(i>=count) die("alias index"); return JS_DupValue(ctx,pool[i]);
    }
    case 16: return checked(JS_Eval(ctx,"",0,"primitive-module",JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY));
    case 17: return checked(JS_Eval(ctx,"",0,"primitive-script",JS_EVAL_TYPE_GLOBAL|JS_EVAL_FLAG_COMPILE_ONLY));
    default: die("unknown fixture kind"); return JS_UNDEFINED;
    }
}
static void equality(JSContext *ctx,JSValue a,JSValue b) {
    put32(5); put64(JS_StrictEq(ctx,a,b)); put64(JS_SameValue(ctx,a,b));
    put64(JS_SameValueZero(ctx,a,b)); put64((int64_t)JS_ToBool(ctx,a)); put64((int64_t)JS_ToBool(ctx,b));
}
static void operate(JSContext *ctx,JSValue *pool,unsigned size) {
    unsigned op=byte();
    if(op==0) {
        JSValue v=__JS_NewFloat64(ctx,number()); int32_t a; int64_t b; double d;
        put32(13);
        ok(JS_ToInt32(ctx,&a,v)); put64((int64_t)a);
        ok(JS_ToInt64(ctx,&b,v)); put64(b);
        JSValue integer=JS_ToIntegerFree(ctx,JS_DupValue(ctx,v));
        ok(JS_ToFloat64(ctx,&d,integer)); scalar(d); JS_FreeValue(ctx,integer);
        ok(JS_ToInt32Sat(ctx,&a,v)); put64((int64_t)a);
        int flags=JS_ToInt64SatF(ctx,&b,v); if(flags<0) die("saturation exception"); put64(b); put64(flags);
        ok(JS_ToUint8ClampFree(ctx,&a,JS_DupValue(ctx,v))); put64((int64_t)a);
        uint32_t length=0; unsigned code=status(ctx,JS_ToArrayLengthFree(ctx,&length,JS_DupValue(ctx,v),FALSE));
        put64(code); put64(code?0:length);
        uint64_t index=0; code=status(ctx,JS_ToIndex(ctx,&index,v)); put64(code); put64(code?0:index);
        ok(JS_ToLengthFree(ctx,&b,JS_DupValue(ctx,v))); put64(b);
        JSValue safe=checked(js_number_isSafeInteger(ctx,JS_UNDEFINED,1,&v));
        int safe_bool=JS_ToBool(ctx,safe); if(safe_bool!=is_safe_integer(JS_VALUE_GET_FLOAT64(v))) die("safe integer kernel/builtin disagreement");
        put64(safe_bool); JS_FreeValue(ctx,safe); JS_FreeValue(ctx,v);
    } else if(op==1) {
        JSValue v=__JS_NewFloat64(ctx,number());
        int32_t lo=(int32_t)word(),hi=(int32_t)word(),offset=(int32_t)word(),a;
        int64_t lo64=(int64_t)wide(),hi64=(int64_t)wide(),offset64=(int64_t)wide(),b;
        put32(2); ok(JS_ToInt32Clamp(ctx,&a,v,lo,hi,offset)); put64((int64_t)a);
        ok(JS_ToInt64Clamp(ctx,&b,v,lo64,hi64,offset64)); put64(b); JS_FreeValue(ctx,v);
    } else if(op==2) {
        unsigned a=word(),b=word(); if(a>=size || b>=size) die("value index"); equality(ctx,pool[a],pool[b]);
    } else if(op==3) {
        JSValue a=__JS_NewFloat64(ctx,number()),b=__JS_NewFloat64(ctx,number()); equality(ctx,a,b);
        JS_FreeValue(ctx,a); JS_FreeValue(ctx,b);
    } else die("unknown operation");
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt) die("runtime allocation");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context allocation");
    unsigned n=word(); JSValue *pool=malloc((n?n:1)*sizeof(*pool)); if(!pool) die("pool allocation");
    for(unsigned i=0;i<n;i++) pool[i]=value(ctx,pool,i);
    unsigned count=word(); put32(count);
    for(fixture=0;fixture<count;fixture++) { operate(ctx,pool,n); if(fflush(stdout)) die("stdout failure"); }
    if(getchar()!=EOF) die("trailing input");
    for(unsigned i=n;i>0;i--) JS_FreeValue(ctx,pool[i-1]); free(pool);
    JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.collections.list { List }
import silk.core.option { Option }
import silk.mem.pointer { Pointer }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.num.u8
import silk.num.u16
import silk.num.u32
import silk.num.u64
import silk.num.usize
import byte_buffer { ByteBuffer, readU32 }
import js_primitives as primitive
import js_primitives { EqualityMode }
import js_value { ValueBits }
import js_heap { HeapCell, HeapHeader, HeapKind }
import js_strings { Strings }
import js_string_types { StringLengthError, RopeString, StringOwner }
import js_atoms { AtomTable }
import js_bigint { BigInt, BigIntError }
import js_core_types {
  ObjectData, ObjectPayload, PropertySlot, ShapeData, ShapeProperty,
  FunctionBytecode, FunctionKind, ByteStorage, VarDef, ClosureVar, FunctionDebugInfo,
  ModuleDef, ModuleStatus, RequestedModule, ExportEntry, StarExportEntry, ImportEntry,
  NativeFunctionId, WeakRefHeader
}
import js_runtime as runtime
import js_gc as gc
import js_gc { HeapHooks, Tracer }
fn trap()->never { return Intrinsic.trap("QuickJS invariant violated") }
fn flag(value:bool)->u64 { if value { return 1 } return 0 }
fn bits(value:i64)->u64 {
  if value<0 { return i64.toU64(-(value+1)) ^ 0xffffffffffffffff }
  return i64.toU64(value)
}
fn signed32(word:u32)->i32 {
  if word>2147483647 { return -1-u32.toI32(word ^ 0xffffffff) }
  return u32.toI32(word)
}
fn signed64(word:u64)->i64 {
  if word>9223372036854775807 { return -1-u64.toI64(word ^ 0xffffffffffffffff) }
  return u64.toI64(word)
}
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn byte(self:&mut Self)->u8 { let v=self.data[self.at] self.at=self.at+1 return v }
  fn word(self:&mut Self)->u32 { let v=readU32(self.data,self.at) self.at=self.at+4 return v }
  fn wide(self:&mut Self)->u64 { let lo=self.word() let hi=self.word() return u32.toU64(lo)|u64.shiftLeft(u32.toU64(hi),32) }
  fn number(self:&mut Self)->f64 { return f64.fromBits(self.wide()) }
}
struct Hooks {}
impl HeapHooks for Hooks {
  unsafe fn traceClass(self:&mut Self,rt:*mut HeapHeader,obj:*mut HeapHeader,callback:NativeFunctionId,tracer:&mut Tracer)->() { trap() }
  unsafe fn finalizeClass(self:&mut Self,rt:*mut HeapHeader,obj:*mut HeapHeader,callback:NativeFunctionId)->() { trap() }
  unsafe effect fn sweepWeak(self:&mut Self,rt:*mut HeapHeader,node:*mut WeakRefHeader)->() ? &mut Allocator { trap() }
  unsafe fn destroyAuxiliary(self:&mut Self,rt:*mut HeapHeader,node:*mut HeapHeader)->() { trap() }
}
// Unpublished typed fixtures own all their edges. Destruction below is explicit;
// no interpreter, intrinsic dispatcher or native expected-value implementation.
effect fn object(html:bool)->ValueBits ! OutOfMemoryError ? &mut Allocator {
  let mut hashes=List<u32>.make() run hashes.append(0)
  let shape=run HeapCell.allocate<ShapeData>(HeapKind.Shape,ShapeData {
    isHashed:false,hash:0,propertyHashMask:0,deletedPropertyCount:0,
    hashNext:Pointer.null<HeapHeader>(),prototype:Pointer.null<HeapHeader>(),
    hashIndices:move hashes,properties:List<ShapeProperty>.make()
  })
  let reference=run HeapCell.allocate<ObjectData>(HeapKind.Object,ObjectData {
    isStandardArrayPrototype:false,extensible:true,freeMark:false,isExotic:false,fastArray:false,
    isConstructor:false,hasImmutablePrototype:false,temporaryMark:false,isHtmlDda:html,
    classId:1,weakRefCount:0,shape:shape,properties:List<PropertySlot>.make(),payload:ObjectPayload.Empty
  })
  return ValueBits.Object { reference:reference }
}
effect fn internal(kind:u8,realm:*mut HeapHeader)->ValueBits ! OutOfMemoryError ? &mut Allocator {
  if kind==16 {
    let reference=run HeapCell.allocate<ModuleDef>(HeapKind.Module,ModuleDef {
      name:0,previousModule:Pointer.null<HeapHeader>(),nextModule:Pointer.null<HeapHeader>(),
      requestedModules:List<RequestedModule>.make(),exports:List<ExportEntry>.make(),
      starExports:List<StarExportEntry>.make(),imports:List<ImportEntry>.make(),namespace:ValueBits.Undefined,
      functionObject:ValueBits.Undefined,initialize:Option<NativeFunctionId>.none(),hasTopLevelAwait:false,
      resolved:false,functionCreated:false,status:ModuleStatus.Unlinked,dfsIndex:-1,dfsAncestorIndex:-1,
      stackPrevious:Pointer.null<HeapHeader>(),asyncParentModules:List<*mut HeapHeader>.make(),
      pendingAsyncDependencies:0,asyncEvaluation:false,asyncEvaluationTimestamp:0,
      cycleRoot:Pointer.null<HeapHeader>(),promise:ValueBits.Undefined,resolvingFunctions:[ValueBits.Undefined;2],
      evaluationHasException:false,evaluationException:ValueBits.Undefined,metaObject:ValueBits.Undefined,privateValue:ValueBits.Undefined
    })
    return ValueBits.Module { reference:reference }
  }
  let reference=run HeapCell.allocate<FunctionBytecode>(HeapKind.FunctionBytecode,FunctionBytecode {
    mode:0,hasPrototype:false,hasSimpleParameterList:true,isDerivedClassConstructor:false,
    needsHomeObject:false,kind:FunctionKind.Normal,newTargetAllowed:false,superCallAllowed:false,
    superAllowed:false,argumentsAllowed:false,readOnlyBytecode:false,isDirectOrIndirectEval:false,
    code:ByteStorage.Owned { bytes:List<u8>.make() },name:0,varDefs:List<VarDef>.make(),
    closureVars:List<ClosureVar>.make(),argumentCount:0,variableCount:0,definedArgumentCount:0,
    stackSize:0,varRefCount:0,realm:realm,constants:List<ValueBits>.make(),debug:Option<FunctionDebugInfo>.none()
  })
  unsafe HeapCell.retain(realm)
  return ValueBits.FunctionBytecode { reference:reference }
}
effect fn value(input:&mut Input,pool:&List<ValueBits>,table:&mut AtomTable,realm:*mut HeapHeader)->ValueBits
  ! OutOfMemoryError | StringLengthError | BigIntError ? &mut Allocator {
  let kind=input.byte()
  if kind==0 { return ValueBits.Int { value:signed32(input.word()) } }
  if kind==1 { return ValueBits.Float64 { value:input.number() } }
  if kind==2 { return ValueBits.Bool { value:input.byte()!=0 } }
  if kind==3 { return ValueBits.Null }
  if kind==4 { return ValueBits.Undefined }
  if kind==5 { return ValueBits.Uninitialized }
  if kind==6 { return ValueBits.CatchOffset { offset:signed32(input.word()) } }
  if kind==7 { return ValueBits.Exception }
  if kind==8 { return ValueBits.ShortBigInt { value:signed32(input.word()) } }
  if kind==9 {
    let n=u32.toUsize(input.word()) let mut bytes=List<u8>.make() let mut i:usize=0
    while i<n { run bytes.append(input.byte()) i=i+1 }
    return run Strings.fromLatin1(bytes.asSlice())
  }
  if kind==10 {
    let n=u32.toUsize(input.word()) let mut units=List<u16>.make() let mut i:usize=0
    while i<n { run units.append(u32.toU16(input.word())) i=i+1 }
    return run Strings.fromUtf16(units.asSlice())
  }
  if kind==11 {
    let left=pool.get(u32.toUsize(input.word())) let right=pool.get(u32.toUsize(input.word()))
    let mut leftOwner=StringOwner.borrowed(left) let mut rightOwner=StringOwner.borrowed(right)
    let mut depth=Strings.depth(left)
    if Strings.depth(right)>depth { depth=Strings.depth(right) }
    let reference=run HeapCell.allocate<RopeString>(HeapKind.Rope,RopeString {
      left:left,right:right,length:Strings.length(left)+Strings.length(right),
      depth:depth+1,wide:Strings.isWide(left)||Strings.isWide(right)
    })
    // Transfer the guarded leaf references only after the allocation succeeds.
    let ownedA=leftOwner.take() let ownedB=rightOwner.take()
    return ValueBits.Rope { reference:reference }
  }
  if kind==12 { return run object(input.byte()!=0) }
  if kind==13 {
    let description=StringOwner.adopt(run Strings.fromLatin1(b"same-description"))
    return run table.uniqueSymbol(Option<ValueBits>.some(description.get()))
  }
  if kind==14 {
    let n=u32.toUsize(input.word()) let mut limbs=List<u32>.make() let mut i:usize=0
    while i<n { run limbs.append(input.word()) i=i+1 }
    let integer=run BigInt.fromOwnedLimbs(move limbs)
    return ValueBits.BigInt { reference:run HeapCell.allocate<BigInt>(HeapKind.BigInt,move integer) }
  }
  if kind==15 { let alias=pool.get(u32.toUsize(input.word())) return unsafe alias.retained() }
  if kind==16 || kind==17 { return run internal(kind,realm) }
  return trap()
}
unsafe fn release(value:ValueBits,hooks:&mut Hooks,rt:*mut HeapHeader)->() {
  if value.isString() || value.tag()==-8 { Strings.release(value) return () }
  if !unsafe value.decrementReference() { return () }
  match value {
    ValueBits.BigInt { reference } => { unsafe HeapCell.destroy<BigInt>(reference) }
    ValueBits.Module { reference } => { unsafe HeapCell.destroy<ModuleDef>(reference) }
    ValueBits.FunctionBytecode { reference } => {
      let anchor=() let data=unsafe HeapCell.payload<FunctionBytecode,()>(&anchor,reference)
      let realm=data.realm drop data unsafe HeapCell.destroy<FunctionBytecode>(reference)
      unsafe gc.releaseHeader(&mut hooks,rt,realm)
    }
    ValueBits.Object { reference } => {
      let anchor=() let data=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference)
      let shape=data.shape drop data unsafe HeapCell.destroy<ObjectData>(reference)
      if unsafe HeapCell.decrement(shape) { unsafe HeapCell.destroy<ShapeData>(shape) }
    }
    _ => { trap() }
  }
}
effect fn scalar(out:&mut ByteBuffer,value:f64)->() ! OutOfMemoryError ? &mut Allocator {
  if f64.isNaN(value) { run out.writeU64(0x7ff8000000000000) }
  else { run out.writeU64(f64.toBits(value)) }
}
effect fn equality(out:&mut ByteBuffer,a:ValueBits,b:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU64(flag(unsafe primitive.equal(a,b,EqualityMode.Strict)))
  run out.writeU64(flag(unsafe primitive.equal(a,b,EqualityMode.SameValue)))
  run out.writeU64(flag(unsafe primitive.equal(a,b,EqualityMode.SameValueZero)))
  run out.writeU64(bits(i32.toI64(unsafe primitive.toBoolean(a))))
  run out.writeU64(bits(i32.toI64(unsafe primitive.toBoolean(b))))
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer,pool:&List<ValueBits>)->()
  ! OutOfMemoryError ? &mut Allocator {
  let op=input.byte()
  if op==0 {
    let v=input.number()
    run out.writeU64(bits(i32.toI64(primitive.numberToInt32(v))))
    run out.writeU64(bits(primitive.numberToInt64(v)))
    run scalar(&mut out,primitive.numberToInteger(v))
    run out.writeU64(bits(i32.toI64(primitive.numberToInt32Saturated(v))))
    let saturated=primitive.numberToInt64Saturated(v)
    run out.writeU64(bits(saturated.value)) run out.writeU64(u32.toU64(u8.toU32(saturated.flags)))
    run out.writeU64(bits(i32.toI64(primitive.numberToUint8Clamp(v))))
    match primitive.numberToArrayLength(v) {
      Option<u32>.Some { value:result } => { run out.writeU64(0) run out.writeU64(u32.toU64(result)) }
      Option<u32>.None => { run out.writeU64(1) run out.writeU64(0) }
    }
    match primitive.numberToIndex(v) {
      Option<u64>.Some { value:result } => { run out.writeU64(0) run out.writeU64(result) }
      Option<u64>.None => { run out.writeU64(1) run out.writeU64(0) }
    }
    run out.writeU64(bits(primitive.numberToLength(v))) run out.writeU64(flag(primitive.numberIsSafeInteger(v)))
  } else if op==1 {
    let v=input.number() let lo=signed32(input.word()) let hi=signed32(input.word()) let offset=signed32(input.word())
    let lo64=signed64(input.wide()) let hi64=signed64(input.wide()) let offset64=signed64(input.wide())
    run out.writeU64(bits(i32.toI64(primitive.numberToInt32Clamped(v,lo,hi,offset))))
    run out.writeU64(bits(primitive.numberToInt64Clamped(v,lo64,hi64,offset64)))
  } else if op==2 {
    let a=pool.get(u32.toUsize(input.word())) let b=pool.get(u32.toUsize(input.word()))
    run equality(&mut out,a,b)
  } else if op==3 {
    let a=ValueBits.Float64 { value:input.number() } let b=ValueBits.Float64 { value:input.number() }
    run equality(&mut out,a,b)
  } else { trap() }
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | BigIntError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let mut table=run AtomTable.make()
  let rt=run runtime.allocateRuntimeStorage(2097152) let realm=run unsafe runtime.allocateContextStorage(rt)
  let mut hooks=Hooks {} let mut pool=List<ValueBits>.make() let size=input.word() let mut i:u32=0
  while i<size { let next=run value(&mut input,&pool,&mut table,realm) run pool.append(next) i=i+1 }
  let count=input.word() let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut length=ByteBuffer.make() i=0
  while i<count {
    out.clear() length.clear() run operate(&mut input,&mut out,&pool)
    run length.writeU32(usize.toU32(out.length()/8)) run Writer.writeAll(length.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
  if input.at!=input.data.length { trap() }
  let mut remaining=pool.length()
  while remaining!=0 { remaining=remaining-1 unsafe release(pool.get(remaining),&mut hooks,rt) }
  pool.clear() unsafe gc.releaseHeader(&mut hooks,rt,realm) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | BigIntError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def u32(n):
    return struct.pack('<I', n & 0xffffffff)


def wide(n):
    return struct.pack('<Q', n & 0xffffffffffffffff)


def float_bits(n):
    return struct.unpack('<Q', struct.pack('<d', n))[0]


@dataclass(frozen=True)
class Case:
    op: int
    label: str
    payload: bytes

    def wire(self):
        return bytes((self.op,)) + self.payload

    def fields(self):
        return (NUMERIC_FIELDS, CLAMP_FIELDS, VALUE_FIELDS, VALUE_FIELDS)[self.op]


def signed_limbs(n):
    """Encode fixture integers only; no conversion/equality expected values."""
    count = 1
    while not -(1 << (32 * count - 1)) <= n < (1 << (32 * count - 1)):
        count += 1
    return [(n >> (32 * i)) & 0xffffffff for i in range(count)]


def value_pool():
    pool = []

    def add(label, kind, data=b''):
        pool.append((label, bytes((kind,)) + data))
        return len(pool) - 1

    for n in (-2147483648, -1, 0, 1, 2, 2147483647):
        add(f'int({n})', 0, u32(n))
    floats = {float_bits(float(n)) for n in (-2147483648, -1, 0, 1, 2, 2147483647, 2147483648, 4294967295)}
    floats.update((0x8000000000000000, 1, 0x8000000000000001, 0x000fffffffffffff,
                   0x0010000000000000, 0x7fefffffffffffff, 0xffefffffffffffff,
                   0x7ff0000000000000, 0xfff0000000000000, 0x7ff0000000000001,
                   0x7ff8000000000000, 0x7ff8000000000001, 0xfff0000000000001,
                   0xfff8000000000042, float_bits(0.5), float_bits(-0.5)))
    for bits in sorted(floats):
        add(f'float({bits:016x})', 1, wide(bits))
    add('false', 2, b'\0')
    add('true', 2, b'\1')
    for kind, label in ((3, 'null'), (4, 'undefined'), (5, 'uninitialized'), (7, 'exception')):
        add(label, kind)
    for n in (-2147483648, -1, 0, 1, 2147483647):
        add(f'catch-offset({n})', 6, u32(n))
        add(f'short-bigint({n})', 8, u32(n))
    for html in (False, True):
        first = add(f'object(htmlDda={html})', 12, bytes((html,)))
        add(f'object-distinct(htmlDda={html})', 12, bytes((html,)))
        add(f'object-alias(htmlDda={html})', 15, u32(first))
    symbol = add('symbol', 13)
    add('symbol-same-description-distinct', 13)
    add('symbol-alias', 15, u32(symbol))
    for kind, label in ((16, 'module'), (17, 'function-bytecode')):
        first = add(label, kind)
        add(label + '-distinct', kind)
        add(label + '-alias', 15, u32(first))

    def text(label, units, latin=False):
        if latin:
            return add(label, 9, u32(len(units)) + bytes(units))
        return add(label, 10, u32(len(units)) + b''.join(u32(n) for n in units))

    empty = text('empty-latin1', [], True)
    text('empty-wide', [])
    for label, units in (('nul', [0]), ('ascii', [97, 98, 99]), ('latin1', [0, 127, 128, 255]),
                         ('wide', [0, 255, 256, 0xffff]), ('surrogates', [0xd800, 0xdc00, 0xdfff]),
                         ('long', [97] * 300), ('long-last-diff', [97] * 299 + [98])):
        flat = text(label + '-wide', units)
        text(label + '-wide-distinct', units)
        if max(units, default=0) <= 255:
            text(label + '-latin1', units, True)
        middle = len(units) // 2
        left = text(label + '-left', units[:middle])
        right = text(label + '-right', units[middle:])
        rope = add(label + '-rope', 11, u32(left) + u32(right))
        add(label + '-rope-alias', 15, u32(rope))
        add(label + '-nested-rope', 11, u32(empty) + u32(rope))
        add(label + '-flat-alias', 15, u32(flat))
    add('empty-rope', 11, u32(empty) + u32(empty))
    integers = {-2147483648, -1, 0, 1, 2147483647}
    for exponent in (31, 32, 33, 63, 64, 65, 95, 96, 127, 128, 255, 256, 1023):
        for delta in (-1, 0, 1):
            n = (1 << exponent) + delta
            integers.update((n, -n))
    for n in sorted(integers):
        limbs = signed_limbs(n)
        encoded = u32(len(limbs)) + b''.join(u32(limb) for limb in limbs)
        index = add(f'heap-bigint({n})', 14, encoded)
        # Equal contents in distinct allocations, plus actual shared ownership.
        add(f'heap-bigint-distinct({n})', 14, encoded)
        add(f'heap-bigint-alias({n})', 15, u32(index))
    return pool


# Valid min<=max domains, deliberately including offsets that wrap at either width.
# The 32-bit source compares against min before adding; 64-bit compares against 0.
CLAMPS = (
    ((0, 255, 0), (0, 255, 0)),
    ((10, 20, 100), (10, 20, 100)),
    ((-20, -10, 100), (-20, -10, 100)),
    ((-100, 100, 80), (-100, 100, 80)),
    ((0, 0, 2147483647), (0, 0, 9223372036854775807)),
    ((-2147483648, 2147483647, 0), (-9223372036854775808, 9223372036854775807, 0)),
    ((-100, 100, -2147483648), (-100, 100, -9223372036854775808)),
    ((-2147483647, -2147483646, -2), (-9223372036854775807, -9223372036854775806, -2)),
    ((1, 2147483647, -1), (1, 9223372036854775807, -1)),
)


def number_corpus(seed, random_cases):
    values = set()
    # All exponent transitions: first/second/third significands, midpoint and
    # its neighbors, last/penultimate significands, for both signs.
    mantissas = (0, 1, 2, (1 << 51) - 1, 1 << 51, (1 << 51) + 1, (1 << 52) - 2, (1 << 52) - 1)
    for exponent in range(2048):
        for mantissa in mantissas:
            for sign in (0, 1 << 63):
                values.add(sign | (exponent << 52) | mantissa)
    # Every low mantissa bit at the modulo conversion transition exponents.
    for exponent in (1022, 1023, 1053, 1054, 1055, 1074, 1075, 1076, 1085, 1086, 1087, 1106, 1107, 1138, 1139):
        for bit in range(52):
            for mantissa in ((1 << bit) - 1, 1 << bit, (1 << bit) + 1):
                for sign in (0, 1 << 63):
                    values.add(sign | (exponent << 52) | mantissa)
    boundaries = [-2.0, -1.0, -0.0, 0.0, 1.0, 2.0, 255.0, 256.0]
    for n in (31, 32, 53, 63, 64):
        for delta in (-1, 0, 1):
            boundaries.extend((float((1 << n) + delta), -float((1 << n) + delta)))
    boundaries.extend(float(n) + 0.5 for n in range(-2, 258))
    for d in boundaries:
        values.update(float_bits(v) for v in (math.nextafter(d, -math.inf), d, math.nextafter(d, math.inf)))
    rng = random.Random(seed)
    values.update(rng.getrandbits(64) for _ in range(random_cases))
    return sorted(values)


def fixtures(pool, seed, random_cases):
    cases = []

    def clamp(bits, bounds):
        small, large = bounds
        cases.append(Case(1, f'bits={bits:016x} min32,max32,offset32={small} min64,max64,offset64={large}',
                          wide(bits) + b''.join(u32(n) for n in small) + b''.join(wide(n) for n in large)))

    for i, bits in enumerate(number_corpus(seed, random_cases)):
        cases.append(Case(0, f'bits={bits:016x}', wide(bits)))
        clamp(bits, CLAMPS[i % len(CLAMPS)])
        # Same bits, flipped sign and adjacent encoding independently cover
        # equality and truthiness throughout the entire IEEE input corpus.
        for other in (bits, bits ^ (1 << 63), bits ^ 1):
            cases.append(Case(3, f'left={bits:016x} right={other:016x}', wide(bits) + wide(other)))
    for bounds in CLAMPS:
        boundaries = {-1.5, -1.0, -0.5, -0.0, 0.0, 0.5, 1.0, math.inf, -math.inf, math.nan}
        for bound in (*bounds[0], *bounds[1]):
            for delta in (-1, 0, 1):
                d = float(bound + delta)
                boundaries.update((d, math.nextafter(d, -math.inf), math.nextafter(d, math.inf)))
        for bits in sorted({float_bits(d) for d in boundaries}):
            clamp(bits, bounds)
    # Exhaustive ordered heterogeneous product: every tag against every other
    # tag, both operand orders, identical references and independently allocated
    # equal payloads. No presumed result is used to prune pairs.
    for a, (left, _) in enumerate(pool):
        for b, (right, _) in enumerate(pool):
            cases.append(Case(2, f'pool[{a}] {left} / pool[{b}] {right}', u32(a) + u32(b)))
    return cases


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('upstream', type=Path)
    ap.add_argument('--silk', default=str(toolchain.compiler_path()))
    ap.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    ap.add_argument('--cc', default='cc')
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--random-cases', type=int, default=4096)
    ap.add_argument('--seed', type=lambda n: int(n, 0), default=0x5052494D)
    ap.add_argument('--max-mismatches', type=int, default=20)
    args = ap.parse_args()
    if args.timeout <= 0 or args.random_cases < 0 or args.max_mismatches <= 0:
        ap.error('timeout/max-mismatches must be positive and random-cases nonnegative')
    upstream = args.upstream.expanduser().resolve()
    pin_count = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
    pool = value_pool()
    cases = fixtures(pool, args.seed, args.random_cases)
    data = u32(len(pool)) + b''.join(payload for _, payload in pool) + u32(len(cases)) + b''.join(case.wire() for case in cases)
    totals = Counter(OPS[case.op] for case in cases)
    print(f'Pins: {pin_count}; seed={args.seed:#x}; pool={len(pool)}; records={len(cases):,}; operations={dict(totals)}', flush=True)
    with tempfile.TemporaryDirectory(prefix='silkjs-primitives-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], args.timeout, owner='C primitive build')
        oracle_bytes = process([str(temp / 'oracle')], args.timeout, owner='C primitive oracle', data=data, cases=cases)
        oracle = records(oracle_bytes, cases, 'C primitive oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'silk.toml').write_text(f'[package]\nname="primitive-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        literal = 'b"' + ''.join(f'\\x{b:02x}' for b in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        command = [silk, 'run', '--quiet', '--release']
        if stdlib:
            command += ['--stdlib', str(stdlib)]
        native_bytes = process(command, args.timeout, owner='native primitive oracle', cwd=temp, cases=cases)
        native = records(native_bytes, cases, 'native primitive oracle')
        failures = 0
        for i, (case, want, got) in enumerate(zip(cases, oracle, native, strict=True)):
            if want == got:
                continue
            failures += 1
            if failures <= args.max_mismatches:
                print(f'MISMATCH #{i} [{OPS[case.op]}] {case.label}')
                for name, expected, actual in zip(case.fields(), want, got, strict=True):
                    if expected != actual:
                        print(f'  {name}: C={expected:#018x} Silk={actual:#018x}')
        print(f'Compared {sum(len(c.fields()) for c in cases):,} exact fields; input SHA256={hashlib.sha256(data).hexdigest()}')
        print(f'C output SHA256={hashlib.sha256(oracle_bytes).hexdigest()}; native output SHA256={hashlib.sha256(native_bytes).hexdigest()}')
        if failures:
            raise SystemExit(f'FAIL: {failures:,} mismatching records ({min(failures, args.max_mismatches)} displayed)')
        print(f'PASS: {len(cases):,} original-C/native primitive records; operations={dict(totals)}')


if __name__ == '__main__':
    main()
