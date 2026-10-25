#!/usr/bin/env python3
"""Compare native Error owners and backtrace attachment with pinned QuickJS.

C is an independent executable, never a binding. Both sides create real native
and bytecode frames, inherit error names from real prototypes, and expose data
property flags and UTF16 values. One-shot/persistent allocation cuts independently
check OOM-state reset and complete teardown. Internal allocation phases are not
compared: native string reservation preallocates storage that C allocates later.
Run: python3 scripts/verify_errors.py QUICKJS
"""
import argparse
import hashlib
import itertools
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import ROOT, SUPPORT, executable_path, process, validate_pins
import toolchain

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <assert.h>
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count, live_bytes;
static int armed, remaining, persistent;
static int fail_allocation(void) {
 if(!armed)return 0;if(remaining){remaining--;return 0;}armed=persistent;return 1;
}
static void *allocate(JSMallocState *s,size_t n) {
 if(!n||fail_allocation())return NULL;Header *h=malloc(sizeof(*h)+n);if(!h)return NULL;
 h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;
}
static void release(JSMallocState *s,void *p) {
 if(!p)return;Header *h=(Header*)p-1;live_count--;live_bytes-=h->size;
 s->malloc_count--;s->malloc_size-=h->size;free(h);
}
static void *resize(JSMallocState *s,void *p,size_t n) {
 if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fail_allocation())return NULL;
 Header *h=(Header*)p-1;size_t old=h->size;Header *r=realloc(h,sizeof(*h)+n);if(!r)return NULL;
 r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;
}
static size_t usable(const void *p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static uint32_t words[8192];static size_t count;
static void word(uint32_t n){assert(count<8192);words[count++]=n;}
static void emit(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static void flush(void){emit(count);for(size_t i=0;i<count;i++)emit(words[i]);count=0;}
static void value(JSValue v) {
 int tag=JS_VALUE_GET_TAG(v);word(tag+10);
 if(tag==JS_TAG_STRING){JSString*s=JS_VALUE_GET_STRING(v);word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));}
 else if(tag==JS_TAG_INT)word(JS_VALUE_GET_INT(v));
}
static JSValue own(JSValue object,JSAtom atom,int *present,int *flags) {
 *present=*flags=0;if(!JS_IsObject(object))return JS_UNDEFINED;
 JSObject*p=JS_VALUE_GET_OBJ(object);JSShapeProperty*sp=find_own_property1(p,atom);
 if(!sp)return JS_UNDEFINED;*present=1;*flags=sp->flags;
 assert(!(sp->flags&JS_PROP_TMASK));return p->prop[sp-get_shape_prop(p->shape)].u.value;
}
static void property(JSValue object,JSAtom atom) {
 int present,flags;JSValue v=own(object,atom,&present,&flags);word(present);word(flags);value(v);
}
static int finalized,saw_old,saw_uncatchable;
static void finalize(JSRuntime*rt,JSValue object) {
 finalized++;saw_old=JS_IsObject(rt->current_exception)&&JS_VALUE_GET_PTR(rt->current_exception)==JS_VALUE_GET_PTR(object);
 saw_uncatchable=rt->current_exception_is_uncatchable;
}
static const JSClassDef watch_definition={"PendingOwner",finalize};
static int proto_index(JSContext*ctx,JSValue object) {
 if(!JS_IsObject(object))return 99;JSObject*p=JS_VALUE_GET_OBJ(object);if(p->class_id!=JS_CLASS_ERROR)return 98;
 for(int i=0;i<9;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return i;
 if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->class_proto[JS_CLASS_ERROR]))return 9;return 97;
}
static void record(JSContext*ctx,JSValue object) {
 JSRuntime*rt=ctx->rt;word(proto_index(ctx,object));word(rt->current_exception_is_uncatchable);
 word(rt->in_out_of_memory);word(finalized);word(saw_old);word(saw_uncatchable);word(JS_HasException(ctx));value(object);
 const JSAtom properties[]={JS_ATOM_message,JS_ATOM_stack,JS_ATOM_fileName,JS_ATOM_lineNumber,JS_ATOM_columnNumber,JS_ATOM_name};
 for(int i=0;i<6;i++)property(object,properties[i]);
 JSValue name=JS_UNDEFINED;if(JS_IsObject(object))name=JS_GetProperty(ctx,object,JS_ATOM_name);value(name);JS_FreeValue(ctx,name);
}
static JSValue raise2(JSContext*ctx,int kind,int backtrace,const char*fmt,...) {
 va_list ap;va_start(ap,fmt);JSValue result=JS_ThrowError2(ctx,kind,fmt,ap,backtrace);va_end(ap);return result;
}
static JSValue raise_auto(JSContext*ctx,int kind,const char*fmt,...) {
 va_list ap;va_start(ap,fmt);JSValue result=JS_ThrowError(ctx,kind,fmt,ap);va_end(ap);return result;
}
static JSValue native(JSContext*ctx,JSValueConst self,int argc,JSValueConst*argv){return JS_UNDEFINED;}
static JSValue worker(JSContext*ctx) {
 const char*source="(function worker(){return 1})";
 JSValue compiled=JS_Eval(ctx,source,strlen(source),"trace.js",JS_EVAL_FLAG_COMPILE_ONLY);assert(!JS_IsException(compiled));
 JSFunctionBytecode*root=JS_VALUE_GET_PTR(compiled);assert(root->cpool_count&&JS_VALUE_GET_TAG(root->cpool[0])==JS_TAG_FUNCTION_BYTECODE);
 JSValue f=js_closure(ctx,JS_DupValue(ctx,root->cpool[0]),NULL,NULL,FALSE);assert(!JS_IsException(f));JS_FreeValue(ctx,compiled);
 JSFunctionBytecode*b=JS_VALUE_GET_OBJ(f)->u.func.function_bytecode;assert(b->has_debug);
 const uint8_t table[]={0,0,8,4};js_free(ctx,b->debug.pc2line_buf);b->debug.pc2line_buf=js_malloc(ctx,sizeof(table));assert(b->debug.pc2line_buf);
 memcpy(b->debug.pc2line_buf,table,sizeof(table));b->debug.pc2line_len=sizeof(table);
 JS_DefinePropertyValue(ctx,f,JS_ATOM_name,JS_NewString(ctx,"worker"),JS_PROP_C_W_E);return f;
}
static void one(int family,int kind,int message,int frame_kind,int policy,int origin,int sealed) {
 armed=0;JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);assert(rt);JSContext*ctx=JS_NewContext(rt);assert(ctx);
 assert(!JS_NewClass(rt,68,&watch_definition));finalized=saw_old=saw_uncatchable=0;
 JSValue parent=JS_NewObjectProto(ctx,JS_NULL);JS_DefinePropertyValue(ctx,parent,JS_ATOM_name,JS_NewString(ctx,"host"),3);
 JSValue host=JS_NewCFunction(ctx,native,"",0);JS_DeleteProperty(ctx,host,JS_ATOM_name,0);JS_SetPrototype(ctx,host,parent);
 JSValue code=worker(ctx);JSFunctionBytecode*b=JS_VALUE_GET_OBJ(code)->u.func.function_bytecode;
 JSStackFrame bottom={0},top={0};bottom.cur_func=code;bottom.cur_pc=b->byte_code_buf+1;
 top.cur_func=host;top.prev_frame=&bottom;if(frame_kind==3)top.js_mode=JS_MODE_BACKTRACE_BARRIER;
 if(frame_kind==1||frame_kind==3)rt->current_stack_frame=&top;else if(frame_kind==2)rt->current_stack_frame=&bottom;
 char bytes[261];memset(bytes,'a',260);bytes[260]=0;
 if(message==0)strcpy(bytes,"message");else if(message==1)memcpy(bytes,"abc\0ignored",12);
 else if(message==3){bytes[253]=0xe2;bytes[254]=0x82;bytes[255]=0xac;}
 else if(message==4){bytes[0]=0x80;bytes[1]=0x81;bytes[2]='X';bytes[3]=0xc0;bytes[4]=0xaf;bytes[5]=0;}
 else if(message==5)bytes[0]=0;
 if(family==0||family==4||family==5){JS_Throw(ctx,JS_NewObjectClass(ctx,68));JS_SetUncatchableException(ctx,TRUE);}
 JSValue object;
 if(family==0){if(!policy)raise_auto(ctx,kind,"%s",bytes);else raise2(ctx,kind,policy==2,"%s",bytes);object=JS_GetException(ctx);}
 else if(family==1)object=JS_NewError(ctx);
 else if(family==2){object=JS_NewError(ctx);if(sealed)JS_PreventExtensions(ctx,object);
  build_backtrace(ctx,object,origin?"parse.js":NULL,origin==1?-1:13,7,policy);}
 else if(family==3){JS_ThrowOutOfMemory(ctx);object=JS_GetException(ctx);}
 else if(family==4){rt->in_out_of_memory=TRUE;JS_ThrowOutOfMemory(ctx);object=JS_GetException(ctx);}
 else if(family==5){armed=persistent=1;remaining=0;JS_ThrowTypeError(ctx,"exhausted");armed=0;object=JS_GetException(ctx);}
 else {JS_ThrowInterrupted(ctx);object=JS_GetException(ctx);}
 record(ctx,object);rt->in_out_of_memory=FALSE;rt->current_stack_frame=NULL;
 JS_FreeValue(ctx,object);JS_FreeValue(ctx,code);JS_FreeValue(ctx,host);JS_FreeValue(ctx,parent);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 word(live_count);word(live_bytes);assert(!live_count&&!live_bytes);flush();
}
static void sweep(int traced) {
 for(int mode=0;mode<2;mode++)for(int cut=0;cut<64;cut++) {
  armed=0;JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);assert(rt);JSContext*ctx=JS_NewContext(rt);assert(ctx);
  JSValue function=JS_UNDEFINED;JSStackFrame frame={0};
  if(traced){function=JS_NewCFunction(ctx,native,"",0);assert(!JS_IsException(function));frame.cur_func=function;rt->current_stack_frame=&frame;}
  remaining=cut;persistent=mode;armed=1;raise2(ctx,JS_TYPE_ERROR,TRUE,"message");armed=0;
  JSValue object=JS_GetException(ctx);
  assert(!rt->in_out_of_memory);JS_FreeValue(ctx,object);rt->current_stack_frame=NULL;JS_FreeValue(ctx,function);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);assert(!live_count&&!live_bytes);
 }
}
int main(void){CALLS sweep(0);sweep(1);return 0;}
'''

S_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.i32
import silk.u16
import silk.usize
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import native_stack { currentFrameAddress }
import js_heap { HeapHeader }
import js_core_types { NativeErrorKind, PropertySlot, StackFrame, JS_MODE_BACKTRACE_BARRIER }
import js_value { Value }
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_runtime as runtime
import js_gc as gc
import js_atom_data as atoms
import js_backtrace as trace
import js_backtrace_test_support as frames
import js_object_allocate as objects
import js_errors as errors
import js_exceptions { JsException }
import js_exceptions as exceptions
import js_errors_test_support as fixture
import js_errors_test_support { Hooks, FaultAllocator }
import js_array_storage_test_support { trap }
fn bit(value: bool)->u32 {if value{return 1}return 0}
fn signed(value:i32)->u32 {
 if value<0{return i32.toU32(-(value+1))^0xffffffff}return i32.toU32(value)
}
effect fn value(out:&mut ByteBuffer,v:Value)->() ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(i32.toU32(v.tag()+10))
 if v.isString(){run out.writeU32(usize.toU32(Strings.length(v))) let mut i:usize=0
 while i<Strings.length(v){run out.writeU32(u16.toU32(Strings.codeUnit(v,i))) i=i+1}}
 else {match v {Value.Int {value:n}=>{run out.writeU32(signed(n))} _=>()}}
}
effect fn property(out:&mut ByteBuffer,object:Value,atom:u32)->() ! OutOfMemoryError ? &mut Allocator {
 let p=unsafe fixture.property(object,atom) run out.writeU32(bit(p.present)) run out.writeU32(p.flags) run value(&mut out,p.value)
}
effect fn record<'a>(out:&mut ByteBuffer,hooks:&Hooks<'a>,rt:*mut HeapHeader,ctx:*mut HeapHeader,object:Value)->()
 ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(unsafe fixture.prototypeIndex(ctx,object)) run out.writeU32(bit(unsafe fixture.uncatchable(rt)))
 run out.writeU32(bit(unsafe fixture.inOom(rt))) run out.writeU32(usize.toU32(hooks.finalized))
 run out.writeU32(bit(hooks.sawOldPending)) run out.writeU32(bit(hooks.sawUncatchable)) run out.writeU32(bit(unsafe exceptions.has(rt)))
 run value(&mut out,object)
 let properties:[u32;6]=[atoms.JS_ATOM_message,atoms.JS_ATOM_stack,atoms.JS_ATOM_fileName,atoms.JS_ATOM_lineNumber,atoms.JS_ATOM_columnNumber,atoms.JS_ATOM_name]
 let mut i:usize=0 while i<6 {run property(&mut out,object,properties[i]) i=i+1}
 let name=match unsafe trace.propertyString(object,atoms.JS_ATOM_name){Option<Value>.Some {value:v}=>v _=>Value.Undefined}
 run value(&mut out,name)
}
effect fn ignore(error:JsException)->(){drop error}
unsafe effect fn interrupt<'a>(hooks:&mut Hooks<'a>,memory:&AllocationObserver,ctx:*mut HeapHeader)->() ! JsException ? &mut Allocator {
 return run unsafe errors.throwInterrupted(&mut hooks,memory,ctx)
}
effect fn body(out:&mut ByteBuffer,memory:&AllocationObserver,family:usize,which:usize,message:usize,frameKind:usize,policy:u32,origin:usize,sealed:bool)->()
 ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
 let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) let ctx=run unsafe runtime.allocateContextStorage(rt)
 let mut hooks=Hooks.make(memory) run unsafe fixture.prepare(&mut hooks,memory,ctx)
 let parent=run unsafe objects.withPrototype(&mut hooks,memory,ctx,Value.Null)
 let parentName=run Strings.fromLatin1(b"host") run unsafe frames.add(&mut hooks,rt,parent,atoms.JS_ATOM_name,3,PropertySlot.Value {value:parentName})
 let host=run unsafe frames.native(&mut hooks,memory,ctx,parent)
 let code=run unsafe frames.compiled(&mut hooks,memory,ctx,b"\0\0\x08\x04",true,true)
 let codeName=run Strings.fromLatin1(b"worker") run unsafe frames.add(&mut hooks,rt,code,atoms.JS_ATOM_name,7,PropertySlot.Value {value:codeName})
 let mut bottom=run frames.frame(code) bottom.currentPc=Option<usize>.some(1)
 let mut top=run frames.frame(host) top.previous=Pointer.fromMutRef<StackFrame>(&mut bottom)
 if frameKind==3{top.mode=JS_MODE_BACKTRACE_BARRIER}
 if frameKind==1||frameKind==3{unsafe frames.publish(rt,Pointer.fromMutRef<StackFrame>(&mut top))}
 else if frameKind==2{unsafe frames.publish(rt,Pointer.fromMutRef<StackFrame>(&mut bottom))}
 let mut bytes:[u8;260]=[97;260]
 if message==3{bytes[253]=0xe2 bytes[254]=0x82 bytes[255]=0xac}
 let mut text:&[u8]=&bytes
 if message==0{text=b"message"}else if message==1{text=b"abc\0ignored"}
 else if message==4{text=b"\x80\x81X\xc0\xaf"}
 else if message==5{text=b""}
 if family==0||family==4{let old=run unsafe fixture.watched(&mut hooks,memory,ctx)
 run unsafe fixture.putPending(&mut hooks,rt,old) unsafe exceptions.setUncatchable(rt,true)}
 let mut object=Value.Undefined
 if family==0{object=run unsafe fixture.capture(&mut hooks,memory,ctx,fixture.kind(which),text,policy)}
 else if family==1{object=run unsafe errors.newError(&mut hooks,memory,ctx)}
 else if family==2{
  object=run unsafe errors.newError(&mut hooks,memory,ctx) if sealed{unsafe fixture.preventExtensions(object)}
  let filename=StringOwner.adopt(run Strings.fromLatin1(b"parse.js")) let mut originValue=Option<Value>.none()
  if origin!=0{originValue=Option<Value>.some(filename.get())} let mut line:i32=13 if origin==1{line= -1}
  run unsafe errors.buildBacktrace(&mut hooks,memory,ctx,object,move originValue,line,7,policy)
 }else if family==3{object=run unsafe fixture.captureOom(&mut hooks,memory,ctx)}
 else if family==4{unsafe fixture.setOom(rt,true) object=run unsafe fixture.captureOom(&mut hooks,memory,ctx)}
 else {run Effect.catchAll(unsafe interrupt(&mut hooks,memory,ctx),ignore) object=unsafe exceptions.take(rt)}
 run record(&mut out,&hooks,rt,ctx,object)
 unsafe fixture.setOom(rt,false) unsafe frames.publish(rt,Pointer.null<StackFrame>())
 unsafe gc.release(&mut hooks,rt,object) unsafe gc.release(&mut hooks,rt,code) unsafe gc.release(&mut hooks,rt,host) unsafe gc.release(&mut hooks,rt,parent)
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
effect fn writeRecord(out:&mut ByteBuffer,data:&ByteBuffer)->() ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(usize.toU32(data.asSlice().length/4)) run out.appendSlice(data.asSlice())
}
effect fn one(out:&mut ByteBuffer,family:usize,which:usize,message:usize,frameKind:usize,policy:u32,origin:usize,sealed:bool)->()
 ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
 let mut data=ByteBuffer.make() run data.reserve(32768)
 if family==5 {
  let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let old=run unsafe fixture.watched(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
  run unsafe fixture.putPending(&mut hooks,rt,old) |> Effect.provideMut<Allocator>(&mut memory) unsafe exceptions.setUncatchable(rt,true)
  let mut fault=FaultAllocator {parent:move memory,armed:true,remaining:0,persistent:true,failures:0}
  let object=run unsafe fixture.capture(&mut hooks,&observer,ctx,NativeErrorKind.Type,b"exhausted",0) |> Effect.provideMut<Allocator>(&mut fault)
  run record(&mut data,&hooks,rt,ctx,object)
  unsafe gc.release(&mut hooks,rt,object) unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut fault)
 }else{run body(&mut data,&observer,family,which,message,frameKind,policy,origin,sealed) |> Effect.provideMut<Allocator>(&mut memory)}
 if observer.stats().allocationCount!=0||observer.stats().usedBytes!=0{trap()}
 run data.writeU32(usize.toU32(observer.stats().allocationCount)) run data.writeU32(usize.toU32(observer.stats().usedBytes))
 run writeRecord(&mut out,&data)
}
effect fn sweep(traced:bool)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 let mut mode:usize=0
 while mode<2{let mut cut:usize=0 while cut<64{
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
  let ctx=run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks.make(&observer) run unsafe fixture.prepare(&mut hooks,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
  let mut function=Value.Undefined
  if traced{function=run unsafe frames.native(&mut hooks,&observer,ctx,Value.Null) |> Effect.provideMut<Allocator>(&mut memory)}
  let mut frame=run frames.frame(function) |> Effect.provideMut<Allocator>(&mut memory)
  if traced{unsafe frames.publish(rt,Pointer.fromMutRef<StackFrame>(&mut frame))}
  let mut fault=FaultAllocator {parent:move memory,armed:true,remaining:cut,persistent:mode==1,failures:0}
  let object=run unsafe fixture.capture(&mut hooks,&observer,ctx,NativeErrorKind.Type,b"message",2) |> Effect.provideMut<Allocator>(&mut fault)
  if unsafe fixture.inOom(rt){trap()}
  unsafe gc.release(&mut hooks,rt,object) unsafe frames.publish(rt,Pointer.null<StackFrame>()) unsafe gc.release(&mut hooks,rt,function)
  unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut fault)
  if observer.stats().allocationCount!=0||observer.stats().usedBytes!=0{trap()}
  cut=cut+1}mode=mode+1}
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | JsException | WriterError {
 let mut system=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make() let mut writer=StdoutWriter.make()
 CALLS
 run sweep(false) |> Effect.provideMut<Allocator>(&mut system)
 run sweep(true) |> Effect.provideMut<Allocator>(&mut system)
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


def cases():
    rows = [(0, k, m, f, p, 0, 0) for k, m, f, p in
            itertools.product(range(9), range(6), range(4), range(3))]
    rows.append((1, 0, 0, 0, 0, 0, 0))
    rows += [(2, 0, 0, f, p, o, s) for f, p, o, s in
             itertools.product(range(4), range(2), range(3), range(2))]
    rows += [(family, 0, 0, f, 0, 0, 0) for family in (3, 4, 6) for f in range(3)]
    rows.append((5, 0, 0, 0, 0, 0, 0))
    return rows


def records(data):
    result, at = [], 0
    while at < len(data):
        length, = struct.unpack_from('<I', data, at)
        at += 4
        row = struct.unpack_from(f'<{length}I', data, at)
        at += 4 * length
        if len(row) < 2 or row[-2:] != (0, 0):
            raise SystemExit(f'Nonzero post-teardown ledger: {row!r}')
        result.append(row)
    if at != len(data):
        raise SystemExit('Trailing or truncated error records')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    rows = cases()
    c_calls = '\n'.join('one(' + ','.join(map(str, row)) + ');' for row in rows)
    s_calls = '\n'.join('run one(&mut out,' + ','.join(map(str, row[:-1])) + ',' +
                        str(bool(row[-1])).lower() + ') |> Effect.provideMut<Allocator>(&mut system)' for row in rows)
    with tempfile.TemporaryDirectory(prefix='silkjs-errors-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', c_calls))
        # Select upstream's direct-malloc profile so every request reaches the
        # fault allocator; the default arena hides small allocation refusals.
        # This configuration switch is not an AddressSanitizer check.
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="errors"',
                 '-D__SANITIZE_ADDRESS__',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Error C oracle compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Pinned C Error algorithms')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(S_SOURCE.replace('CALLS', s_calls))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="errors-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = process(command, 1800, owner='Native Error algorithms', cwd=temp)
        left, right = records(expected), records(actual)
        if len(left) != len(rows) or len(right) != len(rows):
            raise SystemExit(f'Record count mismatch: wanted {len(rows)}, C={len(left)}, native={len(right)}')
        for label, c, native in zip(rows, left, right):
            if c != native:
                raise SystemExit(f'Error case {label}:\nC={c!r}\nnative={native!r}')
        print(f'PASS errors: {len(rows)} behavioral records and independent OOM sweeps; '
              f'{pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; both teardown ledgers zero')


if __name__ == '__main__':
    main()
