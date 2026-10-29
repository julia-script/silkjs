#!/usr/bin/env python3
"""Differential pure Intl probe: extracted pinned C, never production C semantics.

Includes canonicalization, extensions, every numbering identity/digit, locale and
currency boundaries, display pools and inherited collations. Also contrasts every
logical locale table field and raw string byte (including embedded/terminal NULs)
against compiled C, then sweeps every byte budget of each owned-operation case.
Neither oracle values nor C algorithms use the native table generator. --sanitize-c
first proves the pinned DynBuf callback cast is C undefined behavior, then replaces
only that oracle ABI cast with a typed forwarding adapter and checks all cases.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import struct
from verify_bytecode import executable_path, process, validate_pins
import toolchain

ROOT = Path(__file__).resolve().parents[1]

# Independent oracle schema: field names come from intl_private.h, not the
# transcription generator. C evaluates every initializer and sizeof expression.
LOCALE_FIELDS = (
    'symbols.decimal_idx symbols.group_idx symbols.plusSign_idx symbols.minusSign_idx '
    'symbols.percentSign_idx symbols.infinity_idx symbols.nan_idx '
    'patterns.dec_pos patterns.dec_neg patterns.cur_pos patterns.cur_neg '
    'patterns.acc_pos patterns.acc_neg patterns.pct_pos patterns.pct_neg '
    'month_long_idx month_short_idx month_narrow_idx weekday_long_idx weekday_short_idx '
    'weekday_narrow_idx era_idx ampm_idx dayperiod_idx dayperiod_narrow_idx '
    'datePatternShort_idx datePatternMedium_idx datePatternLong_idx datePatternFull_idx '
    'timePatternShort_idx timePatternMedium_idx timePatternLong_idx timePatternFull_idx '
    'combinedPatternShort_idx combinedPatternMedium_idx combinedPatternLong_idx combinedPatternFull_idx '
    'numCompactPatterns groupSize1 groupSize2 currency_offset num_currencies'
).split()
DISPLAY_FIELDS = 'languages regions regions_short scripts calendars dateTimeFields currencies'.split()


def table_probes(reference):
    source = (reference / 'intl/locale-data.c').read_text()
    # Discover declarations only. Never decode C strings or numeric initializers.
    declarations = list(re.finditer(
        r'^(?:static )?const (char \*|char|uint8_t|CompactDecimalPattern|LocaleData|DisplayNamesData)\s*(\w+)\[\] = ',
        source, re.M))
    c, silk, helpers = [], [], []
    for number, declaration in enumerate(declarations):
        kind, name = declaration.groups()
        body = source[declaration.end():]
        c.append(f'emit(sizeof({name})/sizeof({name}[0]));')
        lines = [f'run out.writeU32(usize.toU32(data.{name}_len))']
        if kind in ('char', 'uint8_t'):
            c.append(f'raw({name},sizeof({name}));')
            lines.append(f'run raw(&mut out.*,data.{name}())')
        elif kind == 'char *':
            body = body[:body.index('\n};')]
            literals = re.findall(r'"(?:[^"\\]|\\.)*"', body)
            # Each table entry is one C literal at this pin; fail closed otherwise.
            residue = re.sub(r'"(?:[^"\\]|\\.)*"', '', body)
            if re.sub(r'[\s,{]', '', residue):
                raise ValueError(f'Unhandled pointer initializer in {name}')
            lengths = ','.join(f'sizeof({literal})' for literal in literals)
            c.append(f'{{size_t sizes[]={{ {lengths} }}; _Static_assert(sizeof(sizes)/sizeof(sizes[0])==sizeof({name})/sizeof({name}[0]),"table coverage"); for(size_t i=0;i<sizeof({name})/sizeof({name}[0]);i++){{raw({name}[i],sizes[i]);raw({name}[i],sizes[i]-1);}}}}')
            lines += [f'let mut i:usize=0 while i<data.{name}_len {{',
                      f'run raw(&mut out.*,data.{name}_raw(i)) run raw(&mut out.*,data.{name}(i)) i=i+1 }}']
        elif kind == 'CompactDecimalPattern':
            c.append(f'for(size_t i=0;i<sizeof({name})/sizeof({name}[0]);i++){{emit({name}[i].scale_exp);text({name}[i].shortPattern);text({name}[i].longPattern);}}')
            lines += [f'let mut i:usize=0 while i<data.{name}_len {{ let row=data.{name}(i)',
                      'run out.writeU32(word(row.scale_exp))',
                      'run optionalBytes(&mut out.*,move row.shortPattern)',
                      'run optionalBytes(&mut out.*,move row.longPattern) i=i+1 }']
        elif kind == 'LocaleData':
            c.append(f'for(size_t i=0;i<sizeof({name})/sizeof({name}[0]);i++){{const LocaleData *row=&{name}[i];text(row->locale);')
            lines += [f'let mut i:usize=0 while i<data.{name}_len {{ let row=data.{name}(i)',
                      'run raw(&mut out.*,row.locale)']
            for field in LOCALE_FIELDS:
                c.append(f'emit(row->{field});')
                lines.append(f'run out.writeU32(usize.toU32(row.{field}))')
            c.append('for(size_t j=0;j<row->numCompactPatterns;j++){emit(row->compactPatterns[j].scale_exp);text(row->compactPatterns[j].shortPattern);text(row->compactPatterns[j].longPattern);} }')
            lines += ['let mut j:usize=0 while j<row.numCompactPatterns {',
                      'let pattern=data.compact_pattern(row.compactPatterns+j)',
                      'run out.writeU32(word(pattern.scale_exp))',
                      'run optionalBytes(&mut out.*,move pattern.shortPattern)',
                      'run optionalBytes(&mut out.*,move pattern.longPattern) j=j+1 } i=i+1 }']
        else:
            # Compare complete embedded-NUL pools through actual record pointers.
            c.append(f'for(size_t i=0;i<sizeof({name})/sizeof({name}[0]);i++){{text({name}[i].locale);')
            lines += [f'let mut i:usize=0 while i<data.{name}_len {{ let row=data.{name}(i)',
                      'run raw(&mut out.*,row.locale)']
            for field in DISPLAY_FIELDS:
                c.append(f'raw({name}[i].{field},i==0?sizeof(dn_en_{field})-1:sizeof(dn_fr_{field})-1);')
                lines.append(f'run raw(&mut out.*,row.{field})')
            c.append('}')
            lines.append('i=i+1 }')
        helpers.append(f'effect fn table{number}(out:&mut ByteBuffer)->() !OutOfMemoryError ?&mut Allocator {{\n' + '\n'.join(lines) + '\n}')
        silk.append(f'run table{number}(&mut out.*)')
    # The C enum and direct arrays independently cover numbering identities,
    # sparse zero digit bases, Han decimal digits and supported collations.
    c += ['emit(NS_COUNT);emit(intl_all_numbering_systems_count);emit(intl_supported_collations_count);',
          'for(int i=0;i<NS_COUNT;i++){text(intl_all_numbering_systems[i]);emit(nf_digit_base[i]);}',
          'for(int i=0;i<10;i++)emit(hanidec_cps[i]);',
          'for(int i=0;i<intl_supported_collations_count;i++)text(intl_supported_collations[i]);']
    silk += ['run out.writeU32(i32.toU32(numbering.NS_COUNT))',
             'run out.writeU32(i32.toU32(numbering.intl_all_numbering_systems_count))',
             'run out.writeU32(i32.toU32(numbering.intl_supported_collations_count))',
             'let mut ns:i32=0 while ns<numbering.NS_COUNT { run text(&mut out.*,Option<string>.some(numbering.intl_all_numbering_systems(ns))) run out.writeU32(numbering.nf_digit_base(ns)) ns=ns+1 }',
             'let mut d:i32=0 while d<10 { run out.writeU32(numbering.hanidec_cps(d)) d=d+1 }',
             'let mut col:i32=0 while col<numbering.intl_supported_collations_count { run text(&mut out.*,Option<string>.some(numbering.intl_supported_collations(col))) col=col+1 }']
    return c, silk, '\n'.join(helpers), [declaration.group(1) for declaration in declarations]


def allocation_source(calls):
    operations = []
    for call in calls:
        # Reuse the complete existing owned-operation input inventory, never
        # semantic expected results. Each operation has its own ownership scope.
        if 'run owned(out, ' in call:
            operation = call.replace('run owned(out, ', 'run discard(').replace('else { run text(out, Option<string>.none()) }', 'else {}')
            operations.append(operation)
    arms = '\n'.join(f'{i} => {{ {operation} }}' for i, operation in enumerate(operations))
    return '''
effect fn discard(value:Option<String>)->() { drop value }
effect fn faultOperation(index:usize)->bool !OutOfMemoryError ?&mut Allocator {
  match index { ARMS _ => { return Intrinsic.trap("Unknown allocation case") } }
  return true
}
effect fn refused(error:OutOfMemoryError)->bool { drop error return false }
effect fn allocationSweeps(out:&mut ByteBuffer)->() !OutOfMemoryError ?&mut Allocator {
  let mut cases:usize=0 let mut attempts:usize=0 let mut failures:usize=0 let mut successes:usize=0
  let mut index:usize=0
  while index<CASES {
    let mut baseline=run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
    let ok=run faultOperation(index) |> Effect.provideMut<Allocator>(&mut baseline)
    let peak=baseline.stats().peakBytes
    if !ok || baseline.stats().usedBytes!=0 || baseline.stats().allocationCount!=0 { return Intrinsic.trap("Baseline Intl owner leak") }
    drop baseline
    let mut limit:usize=0 let mut rejected:usize=0
    while limit<=peak {
      let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
      let observer=run memory.observe()
      memory.setLimit(limit)
      let accepted=run Effect.catchAll(faultOperation(index),refused) |> Effect.provideMut<Allocator>(&mut memory)
      if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 { return Intrinsic.trap("Intl allocation owner leak") }
      drop memory
      if observer.stats().usedBytes!=0 || observer.stats().allocationCount!=0 { return Intrinsic.trap("Intl detached owner leak") }
      if accepted { successes=successes+1 } else { failures=failures+1 rejected=rejected+1 }
      if limit==peak && !accepted { return Intrinsic.trap("Intl allocation sweep never succeeded") }
      attempts=attempts+1 limit=limit+1
    }
    if peak!=0 && rejected==0 { return Intrinsic.trap("Intl allocation sweep never failed") }
    cases=cases+1 index=index+1
  }
  run out.writeU32(usize.toU32(cases)) run out.writeU32(usize.toU32(attempts))
  run out.writeU32(usize.toU32(failures)) run out.writeU32(usize.toU32(successes))
}
'''.replace('ARMS', arms).replace('CASES', str(len(operations)))


def table_summary(payload, kinds):
    """Count rows from the exercised C stream, never the generator's AST."""
    at, rows, raw_bytes = 0, 0, 0
    def number():
        nonlocal at
        value, = struct.unpack_from('<I', payload, at)
        at += 4
        return value
    def text():
        nonlocal at
        length = number()
        if length != 0xffffffff:
            at += length
    for kind in kinds:
        count = number()
        if kind in ('char', 'uint8_t'):
            raw_bytes += count
            text()
        else:
            rows += count
            for _ in range(count):
                if kind == 'char *':
                    text(); text()
                elif kind == 'CompactDecimalPattern':
                    number(); text(); text()
                elif kind == 'LocaleData':
                    text()
                    fields = [number() for _ in LOCALE_FIELDS]
                    for _ in range(fields[LOCALE_FIELDS.index('numCompactPatterns')]):
                        number(); text(); text()
                elif kind == 'DisplayNamesData':
                    for _ in range(1 + len(DISPLAY_FIELDS)):
                        text()
    numbering, identities, collations = number(), number(), number()
    if numbering != identities:
        raise ValueError('C numbering count mismatch')
    for _ in range(numbering):
        text(); number()
    for _ in range(10):
        number()
    for _ in range(collations):
        text()
    if at != len(payload):
        raise ValueError('Unaccounted Intl table bytes')
    return f'{rows} locale rows, {raw_bytes} raw pool bytes, {numbering} numbering identities/bases, 10 Han digits, {collations} collations'


