#!/usr/bin/env python3
"""Compare the pinned C integer consumers with native Silk, never linked together.

C calls original static/public QuickJS entry points; native calls the real object
coercion boundary with stored getters, callable closures, method replacement,
collection inside callbacks and real pending TypeError/RangeError objects. The
records include outputs even on failure, saturation flags, integer Value tags,
error prototype/message, callback order, reference deltas and finalizer order.
Both runtimes must independently have zero live allocations after teardown.

Run: python3 scripts/verify_integer_coercions.py QUICKJS
The reference uses 32-bit int/uint32 and 64-bit int64/uint64 on either pointer ABI;
no native Value layout or C long width is assumed. Uint8Clamp assumes the source
round-to-nearest/ties-even floating environment. No BigInt-to-integer extension.
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
OPERATIONS = 26
FAMILIES = 10


def number_bits():
    values = [0, 1, 0x8000000000000000, 0x8000000000000001,
              0x7ff0000000000000, 0xfff0000000000000,
              0x7ff8000000000000, 0xfff8000000000042, 0x7ff0000000000001]
    for value in (0.5, 1.5, 2.5, 7.0, 7.9, 253.5, 254.5, 255.0,
                  2**31 - 1, 2**31, 2**32 - 1, 2**32, 2**53 - 1,
                  2**53, 2**63, 2**64, 2**84, 2**116, 1.7976931348623157e308):
        for magnitude in (math.nextafter(float(value), -math.inf), float(value),
                          math.nextafter(float(value), math.inf)):
            for sign in (1.0, -1.0):
                values.append(struct.unpack('<Q', struct.pack('<d', sign * magnitude))[0])
    for exponent in (30, 31, 32, 51, 52, 53, 62, 63, 64, 82, 83, 84, 114, 115, 116):
        for fraction in (0, 1, 0x5555555555555, 0xfffffffffffff):
            word = ((exponent + 1023) << 52) | fraction
            values.extend((word, word | (1 << 63)))
    return list(dict.fromkeys(values))


BITS = number_bits()
KINDS = len(BITS) + 21
COUNT = KINDS * FAMILIES * OPERATIONS
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
_Static_assert(sizeof(int)==4 && sizeof(uint32_t)==4 && sizeof(int64_t)==8 && sizeof(uint64_t)==8,"integer widths");
typedef union Header { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;
static void *tracked_malloc(JSMallocState*s,size_t n){if(!n)return NULL;Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void tracked_free(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *tracked_realloc(JSMallocState*s,void*p,size_t n){if(!p)return tracked_malloc(s,n);if(!n){tracked_free(s,p);return NULL;}Header*h=(Header*)p-1;size_t old=h->size;h=realloc(h,sizeof(*h)+n);if(!h)return NULL;h->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return h+1;}
static size_t tracked_size(const void*p){return p?((const Header*)p-1)->size:0;}
static uint32_t out[2048];static unsigned used;
static void word(uint32_t v){for(int i=0;i<4;i++)putchar((v>>(8*i))&255);}
static void emit(uint32_t v){if(used==2048)abort();out[used++]=v;}
static void wide(uint64_t v){emit(v);emit(v>>32);}
static void flush(void){word(used);for(unsigned i=0;i<used;i++)word(out[i]);used=0;}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
static int rc(JSValueConst v){return JS_VALUE_HAS_REF_COUNT(v)?js_rc(JS_VALUE_GET_PTR(v))->ref_count:0;}
static void text(JSValue v){JSString*s=JS_VALUE_GET_STRING(v);emit(s->len);for(int i=0;i<s->len;i++)emit(string_get(s,i));}
static uint64_t number(double d){return isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d);}
static uint32_t events[128],finalized[128];static unsigned event_count,finalized_count;
typedef struct {JSValue result,mutation;int event,body;JSAtom atom;} Closure;
static void finalizer(JSRuntime*rt,JSValue o){Closure*p=JS_GetOpaque(o,JS_VALUE_GET_OBJ(o)->class_id);if(!p)abort();finalized[finalized_count++]=p->event;JS_FreeValueRT(rt,p->result);JS_FreeValueRT(rt,p->mutation);js_free_rt(rt,p);}
static void marker(JSRuntime*rt,JSValueConst o,JS_MarkFunc*mark){Closure*p=JS_GetOpaque(o,JS_VALUE_GET_OBJ(o)->class_id);if(!p)abort();JS_MarkValue(rt,p->result,mark);JS_MarkValue(rt,p->mutation,mark);}
static JSValue call(JSContext*ctx,JSValueConst f,JSValueConst receiver,int argc,JSValueConst*argv,int flags){
 Closure*p=JS_GetOpaque(f,69);if(!p)abort();int body=p->body,event=p->event;JSAtom atom=p->atom;
 JSValue result=JS_DupValue(ctx,p->result),mutation=JS_DupValue(ctx,p->mutation);events[event_count++]=event;
 if(argc==1){JSString*s=JS_VALUE_GET_STRING(argv[0]);if(s->len!=6)abort();for(int i=0;i<6;i++)if(string_get(s,i)!="number"[i])abort();events[event_count++]=1001;}else if(argc)abort();
 JS_RunGC(JS_GetRuntime(ctx));
 if(body==3){JSProperty*slot;if(!find_own_property(&slot,JS_VALUE_GET_OBJ(receiver),atom))abort();JSValue old=slot->u.value;slot->u.value=JS_DupValue(ctx,mutation);JS_FreeValue(ctx,old);}
 JS_FreeValue(ctx,mutation);if(body==1)return JS_Throw(ctx,result);
 if(body==2){JS_FreeValue(ctx,result);return JS_DupValue(ctx,receiver);}return result;
}
static const JSClassDef object_definition={.class_name="CoercionClosure",.finalizer=finalizer,.gc_mark=marker};
static const JSClassDef function_definition={.class_name="CoercionClosure",.finalizer=finalizer,.gc_mark=marker,.call=call};
static JSValue closure(JSContext*ctx,int callable,int event,int body,JSValueConst result,JSAtom atom,JSValueConst mutation){JSValue o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,callable?69:68));Closure*p=js_malloc(ctx,sizeof(*p));if(!p)abort();*p=(Closure){JS_DupValue(ctx,result),JS_DupValue(ctx,mutation),event,body,atom};JS_SetOpaque(o,p);return o;}
static void property(JSContext*ctx,JSValueConst o,JSAtom atom,JSValueConst v,int accessor){int r;if(accessor)r=JS_DefinePropertyGetSet(ctx,o,atom,JS_DupValue(ctx,v),JS_UNDEFINED,JS_PROP_CONFIGURABLE|JS_PROP_ENUMERABLE);else r=JS_DefinePropertyValue(ctx,o,atom,JS_DupValue(ctx,v),JS_PROP_C_W_E);if(r<0)abort();}
static void method(JSContext*ctx,JSValueConst o,JSAtom atom,int event,int body,JSValueConst result){JSValue f=closure(ctx,1,event+1,body,result,0,JS_UNDEFINED);JSValue getter=closure(ctx,1,event,0,f,0,JS_UNDEFINED);property(ctx,o,atom,getter,1);JS_FreeValue(ctx,getter);JS_FreeValue(ctx,f);}
static JSValue make(JSContext*ctx,int family,JSValueConst first,JSValueConst second){
 if(!family)return JS_DupValue(ctx,first);
 JSValue o=closure(ctx,0,1,0,JS_UNDEFINED,0,JS_UNDEFINED);
 if(family==3||family==4||family==6){JSAtom atom=family==4?JS_ATOM_Symbol_toPrimitive:JS_ATOM_valueOf;JSValue next=closure(ctx,1,42,family==6?1:0,second,0,JS_UNDEFINED);JSValue initial=closure(ctx,1,41,3,first,atom,next);property(ctx,o,atom,initial,0);JS_FreeValue(ctx,initial);JS_FreeValue(ctx,next);return o;}
 if(family==1)property(ctx,o,JS_ATOM_Symbol_toPrimitive,JS_NULL,0);
 if(family==2||family==5)method(ctx,o,JS_ATOM_Symbol_toPrimitive,10,family==5?1:0,first);
 if(family==7){JSValue getter=closure(ctx,1,20,1,first,0,JS_UNDEFINED);property(ctx,o,JS_ATOM_valueOf,getter,1);JS_FreeValue(ctx,getter);}
 else method(ctx,o,JS_ATOM_valueOf,20,family==8||family==9?2:0,first);
 method(ctx,o,JS_ATOM_toString,30,family==9?2:0,first);return o;
}
static const uint64_t bits[]={@C_BITS@};
static JSValue leaf(JSContext*ctx,int kind){
 if(kind<@NUMBERS@){JSFloat64Union u={.u64=bits[kind]};return __JS_NewFloat64(ctx,u.d);}
 switch(kind-@NUMBERS@){case 0:return JS_UNDEFINED;case 1:return JS_NULL;case 2:return JS_FALSE;case 3:return JS_TRUE;
 case 4:return checked(JS_NewString(ctx,""));case 5:return checked(JS_NewString(ctx," -0 "));
 case 6:return checked(JS_NewString(ctx,"7.9"));case 7:return checked(JS_NewString(ctx,"4294967295"));
 case 8:return checked(JS_NewString(ctx,"4294967296"));case 9:return checked(JS_NewString(ctx,"Infinity"));
 case 10:return checked(JS_NewString(ctx,"NaN"));case 11:return checked(JS_NewString(ctx,"0x10"));
 case 12:return checked(JS_NewString(ctx," \xc2\xa0 7 \xe3\x80\x80"));case 13:return checked(JS_NewStringLen(ctx,"7\0x",3));
 case 14:return checked(JS_NewSymbol(ctx,"integer-symbol",FALSE));case 15:return JS_NewBigInt64(ctx,7);
 case 16:return checked(JS_NewBigInt64(ctx,INT64_C(9007199254740993)));
 case 17:return JS_NewInt32(ctx,INT32_MIN);case 18:return JS_NewInt32(ctx,INT32_MAX);
 case 19:return JS_NewInt32(ctx,0);case 20:return JS_NewInt32(ctx,-1);default:abort();}
}
static int convert(JSContext*ctx,JSValueConst v,int op,uint64_t*output,int*tag){
 double d=17.25;int32_t n=0x12345678;int64_t w=INT64_C(0x1234567812345678);uint32_t u=0x87654321;uint64_t index=UINT64_C(0x8765432187654321);int r=0;JSValue integer=JS_UNDEFINED;
 switch(op){
 case 0:r=JS_ToFloat64(ctx,&d,v);break;case 1:r=JS_ToFloat64Free(ctx,&d,JS_DupValue(ctx,v));break;
 case 2:integer=JS_ToIntegerFree(ctx,JS_DupValue(ctx,v));r=JS_IsException(integer)?-1:0;*tag=JS_VALUE_GET_NORM_TAG(integer);if(!r){double x=JS_VALUE_GET_NORM_TAG(integer)==JS_TAG_INT?JS_VALUE_GET_INT(integer):JS_VALUE_GET_FLOAT64(integer);*output=number(x);}else *output=0;JS_FreeValue(ctx,integer);return r;
 case 3:r=JS_ToInt32Sat(ctx,&n,v);break;case 4:r=JS_ToInt32SatFree(ctx,&n,JS_DupValue(ctx,v));break;
 case 5:r=JS_ToInt32Clamp(ctx,&n,v,0,10,10);break;case 6:r=JS_ToInt32Clamp(ctx,&n,v,5,10,20);break;
 case 7:r=JS_ToInt64Sat(ctx,&w,v);break;case 8:r=JS_ToInt64SatFree(ctx,&w,JS_DupValue(ctx,v),FALSE);break;
 case 9:r=JS_ToInt64SatF(ctx,&w,v);break;case 10:r=JS_ToInt64SatFree(ctx,&w,JS_DupValue(ctx,v),TRUE);break;
 case 11:r=JS_ToInt64Clamp(ctx,&w,v,-3,10,10);break;case 12:r=JS_ToInt64Clamp(ctx,&w,v,INT64_MIN,INT64_MAX,INT64_MAX);break;
 case 13:r=JS_ToInt64(ctx,&w,v);break;case 14:r=JS_ToInt64Free(ctx,&w,JS_DupValue(ctx,v));break;
 case 15:r=JS_ToInt32(ctx,&n,v);break;case 16:r=JS_ToInt32Free(ctx,&n,JS_DupValue(ctx,v));break;
 case 17:r=JS_ToUint32(ctx,&u,v);break;case 18:r=JS_ToUint32Free(ctx,&u,JS_DupValue(ctx,v));break;
 case 19:r=JS_ToUint8ClampFree(ctx,&n,JS_DupValue(ctx,v));break;
 case 20:r=JS_ToArrayLengthFree(ctx,&u,JS_DupValue(ctx,v),TRUE);break;case 21:r=JS_ToArrayLengthFree(ctx,&u,JS_DupValue(ctx,v),FALSE);break;
 case 22:r=JS_ToIndex(ctx,&index,v);break;case 23:r=JS_ToLengthFree(ctx,&w,JS_DupValue(ctx,v));break;
 case 24:r=JS_ToInt32Clamp(ctx,&n,v,5,10,INT32_MAX);break;case 25:r=JS_ToInt64Clamp(ctx,&w,v,5,10,20);break;default:abort();}
 if(op<2)*output=number(d);else if((op>=3&&op<=6)||op==15||op==16||op==19||op==24)*output=(uint32_t)n;
 else if(op==17||op==18||op==20||op==21)*output=u;else if(op==22)*output=index;else *output=w;return r;
}
static void run_case(JSContext*ctx,int family,int kind,int op){
 event_count=finalized_count=0;JSValue first=leaf(ctx,kind),second=kind%2?JS_NewInt32(ctx,7):JS_DupValue(ctx,first);
 int first_roots=rc(first),second_roots=rc(second);
 JSValue input=make(ctx,family,first,second);int input_before=rc(input),first_before=rc(first),second_before=rc(second);uint64_t output;int tag=0;int r=convert(ctx,input,op,&output,&tag);
 emit(r<0);emit(r<0?0:r);wide(output);emit(tag);
 if(r<0){JSValue pending=JS_GetException(ctx);if(JS_IsObject(pending)){
  JSValue proto=checked(JS_GetPrototype(ctx,pending));int kind=JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_RANGE_ERROR])?1:JS_StrictEq(ctx,proto,ctx->native_error_proto[JS_TYPE_ERROR])?2:0;if(!kind)abort();emit(kind);JS_FreeValue(ctx,proto);
  JSValue message=checked(JS_GetPropertyStr(ctx,pending,"message"));text(message);JS_FreeValue(ctx,message);
 }else{emit(3);emit(JS_SameValue(ctx,pending,first));emit(JS_SameValue(ctx,pending,second));}JS_FreeValue(ctx,pending);}
 emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
 emit(rc(input)-input_before);emit(rc(first)-first_before);emit(rc(second)-second_before);JS_FreeValue(ctx,input);
 /* C intrinsic initialization owns shared empty strings; compare scenario owners. */
 emit(rc(first)-first_roots);emit(rc(second)-second_roots);
 emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);flush();
}
int main(void){JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();word(@COUNT@);
 for(int family=0;family<10;family++)for(int kind=0;kind<@KINDS@;kind++)for(int op=0;op<26;op++)run_case(ctx,family,kind,op);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;}
'''

SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.f64
import silk.i32
import silk.i64
import silk.u8
import silk.u16
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader, HeapKind }
import js_core_types { RuntimeState, ContextState, ObjectData, ShapeData }
import js_value { Value }
import js_runtime as runtime
import js_gc as gc
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_bigint { BigInt, BigIntError }
import js_primitives as primitive
import js_primitives { EqualityMode }
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_coercion_host { CoercionHooks }
import js_coercions_test_support as fixture
import js_coercions_test_support { Hooks }
import js_integer_coercions_test_support as transitions
import js_integer_coercions as integer
import js_atom_data as atoms
import js_array_storage_test_support { trap, reference }
unsafe fn rc(value: Value) -> i32 {
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
fn number(value: f64) -> u64 {
  if f64.isNaN(value) { return 0x7ff8000000000000 }
  return f64.toBits(value)
}
effect fn wide(out: &mut ByteBuffer, value: u64) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(u64.toU32(value & 0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(value, 32)))
}
effect fn text(out: &mut ByteBuffer, value: Value) -> () ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i: usize = 0
  while i < Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value, i))) i = i + 1 }
}
unsafe effect fn leaf(rt: *mut HeapHeader, kind: u32) -> Value
  ! OutOfMemoryError | StringLengthError | BigIntError ? &mut Allocator {
  let bits: [u64; @NUMBERS@] = [@SILK_BITS@]
  if kind < @NUMBERS@ { return Value.Float64 { value: f64.fromBits(bits[u32.toUsize(kind)]) } }
  let extra = kind - @NUMBERS@
  if extra == 0 { return Value.Undefined } if extra == 1 { return Value.Null }
  if extra == 2 { return Value.Bool { value: false } } if extra == 3 { return Value.Bool { value: true } }
  if extra == 4 { return run Strings.fromLatin1(b"") }
  if extra == 5 { return run Strings.fromLatin1(b" -0 ") }
  if extra == 6 { return run Strings.fromLatin1(b"7.9") }
  if extra == 7 { return run Strings.fromLatin1(b"4294967295") }
  if extra == 8 { return run Strings.fromLatin1(b"4294967296") }
  if extra == 9 { return run Strings.fromLatin1(b"Infinity") }
  if extra == 10 { return run Strings.fromLatin1(b"NaN") }
  if extra == 11 { return run Strings.fromLatin1(b"0x10") }
  if extra == 12 { let units: [u16; 6] = [32, 160, 32, 55, 32, 12288] return run Strings.fromUtf16(&units) }
  if extra == 13 { let bytes: [u8; 3] = [55, 0, 120] return run Strings.fromLatin1(&bytes) }
  if extra == 14 {
    let description = StringOwner.adopt(run Strings.fromLatin1(b"integer-symbol"))
    let mut anchor = () let state = unsafe HeapCell.payloadMut<RuntimeState, ()>(&mut anchor, rt)
    return run state.atoms.uniqueSymbol(Option<Value>.some(description.get()))
  }
  if extra == 15 { return Value.ShortBigInt { value: 7 } }
  if extra == 17 { return Value.Int { value: -2147483647 - 1 } }
  if extra == 18 { return Value.Int { value: 2147483647 } }
  if extra == 19 { return Value.Int { value: 0 } }
  if extra == 20 { return Value.Int { value: -1 } }
  let big = run BigInt.fromI64(9007199254740993)
  return Value.BigInt { reference: run HeapCell.allocate(HeapKind.BigInt, move big) }
}
struct Outputs { floating: f64, narrow: i32, wideValue: i64, unsigned: u32, index: u64, integerValue: Value, flags: u8 }
unsafe effect fn convert(hooks: &mut Hooks, ctx: *mut HeapHeader, value: Value, op: u32, out: &mut Outputs) -> ()
  ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
  if op == 0 { run unsafe integer.toFloat64(&mut hooks, ctx, &mut out.floating, value) }
  else if op == 1 { run unsafe integer.toFloat64Free(&mut hooks, ctx, &mut out.floating, unsafe value.retained()) }
  else if op == 2 { out.integerValue = run unsafe integer.toIntegerFree(&mut hooks, ctx, unsafe value.retained()) }
  else if op == 3 { run unsafe integer.toInt32Sat(&mut hooks, ctx, &mut out.narrow, value) }
  else if op == 4 { run unsafe integer.toInt32SatFree(&mut hooks, ctx, &mut out.narrow, unsafe value.retained()) }
  else if op == 5 { run unsafe integer.toInt32Clamp(&mut hooks, ctx, &mut out.narrow, value, 0, 10, 10) }
  else if op == 6 { run unsafe integer.toInt32Clamp(&mut hooks, ctx, &mut out.narrow, value, 5, 10, 20) }
  else if op == 7 { run unsafe integer.toInt64Sat(&mut hooks, ctx, &mut out.wideValue, value) }
  else if op == 8 { out.flags = run unsafe integer.toInt64SatFree(&mut hooks, ctx, &mut out.wideValue, unsafe value.retained(), false) }
  else if op == 9 { out.flags = run unsafe integer.toInt64SatF(&mut hooks, ctx, &mut out.wideValue, value) }
  else if op == 10 { out.flags = run unsafe integer.toInt64SatFree(&mut hooks, ctx, &mut out.wideValue, unsafe value.retained(), true) }
  else if op == 11 { run unsafe integer.toInt64Clamp(&mut hooks, ctx, &mut out.wideValue, value, -3, 10, 10) }
  else if op == 12 { run unsafe integer.toInt64Clamp(&mut hooks, ctx, &mut out.wideValue, value, -9223372036854775807 - 1, 9223372036854775807, 9223372036854775807) }
  else if op == 13 { run unsafe integer.toInt64(&mut hooks, ctx, &mut out.wideValue, value) }
  else if op == 14 { run unsafe integer.toInt64Free(&mut hooks, ctx, &mut out.wideValue, unsafe value.retained()) }
  else if op == 15 { run unsafe integer.toInt32(&mut hooks, ctx, &mut out.narrow, value) }
  else if op == 16 { run unsafe integer.toInt32Free(&mut hooks, ctx, &mut out.narrow, unsafe value.retained()) }
  else if op == 17 { run unsafe integer.toUint32(&mut hooks, ctx, &mut out.unsigned, value) }
  else if op == 18 { run unsafe integer.toUint32Free(&mut hooks, ctx, &mut out.unsigned, unsafe value.retained()) }
  else if op == 19 { run unsafe integer.toUint8ClampFree(&mut hooks, ctx, &mut out.narrow, unsafe value.retained()) }
  else if op == 20 || op == 21 { run unsafe integer.toArrayLengthFree(&mut hooks, ctx, &mut out.unsigned, unsafe value.retained(), op == 20) }
  else if op == 22 { run unsafe integer.toIndex(&mut hooks, ctx, &mut out.index, value) }
  else if op == 23 { run unsafe integer.toLengthFree(&mut hooks, ctx, &mut out.wideValue, unsafe value.retained()) }
  else if op == 24 { run unsafe integer.toInt32Clamp(&mut hooks, ctx, &mut out.narrow, value, 5, 10, 2147483647) }
  else if op == 25 { run unsafe integer.toInt64Clamp(&mut hooks, ctx, &mut out.wideValue, value, 5, 10, 20) }
  else { trap() }
}
unsafe fn errorKind(context: *mut HeapHeader, error: Value) -> u32 {
  let anchor = () let object = unsafe HeapCell.payload<ObjectData, ()>(&anchor, reference(error))
  let shape = unsafe HeapCell.payload<ShapeData, ()>(&anchor, object.shape)
  let proto = shape.prototype
  let state = unsafe HeapCell.payload<ContextState, ()>(&anchor, context)
  if Pointer.address<HeapHeader>(proto) == Pointer.address<HeapHeader>(reference(state.nativeErrorPrototypes[1])) { return 1 }
  if Pointer.address<HeapHeader>(proto) == Pointer.address<HeapHeader>(reference(state.nativeErrorPrototypes[4])) { return 2 }
  return trap()
}
unsafe effect fn runCase(out: &mut ByteBuffer, hooks: &mut Hooks, memory: &AllocationObserver,
  context: *mut HeapHeader, family: u32, kind: u32, op: u32) -> ()
  ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
  let rt = unsafe runtime.contextRuntime(context) hooks.clear()
  let first = run unsafe leaf(rt, kind)
  let mut second = Value.Int { value: 7 }
  if (kind & 1) == 0 { second = unsafe first.retained() }
  let firstRoots = unsafe rc(first) let secondRoots = unsafe rc(second)
  let input = run unsafe transitions.make(&mut hooks, memory, context, family, first, second)
  let inputBefore = unsafe rc(input) let firstBefore = unsafe rc(first) let secondBefore = unsafe rc(second)
  let mut outputs = Outputs { floating: 17.25, narrow: 0x12345678, wideValue: 0x1234567812345678,
    unsigned: 0x87654321, index: 0x8765432187654321, integerValue: Value.Exception, flags: 0 }
  let outcome = run Effect.result(unsafe convert(&mut hooks, context, input, op, &mut outputs))
  let mut failed: u32 = 0
  match &outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { .. } => { failed = 1 }
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
  }
  run out.writeU32(failed) run out.writeU32(u8.toU32(outputs.flags))
  let mut bits: u64 = 0 let mut tag: i32 = 0
  if op < 2 { bits = number(outputs.floating) }
  else if op == 2 { tag = outputs.integerValue.tag() if failed == 0 { bits = number(outputs.integerValue.numericValue()) } }
  else if (op >= 3 && op <= 6) || op == 15 || op == 16 || op == 19 || op == 24 { bits = u32.toU64(signed(outputs.narrow)) }
  else if op == 17 || op == 18 || op == 20 || op == 21 { bits = u32.toU64(outputs.unsigned) }
  else if op == 22 { bits = outputs.index }
  else { bits = signedWide(outputs.wideValue) }
  run wide(&mut out, bits) run out.writeU32(signed(tag))
  match move outcome {
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Success { .. } => ()
    Result<(), OutOfMemoryError | StringLengthError | JsException>.Failure { error } => {
      match move error {
        JsException thrown => {
          let pending = unsafe exceptions.take(rt)
          if pending.isObject() {
            run out.writeU32(unsafe errorKind(context, pending))
            let message = StringOwner.adopt(run unsafe hooks.getProperty(context, pending, atoms.JS_ATOM_message))
            run text(&mut out, message.get())
          } else {
            run out.writeU32(3)
            let mut sameFirst: u32 = 0 let mut sameSecond: u32 = 0
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
  }
  run out.writeU32(usize.toU32(hooks.eventCount)) let mut i: usize = 0
  while i < hooks.eventCount { run out.writeU32(hooks.events[i]) i = i + 1 }
  run out.writeU32(signed(unsafe rc(input) - inputBefore))
  run out.writeU32(signed(unsafe rc(first) - firstBefore)) run out.writeU32(signed(unsafe rc(second) - secondBefore))
  unsafe gc.release(&mut hooks, rt, input)
  run out.writeU32(signed(unsafe rc(first) - firstRoots)) run out.writeU32(signed(unsafe rc(second) - secondRoots))
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
      while op < 26 {
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


def records(data):
    if len(data) < 4:
        raise SystemExit('Empty integer oracle output')
    count, = struct.unpack_from('<I', data)
    if count != COUNT:
        raise SystemExit(f'Wrong integer record count: {count}, expected {COUNT}')
    offset = 4
    result = []
    for _ in range(count + 1):
        if offset + 4 > len(data):
            raise SystemExit('Truncated integer record header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated integer record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if offset != len(data) or result[-1] != (0, 0):
        raise SystemExit('Invalid integer teardown ledger or trailing bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    replacements = {'@NUMBERS@': str(len(BITS)), '@KINDS@': str(KINDS), '@COUNT@': str(COUNT),
                    '@C_BITS@': ','.join(f'UINT64_C(0x{x:016x})' for x in BITS),
                    '@SILK_BITS@': ','.join(f'0x{x:016x}' for x in BITS)}
    c_source, silk_source = C_SOURCE, SILK_SOURCE
    for token, value in replacements.items():
        c_source = c_source.replace(token, value)
        silk_source = silk_source.replace(token, value)
    with tempfile.TemporaryDirectory(prefix='silkjs-integer-coercions-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Integer coercions C compilation')
        expected = process([str(temp / 'oracle')], 1200, owner='Integer coercions C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="integer-coercions-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native integer coercions oracle', cwd=temp)
        expected_records, actual_records = records(expected), records(actual)
        for index, (left, right) in enumerate(zip(expected_records, actual_records)):
            if left != right:
                if index == COUNT:
                    label = 'teardown'
                else:
                    op = index % OPERATIONS
                    kind = index // OPERATIONS % KINDS
                    family = index // (OPERATIONS * KINDS)
                    value = f'bits=0x{BITS[kind]:016x}' if kind < len(BITS) else f'primitive={kind-len(BITS)}'
                    label = f'family={family}, {value}, operation={op}'
                raise SystemExit(f'Integer coercion mismatch {index} ({label}):\nC={left}\nSilk={right}')
        print(f'PASS integer coercions: {COUNT} operations, {len(BITS)} binary64 patterns, '
              f'21 other primitives, 10 callback families; failure outputs/flags/errors/owners and zero ledgers; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
