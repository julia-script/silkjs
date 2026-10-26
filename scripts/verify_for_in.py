#!/usr/bin/env python3
"""For-in native vs pinned unchanged QuickJS, in separate executables.

Compares keys, completion, pending values, uncatchability, exact host callback
order and two independent empty allocation ledgers. Allocation ordinals are swept
independently: Silk and C intentionally have different allocation topologies.
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
CASES = [(kind, mode, 0) for kind in range(3) for mode in range(8)]
CASES += [(kind, mode, 0) for kind in (3, 6) for mode in range(9)]
CASES += [(4, mode, fail) for mode in range(5) for fail in range(20)]
CASES += [(5, 0, 0), (5, 1, 0), (7, 0, 0)]
C_SOURCE = r'''
#include "quickjs.c"
#include <stddef.h>
#undef malloc
#undef free
#undef realloc
static void word(uint32_t x) { for(int i=0;i<4;i++)putchar((x>>(8*i))&255); }
static JSValue checked(JSValue v) { if(JS_IsException(v))abort();return v; }
typedef union { max_align_t alignment; size_t size; } Allocation;
static size_t live_count,live_bytes;
static int armed,remaining,failures;
static int refuse(void) { if(!armed)return 0;if(remaining){remaining--;return 0;}armed=0;failures++;return 1; }
static void *allocate(JSMallocState *s,size_t n) {
  if(refuse())return NULL;
  Allocation *p=malloc(sizeof(*p)+n);if(!p)return NULL;p->size=n;
  s->malloc_count++;s->malloc_size+=n;live_count++;live_bytes+=n;return p+1;
}
static void release(JSMallocState *s,void *v) {
  if(!v)return;Allocation *p=(Allocation*)v-1;
  s->malloc_count--;s->malloc_size-=p->size;live_count--;live_bytes-=p->size;free(p);
}
static void *resize(JSMallocState *s,void *v,size_t n) {
  if(!v)return allocate(s,n);if(!n){release(s,v);return NULL;}if(refuse())return NULL;
  Allocation *p=(Allocation*)v-1;size_t old=p->size;p=realloc(p,sizeof(*p)+n);if(!p)return NULL;
  p->size=n;s->malloc_size=s->malloc_size-old+n;live_bytes=live_bytes-old+n;return p+1;
}
static size_t usable(const void *v) {return v?((const Allocation*)v-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
typedef struct {JSAtom atom;int flags,present;} Entry;
typedef struct {JSValue prototype;int count;Entry entries[3];} Stored;
static uint32_t events[128];static int count,fail_at,stop,finalized;
static JSValue reenter;
static int event(JSContext *ctx,int code) {
  if(count>=128)abort();events[count++]=code;JS_RunGC(ctx->rt);
  if(JS_IsObject(reenter)&&JS_GetOwnPropertyInternal(ctx,NULL,JS_VALUE_GET_OBJ(reenter),__JS_AtomFromUInt32(0))<0)abort();
  if(fail_at&&count==fail_at){JS_Throw(ctx,JS_NewInt32(ctx,701));return -1;}return 0;
}
static void finalize(JSRuntime *rt,JSValue o) {
  Stored *p=JS_GetOpaque(o,69);if(!p)return;finalized++;
  JS_FreeValueRT(rt,p->prototype);for(int i=0;i<p->count;i++)JS_FreeAtomRT(rt,p->entries[i].atom);js_free_rt(rt,p);
}
static void mark(JSRuntime *rt,JSValueConst o,JS_MarkFunc *mark_func) {
  Stored *p=JS_GetOpaque(o,69);if(p)JS_MarkValue(rt,p->prototype,mark_func);
}
static int keys(JSContext *ctx,JSPropertyEnum **out,uint32_t *len,JSValueConst o) {
  if(event(ctx,1))return -1;Stored *p=JS_GetOpaque(o,69);uint32_t n=0;
  for(int i=0;i<p->count;i++)n+=p->entries[i].present;
  JSPropertyEnum *tab=js_malloc(ctx,sizeof(*tab)*n);if(!tab)return -1;uint32_t j=0;
  for(int i=0;i<p->count;i++)if(p->entries[i].present)tab[j++]=(JSPropertyEnum){.atom=JS_DupAtom(ctx,p->entries[i].atom),.is_enumerable=0};
  *out=tab;*len=n;return 0;
}
static int own(JSContext *ctx,JSPropertyDescriptor *out,JSValueConst o,JSAtom atom) {
  if(event(ctx,2))return -1;Stored *p=JS_GetOpaque(o,69);
  for(int i=0;i<p->count;i++)if(p->entries[i].present&&p->entries[i].atom==atom){
    if(out)*out=(JSPropertyDescriptor){.flags=p->entries[i].flags,.value=JS_NULL,.getter=JS_UNDEFINED,.setter=JS_UNDEFINED};return 1;
  }return 0;
}
static JSValue prototype(JSContext *ctx,JSValueConst o) {
  if(event(ctx,3))return JS_EXCEPTION;Stored *p=JS_GetOpaque(o,69);return JS_DupValue(ctx,p->prototype);
}
static int interrupt(JSRuntime *rt,void *opaque) {
  if(count>=128)abort();events[count++]=4;JS_RunGC(rt);return stop;
}
static void set_proto(JSContext *ctx,JSValue o,JSValue proto) {
  Stored *p=JS_GetOpaque(o,69);JSValue old=p->prototype;p->prototype=JS_DupValue(ctx,proto);JS_FreeValue(ctx,old);
}
static JSValue exotic(JSContext *ctx,JSValue proto,Entry *entries,int n) {
  JSValue o=checked(JS_NewObjectProtoClass(ctx,JS_NULL,69));Stored *p=js_mallocz(ctx,sizeof(*p));if(!p)abort();
  p->prototype=JS_DupValue(ctx,proto);p->count=n;for(int i=0;i<n;i++){p->entries[i]=entries[i];p->entries[i].atom=JS_DupAtom(ctx,entries[i].atom);}JS_SetOpaque(o,p);return o;
}
static void put(JSContext *ctx,JSValue o,JSAtom atom,int flags) {if(JS_DefinePropertyValue(ctx,o,atom,JS_NULL,flags)!=1)abort();}
static int output(JSContext *ctx,JSValue it) {
  JSValue sp[3]={it,JS_UNDEFINED,JS_UNDEFINED};int ret=js_for_in_next(ctx,sp+1);
  int done=ret<0?1:JS_ToBool(ctx,sp[2]);JSValue v=ret<0?JS_EXCEPTION:sp[1];word(done);
  if(JS_IsException(v))word(0xfffffffe);else if(JS_IsUndefined(v))word(0xffffffff);
  else {JSString *s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(s->is_wide_char?s->u.str16[i]:s->u.str8[i]);}
  int end=done||JS_IsException(v);JS_FreeValue(ctx,v);return end;
}
static void setup(JSRuntime *rt,JSContext *ctx) {
  static const JSClassExoticMethods methods={.get_own_property=own,.get_own_property_names=keys,.get_prototype=prototype};
  JSClassDef def={.class_name="ForInHost",.finalizer=finalize,.gc_mark=mark,.exotic=&methods};
  if(JS_NewClass(rt,69,&def))abort();JS_SetInterruptHandler(rt,interrupt,NULL);
}
static void run_case(int kind,int mode,int failure) {
  count=fail_at=stop=finalized=0;reenter=JS_UNDEFINED;
  JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();setup(rt,ctx);
  JSAtom a=JS_NewAtom(ctx,"a"),b=JS_NewAtom(ctx,"b"),c=JS_NewAtom(ctx,"c"),dup=JS_NewAtom(ctx,"dup"),hidden=JS_NewAtom(ctx,"hidden"),late=JS_NewAtom(ctx,"late");
  JSValue sym=checked(JS_NewSymbol(ctx,"symbol",0));JSAtom symbol=JS_ValueToAtom(ctx,sym);JS_FreeValue(ctx,sym);
  JSValue grand=checked(JS_NewObjectProto(ctx,JS_NULL)),proto=checked(JS_NewObjectProto(ctx,grand)),o=JS_NULL,it=JS_UNDEFINED;
  put(ctx,grand,dup,7);put(ctx,grand,c,7);put(ctx,proto,__JS_AtomFromUInt32(0),7);put(ctx,proto,hidden,7);put(ctx,proto,dup,7);put(ctx,proto,b,7);
  if(kind<=2||kind==7){
    if(kind==1||kind==2){o=checked(JS_NewArray(ctx));if(JS_SetPrototype(ctx,o,proto)<0)abort();int n=kind==1?3:6;
      for(int i=0;i<n;i++)if(kind==1||i==0||i==5)if(JS_SetPropertyUint32(ctx,o,i,JS_NULL)<0)abort();
    }else o=checked(JS_NewObjectProto(ctx,proto));
    if(kind==0||kind==2){put(ctx,o,__JS_AtomFromUInt32(2),7);put(ctx,o,__JS_AtomFromUInt32(0),7);put(ctx,o,a,7);put(ctx,o,dup,7);put(ctx,o,symbol,7);}
    put(ctx,o,hidden,3);
    if(kind==7){JS_DeleteProperty(ctx,proto,__JS_AtomFromUInt32(0),0);JS_DeleteProperty(ctx,proto,hidden,0);JS_DeleteProperty(ctx,proto,dup,0);JS_DeleteProperty(ctx,proto,b,0);JS_DeleteProperty(ctx,grand,dup,0);JS_DeleteProperty(ctx,grand,c,0);}
  }else if(kind==3||kind==6){
    int ids[]={JS_CLASS_NUMBER,JS_CLASS_BOOLEAN,JS_CLASS_STRING,JS_CLASS_SYMBOL,JS_CLASS_BIG_INT};for(int i=0;i<5;i++)JS_SetClassProto(ctx,ids[i],JS_DupValue(ctx,proto));
    switch(mode){case 0:o=JS_NULL;break;case 1:o=JS_UNDEFINED;break;case 2:o=JS_NewInt32(ctx,7);break;case 3:o=JS_TRUE;break;case 4:o=__JS_NewFloat64(ctx,-0.0);break;case 5:o=JS_NewBigInt64(ctx,42);break;case 6:o=checked(JS_NewString(ctx,"abc"));break;case 7:o=checked(JS_AtomToValue(ctx,symbol));break;default:o=checked(JS_NewObjectProto(ctx,proto));break;}
  }else {
    Entry entries[]={{a,7,1},{hidden,3,1},{symbol,7,1}};
    if(kind==5){o=exotic(ctx,JS_NULL,entries,0);if(mode==1){JS_FreeValue(ctx,o);o=exotic(ctx,JS_NULL,entries,3);}set_proto(ctx,o,o);stop=1;}
    else o=exotic(ctx,proto,entries,3);
  }
  fail_at=failure;it=kind==6?JS_DupValue(ctx,o):build_for_in_iterator(ctx,JS_DupValue(ctx,o));word(JS_IsException(it));
  if(!JS_IsException(it)){
    reenter=it;int first=output(ctx,it);
    if(kind<=2){
      if(mode==1)JS_DeleteProperty(ctx,o,__JS_AtomFromUInt32(kind==1?1:2),0);
      if(mode==2){put(ctx,o,late,7);put(ctx,proto,late,7);}
      if(mode==3)JS_DefineProperty(ctx,o,kind==1?__JS_AtomFromUInt32(1):a,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_ENUMERABLE);
      if(mode==4)JS_DefineProperty(ctx,proto,b,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_ENUMERABLE);
      if(mode==5)put(ctx,proto,late,7);if(mode==6)JS_DeleteProperty(ctx,o,hidden,0);if(mode==7)JS_DeleteProperty(ctx,proto,dup,0);
    }
    if(kind==4&&!first){Stored *p=JS_GetOpaque(o,69);if(mode==1)p->entries[1].flags=7;if(mode==2)p->entries[1].present=0;if(mode==3)put(ctx,proto,late,7);if(mode==4)set_proto(ctx,o,grand);}
    if(kind==7)put(ctx,proto,late,7);int done=first&&kind!=7,steps=0;
    while(!done&&steps<64){done=output(ctx,it);steps++;}if(steps==64)abort();reenter=JS_UNDEFINED;
  }
  word(0xeeeeeeee);int thrown=0;
  if(!JS_IsUninitialized(rt->current_exception)){JSValue e=JS_GetException(ctx);thrown=JS_IsNumber(e)?JS_VALUE_GET_INT(e):999;JS_FreeValue(ctx,e);}word(thrown);word(rt->current_exception_is_uncatchable);
  word(count);for(int i=0;i<count;i++)word(events[i]);if(kind==5)set_proto(ctx,o,JS_NULL);
  JS_FreeValue(ctx,it);JS_FreeValue(ctx,o);JS_FreeValue(ctx,proto);JS_FreeValue(ctx,grand);
  JSAtom atoms[]={a,b,c,dup,hidden,late,symbol};for(int i=0;i<7;i++)JS_FreeAtom(ctx,atoms[i]);word(finalized);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count);word(live_bytes);if(live_count||live_bytes)abort();
}
/* Occupy existing arena vacancies without changing a byte of quickjs.c. Thus
   every next size-class allocation can reach the real host allocator failpoint.
   These embedding-owned blocks are released after the observed operation. */
static int occupy_arenas(JSRuntime *rt,void **held) {
  int n=0;
  for(int i=0;i<JS_MALLOC_BLOCK_SIZE_COUNT;i++){
    struct list_head *head=&rt->malloc_ctx.free_arena_list[i];
    while(head->next!=head){
      if(n==65536)abort();
      held[n]=js_malloc_rt(rt,js_malloc_block_sizes[i]-sizeof(JSMallocBlockHeader));
      if(!held[n++])abort();
    }
  }return n;
}
static void faults(void) {
  int mask=0;for(int phase=0;phase<3;phase++){int failed=0,success=0;
    for(int ordinal=0;ordinal<64;ordinal++){
      armed=failures=0;count=fail_at=stop=finalized=0;reenter=JS_UNDEFINED;
      JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
      JSValue proto=checked(JS_NewObjectProto(ctx,JS_NULL)),o=checked(JS_NewObjectProto(ctx,proto)),it=JS_UNDEFINED;
      for(int i=0;i<40;i++)put(ctx,phase==2?proto:o,__JS_AtomFromUInt32(i),7);
      if(phase)it=checked(build_for_in_iterator(ctx,JS_DupValue(ctx,o)));
      void *held[65536];int held_count=occupy_arenas(rt,held);
      remaining=ordinal;armed=1;
      if(!phase)it=build_for_in_iterator(ctx,JS_DupValue(ctx,o));
      else {JSValue sp[3]={it,JS_UNDEFINED,JS_UNDEFINED};if(js_for_in_next(ctx,sp+1)>=0)JS_FreeValue(ctx,sp[1]);}
      armed=0;if(failures)failed=1;else success=1;
      JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);JS_FreeValue(ctx,it);
      if(__js_rc(JS_VALUE_GET_PTR(o))->ref_count!=1)abort();
      JS_FreeValue(ctx,o);JS_FreeValue(ctx,proto);
      for(int i=0;i<held_count;i++)js_free_rt(rt,held[i]);
      JS_FreeContext(ctx);JS_FreeRuntime(rt);if(live_count||live_bytes)abort();
    }
    if(!failed||!success)abort();mask=mask*4+3;
  }word(mask);word(live_count);word(live_bytes);
}
int main(void) { CALLS faults();return 0; }
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_prototypes { PrototypeError }
import js_for_in_cases as cases
import js_for_in_faults as faults
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | BigIntError | JsException | PrototypeError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make()
  CALLS
  let result=run unsafe faults.sweep() |> Effect.provideMut<Allocator>(&mut allocator)
  run out.writeU32(result) |> Effect.provideMut<Allocator>(&mut allocator)
  run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
  run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut stdout=StdoutWriter.make()
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut stdout)
  return 0
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
    c_calls = '\n'.join(f'word({i});run_case({kind},{mode},{failure});' for i, (kind, mode, failure) in enumerate(CASES))
    s_calls = '\n'.join(f'run out.writeU32({i}) |> Effect.provideMut<Allocator>(&mut allocator) '
                        f'run unsafe cases.runCase(&mut out,{kind},{mode},{failure}) |> Effect.provideMut<Allocator>(&mut allocator)'
                        for i, (kind, mode, failure) in enumerate(CASES))
    with tempfile.TemporaryDirectory(prefix='silkjs-for-in-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='For-in C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='For-in unchanged C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="for-in-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native for-in oracle', cwd=temp)
        if not expected or len(expected) % 4 or len(actual) % 4:
            raise SystemExit('Invalid for-in output framing')
        if expected[-12:] != struct.pack('<3I', 63, 0, 0) or actual[-12:] != expected[-12:]:
            raise SystemExit('Allocation sweep did not cover both success/failure and empty ledgers in all three phases')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, s = expected[offset:offset+4], actual[offset:offset+4]
                if c != s:
                    raise SystemExit(f'For-in word {offset//4}: C={c.hex()} Silk={s.hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS for-in: {len(CASES)} cases; 192 allocation attempts per implementation; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')
        print('Exact keys/completion/errors/callback order; native and C allocation counts and bytes are zero.')

if __name__ == '__main__':
    main()
