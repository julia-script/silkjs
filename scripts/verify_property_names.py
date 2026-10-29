#!/usr/bin/env python3
"""Compare native own-key enumeration with unchanged pinned QuickJS C.

The host class is a real stored-key/descriptor embedding in both processes, not a
Proxy substitute. Compare UTF-16 names, string/symbol/private kinds, ordering,
enumerability, native callback order, typed failures and retained-edge cleanup.
No allocator-byte thresholds are compared; allocation-failure proofs are native
unit regressions. C is compiled and executed separately, never linked into Silk.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(family, flags, 0) for family in range(12) for flags in range(64)]
CASES += [(1, flags, failure) for failure in (1, 2, 3) for flags in range(64)]
C_SOURCE = r'''
#include "quickjs.c"
static void word(uint32_t x) { for(int i=0;i<4;i++)putchar((x>>(8*i))&255); }
static void text(JSValue v) { JSString *s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i)); }
static JSValue checked(JSValue v) { if(JS_IsException(v))abort();return v; }
static JSAtom atom(JSContext *ctx,const char *s,int kind) {
    if(!kind)return JS_NewAtom(ctx,s);
    JSValue v;
    if(kind==2)v=JS_NewSymbolInternal(ctx,JS_VALUE_GET_STRING(checked(JS_NewString(ctx,s))),JS_ATOM_TYPE_PRIVATE);
    else v=JS_NewSymbol(ctx,s,kind==3);
    v=checked(v);JSAtom a=JS_DupAtom(ctx,js_symbol_to_atom(ctx,v));JS_FreeValue(ctx,v);return a;
}
static void add(JSContext *ctx,JSValue o,JSAtom a,int flags,JSValue value) {
    JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(o),a,flags);if(!p)abort();p->u.value=value;
}
typedef struct { JSAtom atom;int flags,present,seed;JSValue value,getter,setter; } Entry;
typedef struct { int count;Entry entries[8]; } Stored;
static uint32_t events[128];static int event_count,fail_keys,fail_desc;
static void finalizer(JSRuntime *rt,JSValue o) {
    Stored *p=JS_GetOpaque(o,67);if(!p)abort();
    for(int i=0;i<p->count;i++) { Entry *e=&p->entries[i];JS_FreeAtomRT(rt,e->atom);
      JS_FreeValueRT(rt,e->value);JS_FreeValueRT(rt,e->getter);JS_FreeValueRT(rt,e->setter); }
    js_free_rt(rt,p);
}
static void marker(JSRuntime *rt,JSValueConst o,JS_MarkFunc *mark) {
    Stored *p=JS_GetOpaque(o,67);if(!p)abort();
    for(int i=0;i<p->count;i++) { Entry *e=&p->entries[i];JS_MarkValue(rt,e->value,mark);
      JS_MarkValue(rt,e->getter,mark);JS_MarkValue(rt,e->setter,mark); }
}
static int own_keys(JSContext *ctx,JSPropertyEnum **tab,uint32_t *len,JSValueConst o) {
    events[event_count++]=0;
    if(fail_keys) { JS_Throw(ctx,JS_NewInt32(ctx,101));return -1; }
    Stored *p=JS_GetOpaque(o,67);*len=p->count;*tab=js_malloc(ctx,p->count*sizeof(**tab));if(!*tab)return -1;
    for(int i=0;i<p->count;i++) { (*tab)[i].atom=JS_DupAtom(ctx,p->entries[i].atom);(*tab)[i].is_enumerable=p->entries[i].seed; }
    return 0;
}
static int own_desc(JSContext *ctx,JSPropertyDescriptor *d,JSValueConst o,JSAtom a) {
    Stored *p=JS_GetOpaque(o,67);int i;for(i=0;i<p->count;i++)if(p->entries[i].atom==a)break;
    int event=i<p->count?i+1:127;events[event_count++]=event;
    if(event==fail_desc) {JS_Throw(ctx,JS_NewInt32(ctx,202));return -1;}
    if(i==p->count||!p->entries[i].present)return 0;
    Entry *e=&p->entries[i];d->flags=e->flags;d->value=JS_DupValue(ctx,e->value);
    d->getter=JS_DupValue(ctx,e->getter);d->setter=JS_DupValue(ctx,e->setter);return 1;
}
static JSClassExoticMethods exotic={.get_own_property=own_desc,.get_own_property_names=own_keys};
static const JSClassDef definition={.class_name="StoredKeys",.finalizer=finalizer,.gc_mark=marker,.exotic=&exotic};
static void store(JSContext *ctx,JSValue o,JSAtom a,int flags,int present,int seed,JSValue value,JSValue leaf) {
    Stored *p=JS_GetOpaque(o,67);Entry *e=&p->entries[p->count++];
    *e=(Entry){JS_DupAtom(ctx,a),flags,present,seed,JS_DupValue(ctx,value),JS_DupValue(ctx,leaf),JS_DupValue(ctx,leaf)};
}
static void result(JSContext *ctx,JSValue o,int flags) {
    JSPropertyEnum *tab=NULL;uint32_t n=0;int r=JS_GetOwnPropertyNames(ctx,&tab,&n,o,flags);
    if(r<0) {
      JSValue ex=JS_GetException(ctx);
      if(JS_IsNumber(ex)) {word(3);word(JS_VALUE_GET_INT(ex));}
      else {
        JSValue name=checked(JS_GetPropertyStr(ctx,ex,"name"));const char *s=JS_ToCString(ctx,name);
        if(!s)abort();
        if(!strcmp(s,"TypeError"))word(1);
        else if(!strcmp(s,"ReferenceError")) {
          word(2);JSValue message=checked(JS_GetPropertyStr(ctx,ex,"message"));const char *m=JS_ToCString(ctx,message);
          if(!m||strcmp(m,"uninitializedExport is not initialized"))abort();
          JSValue key=checked(JS_NewString(ctx,"uninitializedExport"));text(key);JS_FreeValue(ctx,key);
          JS_FreeCString(ctx,m);JS_FreeValue(ctx,message);
        } else abort();
        JS_FreeCString(ctx,s);JS_FreeValue(ctx,name);
      }
      JS_FreeValue(ctx,ex);if(tab||n)abort();
    } else {
      word(0);word(n);
      for(uint32_t i=0;i<n;i++) {word(JS_AtomGetKind(ctx,tab[i].atom));word(tab[i].is_enumerable);
        JSValue v=checked(JS_AtomToString(ctx,tab[i].atom));text(v);JS_FreeValue(ctx,v);}
      JS_FreePropertyEnum(ctx,tab,n);
    }
    word(event_count);for(int i=0;i<event_count;i++)word(events[i]);
}
static void run_case(JSContext *ctx,int family,int flags,int failure) {
    event_count=0;fail_keys=failure==1;fail_desc=failure==2?4:failure==3?6:0;
    JSValue value=checked(JS_NewString(ctx,"descriptor-value")),leaf=checked(JS_NewObject(ctx));
    JSValue o=JS_NULL;
    if(family==0||family==9||family==10)o=checked(JS_NewObjectProto(ctx,JS_NULL));
    else if(family==1) {o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));Stored *p=js_mallocz(ctx,sizeof(*p));if(!p)abort();JS_SetOpaque(o,p);}
    else if(family>=2&&family<=4) {
      int cls=family==2?JS_CLASS_ARRAY:family==3?JS_CLASS_ARGUMENTS:JS_CLASS_MAPPED_ARGUMENTS;
      o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,cls));JSObject *p=JS_VALUE_GET_OBJ(o);
      if(family==4) {
        p->u.array.u.var_refs=js_malloc(ctx,3*sizeof(JSVarRef*));if(!p->u.array.u.var_refs)abort();
        for(int i=0;i<3;i++) {p->u.array.u.var_refs[i]=js_create_var_ref(ctx,TRUE);if(!p->u.array.u.var_refs[i])abort();}
        p->u.array.count=3;
      } else if(family==3) {
        if(expand_fast_array(ctx,p,3))abort();
        for(int i=0;i<3;i++)p->u.array.u.values[i]=JS_UNDEFINED;
        p->u.array.count=3;
      } else for(int i=0;i<3;i++)if(add_fast_array_element(ctx,p,JS_UNDEFINED,0)<0)abort();
    } else if(family==5||family==8) {
      o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,JS_CLASS_STRING));
      if(family==5)JS_VALUE_GET_OBJ(o)->u.object_data=checked(JS_NewString(ctx,"A\xf0\x9f\x98\x80"));
    } else if(family==6||family==7) {
      JSValue len=JS_NewInt32(ctx,3);o=checked(JS_NewTypedArray(ctx,1,&len,JS_TYPED_ARRAY_UINT8));
      if(family==7) {JSValue buffer=checked(JS_GetTypedArrayBuffer(ctx,o,NULL,NULL,NULL));JS_DetachArrayBuffer(ctx,buffer);JS_FreeValue(ctx,buffer);}
    }
    if(family==0) {
      const char *texts[]={"4294967294","first","symbol","10","hidden","secret","2","4294967295","deleted","global","01","2147483648"};
      int kinds[]={0,0,1,0,0,2,0,0,0,3,0,0};
      for(int i=0;i<12;i++) {JSAtom a=atom(ctx,texts[i],kinds[i]);add(ctx,o,a,i==4?3:7,JS_UNDEFINED);
        if(i==8&&delete_property(ctx,JS_VALUE_GET_OBJ(o),a)<0)abort();JS_FreeAtom(ctx,a);}
    } else if(family==1) {
      JSAtom prefix=atom(ctx,"ordinary",0);add(ctx,o,prefix,3,JS_UNDEFINED);JS_FreeAtom(ctx,prefix);
      add(ctx,o,__JS_AtomFromUInt32(15),7,JS_UNDEFINED);
      const char *texts[]={"9","alpha","symbol","hidden","absent","secret","global","ordinary"};
      int kinds[]={0,0,1,0,0,2,3,0};
      for(int i=0;i<8;i++) {JSAtom a=atom(ctx,texts[i],kinds[i]);store(ctx,o,a,i==3?3:7,i!=4,i%2,value,leaf);JS_FreeAtom(ctx,a);}
    } else if(family==9||family==10) {
      JSAtom a=atom(ctx,"uninitializedExport",0);JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(o),a,JS_PROP_VARREF|(family==9?4:0));
      if(!p)abort();p->u.var_ref=js_create_var_ref(ctx,TRUE);if(!p->u.var_ref)abort();JS_FreeAtom(ctx,a);
    }
    result(ctx,o,flags);JS_FreeValue(ctx,o);
    word(js_rc(JS_VALUE_GET_STRING(value))->ref_count);word(js_rc(JS_VALUE_GET_OBJ(leaf))->ref_count);
    JS_FreeValue(ctx,value);JS_FreeValue(ctx,leaf);
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime();if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
    if(JS_NewClass(rt,67,&definition))abort();
    CALLS
    JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
'''
SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.i32
import silk.collections.list { List }
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.u16
import silk.num.u32
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import js_heap { HeapCell, HeapHeader, HeapKind }
import js_core_types { RuntimeState, ObjectData, ObjectPayload, PropertySlot, PropertyEnum, FastArrayData, TypedArrayCache }
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { AtomKind, StringLengthError, stringReference }
import js_gc as gc
import js_runtime as runtime
import js_object_allocate as objects
import js_array_storage as arrays
import js_array_storage { ArrayLengthError }
import js_array_storage_test_support as storage
import js_array_storage_test_support { reference, rc, trap }
import js_var_refs as varRefs
import js_class_data as classes
import js_property_names as names
import js_property_names { OwnKeysError }
import js_property_names_test_support as fixture
import js_property_names_test_support { Hooks, Entry }
import js_exceptions { JsException }
import js_exceptions as exceptions
struct BorrowedView { bytes: List<u8> }
fn bit(value:bool)->u32 {if value {return 1} return 0}
effect fn text(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i:usize=0
  while i<Strings.length(value) {run out.writeU32(u16.toU32(Strings.codeUnit(value,i))) i=i+1}
}
// Convert failures to an owned result without catching allocation failures.
union Outcome { Keys { keys:List<PropertyEnum> }, Own { error:OwnKeysError }, Thrown }
unsafe effect fn enumerate(hooks:&mut Hooks,ctx:*mut HeapHeader,o:ValueBits,flags:u32)->Outcome
  ! OutOfMemoryError | StringLengthError | OwnKeysError | JsException ? &mut Allocator {
  return Outcome.Keys {keys:run unsafe names.getOwnPropertyNames(&mut hooks,ctx,o,flags)}
}
effect fn ownFailure(error:OwnKeysError)->Outcome {return Outcome.Own {error:move error}}
effect fn callbackFailure(error:JsException)->Outcome {drop error return Outcome.Thrown}
unsafe effect fn result(out:&mut ByteBuffer,hooks:&mut Hooks,ctx:*mut HeapHeader,o:ValueBits,flags:u32)->()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let rt=unsafe runtime.contextRuntime(ctx)
  let outcome=run Effect.catch<JsException>(Effect.catch<OwnKeysError>(unsafe enumerate(&mut hooks,ctx,o,flags),ownFailure),callbackFailure)
  match move outcome {
    Outcome.Keys {keys}=>{
      run out.writeU32(0) run out.writeU32(usize.toU32(keys.length()))
      let anchor=() let state=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
      let mut i:usize=0 while i<keys.length() {
        let item=keys.get(i) let kind=state.atoms.propertyKind(item.atom)
        let code:u32=match kind {AtomKind.String=>0 AtomKind.Private=>2 _=>1}
        run out.writeU32(code) run out.writeU32(bit(item.isEnumerable))
        let value=run state.atoms.toValue(item.atom,true) run text(&mut out,value) Strings.release(value) i=i+1
      }
      drop state unsafe names.releaseNames(rt,move keys)
    }
    Outcome.Own {error}=>{match move error {
      OwnKeysError.NotObject=>{run out.writeU32(1)}
      OwnKeysError.Uninitialized {name}=>{run out.writeU32(2) run text(&mut out,name.get())}
    }}
    Outcome.Thrown=>{
      run out.writeU32(3) let value=unsafe exceptions.take(rt)
      let number=match value {ValueBits.Int {value:n}=>i32.toU32(n) _=>trap()} run out.writeU32(number)
      unsafe gc.release(&mut hooks,rt,value)
    }
  }
  run out.writeU32(usize.toU32(hooks.eventCount)) let mut i:usize=0
  while i<hooks.eventCount {run out.writeU32(hooks.events[i]) i=i+1}
}
unsafe effect fn runCase(out:&mut ByteBuffer,hooks:&mut Hooks,memory:&AllocationObserver,ctx:*mut HeapHeader,
  family:u32,flags:u32,failure:u32)->() ! OutOfMemoryError | StringLengthError | ArrayLengthError ? &mut Allocator {
  let rt=unsafe runtime.contextRuntime(ctx) hooks.eventCount=0 hooks.failKeys=failure==1 hooks.failDescriptor=0
  if failure==2 {hooks.failDescriptor=4} else if failure==3 {hooks.failDescriptor=6}
  let value=run Strings.fromLatin1(b"descriptor-value")
  let leaf=run unsafe objects.withPrototype(&mut hooks,memory,ctx,ValueBits.Null)
  let mut object=ValueBits.Null let mut view=Pointer.null<HeapHeader>()
  if family==0 || family==9 || family==10 {object=run unsafe objects.withPrototype(&mut hooks,memory,ctx,ValueBits.Null)}
  else if family==1 {object=run unsafe fixture.exotic(&mut hooks,memory,ctx)}
  else if family==2 {object=run unsafe arrays.allocateFastArray(&mut hooks,memory,ctx,3)}
  else if family==3 || family==4 {
    let mut cls=classes.JS_CLASS_ARGUMENTS if family==4 {cls=classes.JS_CLASS_MAPPED_ARGUMENTS}
    object=run unsafe objects.withPrototypeClass(&mut hooks,memory,ctx,ValueBits.Null,cls)
    if family==4 {
      let mut i:usize=0 while i<3 {let cell=run unsafe varRefs.createDetached(rt,true) run unsafe storage.appendMapped(object,cell) i=i+1}
    } else {
      let mut anchor=() let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(object))
      match &mut p.payload {ObjectPayload.FastArray {array}=>{let mut i:usize=0 while i<3 {run array.values.append(ValueBits.Undefined) i=i+1}} _=>trap()}
    }
  } else if family==5 || family==8 {
    object=run unsafe objects.withPrototypeClass(&mut hooks,memory,ctx,ValueBits.Null,classes.JS_CLASS_STRING)
    if family==5 {
      let string=run Strings.fromUtf16(&[65,0xd83d,0xde00]) let mut anchor=()
      let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(object)) p.payload=ObjectPayload.Boxed {value:string}
    }
  } else if family==6 || family==7 {
    object=run unsafe objects.withPrototypeClass(&mut hooks,memory,ctx,ValueBits.Null,classes.JS_CLASS_UINT8_ARRAY)
    let mut bytes=List<u8>.make() run bytes.append(1) run bytes.append(2) run bytes.append(3)
    let allocated=run HeapCell.allocate(HeapKind.Auxiliary,BorrowedView {bytes:move bytes}) view=allocated
    let mut anchor=() let backing=unsafe HeapCell.payloadMut<BorrowedView,()>(&mut anchor,allocated)
    let mut pointer: ?*mut u8=Pointer.fromMutRef<u8>(&mut backing.bytes.asMutSlice()[0]) drop backing
    let mut count:u32=3 if family==7 {count=0 pointer=Pointer.null<u8>()}
    let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(object))
    p.payload=ObjectPayload.TypedArray {array:TypedArrayCache {view:allocated,shared:false,cachedData:pointer,count:count,requiresExtensible:false}}
  }
  if family==0 {
    let texts:[&[u8];12]=[b"4294967294",b"first",b"symbol",b"10",b"hidden",b"secret",b"2",b"4294967295",b"deleted",b"global",b"01",b"2147483648"]
    let kinds:[u32;12]=[0,0,1,0,0,2,0,0,0,3,0,0] let mut i:usize=0
    while i<12 {
      let atom=run unsafe fixture.atom(rt,texts[i],kinds[i]) let mut attrs:u8=7 if i==4 {attrs=3}
      run unsafe fixture.add(&mut hooks,rt,object,atom,attrs,PropertySlot.Value {value:ValueBits.Undefined})
      if i==8 {run unsafe fixture.remove(&mut hooks,rt,object,atom)} unsafe fixture.releaseAtom(rt,atom) i=i+1
    }
  } else if family==1 {
    let ordinary=run unsafe fixture.atom(rt,b"ordinary",0)
    run unsafe fixture.add(&mut hooks,rt,object,ordinary,3,PropertySlot.Value {value:ValueBits.Undefined}) unsafe fixture.releaseAtom(rt,ordinary)
    run unsafe fixture.add(&mut hooks,rt,object,0x8000000f,7,PropertySlot.Value {value:ValueBits.Undefined})
    let texts:[&[u8];8]=[b"9",b"alpha",b"symbol",b"hidden",b"absent",b"secret",b"global",b"ordinary"]
    let kinds:[u32;8]=[0,0,1,0,0,2,3,0] let mut i:usize=0
    while i<8 {
      let atom=run unsafe fixture.atom(rt,texts[i],kinds[i]) let mut attrs:u32=7 if i==3 {attrs=3}
      run unsafe fixture.store(rt,object,Entry {atom:atom,flags:attrs,present:i!=4,seedEnumerable:i%2!=0,value:value,getter:leaf,setter:leaf})
      unsafe fixture.releaseAtom(rt,atom) i=i+1
    }
  } else if family==9 || family==10 {
    let atom=run unsafe fixture.atom(rt,b"uninitializedExport",0) let cell=run unsafe varRefs.createDetached(rt,true)
    let mut attrs:u8=32 if family==9 {attrs=36}
    run unsafe fixture.add(&mut hooks,rt,object,atom,attrs,PropertySlot.VarRef {reference:cell}) unsafe fixture.releaseAtom(rt,atom)
  }
  run unsafe result(&mut out,&mut hooks,ctx,object,flags)
  match Pointer.nonNullMut<HeapHeader>(view) {
    Option<*mut HeapHeader>.Some {value:owned}=>{
      let mut anchor=() let p=unsafe HeapCell.payloadMut<ObjectData,()>(&mut anchor,reference(object)) p.payload=ObjectPayload.Empty drop p
      unsafe HeapCell.destroy<BorrowedView>(owned)
    }
    Option<*mut HeapHeader>.None=>()
  }
  unsafe gc.release(&mut hooks,rt,object)
  run out.writeU32(i32.toU32(unsafe rc(stringReference(value)))) run out.writeU32(i32.toU32(unsafe rc(reference(leaf))))
  unsafe gc.release(&mut hooks,rt,value) unsafe gc.release(&mut hooks,rt,leaf)
}
effect fn probe(out:&mut ByteBuffer)->AllocationObserver ! OutOfMemoryError | StringLengthError | ArrayLengthError ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe fixture.register(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks.make()
  CALLS
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory) return move observer
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | ArrayLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make() let mut writer=StdoutWriter.make()
  let ledger=run probe(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer) drop out
  if ledger.stats().usedBytes!=0 || ledger.stats().allocationCount!=0 {trap()} return 0
}
'''


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
    c_calls = '\n'.join(f'word({i});run_case(ctx,{family},{flags},{failure});' for i, (family, flags, failure) in enumerate(CASES))
    s_calls = '\n'.join(f'run out.writeU32({i}) run unsafe runCase(&mut out,&mut hooks,&observer,ctx,{family},{flags},{failure}) |> Effect.provideMut<Allocator>(&mut memory)' for i, (family, flags, failure) in enumerate(CASES))
    with tempfile.TemporaryDirectory(prefix='silkjs-property-names-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Property names C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Property names C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="property-names-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native property names oracle', cwd=temp)
        if not expected or len(expected) % 4:
            raise SystemExit('Invalid C property-name output')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                a, b = expected[offset:offset+4], actual[offset:offset+4]
                if a != b:
                    raise SystemExit(f'Property names word {offset//4}: C={a.hex()} Silk={b.hex()}; byte lengths={len(expected)}/{len(actual)}')
        print(f'PASS property names: {len(CASES)} cases, {len(actual)//4} ordered words; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
