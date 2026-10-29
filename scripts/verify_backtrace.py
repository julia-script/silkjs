#!/usr/bin/env python3
"""Compare non-executing stack inspection/formatting against pinned QuickJS.

The C executable constructs real native functions and compiled bytecode closures;
the native executable constructs typed function owners with valid bytecode and
owned/ROM debug tables. Neither executes those frames. Only the debug metadata is
varied. C references are standalone processes, never linked into Silk.
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
#include <assert.h>
static int getter_calls;
static JSValue native(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) { return JS_UNDEFINED; }
static JSValue getter(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) { getter_calls++; return JS_NewString(ctx,"invoked"); }
static void word(uint32_t n) { for(int i=0;i<4;i++)putchar((n>>(8*i))&255); }
static void text(JSValue value) { assert(JS_VALUE_GET_TAG(value)==JS_TAG_STRING);JSString *p=JS_VALUE_GET_STRING(value);word(p->len);for(int i=0;i<p->len;i++)word(string_get(p,i)); }
static JSValue name(int kind, JSContext *ctx) {
 if(kind==2)return JS_NewString(ctx,"");
 if(kind==3)return JS_NewStringLen(ctx,"pre\0post",8);
 if(kind==4){uint16_t s[]={0xd834,0xdd1e,0xd800,0x00e9};return js_new_string16_len(ctx,s,4);}
 if(kind==6){char a[301],b[514];memset(a,'a',300);memset(b,'b',513);a[300]=b[513]=0;
  JSValue left=JS_NewString(ctx,a),right=JS_NewString(ctx,b);
  JSValue result=JS_ConcatString(ctx,JS_DupValue(ctx,left),JS_DupValue(ctx,right));JS_FreeValue(ctx,left);JS_FreeValue(ctx,right);
  assert(JS_VALUE_GET_TAG(result)==JS_TAG_STRING_ROPE);return result;}
 return JS_NewString(ctx,"named");
}
static void one(int n,int t,int pc,int skip,int barrier,int origin) {
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);assert(ctx);getter_calls=0;
 JSValue parent=JS_NewObjectProto(ctx,JS_NULL),middle=JS_NewObjectProto(ctx,parent);
 JS_DefinePropertyValue(ctx,parent,JS_ATOM_name,JS_NewString(ctx,"inherited"),JS_PROP_C_W_E);
 JSValue first=JS_NewCFunction(ctx,native,"",0);JS_DeleteProperty(ctx,first,JS_ATOM_name,0);
 JS_SetPrototype(ctx,first,n==7||n==9?parent:n==8?middle:JS_NULL);
 if(n==5)JS_DefinePropertyGetSet(ctx,first,JS_ATOM_name,JS_NewCFunction(ctx,getter,"getter",0),JS_UNDEFINED,JS_PROP_CONFIGURABLE);
 else if(n==9)JS_DefinePropertyValue(ctx,first,JS_ATOM_name,JS_NewInt32(ctx,7),JS_PROP_C_W_E);
 else if(n>0&&n<7)JS_DefinePropertyValue(ctx,first,JS_ATOM_name,name(n,ctx),JS_PROP_C_W_E);
 const char *source="__FUNCTION_SOURCE__";
 JSValue compiled=JS_Eval(ctx,source,strlen(source),"trace.js",JS_EVAL_FLAG_COMPILE_ONLY);assert(!JS_IsException(compiled));
 JSFunctionBytecode *root=JS_VALUE_GET_PTR(compiled);assert(root->cpool_count>0&&JS_VALUE_GET_TAG(root->cpool[0])==JS_TAG_FUNCTION_BYTECODE);
 JSValue worker=js_closure(ctx,JS_DupValue(ctx,root->cpool[0]),NULL,NULL,FALSE);assert(!JS_IsException(worker));JS_FreeValue(ctx,compiled);
 JSObject *p=JS_VALUE_GET_OBJ(worker);JSFunctionBytecode *b=p->u.func.function_bytecode;assert(b->has_debug&&b->byte_code_len>102);
 JS_DefinePropertyValue(ctx,worker,JS_ATOM_name,JS_NewString(ctx,"worker"),JS_PROP_C_W_E);
 const uint8_t good[]={0,0,8,4},bad[]={0},header[]={3,4},wrapped[]={255,255,255,255,15,0};
 const uint8_t *table=good;size_t len=sizeof(good);
 if(t==2)len=0;else if(t==3){table=bad;len=sizeof(bad);}else if(t==4){table=header;len=sizeof(header);}else if(t==5){table=wrapped;len=sizeof(wrapped);}
 js_free(ctx,b->debug.pc2line_buf);b->debug.pc2line_buf=js_malloc(ctx,len+1);assert(b->debug.pc2line_buf);memcpy(b->debug.pc2line_buf,table,len);b->debug.pc2line_len=len;
 b->has_debug=t!=0;
 JSStackFrame bottom={0},mid={0},top={0};bottom.cur_func=first;bottom.js_mode=barrier==2?JS_MODE_BACKTRACE_BARRIER:0;
 mid.cur_func=worker;mid.cur_pc=b->byte_code_buf+pc;mid.prev_frame=&bottom;
 top.cur_func=first;top.prev_frame=&mid;top.js_mode=barrier==1?JS_MODE_BACKTRACE_BARRIER:0;rt->current_stack_frame=&top;
 const char *peek=get_prop_string(ctx,first,JS_ATOM_name);word(peek!=NULL);JS_FreeCString(ctx,peek);
 JS_ThrowTypeError(ctx,"policy");JSValue policy=JS_GetException(ctx);word(!is_backtrace_needed(ctx,policy));JS_FreeValue(ctx,policy);
 rt->current_stack_frame=&mid;JS_ThrowTypeError(ctx,"policy");policy=JS_GetException(ctx);word(!is_backtrace_needed(ctx,policy));JS_FreeValue(ctx,policy);
 rt->current_stack_frame=&top;rt->in_out_of_memory=TRUE;JS_ThrowTypeError(ctx,"policy");policy=JS_GetException(ctx);word(!is_backtrace_needed(ctx,policy));JS_FreeValue(ctx,policy);rt->in_out_of_memory=FALSE;
 JSValue error=JS_NewObjectProtoClass(ctx,JS_NULL,JS_CLASS_ERROR);word(is_backtrace_needed(ctx,error));
 build_backtrace(ctx,error,origin?"parse.js":NULL,origin==1?-1:13,7,skip);
 word(is_backtrace_needed(ctx,error));JSValue stack=JS_GetProperty(ctx,error,JS_ATOM_stack);text(stack);JS_FreeValue(ctx,stack);JS_FreeValue(ctx,error);
 assert(getter_calls==0);rt->current_stack_frame=NULL;b->has_debug=TRUE;
 JS_FreeValue(ctx,worker);JS_FreeValue(ctx,first);JS_FreeValue(ctx,middle);JS_FreeValue(ctx,parent);JS_FreeContext(ctx);JS_FreeRuntime(rt);
}
int main(void){for(int n=0;n<10;n++)for(int t=0;t<6;t++)for(int pc=0;pc<3;pc++)for(int s=0;s<2;s++)for(int b=0;b<3;b++)for(int o=0;o<3;o++)one(n,t,pc,s,b,o);return 0;}
'''

S_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.collections.list { List }
import silk.option { Option }
import silk.mem.pointer { Pointer }
import silk.num.u32
import silk.num.u16
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import native_stack { currentFrameAddress }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, PropertySlot, StackFrame, JS_MODE_BACKTRACE_BARRIER }
import js_value { ValueBits }
import js_strings { Strings, StringBuilder }
import js_string_types { StringOwner, StringLengthError }
import js_runtime as runtime
import js_gc as gc
import js_object_allocate as objects
import js_atom_data as atoms
import js_class_data as classes
import js_backtrace as trace
import js_backtrace_test_support as fixture
import js_array_storage_test_support { Hooks, reference, trap }
struct Record { stack: StringOwner, flags: [u32; 6] }
fn bit(value: bool) -> u32 { if value { return 1 } return 0 }
unsafe fn oom(rt: *mut HeapHeader, flag: bool) -> () {
 let mut anchor=() let state=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut anchor,rt) state.inOutOfMemory=flag
}
effect fn name(kind: u32) -> ValueBits ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 if kind==2 { return run Strings.fromLatin1(b"") }
 if kind==3 { return run Strings.fromLatin1(b"pre\0post") }
 if kind==4 { return run Strings.fromUtf16(&[0xd834,0xdd1e,0xd800,0x00e9]) }
 if kind==6 {
  let mut a=StringBuilder.make() run a.fill(97,300) let left=StringOwner.adopt(run a.finish())
  let mut b=StringBuilder.make() run b.fill(98,513) let right=StringOwner.adopt(run b.finish())
  let result=run Strings.concat(left.get(),right.get()) if result.tag()!= -6 { trap() } return result
 }
 return run Strings.fromLatin1(b"named")
}
effect fn body(memory: &AllocationObserver,n:u32,t:u32,pc:usize,skip:u32,barrier:u32,origin:u32)->Record
 ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) let ctx=run unsafe runtime.allocateContextStorage(rt)
 let mut hooks=Hooks {finalized:0}
 let parent=run unsafe objects.withPrototype(&mut hooks,memory,ctx,ValueBits.Null)
 let middle=run unsafe objects.withPrototype(&mut hooks,memory,ctx,parent)
 let inherited=run Strings.fromLatin1(b"inherited")
 run unsafe fixture.add(&mut hooks,rt,parent,atoms.JS_ATOM_name,7,PropertySlot.Value {value:inherited})
 let mut proto=ValueBits.Null if n==7||n==9 {proto=parent} else if n==8 {proto=middle}
 let first=run unsafe fixture.native(&mut hooks,memory,ctx,proto)
 if n==5 {
  let getter=run unsafe fixture.native(&mut hooks,memory,ctx,ValueBits.Null)
  run unsafe fixture.add(&mut hooks,rt,first,atoms.JS_ATOM_name,17,PropertySlot.GetterSetter {getter:reference(getter),setter:Pointer.null<HeapHeader>()})
 } else if n==9 {run unsafe fixture.add(&mut hooks,rt,first,atoms.JS_ATOM_name,7,PropertySlot.Value {value:ValueBits.Int {value:7}})}
 else if n>0&&n<7 {let text=run name(n) run unsafe fixture.add(&mut hooks,rt,first,atoms.JS_ATOM_name,7,PropertySlot.Value {value:text})}
 let mut table:&'static [u8]=b"\0\0\x08\x04"
 if t==2 {table=b""} else if t==3 {table=b"\0"} else if t==4 {table=b"\x03\x04"} else if t==5 {table=b"\xff\xff\xff\xff\x0f\0"}
 let worker=run unsafe fixture.compiled(&mut hooks,memory,ctx,table,n%2==0,t!=0)
 let workerName=run Strings.fromLatin1(b"worker")
 run unsafe fixture.add(&mut hooks,rt,worker,atoms.JS_ATOM_name,7,PropertySlot.Value {value:workerName})
 let mut bottom=run fixture.frame(first) if barrier==2 {bottom.mode=JS_MODE_BACKTRACE_BARRIER}
 let mut mid=run fixture.frame(worker) mid.currentPc=Option<usize>.some(pc) mid.previous=Pointer.fromMutRef<StackFrame>(&mut bottom)
 let mut top=run fixture.frame(first) top.previous=Pointer.fromMutRef<StackFrame>(&mut mid) if barrier==1 {top.mode=JS_MODE_BACKTRACE_BARRIER}
 unsafe fixture.publish(rt,Pointer.fromMutRef<StackFrame>(&mut top))
 let peek=match unsafe trace.propertyString(first,atoms.JS_ATOM_name) {Option<ValueBits>.Some {..}=>true _=>false}
 let immediate=unsafe trace.shouldAttachImmediately(rt)
 unsafe fixture.publish(rt,Pointer.fromMutRef<StackFrame>(&mut mid)) let deferred=unsafe trace.shouldAttachImmediately(rt)
 unsafe fixture.publish(rt,Pointer.fromMutRef<StackFrame>(&mut top)) unsafe oom(rt,true)
 let suppressed=unsafe trace.shouldAttachImmediately(rt) unsafe oom(rt,false)
 let error=run unsafe objects.withPrototypeClass(&mut hooks,memory,ctx,ValueBits.Null,classes.JS_CLASS_ERROR)
 let before=unsafe trace.isNeeded(error)
 let filename=StringOwner.adopt(run Strings.fromLatin1(b"parse.js"))
 let mut originValue=Option<ValueBits>.none() if origin!=0 {originValue=Option<ValueBits>.some(filename.get())}
 let mut line:i32=13 if origin==1 {line= -1}
 let stack=StringOwner.adopt(run unsafe trace.format(rt,move originValue,line,7,skip))
 run unsafe fixture.add(&mut hooks,rt,error,atoms.JS_ATOM_stack,3,PropertySlot.Value {value:unsafe stack.get().retained()})
 let after=unsafe trace.isNeeded(error)
 unsafe fixture.publish(rt,Pointer.null<StackFrame>())
 unsafe gc.release(&mut hooks,rt,error) unsafe gc.release(&mut hooks,rt,worker) unsafe gc.release(&mut hooks,rt,first)
 unsafe gc.release(&mut hooks,rt,middle) unsafe gc.release(&mut hooks,rt,parent)
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
 return Record {stack:move stack,flags:[bit(peek),bit(immediate),bit(deferred),bit(suppressed),bit(before),bit(after)]}
}
effect fn one(out:&mut ByteBuffer,n:u32,t:u32,pc:usize,skip:u32,barrier:u32,origin:u32)->()
 ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
 let record=run body(&observer,n,t,pc,skip,barrier,origin) |> Effect.provideMut<Allocator>(&mut memory)
 let mut i:usize=0 while i<6 {run out.writeU32(record.flags[i]) i=i+1}
 let value=record.stack.get() run out.writeU32(usize.toU32(Strings.length(value)))
 i=0 while i<Strings.length(value) {run out.writeU32(u16.toU32(Strings.codeUnit(value,i))) i=i+1}
 drop record
 if observer.stats().usedBytes!=0||observer.stats().allocationCount!=0 {trap()}
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
 let mut system=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make() let mut out=ByteBuffer.make()
 let mut n:u32=0 while n<10 {let mut t:u32=0 while t<6 {let mut pc:usize=0 while pc<3 {
 let mut s:u32=0 while s<2 {let mut b:u32=0 while b<3 {let mut o:u32=0 while o<3 {
 run one(&mut out,n,t,pc,s,b,o) |> Effect.provideMut<Allocator>(&mut system)
 o=o+1} b=b+1} s=s+1} pc=pc+1} t=t+1} n=n+1}
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


def records(data):
    result, offset = [], 0
    while offset < len(data):
        flags = struct.unpack_from('<6I', data, offset)
        length, = struct.unpack_from('<I', data, offset + 24)
        offset += 28
        units = struct.unpack_from(f'<{length}I', data, offset)
        offset += 4 * length
        result.append((flags, units))
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
    cases = list(itertools.product(range(10), range(6), range(3), range(2), range(3), range(3)))
    source = '(function worker(){let n=0;' + 'n++;' * 200 + 'return n})'
    with tempfile.TemporaryDirectory(prefix='silkjs-backtrace-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('__FUNCTION_SOURCE__', source))
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="backtrace"',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / item) for item in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Backtrace C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Original backtrace formatter')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(S_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="backtrace-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = process(command, 1800, owner='Native backtrace formatter', cwd=temp)
        left, right = records(expected), records(actual)
        if len(left) != len(cases) or len(right) != len(cases):
            raise SystemExit(f'Record counts: expected={len(cases)}, C={len(left)}, native={len(right)}')
        for parameters, c, native in zip(cases, left, right):
            if c != native:
                raise SystemExit(f'Backtrace (name,table,pc,skip,barrier,origin)={parameters}: C={c!r}; native={native!r}')
        print(f'PASS backtrace: {len(cases)} records, names/frames/coordinates/attachment policy; '
              f'{pins} pins; SHA256={hashlib.sha256(actual).hexdigest()}; native post-teardown ledgers zero')


if __name__ == '__main__':
    main()