def probes(reference):
    c, silk, labels = [], [], []
    def add(label, ce, se, kind='text'):
        labels.append(label)
        if kind == 'number':
            c.append(f'emit({ce});')
            silk.append(f'run out.writeU32({se})')
        elif kind == 'owned':
            c.append(f'{{char *s={ce}; text(s); free(s);}}')
            expression = se if se.startswith('Option<') else 'run ' + se
            silk.append(f'run owned(out, {expression})')
        else:
            c.append(f'text({ce});')
            silk.append(f'run text(out, {se})')
    q = json.dumps
    tags = ['', 'a', 'en', 'EN-us', 'en_US', 'en--US', 'i-klingon', 'en-gb-oed',
            'zh-min-nan', 'no-bok', 'root', 'und', 'abcdefgh', 'abcdefghi', '123', 'en-foobar-US',
            'en-a', 'en-a-foo-a-bar', 'en-u-ca-gregory-ca-buddhist', 'de-1901-1901',
            'en-x-private', 'x-private', 'en-u-foo', 'en-u-kn-true', 'en-u-nu-native',
            'en-u-zz-abc-aa-def', 'en-u-zzz-aaa-ca-islamicc-kn-true',
            'en-t-en-us-m0-ungegn-h0-hybrid', 'en-b-foo-a-bar-u-kn-true-x-hi',
            'cmn-Hans-CN', 'ji', 'in', 'sgn-GR', 'de-DD', 'mo', 'aar', 'heb',
            'ces', 'sh', 'sh-Cyrl-RS', 'cnr', 'iw-IL', 'en-BU', 'hy-arevela',
            'en-' + 'a' * 508, 'en-' + 'a' * 509,
            'en' + '-abcde' * 62, 'en' + '-abcde' * 63, 'en' + '-abcde' * 64]
    tags += ['en-t-en-us-a0-one-two-three-four-five-b0-six', 'en-u-ca-kn-true', 'en-u-zzz-aaa-nu-latn-ca-gregory']
    for tag in tags:
        add('wellformed:' + tag, f'is_wellformed_language_tag({q(tag)})', f'flag(tags.is_wellformed_language_tag({q(tag)}))', 'number')
        # Canonicalization's public precondition is wellformed; malformed forms
        # still exercise its documented bounded-storage rejection independently.
        c.append(f'if(is_wellformed_language_tag({q(tag)})) {{ char *s=canonicalize_locale(NULL,{q(tag)}); text(s); free(s); }} else text(NULL);')
        silk.append(f'if tags.is_wellformed_language_tag({q(tag)}) {{ run owned(out, run tags.canonicalize_locale({q(tag)})) }} else {{ run text(out, Option<string>.none()) }}')
        labels.append('canonical:' + tag)
    for tag in ['en-' + 'a' * 508, 'en-' + 'a' * 509, 'en' + '-abcde' * 63]:
        add('canonical-bounds:' + tag, f'canonicalize_locale(NULL,{q(tag)})', f'tags.canonicalize_locale({q(tag)})', 'owned')
    extensions = ['en', 'en-U-nu-arab', 'en-U-foo-u-nu-latn', 'en-x-u-nu-arab',
                  'en-u-nu-arab', 'en-u-nu-native', 'en-u-nu-finance', 'en-u-nu-traditio',
                  'en-u-nu-roman', 'en-u-nu-unknown', 'en-u-kn', 'en-u-kn-true-ca-islamic-civil-x-private',
                  'en-u-ca-x-nu-arab', 'en-u-aaa-ca-gregory-nu-arab', 'en-u-ca--gregory']
    for locale in extensions:
        add('strip:' + locale, f'js_intl_strip_unicode_extensions(NULL,{q(locale)})', f'Option<String>.some(run api.js_intl_strip_unicode_extensions({q(locale)}))', 'owned')
        add('extension:' + locale, f'js_intl_find_u_extension({q(locale)})', f'api.js_intl_find_u_extension({q(locale)})')
        for key in ['nu', 'ca', 'kn', 'xx']:
            add(f'has:{locale}:{key}', f'js_intl_locale_has_key({q(locale)},{q(key)})', f'flag(api.js_intl_locale_has_key({q(locale)},{q(key)}))', 'number')
            add(f'key:{locale}:{key}', f'js_intl_locale_get_unicode_key(NULL,{q(locale)},{q(key)})', f'api.js_intl_locale_get_unicode_key({q(locale)},{q(key)})', 'owned')
        add('numbering-key:' + locale, f'js_intl_locale_get_numbering_system(NULL,{q(locale)})', f'api.js_intl_locale_get_numbering_system({q(locale)})', 'owned')
    source = (reference / 'intl/intl.c').read_text()
    names = re.findall(r'"([a-z]+)"', re.search(r'intl_all_numbering_systems\[\] = \{(.*?)\n\};', source, re.S).group(1))
    for name in ['', 'unknown', 'LATN', *names]:
        add('numbering-id:' + name, f'js_intl_string_to_numbering_system({q(name)})', f'word(api.js_intl_string_to_numbering_system({q(name)}))', 'number')
        add('numbering-valid:' + name, f'is_valid_numbering_system({q(name)})', f'flag(api.is_valid_numbering_system({q(name)}))', 'number')
    for ns in range(-1, len(names) + 1):
        add(f'numbering-name:{ns}', f'js_intl_numbering_system_to_string({ns})', f'api.js_intl_numbering_system_to_string({ns})')
        for digit in range(10):
            add(f'digit:{ns}:{digit}', f'nf_get_digit({ns},{digit})', f'api.nf_get_digit({ns},{digit})', 'number')
            c.append(f'{{DynBuf b;js_intl_dbuf_init(NULL,&b);nf_put_digit(&b,{ns},{digit});emit(b.size);fwrite(b.buf,1,b.size,stdout);dbuf_free(&b);}}')
            silk.append(f'run encoded(out,{ns},{digit})')
            labels.append(f'encoded:{ns}:{digit}')
    for locale in ['de', 'de-DE', 'deu', 'DE', 'en', 'zz-ZZ']:
        for collation in ['default', 'emoji', 'eor', 'phonebk', 'search', '']:
            add(f'collation:{locale}:{collation}', f'js_intl_collation_is_supported({q(collation)},{q(locale)})', f'flag(api.js_intl_collation_is_supported({q(collation)},{q(locale)}))', 'number')
    for locale in ['', 'zz-ZZ', 'en', 'en-US', 'en-US-u-nu-arab', 'english', 'fr-CA', 'de', 'ar', 'zh-Hant', 'aa', 'zu']:
        add('locale:' + locale, f'js_intl_find_locale_data({q(locale)})->locale', f'Option<string>.some(unsafe String.fromUtf8Unchecked(api.js_intl_find_locale_data({q(locale)}).locale))')
        for currency in ['JPY', 'KRW', 'VND', 'ISK', 'CLF', 'BHD', 'JOD', 'KWD', 'OMR', 'TND', 'CLP', 'KMF', 'GNF', 'PYG', 'RWF', 'USD', 'EUR', 'ZZZ', 'usd', '']:
            add(f'currency:{locale}:{currency}', f'js_intl_get_currency_symbol({q(currency)},{q(locale)})', f'Option<string>.some(api.js_intl_get_currency_symbol({q(currency)},{q(locale)}))')
    for currency in ['JPY','KRW','VND','ISK','CLF','BHD','JOD','KWD','OMR','TND','CLP','KMF','GNF','PYG','RWF','USD','usd','']:
        add('digits:' + currency, f'js_intl_get_currency_digits({q(currency)})', f'i32.toU32(api.js_intl_get_currency_digits({q(currency)}))', 'number')
    for code in ['', 'aa', 'bb', 'cc', 'AA', 'missing']:
        add('display:' + code, f'js_intl_find_display_name("aa\\0first\\0bb\\0second\\0cc\\0\\0",{q(code)})', f'api.js_intl_find_display_name(b"aa\\x00first\\x00bb\\x00second\\x00cc\\x00\\x00",{q(code)})')
    return c, silk, labels


