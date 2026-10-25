#!/usr/bin/env python3
"""Compare native consuming comparisons with pinned original QuickJS executables.

Exact booleans, pending values, callback hints/order, finalizers, owner deltas and
BigInt-string error swallowing. No C code is linked into the Silk consumer.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bigint_coercions import C_EMBEDDING, SILK_SOURCE as BASE_SILK, KINDS as BASE_KINDS, leaves
import toolchain

ROOT = Path(__file__).resolve().parents[1]
KINDS = BASE_KINDS + 2
OPERATIONS = 6
MATRIX = KINDS * KINDS * OPERATIONS
CALLBACKS = 9 * KINDS * 3 * OPERATIONS
FAULTS = 4 * 2 * OPERATIONS
COUNT = MATRIX + CALLBACKS + FAULTS

C_SOURCE = C_EMBEDDING.replace('static size_t live_count,live_bytes;',
    'static size_t live_count,live_bytes;static int armed,persistent,failures,count_at_error;static JSValue watched_string;').replace(
    'if(!n)return NULL;Header*h=malloc',
    'if(!n)return NULL;if(armed){failures++;if(!persistent)armed=0;return NULL;}Header*h=malloc').replace(
    'Header*h=(Header*)p-1;size_t old=h->size;h=realloc',
    'if(armed){failures++;if(!persistent)armed=0;return NULL;}Header*h=(Header*)p-1;size_t old=h->size;h=realloc').replace(
    'finalized[finalized_count++]=p->event;',
    'finalized[finalized_count++]=p->event;if(p->event==909)count_at_error=rc(watched_string);').replace(
    'if(argc==1){JSString*s=JS_VALUE_GET_STRING(argv[0]);if(s->len!=6)abort();for(int i=0;i<6;i++)if(string_get(s,i)!="number"[i])abort();events[event_count++]=1001;}else if(argc)abort();',
    'if(argc==1){JSString*s=JS_VALUE_GET_STRING(argv[0]);const char*hint=s->len==6?"number":s->len==7?"default":NULL;if(!hint)abort();for(int i=0;i<s->len;i++)if(string_get(s,i)!=hint[i])abort();events[event_count++]=s->len==6?1001:1000;}else if(argc)abort();') + r'''
static JSValue leaf(JSContext*ctx,int kind){
 @C_LEAVES@
 abort();
}
static int apply(JSContext*ctx,JSValue*slots,int op){
 static const OPCodeEnum operations[]={OP_lt,OP_lte,OP_gt,OP_gte};
 int result=op<4?js_relational_slow(ctx,slots+2,operations[op]):js_eq_slow(ctx,slots+2,op==5);
 /* The source's second slot is popped, not an owner, after success. */
 if(!result)slots[1]=JS_UNDEFINED;
 return result;
}
static void output_value(JSValue value){emit(JS_VALUE_GET_NORM_TAG(value));if(JS_IsBool(value))emit(JS_VALUE_GET_INT(value));}
static void string_record(JSValue value){
 int rope=JS_VALUE_GET_TAG(value)==JS_TAG_STRING_ROPE;
 int n=rope?JS_VALUE_GET_STRING_ROPE(value)->len:JS_VALUE_GET_STRING(value)->len;
 emit(n);for(int i=0;i<n;i++)emit(rope?string_rope_get(value,i):string_get(JS_VALUE_GET_STRING(value),i));
}
static void pending(JSContext*ctx,JSValue first,JSValue second){
 int present=JS_HasException(ctx);emit(present);if(!present)return;
 JSValue error=JS_GetException(ctx);emit(JS_VALUE_GET_NORM_TAG(error));
 if(JS_IsObject(error)){
  JSObject*p=JS_VALUE_GET_OBJ(error);int kind=99;
  if(p->class_id==JS_CLASS_ERROR)for(int i=0;i<JS_NATIVE_ERROR_COUNT;i++)if(p->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))kind=i;
  emit(kind);if(kind!=99){JSValue message=checked(JS_GetProperty(ctx,error,JS_ATOM_message));string_record(message);JS_FreeValue(ctx,message);}
  else{emit(JS_SameValue(ctx,error,first));emit(JS_SameValue(ctx,error,second));}
 }else if(JS_IsString(error))string_record(error);
 else if(JS_VALUE_GET_NORM_TAG(error)==JS_TAG_INT||JS_IsBool(error))emit(JS_VALUE_GET_INT(error));
 else if(JS_VALUE_GET_NORM_TAG(error)==JS_TAG_FLOAT64)wide(float64_as_uint64(JS_VALUE_GET_FLOAT64(error)));
 else{emit(JS_SameValue(ctx,error,first));emit(JS_SameValue(ctx,error,second));}
 JS_FreeValue(ctx,error);
}
static void run_case(JSContext*ctx,int a,int b,int family_a,int family_b,int op){
 event_count=finalized_count=0;
 JSValue first=leaf(ctx,a),second=a==b?JS_DupValue(ctx,first):leaf(ctx,b);
 int first_root=rc(first),second_root=rc(second);
 JSValue left=make(ctx,family_a,first,second),right=make(ctx,family_b,second,first);
 int first_before=rc(first),second_before=rc(second),left_before=rc(left),right_before=rc(right);
 JSValue slots[2]={JS_DupValue(ctx,left),JS_DupValue(ctx,right)};int r=apply(ctx,slots,op);
 emit(r<0);output_value(slots[0]);output_value(slots[1]);pending(ctx,first,second);
 emit(event_count);for(unsigned i=0;i<event_count;i++)emit(events[i]);
 emit(rc(left)-left_before);emit(rc(right)-right_before);emit(rc(first)-first_before);emit(rc(second)-second_before);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);JS_FreeValue(ctx,left);JS_FreeValue(ctx,right);
 emit(rc(first)-first_root);emit(rc(second)-second_root);
 emit(finalized_count);for(unsigned i=0;i<finalized_count;i++)emit(finalized[i]);
 JS_FreeValue(ctx,first);JS_FreeValue(ctx,second);flush();
}
static void fault_case(JSContext*ctx,int mode,int reverse,int op){
 armed=0;persistent=mode==2;failures=count_at_error=0;
 JSValue text;
 if(mode==3){size_t n=1048579;char*bytes=malloc(n);if(!bytes)abort();memset(bytes,'0',n);bytes[0]='0';bytes[1]='b';bytes[2]='1';text=checked(JS_NewStringLen(ctx,bytes,n));free(bytes);}
 else text=checked(JS_NewString(ctx,"4294967296"));
 watched_string=text;JS_Throw(ctx,closure(ctx,0,909,0,JS_UNDEFINED,0,JS_UNDEFINED));
 event_count=finalized_count=0;ctx->rt->in_out_of_memory=mode==1;
 JSValue slots[2]={JS_NewBigInt64(ctx,0),JS_DupValue(ctx,text)};
 if(reverse){JSValue temporary=slots[0];slots[0]=slots[1];slots[1]=temporary;}
 armed=mode!=3;int r=apply(ctx,slots,op);armed=0;
 emit(r<0);output_value(slots[0]);output_value(slots[1]);
 if(mode!=1)emit(count_at_error);
 emit(ctx->rt->in_out_of_memory);emit(rc(text));
 pending(ctx,text,JS_UNDEFINED);
 JS_FreeValue(ctx,slots[0]);JS_FreeValue(ctx,slots[1]);JS_FreeValue(ctx,text);ctx->rt->in_out_of_memory=0;flush();
}
int main(void){
 JSMallocFunctions mf={tracked_malloc,tracked_free,tracked_realloc,tracked_size};JSRuntime*rt=JS_NewRuntime2(&mf,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,68,&object_definition)||JS_NewClass(rt,69,&function_definition))abort();word(@COUNT@);
 for(int a=0;a<@KINDS@;a++)for(int b=0;b<@KINDS@;b++)for(int op=0;op<6;op++)run_case(ctx,a,b,0,0,op);
 for(int family=1;family<10;family++)for(int kind=0;kind<@KINDS@;kind++)for(int side=0;side<3;side++)for(int op=0;op<6;op++){
  int a=family,b=(family+3)%9+1;if(side==0)b=0;if(side==1){b=a;a=0;}
  run_case(ctx,kind,(kind+17)%@KINDS@,a,b,op);
 }
 for(int mode=0;mode<4;mode++)for(int reverse=0;reverse<2;reverse++)for(int op=0;op<6;op++)fault_case(ctx,mode,reverse,op);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);emit(live_count);emit(live_bytes);flush();if(live_count||live_bytes)abort();return 0;
}
'''

SILK_SOURCE = BASE_SILK.partition('unsafe effect fn value(')[0] + r'''
import js_comparison_operators { Operation }
import js_comparison_operators as comparisons
import js_unary_operators_test_support { ErrorOrderHooks }
import js_errors_test_support { FaultAllocator }
import js_errors_test_support as errorFixture
import js_property_descriptors_test_support as descriptorFixture
import js_core_types { ObjectData }
import silk.list { List }
fn operation(index:u32)->Operation{
 return match index {0=>Operation.Less 1=>Operation.LessEqual 2=>Operation.Greater 3=>Operation.GreaterEqual 4=>Operation.Equal _=>Operation.NotEqual}
}
effect fn flag(out:&mut ByteBuffer,value:bool)->() ! OutOfMemoryError ? &mut Allocator {
 if value{run out.writeU32(1)}else{run out.writeU32(0)}
}
effect fn outputValue(out:&mut ByteBuffer,value:Value)->() ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(signed(value.tag()))
 match value {Value.Bool {value:bit}=>{run flag(&mut out,bit)} _=>()}
}
unsafe effect fn pending(out:&mut ByteBuffer,hooks:&mut Hooks,ctx:*mut HeapHeader,first:Value,second:Value)->()
 ! OutOfMemoryError | JsException ? &mut Allocator {
 let rt=unsafe runtime.contextRuntime(ctx) let present=unsafe exceptions.has(rt)
 run flag(&mut out,present) if !present{return ()}
 let error=unsafe exceptions.take(rt) run out.writeU32(signed(error.tag()))
 if error.isObject(){
  let kind=unsafe descriptorFixture.errorKind(ctx,error) run out.writeU32(kind)
  if kind!=99{let message=StringOwner.adopt(run unsafe hooks.getProperty(ctx,error,atoms.JS_ATOM_message)) run text(&mut out,message.get())}
  else{run flag(&mut out,unsafe primitive.equal(error,first,EqualityMode.SameValue)) run flag(&mut out,unsafe primitive.equal(error,second,EqualityMode.SameValue))}
 }else if error.isString(){run text(&mut out,error)}else{
  match error {
   Value.Int {value:n}=>{run out.writeU32(signed(n))}
   Value.Bool {value:b}=>{run flag(&mut out,b)}
   Value.Float64 {value:n}=>{run wide(&mut out,f64.toBits(n))}
   _=>{run flag(&mut out,unsafe primitive.equal(error,first,EqualityMode.SameValue)) run flag(&mut out,unsafe primitive.equal(error,second,EqualityMode.SameValue))}
  }
 }
 unsafe gc.release(&mut hooks,rt,error)
}
unsafe effect fn runCase(out:&mut ByteBuffer,hooks:&mut Hooks,memory:&AllocationObserver,ctx:*mut HeapHeader,
 a:u32,b:u32,familyA:u32,familyB:u32,op:u32)->()
 ! OutOfMemoryError | StringLengthError | JsException | BigIntError ? &mut Allocator {
 hooks.clear() let rt=unsafe runtime.contextRuntime(ctx)
 let first=run unsafe leaf(rt,a) let mut second=Value.Undefined
 if a==b{second=unsafe first.retained()}else{second=run unsafe leaf(rt,b)}
 let firstRoot=unsafe rc(first) let secondRoot=unsafe rc(second)
 let left=run unsafe transitions.make(&mut hooks,memory,ctx,familyA,first,second)
 let right=run unsafe transitions.make(&mut hooks,memory,ctx,familyB,second,first)
 let firstBefore=unsafe rc(first) let secondBefore=unsafe rc(second) let leftBefore=unsafe rc(left) let rightBefore=unsafe rc(right)
 let mut old=unsafe left.retained() let mut next=unsafe right.retained()
 let outcome=run Effect.result(unsafe comparisons.apply(&mut hooks,ctx,&mut old,&mut next,operation(op)))
 let mut failed=false
 match move outcome {
  Result<(),OutOfMemoryError|StringLengthError|JsException>.Success {..}=>()
  Result<(),OutOfMemoryError|StringLengthError|JsException>.Failure {error}=>match move error{
   JsException signal=>{failed=true}
   OutOfMemoryError allocation=>{fail move allocation} StringLengthError length=>{fail move length}
  }
 }
 run flag(&mut out,failed) run outputValue(&mut out,old) run outputValue(&mut out,next) run unsafe pending(&mut out,&mut hooks,ctx,first,second)
 run out.writeU32(usize.toU32(hooks.eventCount)) let mut i:usize=0
 while i<hooks.eventCount{run out.writeU32(hooks.events[i]) i=i+1}
 run out.writeU32(signed(unsafe rc(left)-leftBefore)) run out.writeU32(signed(unsafe rc(right)-rightBefore))
 run out.writeU32(signed(unsafe rc(first)-firstBefore)) run out.writeU32(signed(unsafe rc(second)-secondBefore))
 unsafe gc.release(&mut hooks,rt,old) unsafe gc.release(&mut hooks,rt,next) unsafe gc.release(&mut hooks,rt,left) unsafe gc.release(&mut hooks,rt,right)
 run out.writeU32(signed(unsafe rc(first)-firstRoot)) run out.writeU32(signed(unsafe rc(second)-secondRoot))
 run out.writeU32(usize.toU32(hooks.finalizedCount)) i=0
 while i<hooks.finalizedCount{run out.writeU32(hooks.finalized[i]) i=i+1}
 unsafe gc.release(&mut hooks,rt,first) unsafe gc.release(&mut hooks,rt,second)
}
effect fn ignore(error:JsException)->(){drop error}
unsafe effect fn faultCase(out:&mut ByteBuffer,mode:u32,reverse:bool,op:u32)->()
 ! OutOfMemoryError | StringLengthError | JsException ? &mut Allocator {
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
 let rt=run runtime.allocateRuntimeStorage(0) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx=run unsafe runtime.allocateContextStorage(rt) |> Effect.provideMut<Allocator>(&mut memory)
 run unsafe fixture.register(rt) |> Effect.provideMut<Allocator>(&mut memory)
 let mut inner=Hooks.make() run unsafe fixture.prepareErrors(&mut inner,&observer,ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut source=List<u8>.make()
 if mode==3{
  run source.reserveExact(1048579) let mut i:usize=0
  while i<1048579{let mut byte:u8=48 if i==1{byte=98}else if i==2{byte=49} run source.append(byte) i=i+1}
 }else{let bytes=b"4294967296" let mut i:usize=0 while i<bytes.length{run source.append(bytes[i]) i=i+1}}
 let string=run Strings.fromLatin1(source.asSlice()) |> Effect.provideMut<Allocator>(&mut memory)
 drop source
 let previous=run unsafe fixture.object(&mut inner,&observer,ctx,909) |> Effect.provideMut<Allocator>(&mut memory)
 run Effect.catch<JsException>(unsafe exceptions.throwValue<(),Hooks>(&mut inner,rt,previous),ignore)
 let mut hooks=ErrorOrderHooks {inner:move inner,watched:support.heapReference(string),countAtThrow:0}
 unsafe errorFixture.setOom(rt,mode==1)
 let mut old=Value.ShortBigInt {value:0} let mut next=unsafe string.retained()
 if reverse{old=next next=Value.ShortBigInt {value:0}}
 let mut fault=FaultAllocator {parent:move memory,armed:mode!=3,remaining:0,persistent:mode==2,failures:0}
 let outcome=run Effect.result(unsafe comparisons.apply(&mut hooks,ctx,&mut old,&mut next,operation(op))) |> Effect.provideMut<Allocator>(&mut fault)
 fault.armed=false
 let mut failed=false
 match move outcome{
  Result<(),OutOfMemoryError|StringLengthError|JsException>.Success {..}=>()
  Result<(),OutOfMemoryError|StringLengthError|JsException>.Failure {error}=>match move error{
   JsException signal=>{failed=true} OutOfMemoryError allocation=>{fail move allocation} StringLengthError length=>{fail move length}
  }
 }
 run flag(&mut out,failed) run outputValue(&mut out,old) run outputValue(&mut out,next)
 if mode!=1{run out.writeU32(signed(hooks.countAtThrow))}
 run flag(&mut out,unsafe errorFixture.inOom(rt)) run out.writeU32(signed(unsafe rc(string)))
 run unsafe pending(&mut out,&mut hooks.inner,ctx,string,Value.Undefined) |> Effect.provideMut<Allocator>(&mut fault)
 unsafe gc.release(&mut hooks,rt,old) unsafe gc.release(&mut hooks,rt,next) unsafe gc.release(&mut hooks,rt,string)
 unsafe errorFixture.setOom(rt,false) unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut fault)
 if observer.stats().usedBytes!=0||observer.stats().allocationCount!=0{trap()}
}
effect fn record(out:&ByteBuffer)->() ! OutOfMemoryError | WriterError ? &mut Allocator | &mut Writer {
 let mut size=ByteBuffer.make() run size.writeU32(usize.toU32(out.length()/4)) run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice())
}
effect fn probe(memory:&AllocationObserver)->()
 ! OutOfMemoryError | StringLengthError | JsException | BigIntError | WriterError ? &mut Allocator | &mut Writer {
 let rt=run runtime.allocateRuntimeStorage(0) let ctx=run unsafe runtime.allocateContextStorage(rt)
 run unsafe fixture.register(rt) let mut hooks=Hooks.make() hooks.collect=true
 run unsafe fixture.prepareErrors(&mut hooks,memory,ctx)
 let mut header=ByteBuffer.make() run header.writeU32(@COUNT@) run Writer.writeAll(header.asSlice())
 let mut out=ByteBuffer.make() let mut a:u32=0
 while a<@KINDS@{let mut b:u32=0 while b<@KINDS@{let mut op:u32=0 while op<6{
  out.clear() run unsafe runCase(&mut out,&mut hooks,memory,ctx,a,b,0,0,op) run record(&out) op=op+1
 } b=b+1} a=a+1}
 let mut family:u32=1
 while family<10{let mut kind:u32=0 while kind<@KINDS@{let mut side:u32=0 while side<3{let mut op:u32=0 while op<6{
  let mut fa=family let mut fb=(family+3)%9+1 if side==0{fb=0} if side==1{fb=fa fa=0}
  out.clear() run unsafe runCase(&mut out,&mut hooks,memory,ctx,kind,(kind+17)%@KINDS@,fa,fb,op) run record(&out) op=op+1
 } side=side+1} kind=kind+1} family=family+1}
 let mut mode:u32=0
 while mode<4{let mut reverse:u32=0 while reverse<2{let mut op:u32=0 while op<6{
  out.clear() run unsafe faultCase(&mut out,mode,reverse!=0,op) run record(&out) op=op+1
 } reverse=reverse+1} mode=mode+1}
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | JsException | BigIntError | WriterError {
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe() let mut writer=StdoutWriter.make()
 run probe(&observer) |> Effect.provideMut<Allocator>(&mut memory) |> Effect.provideMut<Writer>(&mut writer)
 if observer.stats().usedBytes!=0||observer.stats().allocationCount!=0{trap()}
 let mut allocator=Allocator.systemAllocatorProvider() let mut footer=ByteBuffer.make()
 run footer.writeU32(2) |> Effect.provideMut<Allocator>(&mut allocator)
 run footer.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run footer.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run Writer.writeAll(footer.asSlice()) |> Effect.provideMut<Writer>(&mut writer) return 0
}
'''


def corpus():
    c, silk = leaves()
    for index, dda in enumerate((False, True), BASE_KINDS):
        c += f'\nif(kind=={index}){{JSValue value=closure(ctx,0,777,0,JS_UNDEFINED,0,JS_UNDEFINED);JS_VALUE_GET_OBJ(value)->is_HTMLDDA={int(dda)};return value;}}'
        body = 'let object = run unsafe fixture.object(&mut hooks, memory, ctx, 777) '
        if dda:
            body += ('let mut anchor = () let data = unsafe HeapCell.payloadMut<ObjectData, ()>'
                     '(&mut anchor, support.heapReference(object)) data.isHtmlDda = true ')
        silk += f'\nif kind == {index} {{ {body}return object }}'
    return c, silk


# The primitive leaf signature predates object fixtures. Explicitly thread the
# real context/provider through this consumer instead of inventing a global host.
SILK_SOURCE = SILK_SOURCE.replace('leaf(rt: *mut HeapHeader, kind: u32)',
    'leaf(hooks: &mut Hooks, memory: &AllocationObserver, ctx: *mut HeapHeader, rt: *mut HeapHeader, kind: u32)')
SILK_SOURCE = SILK_SOURCE.replace('leaf(rt,a)', 'leaf(&mut hooks,memory,ctx,rt,a)').replace('leaf(rt,b)', 'leaf(&mut hooks,memory,ctx,rt,b)')


def records(data):
    if len(data) < 4 or struct.unpack_from('<I', data)[0] != COUNT:
        raise SystemExit('Invalid comparison record count')
    offset, result = 4, []
    for _ in range(COUNT + 1):
        if offset + 4 > len(data):
            raise SystemExit('Truncated comparison header')
        size, = struct.unpack_from('<I', data, offset)
        offset += 4
        if offset + size * 4 > len(data):
            raise SystemExit('Truncated comparison record')
        result.append(struct.unpack_from(f'<{size}I', data, offset))
        offset += size * 4
    if offset != len(data) or result[-1] != (0, 0):
        raise SystemExit('Comparison trailing bytes or nonzero teardown ledger')
    return result


def label(index):
    if index < MATRIX:
        return f'matrix left={index//(KINDS*6)}, right={index//6%KINDS}, operation={index%6}'
    index -= MATRIX
    if index < CALLBACKS:
        return f'callback family={index//(KINDS*18)+1}, kind={index//18%KINDS}, side={index//6%3}, operation={index%6}'
    index -= CALLBACKS
    if index < FAULTS:
        return f'fault mode={index//12}, reverse={index//6%2}, operation={index%6}'
    return 'teardown'


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
    with tempfile.TemporaryDirectory(prefix='silkjs-comparison-', dir='/private/tmp') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        # Use original direct-malloc source profile for observable allocation
        # refusals. This does not instrument or claim an AddressSanitizer run.
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Comparison C compilation')
        expected = process([str(temp / 'oracle')], 1200, owner='Comparison C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="comparison-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 1800, owner='Native comparison oracle', cwd=temp)
        for index, (left, right) in enumerate(zip(records(expected), records(actual))):
            if left != right:
                raise SystemExit(f'Comparison mismatch {index} ({label(index)}):\nC={left}\nSilk={right}')
        print(f'PASS comparison: {COUNT} consuming operations, {KINDS} value kinds, {CALLBACKS} callback cases, '
              f'{FAULTS} parse-failure cases; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}; both ledgers zero')


if __name__ == '__main__':
    main()
