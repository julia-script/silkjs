#!/usr/bin/env python3
"""Exact native/original-C prototype semantics with real registered host storage.

C runs in an isolated executable, never linked into Silk. The final fault witness
records the source's speculative-retain leak BEFORE explicitly releasing that
extra C owner for teardown. Only that named ownership difference is excluded
from equality; all ordinary words and allocation ledgers must match exactly.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
CASES = [(0, flags, proto, mode, 0, 0) for flags in range(4) for proto in range(5) for mode in range(2)]
CASES += [(1, tag, proto, mode, 0, 0) for tag in range(7) for proto in range(3) for mode in range(2)]
CASES += [(2, flags, proto, mode, mask, failure) for flags in range(4) for proto in range(4)
          for mode in range(2) for mask in range(8) for failure in range(4)]
C_SOURCE = r'''
#include "quickjs.c"
#include <stddef.h>
#undef malloc
#undef free
#undef realloc
static void word(uint32_t x) { for(int i=0;i<4;i++)putchar((x>>(8*i))&255); }
static JSValue checked(JSValue v) {if(JS_IsException(v))abort();return v;}
/* Independent underlying allocation ledger, including runtime and arena storage. */
typedef union { max_align_t alignment; size_t size; } Allocation;
static size_t live_count,live_bytes;
static void *allocate(JSMallocState *s,size_t n) {
  if(n>s->malloc_limit || s->malloc_size>s->malloc_limit-n)return NULL;
  Allocation *p=malloc(sizeof(*p)+n);if(!p)return NULL;p->size=n;
  s->malloc_count++;s->malloc_size+=n;live_count++;live_bytes+=n;return p+1;
}
static void release(JSMallocState *s,void *v) {
  if(!v)return;Allocation *p=(Allocation*)v-1;
  s->malloc_count--;s->malloc_size-=p->size;live_count--;live_bytes-=p->size;free(p);
}
static void *resize(JSMallocState *s,void *v,size_t n) {
  if(!v)return allocate(s,n);if(!n){release(s,v);return NULL;}
  Allocation *p=(Allocation*)v-1;size_t old=p->size;
  if(n>s->malloc_limit || s->malloc_size-old>s->malloc_limit-n)return NULL;
  p=realloc(p,sizeof(*p)+n);if(!p)return NULL;p->size=n;
  s->malloc_size=s->malloc_size-old+n;live_bytes=live_bytes-old+n;return p+1;
}
static size_t usable(const void *v) {return v?((const Allocation*)v-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
typedef struct {JSValue prototype;int accepts,extensible,failure;} Stored;
static uint32_t events[128];static int count,finalized;
static void finalize(JSRuntime *rt,JSValue o) {
  Stored *p=JS_GetOpaque(o,67);if(!p)abort();events[count++]=4;finalized++;
  JS_FreeValueRT(rt,p->prototype);js_free_rt(rt,p);
}
static void trace(JSRuntime *rt,JSValueConst o,JS_MarkFunc *mark) {
  Stored *p=JS_GetOpaque(o,67);JS_MarkValue(rt,p->prototype,mark);
}
static JSValue get(JSContext *ctx,JSValueConst o) {
  events[count++]=1;JS_RunGC(ctx->rt);Stored *p=JS_GetOpaque(o,67);
  if(p->failure==1)return JS_Throw(ctx,JS_NewInt32(ctx,101));
  return JS_DupValue(ctx,p->prototype);
}
static int set(JSContext *ctx,JSValueConst o,JSValueConst proto) {
  events[count++]=2;JS_RunGC(ctx->rt);Stored *p=JS_GetOpaque(o,67);
  if(p->failure==2){JS_Throw(ctx,JS_NewInt32(ctx,102));return -1;}
  if(!p->accepts)return 0;JSValue old=p->prototype;p->prototype=JS_DupValue(ctx,proto);JS_FreeValue(ctx,old);return 1;
}
static int extensible(JSContext *ctx,JSValueConst o) {
  events[count++]=3;JS_RunGC(ctx->rt);Stored *p=JS_GetOpaque(o,67);
  if(p->failure==3){JS_Throw(ctx,JS_NewInt32(ctx,103));return -1;}return p->extensible;
}
static int refcount(JSValue v) {return js_rc(JS_VALUE_GET_OBJ(v))->ref_count;}
static int pending(JSContext *ctx) {
  JSValue e=JS_GetException(ctx);if(!JS_IsNumber(e))abort();int n=JS_VALUE_GET_INT(e);JS_FreeValue(ctx,e);return n;
}
static int diagnostic(JSContext *ctx,int *thrown) {
  JSValue e=JS_GetException(ctx);if(JS_IsNumber(e)){*thrown=JS_VALUE_GET_INT(e);JS_FreeValue(ctx,e);return 7;}
  JSValue n=checked(JS_GetPropertyStr(ctx,e,"name")),m=checked(JS_GetPropertyStr(ctx,e,"message"));
  const char *name=JS_ToCString(ctx,n),*message=JS_ToCString(ctx,m);if(!name||!message||strcmp(name,"TypeError"))abort();
  const char *messages[]={"not an object","proxy: bad prototype","prototype is immutable","object is not extensible","circular prototype chain"};
  int code=0;for(int i=0;i<5;i++)if(!strcmp(message,messages[i]))code=i+2;if(!code)abort();
  JS_FreeCString(ctx,name);JS_FreeCString(ctx,message);JS_FreeValue(ctx,n);JS_FreeValue(ctx,m);JS_FreeValue(ctx,e);return code;
}
static int identity(JSValue v,JSValue old,JSValue next,JSValue object,JSValue child) {
  if(JS_IsNull(v))return 0;if(!JS_IsObject(v))abort();void *p=JS_VALUE_GET_PTR(v);
  if(p==JS_VALUE_GET_PTR(old))return 1;if(p==JS_VALUE_GET_PTR(next))return 2;
  if(JS_IsObject(object)&&p==JS_VALUE_GET_PTR(object))return 3;
  if(JS_IsObject(child)&&p==JS_VALUE_GET_PTR(child))return 4;abort();
}
static void get_result(JSContext *ctx,JSValue o,JSValue old,JSValue next,JSValue child,int consuming) {
  JSValue v=consuming?JS_GetPrototypeFree(ctx,JS_DupValue(ctx,o)):JS_GetPrototype(ctx,o);
  if(JS_IsException(v)){word(7);word(0);word(pending(ctx));}
  else {word(1);word(identity(v,old,next,o,child));word(0);JS_FreeValue(ctx,v);}
}
static void run_case(int family,int flags,int proto,int mode,int mask,int failure) {
  count=finalized=0;JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
  JSClassExoticMethods methods={.get_prototype=(mask&1)?get:NULL,.set_prototype=(mask&2)?set:NULL,.is_extensible=(mask&4)?extensible:NULL};
  JSClassDef definition={.class_name="StoredPrototype",.finalizer=finalize,.gc_mark=trace,.exotic=&methods};
  if(JS_NewClass(rt,67,&definition))abort();
  JSValue old=checked(JS_NewObjectProto(ctx,JS_NULL)),next=checked(JS_NewObjectProto(ctx,JS_NULL)),o=JS_NULL,child=JS_NULL;
  if(family==0) {
    o=checked(JS_NewObjectProto(ctx,old));JSObject *p=JS_VALUE_GET_OBJ(o);
    p->has_immutable_prototype=flags&1;p->extensible=!!(flags&2);p->is_std_array_prototype=1;
    if(proto==3)child=checked(JS_NewObjectProto(ctx,o));
  } else if(family==1) {
    int classes[]={JS_CLASS_NUMBER,JS_CLASS_BOOLEAN,JS_CLASS_STRING,JS_CLASS_SYMBOL,JS_CLASS_BIG_INT};
    for(int i=0;i<5;i++)JS_SetClassProto(ctx,classes[i],JS_DupValue(ctx,old));
    switch(flags) {case 0:o=JS_NULL;break;case 1:o=JS_UNDEFINED;break;case 2:o=JS_NewInt32(ctx,7);break;
      case 3:o=JS_TRUE;break;case 4:o=__JS_NewFloat64(ctx,-0.0);break;case 5:o=JS_NewBigInt64(ctx,8);break;case 6:o=checked(JS_NewString(ctx,"primitive"));break;}
  } else {
    o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored *p=js_mallocz(ctx,sizeof(*p));if(!p)abort();
    *p=(Stored){JS_DupValue(ctx,old),!!(flags&1),!!(flags&2),failure};JS_SetOpaque(o,p);
    JSObject *q=JS_VALUE_GET_OBJ(o);q->has_immutable_prototype=1;q->extensible=0;q->is_std_array_prototype=1;
  }
  JSValue proposed=JS_NULL;
  if(proto==1)proposed=next;
  else if(proto==2)proposed=family==1?JS_NewInt32(ctx,0):o;
  else if(proto==3)proposed=family==0?child:JS_NewInt32(ctx,0);
  else if(proto==4)proposed=JS_NewInt32(ctx,0);
  int thrown=0,result=JS_SetPrototypeInternal(ctx,o,proposed,mode);
  if(result<0)result=diagnostic(ctx,&thrown);word(result);word(thrown);
  get_result(ctx,o,old,next,child,0);get_result(ctx,o,old,next,child,1);
  result=JS_IsExtensible(ctx,o);if(result<0){word(7);word(pending(ctx));}else{word(result);word(0);}
  word(JS_IsObject(o)?JS_VALUE_GET_OBJ(o)->is_std_array_prototype:0);
  word(refcount(old));word(refcount(next));word(count);for(int i=0;i<count;i++)word(events[i]);
  JS_FreeValue(ctx,child);JS_FreeValue(ctx,o);JS_RunGC(rt);word(finalized);word(refcount(old));word(refcount(next));
  JS_FreeValue(ctx,old);JS_FreeValue(ctx,next);JS_FreeContext(ctx);JS_FreeRuntime(rt);
  word(live_count);word(live_bytes);if(live_count||live_bytes)abort();
}
static void oom_witness(void) {
  JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
  JSValue next=checked(JS_NewObjectProto(ctx,JS_NULL)),o=checked(JS_NewObjectProto(ctx,JS_NULL));
  /* Force a large shape so the runtime's small-block arena cannot satisfy the
     clone while the underlying allocator refuses every allocation. */
  for(int i=0;i<100;i++){JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(o),__JS_AtomFromUInt32(i),7);if(!p)abort();p->u.value=JS_UNDEFINED;}
  JSObject *object=JS_VALUE_GET_OBJ(o);JSShape *shape=js_dup_shape(object->shape);
  if(!shape->is_hashed||js_rc(shape)->ref_count!=2)abort();object->is_std_array_prototype=1;
  int before=refcount(next);JS_SetMemoryLimit(rt,0);
  int result=JS_SetPrototype(ctx,o,next);int after=refcount(next);
  /* Capture actual source behavior before normalization, with no source edits. */
  word(0x4f4f4d);word(before);word(after);word(result==-1?8:1);word(object->shape==shape);word(object->is_std_array_prototype);
  JS_SetMemoryLimit(rt,(size_t)-1);JSValue exception=JS_GetException(ctx);JS_FreeValue(ctx,exception);
  if(result!=-1||after!=before+1||object->shape!=shape)abort();
  /* Explicit TEARDOWN ONLY normalization: consume the leaked speculative owner. */
  JS_FreeValue(ctx,next);js_free_shape(rt,shape);JS_FreeValue(ctx,o);JS_FreeValue(ctx,next);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();
}
int main(void) {CALLS oom_witness();return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.i32
import silk.pointer { Pointer }
import silk.u32
import silk.usize
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader }
import js_core_types { ObjectData, EXOTIC_GET_PROTOTYPE, EXOTIC_SET_PROTOTYPE, EXOTIC_IS_EXTENSIBLE }
import js_value { Value }
import js_strings { Strings }
import js_string_types { StringLengthError }
import js_gc as gc
import js_runtime as runtime
import js_object_allocate as objects
import js_class_data as classes
import js_prototypes as prototypes
import js_prototypes_test_support as fixture
import js_prototypes_test_support { Hooks }
import js_array_storage_test_support { FaultAllocator, reference, rc, shape, trap }
import js_exceptions { JsException }
import js_exceptions as exceptions
fn bit(value:bool)->u32 {if value{return 1}return 0}
fn same(a:Value,b:Value)->bool {
  return a.isObject() && b.isObject() && Pointer.address<HeapHeader>(reference(a))==Pointer.address<HeapHeader>(reference(b))
}
fn identity(v:Value,old:Value,next:Value,object:Value,child:Value)->u32 {
  if v.tag()==2{return 0}if same(v,old){return 1}if same(v,next){return 2}
  if same(v,object){return 3}if same(v,child){return 4}return trap()
}
unsafe fn pending(rt:*mut HeapHeader)->u32 {
  let v=unsafe exceptions.take(rt)
  return match v {Value.Int {value}=>i32.toU32(value) _=>trap()}
}
effect fn failedGet(error:JsException)->Value {drop error return Value.Exception}
effect fn failedExt(error:JsException)->u32 {drop error return 7}
unsafe effect fn ext(hooks:&mut Hooks,ctx:*mut HeapHeader,o:Value)->u32
  ! OutOfMemoryError | JsException ? &mut Allocator {
  return bit(run unsafe prototypes.isExtensible(&mut hooks,ctx,o))
}
unsafe effect fn getResult(out:&mut ByteBuffer,hooks:&mut Hooks,ctx:*mut HeapHeader,o:Value,
  old:Value,next:Value,child:Value,consuming:bool)->() ! OutOfMemoryError ? &mut Allocator {
  let mut v=Value.Null
  if consuming {v=run Effect.catch<JsException>(unsafe prototypes.getPrototypeFree(&mut hooks,ctx,unsafe o.retained()),failedGet)}
  else {v=run Effect.catch<JsException>(unsafe prototypes.getPrototype(&mut hooks,ctx,o),failedGet)}
  let rt=unsafe runtime.contextRuntime(ctx)
  if v.isException() {run out.writeU32(7) run out.writeU32(0) run out.writeU32(unsafe pending(rt))}
  else {run out.writeU32(1) run out.writeU32(identity(v,old,next,o,child)) run out.writeU32(0) unsafe gc.release(&mut hooks,rt,v)}
}
unsafe effect fn caseBody(out:&mut ByteBuffer,memory:&AllocationObserver,family:u32,flags:u32,proto:u32,mode:bool,mask:u32,failure:u32)->()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let rt=run runtime.allocateRuntimeStorage(0)
  let ctx=run unsafe runtime.allocateContextStorage(rt)
  let mut hooks=Hooks.make()
  hooks.collectInCallback=true
  let mut methods:u16=0
  if (mask & 1)!=0 {methods=methods | EXOTIC_GET_PROTOTYPE}
  if (mask & 2)!=0 {methods=methods | EXOTIC_SET_PROTOTYPE}
  if (mask & 4)!=0 {methods=methods | EXOTIC_IS_EXTENSIBLE}
  run unsafe fixture.register(rt,methods)
  let old=run unsafe objects.withPrototype(&mut hooks,memory,ctx,Value.Null)
  let next=run unsafe objects.withPrototype(&mut hooks,memory,ctx,Value.Null)
  let mut o=Value.Null let mut child=Value.Null
  if family==0 {
    o=run unsafe objects.withPrototype(&mut hooks,memory,ctx,old)
    let mut anchor=() let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(o))
    p.hasImmutablePrototype=(flags & 1)!=0 p.extensible=(flags & 2)!=0 p.isStandardArrayPrototype=true
    drop p
    if proto==3 {child=run unsafe objects.withPrototype(&mut hooks,memory,ctx,o)}
  } else if family==1 {
    let ids=[classes.JS_CLASS_NUMBER,classes.JS_CLASS_BOOLEAN,classes.JS_CLASS_STRING,classes.JS_CLASS_SYMBOL,classes.JS_CLASS_BIG_INT]
    let mut i:usize=0 while i<ids.length {unsafe runtime.setClassPrototype(&mut hooks,ctx,ids[i],unsafe old.retained()) i=i+1}
    o=match flags {0=>Value.Null 1=>Value.Undefined 2=>Value.Int {value:7} 3=>Value.Bool {value:true}
      4=>Value.Float64 {value:-0.0} 5=>Value.ShortBigInt {value:8} _=>run Strings.fromLatin1(b"primitive")}
  } else {
    o=run unsafe fixture.exotic(&mut hooks,memory,ctx,old,(flags & 1)!=0,(flags & 2)!=0,failure)
    let mut anchor=() let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(o))
    p.hasImmutablePrototype=true p.extensible=false p.isStandardArrayPrototype=true
  }
  let mut proposed=Value.Null
  if proto==1 {proposed=next}
  else if proto==2 {proposed=o if family==1 {proposed=Value.Int {value:0}}}
  else if proto==3 {proposed=child if family!=0 {proposed=Value.Int {value:0}}}
  else if proto==4 {proposed=Value.Int {value:0}}
  let result=run unsafe fixture.setResult(&mut hooks,ctx,o,proposed,mode)
  run out.writeU32(result)
  let mut thrown:u32=0 if result==7 {thrown=unsafe pending(rt)} run out.writeU32(thrown)
  run unsafe getResult(&mut out,&mut hooks,ctx,o,old,next,child,false)
  run unsafe getResult(&mut out,&mut hooks,ctx,o,old,next,child,true)
  let query=run Effect.catch<JsException>(unsafe ext(&mut hooks,ctx,o),failedExt)
  run out.writeU32(query)
  let mut queryThrown:u32=0 if query==7 {queryThrown=unsafe pending(rt)} run out.writeU32(queryThrown)
  let mut standard=false
  if o.isObject() {let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference(o)) standard=p.isStandardArrayPrototype}
  run out.writeU32(bit(standard)) run out.writeU32(i32.toU32(unsafe rc(reference(old))))
  run out.writeU32(i32.toU32(unsafe rc(reference(next)))) run out.writeU32(usize.toU32(hooks.eventCount))
  let mut e:usize=0 while e<hooks.eventCount {run out.writeU32(hooks.events[e]) e=e+1}
  unsafe gc.release(&mut hooks,rt,child) unsafe gc.release(&mut hooks,rt,o) run unsafe gc.collect(&mut hooks,rt,true)
  run out.writeU32(usize.toU32(hooks.finalized)) run out.writeU32(i32.toU32(unsafe rc(reference(old))))
  run out.writeU32(i32.toU32(unsafe rc(reference(next))))
  unsafe gc.release(&mut hooks,rt,old) unsafe gc.release(&mut hooks,rt,next)
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
unsafe effect fn runCase(out:&mut ByteBuffer,family:u32,flags:u32,proto:u32,mode:bool,mask:u32,failure:u32)->()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  // Allocate serialization separately, otherwise its live buffer contaminates the runtime ledger.
  let mut data=ByteBuffer.make()
  run data.reserve(256)
  run unsafe caseBody(&mut data,&observer,family,flags,proto,mode,mask,failure) |> Effect.provideMut<Allocator>(&mut memory)
  run out.appendSlice(data.asSlice())
  run out.writeU32(usize.toU32(observer.stats().allocationCount)) run out.writeU32(usize.toU32(observer.stats().usedBytes))
  if observer.stats().allocationCount!=0 || observer.stats().usedBytes!=0 {trap()}
}
effect fn oom(error:OutOfMemoryError)->u32 {drop error return 8}
unsafe effect fn witness(out:&mut ByteBuffer)->() ! OutOfMemoryError ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks.make()
  let next=run unsafe objects.withPrototype(&mut hooks,&observer,ctx,Value.Null) |> Effect.provideMut<Allocator>(&mut memory)
  let object=run unsafe objects.withPrototype(&mut hooks,&observer,ctx,Value.Null) |> Effect.provideMut<Allocator>(&mut memory)
  let shapeNode=unsafe shape(object)
  unsafe HeapCell.retain(shapeNode)
  let mut anchor=() let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(object)) p.isStandardArrayPrototype=true drop p
  let before=unsafe rc(reference(next))
  let mut fault=FaultAllocator {parent:move memory,remaining:0}
  let result=run Effect.catch<OutOfMemoryError>(unsafe fixture.setResult(&mut hooks,ctx,object,next,true),oom)
    |> Effect.provideMut<Allocator>(&mut fault)
  let after=unsafe rc(reference(next))
  run out.writeU32(0x4f4f4d) run out.writeU32(i32.toU32(before)) run out.writeU32(i32.toU32(after)) run out.writeU32(result)
  run out.writeU32(bit(Pointer.address<HeapHeader>(unsafe shape(object))==Pointer.address<HeapHeader>(shapeNode)))
  let data=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference(object)) run out.writeU32(bit(data.isStandardArrayPrototype)) drop data
  unsafe gc.releaseHeader(&mut hooks,rt,shapeNode) unsafe gc.release(&mut hooks,rt,object) unsafe gc.release(&mut hooks,rt,next)
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut fault)
  run out.writeU32(usize.toU32(observer.stats().allocationCount)) run out.writeU32(usize.toU32(observer.stats().usedBytes))
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider()
  let mut out=ByteBuffer.make()
  CALLS
  run unsafe witness(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut stdout=StdoutWriter.make()
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut stdout)
  return 0
}
'''


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
    c_calls = '\n'.join(f'word({i});run_case({",".join(map(str, case))});' for i, case in enumerate(CASES))
    s_calls = '\n'.join(f'run out.writeU32({i}) |> Effect.provideMut<Allocator>(&mut allocator) '
                        f'run unsafe runCase(&mut out,{family},{flags},{proto},{str(bool(mode)).lower()},{mask},{failure}) '
                        f'|> Effect.provideMut<Allocator>(&mut allocator)'
                        for i, (family, flags, proto, mode, mask, failure) in enumerate(CASES))
    with tempfile.TemporaryDirectory(prefix='silkjs-prototypes-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Prototype C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Prototype C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="prototypes-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native prototype oracle', cwd=temp)
        if len(expected) < 32 or len(actual) < 32 or len(expected) % 4 or len(actual) % 4:
            raise SystemExit('Invalid prototype output')
        source_witness, native_witness = struct.unpack('<8I', expected[-32:]), struct.unpack('<8I', actual[-32:])
        if source_witness != (0x4f4f4d, 1, 2, 8, 1, 1, 0, 0):
            raise SystemExit(f'Original-C OOM witness changed: {source_witness}')
        if native_witness != (0x4f4f4d, 1, 1, 8, 1, 1, 0, 0):
            raise SystemExit(f'Native OOM cleanup witness failed: {native_witness}')
        if actual[:-32] != expected[:-32]:
            for offset in range(0, max(len(actual), len(expected))-32, 4):
                c, s = expected[offset:offset+4], actual[offset:offset+4]
                if c != s:
                    raise SystemExit(f'Prototype word {offset//4}: C={c.hex()} Silk={s.hex()}; lengths={len(expected)}/{len(actual)}')
            raise SystemExit('Prototype output length mismatch')
        print(f'PASS prototypes: {len(CASES)} cases; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')
        print('OOM witness before teardown normalization: C prototype refcount 1->2; native 1->1. '
              'C-only leaked owner explicitly released after observation; both allocation ledgers zero. '
              'Only this documented witness differs; ordinary semantics compare exactly.')


if __name__ == '__main__':
    main()