def c_source(reference, calls, table_calls, typed_callback=False):
    lines = (reference / 'intl/intl.c').read_text().splitlines()
    extracted = '\n'.join('\n'.join(lines[a-1:b]) for a,b in [(96,114),(121,268),(381,1290),(1933,2103),(2125,2136)])
    collator = (reference / 'intl/collator.c').read_text().splitlines()
    if typed_callback:
        cast = '(DynBufReallocFunc *)js_realloc'
        if extracted.count(cast) != 1:
            raise ValueError('Pinned DynBuf callback cast changed')
        extracted = extracted.replace(cast, 'oracle_realloc')
    return r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include "intl/intl_private.h"
#include "intl/locale-data.c"
void *js_malloc(JSContext *ctx,size_t n){(void)ctx;return malloc(n);}
void *js_realloc(JSContext *ctx,void *p,size_t n){(void)ctx;return realloc(p,n);}
void js_free(JSContext *ctx,void *p){(void)ctx;free(p);}
char *js_strdup(JSContext *ctx,const char *s){(void)ctx;return strdup(s);}
static void *oracle_realloc(void *opaque,void *p,size_t n){return js_realloc((JSContext *)opaque,p,n);}
''' + extracted + '\n' + '\n'.join(collator[80:98]) + r'''
static void emit(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static void text(const char *s){if(!s){emit(UINT32_MAX);return;}emit(strlen(s));fwrite(s,1,strlen(s),stdout);}
static void raw(const void *bytes,size_t n){emit(n);fwrite(bytes,1,n,stdout);}
int main(int argc,char **argv){
''' + 'if(argc>1){\n' + '\n'.join(table_calls) + '\nreturn 0;}\n' + '\n'.join(calls) + '\nreturn 0;}\n'


def silk_source(calls, table_calls, helpers, allocations):
    return '''import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.collections.bytes { Bytes }
import silk.text.string { String }
import silk.core.option { Option }
import silk.num.usize
import silk.num.i32
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import intl_shared as api
import intl_locale_tag as tags
import intl_locale_data as data
import intl_numbering_data as numbering
import runtime_memory { RuntimeAllocator }
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
fn word(value:i32)->u32 { if value < 0 { return 0xffffffff - i32.toU32(-(value + 1)) } return i32.toU32(value) }
effect fn raw(out:&mut ByteBuffer,value:&[u8])->() !OutOfMemoryError ?&mut Allocator {
  run out.writeU32(usize.toU32(value.length)) run out.appendSlice(value)
}
effect fn text(out:&mut ByteBuffer,value:Option<string>)->() !OutOfMemoryError ?&mut Allocator {
  match move value { Option<string>.Some { value: found } => { run raw(&mut out.*,String.utf8Bytes(found)) } Option<string>.None => { run out.writeU32(0xffffffff) } }
}
effect fn owned(out:&mut ByteBuffer,value:Option<String>)->() !OutOfMemoryError ?&mut Allocator {
  match move value { Option<String>.Some { value: found } => { run raw(&mut out.*,String.utf8Bytes(found.view())) } Option<String>.None => { run out.writeU32(0xffffffff) } }
}
effect fn optionalBytes(out:&mut ByteBuffer,value:Option<&'static [u8]>)->() !OutOfMemoryError ?&mut Allocator {
  match move value { Option<&'static [u8]>.Some { value: found } => { run raw(&mut out.*,found) } Option<&'static [u8]>.None => { run out.writeU32(0xffffffff) } }
}
effect fn encoded(out:&mut ByteBuffer,ns:i32,digit:i32)->() !OutOfMemoryError ?&mut Allocator {
  let mut bytes=Bytes.make()
  run api.nf_put_digit(&mut bytes,ns,digit)
  run raw(&mut out.*,bytes.asSlice())
}
effect fn exercise(out:&mut ByteBuffer)->() !OutOfMemoryError ?&mut Allocator {
''' + '\n'.join(calls).replace('(out,', '(&mut out.*,') + '''
}
''' + helpers + allocations + '''
effect fn tables(out:&mut ByteBuffer)->() !OutOfMemoryError ?&mut Allocator {
''' + '\n'.join(table_calls) + '''
}
pub effect fn main()->i32 !OutOfMemoryError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  let mut out=ByteBuffer.make()
  run exercise(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run tables(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run allocationSweeps(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)
  run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--sanitize-c', action='store_true', help='Run the full C oracle with AddressSanitizer and UndefinedBehaviorSanitizer')
    parser.add_argument('--cflag', action='append', default=[], help='Additional C compiler flag (repeatable; use --cflag=-flag)')
    args = parser.parse_args()
    reference = args.upstream.resolve()
    validate_pins(reference)
    c, silk, labels = probes(reference)
    table_c, table_silk, helpers, table_kinds = table_probes(reference)
    with tempfile.TemporaryDirectory(prefix='silkjs-intl-pure-') as directory:
        tmp = Path(directory)
        (tmp/'oracle.c').write_text(c_source(reference,c,table_c))
        flags = ['-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-fno-omit-frame-pointer'] if args.sanitize_c else []
        compile_c = [executable_path(args.cc), '-std=gnu11', '-O2', *flags, *args.cflag, '-I', str(reference), str(tmp/'oracle.c'), str(reference/'cutils.c'), '-o', str(tmp/'oracle')]
        process(compile_c, args.timeout, owner='Pure Intl C oracle compilation')
        if args.sanitize_c:
            rejected = subprocess.run([str(tmp/'oracle')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=args.timeout)
            diagnostic = rejected.stderr.decode(errors='replace')
            if rejected.returncode == 0 or 'cutils.c:119:19: runtime error: call to function js_realloc through pointer to incorrect function type' not in diagnostic:
                raise SystemExit(f'Expected pinned DynBuf callback UB was not isolated:\n{diagnostic}')
            print('C UB isolated: intl.c:1289 casts js_realloc(JSContext*,...) to DynBufReallocFunc(void*,...); UBSan rejects the indirect call at cutils.c:119')
            (tmp/'oracle.c').write_text(c_source(reference,c,table_c,typed_callback=True))
            process(compile_c, args.timeout, owner='ABI-corrected Intl sanitizer oracle compilation')
        expected = process([str(tmp/'oracle')], args.timeout, owner='Pinned pure Intl C oracle')
        expected_tables = process([str(tmp/'oracle'), 'tables'], args.timeout, owner='Pinned Intl table oracle')
        shutil.copytree(ROOT/'src',tmp/'src')
        (tmp/'src/main.silk').write_text(silk_source(silk,table_silk,helpers,allocation_source(silk)))
        version = tomllib.loads((ROOT/'silk.toml').read_text())['package']['silk-version']
        (tmp/'silk.toml').write_text(f'[package]\nname="intl-pure-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk),'run','--quiet','--release']
        if args.stdlib: command += ['--stdlib',str(args.stdlib.resolve())]
        actual = process(command,args.timeout,owner='Native pure Intl probe',cwd=tmp)
        semantic = actual[:len(expected)]
        tables = actual[len(expected):-16]
        if semantic != expected or tables != expected_tables:
            combined = expected + expected_tables
            offset = next((i for i,(a,b) in enumerate(zip(actual,combined)) if a != b), min(len(actual),len(combined)))
            raise SystemExit(f'Intl mismatch at byte {offset}; C={len(combined)} bytes Silk={len(actual)-16} bytes')
        cases, attempts, failures, successes = struct.unpack('<4I', actual[-16:])
        if not cases or not failures or attempts != failures + successes:
            raise SystemExit('Incomplete allocation-failure sweep')
        print(f'Pure Intl: {len(labels)} independent matching records; bytes={len(semantic)}; sha256={hashlib.sha256(semantic).hexdigest()}')
        print(f'Intl tables: {len(table_kinds)} complete locale tables; {table_summary(expected_tables, table_kinds)}; bytes={len(tables)}; sha256={hashlib.sha256(tables).hexdigest()}')
        print(f'Intl allocation sweeps: {cases} owned-operation cases; {attempts} byte-budget attempts; {failures} failures; {successes} successes; all live-owner/byte ledgers zero before and after provider destruction')
        if args.sanitize_c:
            print('C oracle: typed callback adapter only; complete semantic and table streams passed ASan/UBSan without further undefined behavior')


if __name__ == '__main__':
    main()
