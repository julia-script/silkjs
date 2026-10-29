#!/usr/bin/env python3
"""Contrast native Intl text kernels with extracted pinned C, including exact keys.

The fixture's JS shim only supplies storage, reference/value envelopes and memory.
All C comparison and boundary decisions are verbatim pinned function bodies.
Non-ASCII word inputs outside isalnum's unsigned-char domain are counted separately
as C-undefined inputs; their observed host output is compared but is not a portable
C correctness claim. No oracle C is linked into the native executable.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ['en-US', 'de', 'de-DE', 'deu', 'DE', 'tr', 'tr-TR', 'az', 'az-Latn', 'th', 'th-TH', 'fr', 'ja', 'zz-ZZ']
COLLATIONS = ['default', 'emoji', 'eor', 'phonebk']


def corpus():
    values = ['', 'a', 'A', 'b', 'B', 'z', 'Z', 'aA', 'Aa', 'ab', 'AB', 'a-b', 'ab!', 'a b',
              '2', '10', '02', '0002', '9'*80, '1'+'0'*80, '-1', '+1', '1.2', '12', '100%', '$100',
              'a\u0308', 'ä', 'ae', 'Ä', 'ö', 'oe', 'ü', 'ue', 'ß', 'ss', 'ẞ',
              'I', 'i', 'İ', 'ı', 'h', 'h\uffff', 'i\u0307', 'é', 'e\u0301', 'e', 'E',
              '\u0301', 'a\u0315\u0300', 'a\u0300\u0315', 'ﬃ', 'ffi', 'Σ', 'σ', 'ς',
              '\x00', '\x00a', '\x7f', '\x80', '\xff', '\u0100', '\uffff', '\U0010ffff',
              '😀', '😀a', 'a😀', '👩\u200d🚀', '🇦🇧🇨🇩', '👍🏽', 'x\ufe0f', '\r\n',
              'One. Two! Three?', 'hello, world!', 'foo-bar $12.50 +1% _can\'t_',
              '\ud800', '\udc00', '\ud800a', 'a\ud800b', '\udc00\ud800', '\ud800\ud800',
              '\ud800\udc00', '\udbff\udfff', '\udbff\udfff\udbff',
              '\u0e30\u0e31\u0e3a\u0e3b', '\u0e46\u0e47\u0e4e\u0e4f',
              '\u200da\u200db', '\ufe0e\ufe0f\ufe10', '\U000e0100',
              'a\u1ab0\u1aff\u1b00', 'a\u1dc0\u1dff\u1e00', 'a\u20d0\u20ff\u2100',
              'a\ufe20\ufe2f\ufe30', '\u034f', '\u0903', '中文', 'ไทย']
    # Every pair of Hangul types, including exact edges and adjacent non-members.
    hangul = [0x10ff, 0x1100, 0x115f, 0x1160, 0x11a7, 0x11a8, 0x11ff, 0x1200, 0xabff, 0xac00, 0xac01, 0xd7a3, 0xd7a4]
    values += [chr(a)+chr(b) for a in hangul for b in hangul]
    # Boundary neighbors for every hard-coded grapheme and combining range.
    edges = [0x300,0x36f,0x1ab0,0x1aff,0x1dc0,0x1dff,0x20d0,0x20ff,0xfe20,0xfe2f,
             0xe31,0xe3a,0xe47,0xe4e,0x1f3fb,0x1f3ff,0xfe00,0xfe0f,0x200d,0x1f1e6,0x1f1ff]
    values += ['a'+chr(c) for edge in edges for c in (edge-1,edge,edge+1)]
    values = list(dict.fromkeys(values))
    units = [list(struct.unpack('<'+'H'*(len(b)//2), b)) for text in values for b in [text.encode('utf-16-le', 'surrogatepass')]]
    pairs = []
    # Tie order, inverse order and all identity cases, plus nearby independent text.
    for a,b in [('a','A'),('a','b'),('z','A'),('2','10'),('02','2'),('0002','2'),('9'*80,'1'+'0'*80),
                ('a-b','ab'),('ab!','ab'),('a b','ab'),('ä','a'),('ä','ae'),('Ä','ä'),('ö','oe'),('ü','ue'),
                ('ß','ss'),('ẞ','ß'),('I','i'),('İ','i'),('ı','i'),('ı','h'),('ı','h\uffff'),
                ('é','e'),('é','e\u0301'),('e','E'),('a\u0315\u0300','a\u0300\u0315'),
                ('ﬃ','ffi'),('Σ','ς'),('😀','\uffff'),('\ud800','\udc00'),('a\ud800b','ab'),('','\u0301'),('','\x00')]:
        x,y = values.index(a),values.index(b)
        pairs += [(x,y),(y,x)]
    pairs += [(i,i) for i in range(len(values))]
    pairs += [(i,i+1) for i in range(len(values)-1)]
    return values, units, pairs


def function(source, name):
    found = __import__('re').search(r'^(?:static )?(?:int|uint32_t \*|JSValue)\s*'+__import__('re').escape(name)+r'\(', source, __import__('re').M)
    if not found:
        raise ValueError('Missing pinned function '+name)
    end = source.index('\n}', found.end())+2
    return source[found.start():end]


def pinned_source(reference):
    collator = (reference/'intl/collator.c').read_text()
    segmenter = (reference/'intl/segmenter.c').read_text()
    parts = [collator[collator.index('enum {'):collator.index('static void js_collator_finalizer')],
             segmenter[segmenter.index('enum {'):segmenter.index('static void js_segmenter_finalizer')]]
    for name in ['is_combining_mark','is_significant','compare_case_order','transform_string','js_UTF32_compare_len','js_string_normalize1','js_collator_bound_compare']:
        parts.append(function(collator,name))
    for name in ['is_word_char','is_grapheme_extender','hangul_jamo_type','hangul_combine','js_segments_containing','js_segment_iterator_next']:
        parts.append(function(segmenter,name))
    return '\n\n'.join(parts)


def c_cases(units, pairs):
    lines=[]
    for i,items in enumerate(units):
        lines.append(f'static const uint16_t input_{i}[]={{'+','.join(map(str,items or [0]))+'};')
    lines += ['static const JSValue inputs[]={'+','.join(f'{{.units=input_{i},.length={len(items)}}}' for i,items in enumerate(units))+'};',
              'static const unsigned pairs[][2]={'+','.join(f'{{{a},{b}}}' for a,b in pairs)+'};',
              'static const char *locales[]={'+','.join(json.dumps(s) for s in LOCALES)+'};',
              'static const char *collations[]={'+','.join(json.dumps(s) for s in COLLATIONS)+'};',
              f'#define INPUT_COUNT {len(units)}\n#define PAIR_COUNT {len(pairs)}\n#define LOCALE_COUNT {len(LOCALES)}']
    return '\n'.join(lines)


NATIVE = '''import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.option { Option }
import silk.collections.list { List }
import silk.num.usize
import silk.num.i32
import silk.num.u32
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import js_string_types { StringOwner, StringLengthError }
import js_strings { Strings }
import js_value { ValueBits }
import intl_collation as col
import intl_collation { CollationOptions }
import intl_segmentation as seg
import intl_segmentation { Granularity, Segment, SegmentIterator }
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
fn word(value:i32)->u32 { if value<0 { return 0xffffffff-i32.toU32(-(value+1)) } return i32.toU32(value) }
fn granularity(i:usize)->Granularity { if i==0 { return Granularity.Grapheme } if i==1 { return Granularity.Word } return Granularity.Sentence }
effect fn segment(out:&mut ByteBuffer,value:Option<Segment>)->() !OutOfMemoryError ?&mut Allocator {
  match move value {
    Option<Segment>.None => { run out.writeU32(0) }
    Option<Segment>.Some { value:s } => { run out.writeU32(1) run out.writeU32(usize.toU32(s.index)) run out.writeU32(usize.toU32(s.length)) run out.writeU32(flag(s.isWordLike)) run out.writeU32(flag(s.includeIsWordLike)) }
  }
}
INPUT_FUNCTIONS
// Loop order is shared input schema only. Expected values are never calculated here.
effect fn exercise(out:&mut ByteBuffer)->() !OutOfMemoryError | StringLengthError ?&mut Allocator {
  let mut p:usize=0
  while p<PAIR_COUNT {
    let pair=pairAt(p)
    let a=run input(pair[0]) let b=run input(pair[1])
    let mut l:usize=0 while l<LOCALE_COUNT { let mut co:usize=0 while co<4 {
      let mut usage:i32=0 while usage<2 { let mut sensitivity:i32=0 while sensitivity<4 {
        let mut first:i32=0 while first<3 { let mut numeric:i32=0 while numeric<2 { let mut punct:i32=0 while punct<2 {
          let mut options=CollationOptions.make(locale(l),collation(co))
          options.usage=usage options.sensitivity=sensitivity options.caseFirst=first options.numeric=numeric!=0 options.ignorePunctuation=punct!=0
          run out.writeU32(word(run col.compare(a.get(),b.get(),&options)))
          punct=punct+1 } numeric=numeric+1 } first=first+1 } sensitivity=sensitivity+1 } usage=usage+1 } co=co+1 } l=l+1 }
    p=p+1
  }
  let mut n:usize=0 while n<INPUT_COUNT {
    let owner=run input(n)
    let mut points=List<u32>.make() let mut at:usize=0
    while at<Strings.length(owner.get()) { run points.append(Strings.codePoint(owner.get(),&mut at)) }
    let mut l:usize=0 while l<LOCALE_COUNT { let mut co:usize=0 while co<4 { let mut usage:i32=0 while usage<2 {
      let mut punct:i32=0 while punct<2 { let mut level:i32=0 while level<4 {
        let mut options=CollationOptions.make(locale(l),collation(co)) options.usage=usage options.ignorePunctuation=punct!=0
        let key=run col.transform_string(&options,points.asSlice(),level)
        run out.writeU32(usize.toU32(key.length()))
        let mut k:usize=0 while k<key.length() { run out.writeU32(key.get(k)) k=k+1 }
        level=level+1 } punct=punct+1 } usage=usage+1 } co=co+1 } l=l+1 }
    n=n+1
  }
  n=0 while n<INPUT_COUNT {
    let owner=run input(n) let value=owner.get() let length=Strings.length(value)
    let mut g:usize=0 while g<3 {
      let kind=granularity(g) let mut iterator=SegmentIterator.make()
      let mut i:usize=0 while i<length+2 {
        let done=iterator.nextIndex>=length
        run out.writeU32(flag(done)) run segment(&mut out.*,iterator.next(value,kind)) i=i+1
      }
      let mut pos:i32=-1 while pos<=usize.toI32(length) { run segment(&mut out.*,seg.containing(value,kind,pos)) pos=pos+1 }
      run segment(&mut out.*,seg.containing(value,kind,-2147483648)) run segment(&mut out.*,seg.containing(value,kind,2147483647))
      g=g+1
    }
    n=n+1
  }
  let mut c:u32=0 while c<0x110000 {
    run out.writeU32(flag(col.is_combining_mark(c))) run out.writeU32(flag(col.is_significant(c)))
    run out.writeU32(flag(seg.is_grapheme_extender(0,c))) run out.writeU32(word(seg.hangul_jamo_type(c))) c=c+1
  }
}
effect fn faultOperation(index:usize)->bool !OutOfMemoryError | StringLengthError ?&mut Allocator {
  let a=run input(FAULT_A) let b=run input(FAULT_B)
  let mut options=CollationOptions.make("de-DE","phonebk") options.sensitivity=usize.toI32(index%4)
  if index<4 { let result=run col.compare(a.get(),b.get(),&options) drop result }
  else if index<8 { let points:[u32;8]=[0xc4,0xdf,0x131,0x301,0x315,0x300,0xd800,0x1f600] let key=run col.transform_string(&options,&points,usize.toI32(index%4)) drop key }
  else { let normalized=run col.normalize_string(a.get()) drop normalized }
  return true
}
effect fn refused(error:OutOfMemoryError | StringLengthError)->bool { drop error return false }
effect fn allocationSweeps(out:&mut ByteBuffer)->() !OutOfMemoryError | StringLengthError ?&mut Allocator {
  let mut attempts:usize=0 let mut failures:usize=0 let mut successes:usize=0 let mut index:usize=0
  while index<9 {
    let mut baseline=run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
    let ok=run faultOperation(index) |> Effect.provideMut<Allocator>(&mut baseline)
    let peak=baseline.stats().peakBytes
    if !ok || baseline.stats().usedBytes!=0 || baseline.stats().allocationCount!=0 { return Intrinsic.trap("Intl text baseline owner leak") }
    drop baseline
    let mut limit:usize=0 while limit<=peak {
      let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
      memory.setLimit(limit)
      let accepted=run Effect.catchAll(faultOperation(index),refused) |> Effect.provideMut<Allocator>(&mut memory)
      if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 { return Intrinsic.trap("Intl text temporary owner leak") }
      drop memory
      if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 { return Intrinsic.trap("Intl text detached owner leak") }
      if accepted { successes=successes+1 } else { failures=failures+1 }
      if limit==peak && !accepted { return Intrinsic.trap("Intl text fault sweep never succeeds") }
      attempts=attempts+1 limit=limit+1
    }
    index=index+1
  }
  run out.writeU32(9) run out.writeU32(usize.toU32(attempts)) run out.writeU32(usize.toU32(failures)) run out.writeU32(usize.toU32(successes))
}
pub effect fn main()->i32 !OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make() let mut out=ByteBuffer.make()
  run exercise(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run allocationSweeps(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def native_source(values, units, pairs):
    funcs = ['effect fn input(index:usize)->StringOwner !OutOfMemoryError | StringLengthError ?&mut Allocator { match index {']
    for i,items in enumerate(units):
        funcs.append(f'{i} => {{ let units:[u16;{len(items)}]=['+','.join(map(str,items))+'] return StringOwner.adopt(run Strings.fromUtf16(&units)) }')
    funcs += ['_ => { return Intrinsic.trap("Unknown input") } } }',
              'fn pairAt(index:usize)->[usize;2] { match index {']
    funcs += [f'{i} => {{ return [{a},{b}] }}' for i,(a,b) in enumerate(pairs)]
    funcs += ['_ => { return Intrinsic.trap("Unknown pair") } } }']
    for name,items in [('locale',LOCALES),('collation',COLLATIONS)]:
        funcs += [f"fn {name}(index:usize)->string<'static> {{ match index {{"]
        funcs += [f'{i} => {{ return {json.dumps(item)} }}' for i,item in enumerate(items)]
        funcs += ['_ => { return Intrinsic.trap("Unknown option") } } }']
    return (NATIVE.replace('INPUT_FUNCTIONS','\n'.join(funcs)).replace('PAIR_COUNT',str(len(pairs)))
            .replace('LOCALE_COUNT',str(len(LOCALES))).replace('INPUT_COUNT',str(len(units)))
            .replace('FAULT_A',str(values.index('a\u0315\u0300'))).replace('FAULT_B',str(values.index('a\u0300\u0315'))))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream',type=Path,required=True)
    parser.add_argument('--silk',default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib',type=Path,default=toolchain.stdlib_path())
    parser.add_argument('--cc', default=toolchain.clang_path())
    parser.add_argument('--timeout',type=int,default=900)
    parser.add_argument('--sanitize-c',action='store_true')
    args=parser.parse_args()
    reference=args.upstream.resolve()
    validate_pins(reference)
    values,units,pairs=corpus()
    source_files=['intl/collator.c','intl/segmenter.c','libunicode.c','libunicode-table.h','cutils.c']
    for name in source_files:
        print(f'Source {name}: sha256={hashlib.sha256((reference/name).read_bytes()).hexdigest()}',flush=True)
    with tempfile.TemporaryDirectory(prefix='silkjs-intl-text-') as directory:
        tmp=Path(directory).resolve()
        (tmp/'pinned_text.inc').write_text(pinned_source(reference))
        (tmp/'text_cases.inc').write_text(c_cases(units,pairs))
        shutil.copyfile(ROOT/'scripts/intl_text_oracle.c',tmp/'oracle.c')
        flags=['-fsanitize=address,undefined','-fno-sanitize-recover=all','-fno-omit-frame-pointer'] if args.sanitize_c else []
        if os.uname().sysname == 'Darwin':
            sdk=subprocess.check_output(['xcrun','--show-sdk-path'],text=True).strip()
            flags += ['-isysroot',sdk]
        process([executable_path(args.cc),'-std=gnu11','-O2',*flags,'-I',str(reference),str(tmp/'oracle.c'),str(reference/'libunicode.c'),str(reference/'cutils.c'),'-o',str(tmp/'oracle')],args.timeout,owner='Pinned Intl text C compilation')
        expected=process([str(tmp/'oracle')],args.timeout,owner='Pinned Intl text C execution')
        shutil.copytree(ROOT/'src',tmp/'src')
        shutil.copyfile(ROOT/'silk.toml',tmp/'silk.toml')
        (tmp/'src/intl_text_probe.silk').write_text(native_source(values,units,pairs))
        process([executable_path(args.silk),'build','src/intl_text_probe.silk','-o',str(tmp/'native'),'--stdlib',str(args.stdlib.resolve()),'--optimization','speed','--debug','false'],args.timeout,owner='Native Intl text compilation',cwd=tmp)
        actual=process([str(tmp/'native')],args.timeout,owner='Native Intl text execution')
        if actual[:-16]!=expected:
            offset=next((i for i,(a,b) in enumerate(zip(actual,expected)) if a!=b),min(len(actual)-16,len(expected)))
            raise SystemExit(f'Intl text mismatch byte={offset} C={len(expected)} native={len(actual)-16}; C nearby={expected[max(0,offset-16):offset+32].hex()} native nearby={actual[max(0,offset-16):offset+32].hex()}')
        cases,attempts,failures,successes=struct.unpack('<4I',actual[-16:])
        if cases!=9 or failures==0 or successes<9 or attempts!=failures+successes:
            raise SystemExit('Incomplete fault injection ledger')
        comparisons=len(pairs)*len(LOCALES)*4*2*4*3*2*2
        keys=len(units)*len(LOCALES)*4*2*2*4
        undefined=sum(any(ord(c)>255 for c in value) for value in values)
        print(f'Intl text: {len(units)} UTF16 inputs; {len(pairs)} pairs; {len(LOCALES)} locale paths; {comparisons} exact comparisons; {keys} complete transform keys; all three granularities, every containing code-unit index plus out-of-range extrema, exhausted iteration; 1114112 exhaustive property records')
        print(f'Behavior stream: bytes={len(expected)} sha256={hashlib.sha256(expected).hexdigest()}')
        print(f'Allocation sweeps: {cases} operations, {attempts} byte-budget attempts, {failures} failures, {successes} successes; zero live bytes/owners before and after allocator destruction')
        print(f'C undefined-domain inputs: {undefined}/{len(values)} word strings contain codepoints > U+00FF passed to isalnum by pinned is_word_char; host-observed outputs compared, not portable C guarantees')
        if args.sanitize_c:
            print('C oracle ASan/UBSan: passed complete stream (libc ctype domain preconditions are not diagnosed by these sanitizers); typed allocator callback shim only')
        print('JS constructor/options/property/GC wrappers excluded; complete text kernels only, not complete Intl JS integration')


if __name__=='__main__':
    main()
