#!/usr/bin/env python3
"""Compare native extensibility transitions with the pinned independent C engine."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
CASES = [(0, 0, kind, 1, 0, 1, 0, 0) for kind in range(7)]
CASES += [(1, 0, 0, initial, 0, 1, 0, 0) for initial in range(2)]
CASES += [(2, 0, 0, initial, mask, accepts, failure, 0)
          for initial in range(2) for mask in range(4)
          for accepts in range(2) for failure in (0, 5)]
CASES += [(3, cls, kind, initial, 0, 1, 0, detached)
          for cls in range(12) for kind in range(5) for initial in range(2)
          for detached in (range(2) if kind < 3 else range(1))]
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes;
static void *allocate(JSMallocState *s,size_t n) {
 Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;
 live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static JSValue checked(JSValue v){if(JS_IsException(v))abort();return v;}
typedef struct {int accepts,extensible,failure;} State;
static int events;
static void finalize(JSRuntime *rt,JSValue v){js_free_rt(rt,JS_GetOpaque(v,67));}
static int extensible(JSContext *ctx,JSValueConst v){events++;JS_RunGC(ctx->rt);return ((State*)JS_GetOpaque(v,67))->extensible;}
static int prevent(JSContext *ctx,JSValueConst v){
 events++;JS_RunGC(ctx->rt);State *s=JS_GetOpaque(v,67);
 if(s->failure==5){JS_Throw(ctx,JS_NewInt32(ctx,105));return -1;}
 if(!s->accepts)return 0;s->extensible=0;return 1;
}
static int pending(JSContext *ctx){
 if(!JS_HasException(ctx))return 0;JSValue e=JS_GetException(ctx);
 if(JS_VALUE_GET_TAG(e)!=JS_TAG_INT)abort();int n=JS_VALUE_GET_INT(e);JS_FreeValue(ctx,e);return n;
}
static int refs(JSValueConst v){return JS_VALUE_GET_TAG(v)<0?__js_rc(JS_VALUE_GET_PTR(v))->ref_count:0;}
static void one(int family,int cls,int kind,int initial,int mask,int accepts,int failure,int detached){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 events=0;JSValue v=JS_UNDEFINED;
 JSClassExoticMethods methods={.is_extensible=(mask&1)?extensible:NULL,.prevent_extensions=(mask&2)?prevent:NULL};
 if(family==0){
  switch(kind){case 0:v=JS_NULL;break;case 1:break;case 2:v=JS_NewInt32(ctx,19);break;
  case 3:v=JS_TRUE;break;case 4:v=__JS_NewFloat64(ctx,-0.0);break;
  case 5:v=checked(JS_NewBigInt64(ctx,21));break;default:v=checked(JS_NewString(ctx,"value"));}
 }else if(family==1){v=checked(JS_NewObjectProto(ctx,JS_NULL));}
 else if(family==2){
  JSClassDef definition={.class_name="StoredPrototype",.finalizer=finalize,.exotic=&methods};
  if(JS_NewClass(rt,67,&definition))abort();v=checked(JS_NewObjectProtoClass(ctx,JS_NULL,67));
  State *s=js_malloc(ctx,sizeof(*s));if(!s)abort();*s=(State){accepts,initial,failure};JS_SetOpaque(v,s);
 }else{
  const char *names[]={"Uint8ClampedArray","Int8Array","Uint8Array","Int16Array","Uint16Array","Int32Array","Uint32Array","BigInt64Array","BigUint64Array","Float16Array","Float32Array","Float64Array"};
  char code[256];snprintf(code,sizeof(code),"new %s(new %s(64%s)%s)",names[cls],kind>=3?"SharedArrayBuffer":"ArrayBuffer",kind?",{maxByteLength:128}":"",(kind==2||kind==4)?"":",0,4");
  v=checked(JS_Eval(ctx,code,strlen(code),"view.js",JS_EVAL_TYPE_GLOBAL));
  if(detached){JSTypedArray *ta=JS_VALUE_GET_OBJ(v)->u.typed_array;JS_DetachArrayBuffer(ctx,JS_MKPTR(JS_TAG_OBJECT,ta->buffer));}
 }
 if(JS_IsObject(v))JS_VALUE_GET_OBJ(v)->extensible=initial;
 JSShape *shape=JS_IsObject(v)?JS_VALUE_GET_OBJ(v)->shape:NULL;int before=refs(v),out[8]={0};
 int result=JS_PreventExtensions(ctx,v);out[0]=result<0?7:result;out[1]=pending(ctx);
 out[2]=JS_IsObject(v)?JS_VALUE_GET_OBJ(v)->extensible:0;out[3]=JS_IsExtensible(ctx,v);if(out[3]<0)abort();
 out[4]=(shape==(JS_IsObject(v)?JS_VALUE_GET_OBJ(v)->shape:NULL))&&before==refs(v);
 result=JS_PreventExtensions(ctx,v);out[6]=result<0?7:result;out[7]=pending(ctx);out[5]=events;
 for(int i=0;i<8;i++)word(out[i]);JS_FreeValue(ctx,v);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(live_count||live_bytes)abort();
}
int main(void){CALLS word(live_count);word(live_bytes);return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.writer {Writer, WriterError}
import silk.os_writer {StdoutWriter}
import byte_buffer {ByteBuffer}
import js_string_types {StringLengthError}
import js_exceptions {JsException}
import js_prevent_extensions_test_support as fixture
effect fn one(out:&mut ByteBuffer,family:u32,cls:u32,kind:u32,initial:bool,mask:u32,accepts:bool,failure:u32,detached:bool)->()
 ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
 let record=run fixture.runCase(family,cls,kind,initial,mask,accepts,failure,detached)
 let mut i:usize=0 while i<record.length {run out.writeU32(record[i]) i=i+1}
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
 let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make()
 CALLS
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 let mut writer=StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    c_calls = '\n'.join(f'one({",".join(map(str, case))});' for case in CASES)
    silk_calls = '\n'.join('run one(&mut out,' + ','.join(str(bool(n)).lower() if i in (3, 5, 7) else str(n)
                          for i, n in enumerate(case)) + ') |> Effect.provideMut<Allocator>(&mut allocator)' for case in CASES)
    with tempfile.TemporaryDirectory(prefix='silkjs-prevent-extensions-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Prevention C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Prevention C consumer')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', silk_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="prevention-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1200, owner='Native prevention consumer', cwd=temp)
        if len(expected) != len(CASES) * 32 + 8 or expected[-8:] != bytes(8):
            raise SystemExit('Invalid independent C prevention output/ledger')
        if actual != expected:
            for offset in range(0, max(len(actual), len(expected)), 4):
                c, silk = expected[offset:offset+4], actual[offset:offset+4]
                if c != silk:
                    case, field = divmod(offset // 4, 8)
                    label = CASES[case] if case < len(CASES) else 'ledger'
                    raise SystemExit(f'Prevention {label} field {field}: C={c.hex()} Silk={silk.hex()}; bytes={len(expected)}/{len(actual)}')
        print(f'PASS preventExtensions: {len(CASES)} cases, all 12 typed-array classes; {pins} pinned files; '
              f'SHA256={hashlib.sha256(actual).hexdigest()}; both ledgers zero')

if __name__ == '__main__':
    main()
