#!/usr/bin/env python3
"""Compare owned JSON graphs and source-record lookups with unchanged pinned C.

No stringify, eval, Python JSON parser, or copied parser implementation is used.
Property snapshots preserve the actual ordered own storage (including numeric keys),
UTF-16 units, descriptors, prototype identity and IEEE bits. Records are observed
AFTER releasing the returned value, through the public native lookup API; duplicate
lookup intentionally follows upstream's first-before-nine/newest-after rule.
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
SOURCES = [
    b'null', b'true', b'false', b'0', b'-0', b'-0.0', b'1', b'-1',
    b'2147483647', b'2147483648', b'-2147483648', b'-2147483649',
    b'9007199254740991', b'9007199254740992', b'9007199254740993',
    b'1.7976931348623157e308', b'1.7976931348623159e308', b'-1e400',
    b'5e-324', b'2.4703282292062327e-324', b'2.4703282292062328e-324',
    b'2.2250738585072014e-308', b'-1e-400', b'0.10000000000000000555',
    b'""', b'"plain"', b'"\\\"\\\\\\/\\b\\f\\n\\r\\t"',
    b'"\\u0000\\u00ff\\u0100\\uffff"', b'"\\ud800"', b'"\\udc00"',
    b'"\\ud83d\\ude00"', b'"\\ud800x\\udc00"', '"é😀"'.encode(),
    b'{}', b'[]', b'[null,true,false,0,-0,"x",[],{}]',
    b'{"nested":[{"x":"original"},[1,2,3]],"end":false}',
    b'{"x":"first","x":"last"}',
    b'{"x":{"old":["held"]},"x":{"new":[false]}}',
    b'{"2":2,"10":10,"1":1,"01":11,"4294967294":4,"4294967295":5,"__proto__":{"polluted":true},"constructor":0}',
    b' \t\r\n [ -0.00e+00 , "\\u0061" , true , null ] \r\n',
    b'NaN', b'Infinity', b'+Infinity', b'-Infinity', b'+NaN', b'-NaN',
    b'[NaN,Infinity,+Infinity,-Infinity]', b'+1', b'.5', b'1.', b'0x10',
    b'0b10', b'0o10', b'01', b'-01', b'{a:1,}', b"{'x':'a\\x41',}",
    b'{true:1,null:2,NaN:3,Infinity:4}', b'[1,2,]', b'/* hi */ {a:1}//end',
    b'"a\\\nb"', b'"\\v\\0"', b'"\\q"',
    b'', b' ', b'undefined', b'[', b'{', b'[1', b'{"a"', b'{"a" 1}',
    b'{"a":}', b'{,}', b'[,]', b'[1,,2]', b'[1 2]', b'{"a":1 "b":2}',
    b'null true', b'{}[]', b'\n {"a": [1,\n 2,]} trailing',
    b'"unterminated', b'"\\u12"', b'"\\uZZZZ"', b'"raw\nnewline"',
    b'1e', b'1e+', b'-', b'--1', b'1n', b'1_0', b'//only comment',
    '{"é":1,\n "x": }'.encode(), b'\r\n[true,\r\nfalse] garbage',
]
# Eight/nine/sixteen/seventeen entries exercise both hash thresholds with a
# displaced object whose lifetime cannot be tested by primitive values alone.
for count in (2, 8, 9, 16, 17):
    SOURCES.append(b'{"dup":{"old":["held"]},' + b','.join(
        ('"k%d":%d' % (i, i)).encode() for i in range(count - 2))
        + (b',' if count > 2 else b'') + b'"dup":{"new":[42]}}')
for depth in (3, 16, 48):
    SOURCES.append(b'{"a":[' * depth + b'"leaf"' + b']}' * depth)
CASES = [(source, extended, records) for source in SOURCES
         for extended in (False, True) for records in (False, True)]

C_SOURCE = r'''
#include "quickjs.c"
static void word(uint32_t x) { for(int i=0;i<4;i++)putchar((x>>(8*i))&255); }
static JSValue checked(JSValue v) { if(JS_IsException(v))abort();return v; }
static void text(JSValue v) {
    if(!JS_IsString(v))abort();JSString *s=JS_VALUE_GET_STRING(v);
    word(s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));
}
static void graph(JSContext *ctx,JSValue v) {
    int tag=JS_VALUE_GET_TAG(v);
    if(JS_IsUndefined(v)){word(0);return;} if(JS_IsNull(v)){word(1);return;}
    if(JS_IsBool(v)){word(2);word(JS_VALUE_GET_BOOL(v));return;}
    if(tag==JS_TAG_INT){word(3);word(JS_VALUE_GET_INT(v));return;}
    if(tag==JS_TAG_FLOAT64){union{double d;uint64_t u;}n={.d=JS_VALUE_GET_FLOAT64(v)};
        word(4);word(n.u);word(n.u>>32);return;}
    if(JS_IsString(v)){word(5);text(v);return;}
    if(!JS_IsObject(v))abort();JSObject *p=JS_VALUE_GET_OBJ(v);JSShape *s=p->shape;
    int arr=p->class_id==JS_CLASS_ARRAY;word(arr?6:7);
    word(s->proto==JS_VALUE_GET_OBJ(ctx->class_proto[arr?JS_CLASS_ARRAY:JS_CLASS_OBJECT]));
    if(arr){word(p->u.array.count);graph(ctx,p->prop[0].u.value);
        for(uint32_t i=0;i<p->u.array.count;i++)graph(ctx,p->u.array.u.values[i]);return;}
    word(s->prop_count);
    for(int i=0;i<s->prop_count;i++) {JSShapeProperty *sp=get_shape_prop(s)+i;
        JSValue key=checked(JS_AtomToString(ctx,sp->atom));text(key);JS_FreeValue(ctx,key);
        word(sp->flags);graph(ctx,p->prop[i].u.value);}
}
static void record(JSContext *ctx,JSONParseRecord *r,const uint8_t *source) {
    int kind=JS_IsUndefined(r->value)?0:JS_IsObject(r->value)?(JS_IsArray(ctx,r->value)?3:2):1;
    word(kind);graph(ctx,r->value);
    if(kind==1){word(r->u.primitive.source_pos);word(r->u.primitive.source_len);
        for(uint32_t i=0;i<r->u.primitive.source_len;i++)word(source[r->u.primitive.source_pos+i]);}
    if(kind==3){word(r->u.array.count);for(int i=0;i<r->u.array.count;i++)record(ctx,&r->u.array.elements[i],source);}
    if(kind==2){JSShape *s=JS_VALUE_GET_OBJ(r->value)->shape;word(r->u.obj.count);word(s->prop_count);
        for(int i=0;i<s->prop_count;i++){JSAtom atom=get_shape_prop(s)[i].atom;
            JSValue key=checked(JS_AtomToString(ctx,atom));text(key);JS_FreeValue(ctx,key);
            JSONParseRecord *child=json_parse_record_find(r,atom);if(!child)abort();record(ctx,child,source);}}
}
static void probe(JSContext *ctx,unsigned id,const uint8_t *source,size_t length,int ext,int capture) {
    JSONParseRecord r={.value=JS_UNDEFINED};word(id);
    JSValue v=JS_ParseJSON3(ctx,(const char*)source,length,"json-oracle",ext?JS_PARSE_JSON_EXT:0,capture?&r:NULL);
    if(JS_IsException(v)){word(1);JSValue error=JS_GetException(ctx);
        JSValue message=checked(JS_GetPropertyStr(ctx,error,"message"));text(message);JS_FreeValue(ctx,message);
        const char *names[]={"lineNumber","columnNumber"};
        for(int i=0;i<2;i++){JSValue n=checked(JS_GetPropertyStr(ctx,error,names[i]));
            if(JS_VALUE_GET_TAG(n)!=JS_TAG_INT)abort();word(JS_VALUE_GET_INT(n));JS_FreeValue(ctx,n);}
        JS_FreeValue(ctx,error);return;}
    word(0);graph(ctx,v);JS_FreeValue(ctx,v);word(capture);
    if(capture){record(ctx,&r,source);json_free_parse_record(ctx,&r);}
}
int main(void){JSRuntime *rt=JS_NewRuntime();if(!rt)abort();JSContext *ctx=JS_NewContextRaw(rt);if(!ctx)abort();
CALLS
JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.num.f64
import silk.num.i32
import silk.num.i64
import silk.core.option { Option }
import silk.mem.pointer { Pointer }
import silk.core.result { Result }
import silk.num.u8
import silk.num.u16
import silk.num.u32
import silk.num.u64
import silk.num.usize
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import native_stack { currentFrameAddress }
import js_heap { HeapCell, HeapHeader }
import js_value { ValueBits }
import js_core_types { ContextState, RuntimeState, ObjectData, ObjectPayload, ShapeData, PropertySlot }
import js_gc as gc
import js_runtime as runtime
import js_class_data as classes
import js_strings { Strings }
import js_string_types { StringLengthError, StringOwner }
import js_bigint { BigIntError }
import js_parser_diagnostics { SyntaxError }
import js_parser_core { ParserStackOverflow }
import js_json_parse as json
import js_json_parse { ParsedJson, JsonParseRecords, JsonRecordKind, JsonSourceSpan }
import js_json_parse_test_support as jsonFixture
import js_array_storage_test_support { Hooks, trap, reference }
fn word(n:i32)->u32 {let mut x=i32.toI64(n) if x<0{x=x+4294967296} return i64.toU32(x)}
fn boolean(value:bool)->u32 {if value{return 1} return 0}
unsafe effect fn text(out:&mut ByteBuffer,v:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  if !v.isString(){trap()} run out.writeU32(usize.toU32(Strings.length(v))) let mut i:usize=0
  while i<Strings.length(v){run out.writeU32(u16.toU32(Strings.codeUnit(v,i))) i=i+1}
}
unsafe effect fn key(out:&mut ByteBuffer,rt:*mut HeapHeader,atom:u32)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let anchor=() let state=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  let value=StringOwner.adopt(run state.atoms.toValue(atom,true)) run unsafe text(&mut out,value.get())
}
unsafe effect fn graph(out:&mut ByteBuffer,ctx:*mut HeapHeader,v:ValueBits)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  match v {
    ValueBits.Undefined=>{run out.writeU32(0)} ValueBits.Null=>{run out.writeU32(1)}
    ValueBits.Bool {value}=>{run out.writeU32(2) run out.writeU32(boolean(value))}
    ValueBits.Int {value}=>{run out.writeU32(3) run out.writeU32(word(value))}
    ValueBits.Float64 {value}=>{run out.writeU32(4) let bits=f64.toBits(value)
      run out.writeU32(u64.toU32(bits&0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(bits,32)))}
    ValueBits.Object {reference:node}=>{
      let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,node)
      let shape=unsafe HeapCell.payload<ShapeData,()>(&anchor,p.shape)
      let context=unsafe HeapCell.payload<ContextState,()>(&anchor,ctx)
      let arr=p.classId==classes.JS_CLASS_ARRAY let mut kind:u32=7 let mut expectedClass=classes.JS_CLASS_OBJECT
      if arr {kind=6 expectedClass=classes.JS_CLASS_ARRAY} run out.writeU32(kind)
      let expected=reference(context.classPrototypes.get(u32.toUsize(expectedClass)))
      run out.writeU32(boolean(Pointer.address<HeapHeader>(shape.prototype)==Pointer.address<HeapHeader>(expected)))
      if arr {
        match &p.payload {ObjectPayload.FastArray {array}=>{
          run out.writeU32(usize.toU32(array.values.length()))
          match p.properties.get(0){PropertySlot.Value {value}=>{run unsafe graph(&mut out,ctx,value)} _=>trap()}
          let mut i:usize=0 while i<array.values.length(){run unsafe graph(&mut out,ctx,array.values.get(i)) i=i+1}
        } _=>trap()}
      } else {
        run out.writeU32(usize.toU32(shape.properties.length())) let mut i:usize=0
        while i<shape.properties.length(){let prop=shape.properties.get(i)
          run unsafe key(&mut out,context.runtime,prop.atom) run out.writeU32(u8.toU32(prop.flags))
          match p.properties.get(i){PropertySlot.Value {value}=>{run unsafe graph(&mut out,ctx,value)} _=>trap()} i=i+1}
      }
    }
    _=>{if !v.isString(){trap()} run out.writeU32(5) run unsafe text(&mut out,v)}
  }
}
unsafe effect fn record(out:&mut ByteBuffer,ctx:*mut HeapHeader,r:&JsonParseRecords,index:usize)->()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let kind=r.kind(index) run out.writeU32(match kind {JsonRecordKind.Empty=>0 JsonRecordKind.Primitive=>1 JsonRecordKind.Object=>2 JsonRecordKind.Array=>3})
  let value=r.originalValue(index) run unsafe graph(&mut out,ctx,value)
  if kind==JsonRecordKind.Primitive {
    match r.sourceSpan(index){Option<JsonSourceSpan>.Some {value:span}=>{
      run out.writeU32(usize.toU32(span.start)) run out.writeU32(usize.toU32(span.length))
      match r.primitiveSource(index){Option<&[u8]>.Some {value:bytes}=>{let mut i:usize=0 while i<bytes.length {run out.writeU32(u8.toU32(bytes[i])) i=i+1}} _=>trap()}
    } _=>trap()}
  }
  if kind==JsonRecordKind.Array {run out.writeU32(usize.toU32(r.childCount(index))) let mut i:usize=0
    while i<r.childCount(index){match r.arrayElement(index,i){Option<usize>.Some {value:child}=>{run unsafe record(&mut out,ctx,r,child)} _=>trap()} i=i+1}}
  if kind==JsonRecordKind.Object {
    let anchor=() let p=unsafe HeapCell.payload<ObjectData,()>(&anchor,reference(value))
    let shape=unsafe HeapCell.payload<ShapeData,()>(&anchor,p.shape)
    run out.writeU32(usize.toU32(r.childCount(index))) run out.writeU32(usize.toU32(shape.properties.length()))
    let mut i:usize=0 while i<shape.properties.length(){let atom=shape.properties.get(i).atom
      run unsafe key(&mut out,unsafe runtime.contextRuntime(ctx),atom)
      match r.find(index,atom){Option<usize>.Some {value:child}=>{run unsafe record(&mut out,ctx,r,child)} _=>trap()} i=i+1}
  }
}
unsafe effect fn probe(out:&mut ByteBuffer,ctx:*mut HeapHeader,hooks:&mut Hooks,memory:&AllocationObserver,
  filename:ValueBits,id:u32,source:&[u8],extended:bool,capture:bool)->()
  ! OutOfMemoryError | StringLengthError | BigIntError | ParserStackOverflow ? &mut Allocator {
  run out.writeU32(id)
  let result=run Effect.result(unsafe json.parse(&mut hooks,memory,ctx,source,filename,extended,capture))
  match move result {
    Result<ParsedJson,OutOfMemoryError | StringLengthError | BigIntError | SyntaxError | ParserStackOverflow>.Success {value:parsed}=>{
      let mut owned=move parsed run out.writeU32(0) run unsafe graph(&mut out,ctx,owned.value())
      let mut records=owned.takeRecords() unsafe owned.destroy(&mut hooks)
      run out.writeU32(boolean(capture))
      match &mut records {Option<JsonParseRecords>.Some {value:r}=>{
        let root=match r.root(){Option<usize>.Some {value}=>value _=>trap()}
        run unsafe record(&mut out,ctx,&r,root) unsafe r.destroy(&mut hooks)
      } Option<JsonParseRecords>.None=>{if capture {trap()}}}
    }
    Result<ParsedJson,OutOfMemoryError | StringLengthError | BigIntError | SyntaxError | ParserStackOverflow>.Failure {error}=>{
      match move error {
        SyntaxError e=>{run out.writeU32(1) run unsafe text(&mut out,e.message.get())
          run out.writeU32(word(e.location.line)) run out.writeU32(word(e.location.column))}
        OutOfMemoryError e=>{fail move e} StringLengthError e=>{fail move e}
        BigIntError e=>{fail move e} ParserStackOverflow e=>{fail move e}
      }
    }
  }
}
effect fn all(out:&mut ByteBuffer)->AllocationObserver ! OutOfMemoryError | StringLengthError | BigIntError | ParserStackOverflow ? &mut Allocator {
  let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let ledger=run memory.observe()
  let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
  let mut hooks=Hooks {finalized:0}
  let ctx=run unsafe jsonFixture.context(rt,&ledger,&mut hooks) |> Effect.provideMut<Allocator>(&mut memory)
  let filename=StringOwner.adopt(run Strings.fromLatin1(b"json-oracle") |> Effect.provideMut<Allocator>(&mut memory))
CALLS
  drop filename unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt) |> Effect.provideMut<Allocator>(&mut memory)
  return move ledger
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | BigIntError | ParserStackOverflow | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make()
  let ledger=run all(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut writer=StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  drop out if ledger.stats().usedBytes!=0 || ledger.stats().allocationCount!=0 {trap()} return 0
}
'''


def silk_bytes(source):
    return 'b"' + ''.join('\\x%02x' % byte for byte in source) + '"'


class Decoder:
    def __init__(self, data, owner):
        if len(data) % 4:
            raise SystemExit(f'{owner}: truncated output ({len(data)} bytes)')
        self.words = struct.unpack('<' + 'I' * (len(data) // 4), data)
        self.index = 0
        self.owner = owner

    def word(self):
        if self.index == len(self.words):
            raise SystemExit(f'{self.owner}: truncated word {self.index}')
        value = self.words[self.index]
        self.index += 1
        return value

    def text(self):
        return tuple(self.word() for _ in range(self.word()))

    def graph(self):
        kind = self.word()
        if kind in (0, 1):
            return (kind,)
        if kind in (2, 3):
            return kind, self.word()
        if kind == 4:
            return kind, self.word() | self.word() << 32
        if kind == 5:
            return kind, self.text()
        if kind in (6, 7):
            prototype, count = self.word(), self.word()
            if kind == 6:
                return kind, prototype, self.graph(), tuple(self.graph() for _ in range(count))
            return kind, prototype, tuple((self.text(), self.word(), self.graph()) for _ in range(count))
        raise SystemExit(f'{self.owner}: invalid graph tag {kind} at word {self.index - 1}')

    def record(self):
        kind, value = self.word(), self.graph()
        if kind == 0:
            return kind, value
        if kind == 1:
            start, length = self.word(), self.word()
            return kind, value, start, bytes(self.word() for _ in range(length))
        if kind == 3:
            return kind, value, tuple(self.record() for _ in range(self.word()))
        if kind == 2:
            count, unique = self.word(), self.word()
            return kind, value, count, tuple((self.text(), self.record()) for _ in range(unique))
        raise SystemExit(f'{self.owner}: invalid record kind {kind}')

    def case(self, expected_id):
        identifier, failed = self.word(), self.word()
        if identifier != expected_id:
            raise SystemExit(f'{self.owner}: case framing {identifier} != {expected_id}')
        if failed == 1:
            return {'error': self.text(), 'line': self.word(), 'column': self.word()}
        if failed != 0:
            raise SystemExit(f'{self.owner}: invalid outcome {failed}')
        graph, capture = self.graph(), self.word()
        if capture not in (0, 1):
            raise SystemExit(f'{self.owner}: invalid capture flag {capture}')
        return {'graph': graph, 'record': self.record() if capture else None}


def difference(expected, actual, path='$'):
    if type(expected) is not type(actual):
        return f'{path}: C={expected!r}, native={actual!r}'
    if isinstance(expected, dict):
        if expected.keys() != actual.keys():
            return f'{path}: C keys={list(expected)}, native keys={list(actual)}'
        for key in expected:
            found = difference(expected[key], actual[key], f'{path}.{key}')
            if found:
                return found
    elif isinstance(expected, tuple):
        if len(expected) != len(actual):
            return f'{path}: C length={len(expected)}, native length={len(actual)}'
        for index, (a, b) in enumerate(zip(expected, actual)):
            found = difference(a, b, f'{path}[{index}]')
            if found:
                return found
    elif expected != actual:
        return f'{path}: C={expected!r}, native={actual!r}'
    return None


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
    c_calls, s_calls = [], []
    for index, (source, extended, records) in enumerate(CASES):
        data = ','.join(str(byte) for byte in source + b'\0')
        c_calls.append(f'{{const uint8_t source[]={{ {data} }};probe(ctx,{index},source,{len(source)},{int(extended)},{int(records)});}}')
        s_calls.append(f'  run unsafe probe(&mut out,ctx,&mut hooks,&ledger,filename.get(),{index},{silk_bytes(source)},{str(extended).lower()},{str(records).lower()}) |> Effect.provideMut<Allocator>(&mut memory)')
    with tempfile.TemporaryDirectory(prefix='silkjs-json-parse-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE.replace('CALLS', '\n'.join(c_calls)))
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='JSON C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='JSON C oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('CALLS', '\n'.join(s_calls)))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="json-parse-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command, 900, owner='Native JSON oracle', cwd=temp)
        c, native = Decoder(expected, 'C'), Decoder(actual, 'native')
        for index, (source, extended, records) in enumerate(CASES):
            mismatch = difference(c.case(index), native.case(index))
            if mismatch:
                raise SystemExit(f'JSON case {index}, extended={extended}, capture={records}, source={source!r}\n{mismatch}')
        if c.index != len(c.words) or native.index != len(native.words):
            raise SystemExit('JSON oracle has unexpected trailing output')
        print(f'PASS JSON: {len(CASES)} graph/record cases; {pins} pinned files; SHA256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
