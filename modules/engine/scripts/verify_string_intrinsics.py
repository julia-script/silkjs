#!/usr/bin/env python3
"""Real-engine String behavior and independent native/pinned-C allocation sweeps.

--native is the integrated Silk engine executable, never another JS engine:
  string-case SOURCE.js CASE    -> 256 LE u32 observations + zero bytes/blocks ledger
  string-fault SOURCE.js CASE N -> consumers.runFault's six LE u32 fields
The launcher creates a fresh installed engine and uses js_string_intrinsics_consumers
prepare/runCase/runFault. Baseline UTF-16 text has a handwritten independent oracle.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/string_intrinsics_cases.js'
EXPECTED = [
    '|undefined|Symbol(x)|Symbol()|TypeError',
    '3|55296|false|true|false|false|false|false|true|TypeError',
    '65535,0,1,0|55357,56832,55296,56319,57343|RangeError|RangeError',
    'RangeError|1,2',
    'aXbYc|1,2,3,4,5,6,7|aXbc',
    '5|55296|56832|55357|128512|56832|||true|',
    '4|4|4|6|true|true|true|true|0|-1|-1',
    'TypeError|1,2',
    'bcd|ab|de||cde||abcdef',
    'b|1,2,3',
    'ababax|xababa|x|ababab||RangeError|RangeError|RangeError',
    'long|1|x',
    'a|97,32,8233|65279,8192,32,97|1|true|true',
    '97,962|97,962,769|97,963,98|105,775|STRASSE|55296|66600',
    '233|101,769|102,102,105|65,778|55296|RangeError',
    '0|1|-25|i|2|I',
    'false|65533,65,65533,55357,56832|true|true',
    '130|128512|true|55357,56832|64|129|64,64',
    '65;55357,56832;55296|true|undefined|TypeError|[object String Iterator]',
    '77|1,2',
    'TypeError|1,2,3',
    'TypeError|1,2',
    "a[$][b][a][c][$1][$<x>]c|XbX|-a-b-|-|abc|1",
    '0b2|a:0:aba,s,a:2:aba,s',
    'ab-c-b-b-$3|0b2|a:0:aba,a:2:aba',
    '1,22|1:1,22:3|1|2|b',
    'a,b|a:b:|0|1|abc|0|a:1:b:2:',
    '0|1,2,3,4',
    '<a name="a&quot;<&">x</a>|<a href="&quot;">x</a>|<font color="red">x</font>|<font size="3">x</font>|TypeError|TypeError',
    '<big>x</big>|<blink>x</blink>|<b>x</b>|<tt>x</tt>|<i>x</i>|<small>x</small>|<strike>x</strike>|<sub>x</sub>|<sup>x</sup>',
    '42|2|x|xy|true',
    'x|s,p',
    'Z:Nbc|exec,exec,group',
    'true|TypeError',
    '11|22|33|TypeError|1,2,3',
    'TypeError|1,2,3',
    '|1,2|aXb',
    '131|ax|ybc|65|1,2',
]
SWEEPS = (0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20,
          21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37)
C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>
typedef union { max_align_t alignment; size_t size; } Header;
static size_t live_count,live_bytes,remaining,fault_count;static int armed;
static int fault(void){if(!armed)return 0;if(!remaining){armed=0;fault_count++;return 1;}remaining--;return 0;}
static void *allocate(JSMallocState*s,size_t n){if(!n||fault())return NULL;Header*h=malloc(sizeof(*h)+n);if(!h)return NULL;h->size=n;live_count++;live_bytes+=n;s->malloc_count++;s->malloc_size+=n;return h+1;}
static void release(JSMallocState*s,void*p){if(!p)return;Header*h=(Header*)p-1;live_count--;live_bytes-=h->size;s->malloc_count--;s->malloc_size-=h->size;free(h);}
static void *resize(JSMallocState*s,void*p,size_t n){if(!p)return allocate(s,n);if(!n){release(s,p);return NULL;}if(fault())return NULL;Header*h=(Header*)p-1;size_t old=h->size;Header*r=realloc(h,sizeof(*h)+n);if(!r)return NULL;r->size=n;live_bytes=live_bytes-old+n;s->malloc_size=s->malloc_size-old+n;return r+1;}
static size_t usable(const void*p){return p?((const Header*)p-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static void clear_exception(JSContext*ctx){if(JS_HasException(ctx)){JSValue e=JS_GetException(ctx);JS_FreeValue(ctx,e);}}
static char*load(const char*path,size_t*length){FILE*f=fopen(path,"rb");if(!f)abort();if(fseek(f,0,SEEK_END))abort();long n=ftell(f);if(n<0||fseek(f,0,SEEK_SET))abort();char*s=malloc(n+1);if(!s||fread(s,1,n,f)!=(size_t)n)abort();s[n]=0;fclose(f);*length=n;return s;}
int main(int argc,char**argv){
 if(argc<4)abort();int is_fault=!strcmp(argv[1],"fault");if(is_fault&&argc!=5)abort();
 size_t length;char*source=load(argv[2],&length);JSRuntime*rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext*ctx=JS_NewContext(rt);if(!ctx)abort();
 JSValue function=JS_Eval(ctx,source,length,"string_intrinsics_cases.js",JS_EVAL_TYPE_GLOBAL);free(source);if(JS_IsException(function))abort();
 JSValue operation=JS_NewInt32(ctx,atoi(argv[3]));uint32_t rec[256]={0};
 if(is_fault){remaining=strtoull(argv[4],NULL,10);armed=1;}
 JSValue output=JS_Call(ctx,function,JS_UNDEFINED,1,&operation);
 if(is_fault){if(JS_IsException(output)&&!JS_HasException(ctx))abort();armed=0;rec[0]=fault_count;rec[1]=JS_IsException(output);rec[2]=remaining;rec[3]=JS_HasException(ctx);}
 else {if(JS_IsException(output)||!JS_IsString(output))abort();output=JS_ToStringFree(ctx,output);if(JS_IsException(output))abort();JSString*p=JS_VALUE_GET_STRING(output);if(p->len>253)abort();rec[0]=1;rec[1]=JS_HasException(ctx);rec[2]=p->len;for(unsigned i=0;i<p->len;i++)rec[3+i]=string_get(p,i);}
 JS_FreeValue(ctx,output);JS_FreeValue(ctx,function);clear_exception(ctx);JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(is_fault){rec[4]=live_bytes;rec[5]=live_count;for(int i=0;i<6;i++)word(rec[i]);}
 else {for(int i=0;i<256;i++)word(rec[i]);word(live_bytes);word(live_count);}
 return 0;
}
'''


def words(data, count, owner):
    if len(data) != count * 4:
        raise SystemExit(f'{owner}: expected {count * 4} bytes, received {len(data)}')
    return struct.unpack(f'<{count}I', data)


def run(command, owner):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise SystemExit(f'{owner}: exit {result.returncode}\n{result.stderr.decode(errors="replace")}')
    return result.stdout


def behavior(case, row, owner):
    expected = tuple(ord(c) for c in EXPECTED[case])
    if row[0] != 1 or row[1] or row[2] != len(expected) or row[3:3 + len(expected)] != expected:
        raise SystemExit(f'{owner} case={case}: independent UTF-16/order oracle failed: {row[:3 + row[2]]}')
    if any(row[3 + len(expected):]):
        raise SystemExit(f'{owner} case={case}: trailing observations or nonzero owner ledger: {row}')


def sweep(executable, case, maximum, is_source, defects):
    injected = 0
    mode = 'fault' if is_source else 'string-fault'
    for cutoff in range(maximum):
        result = subprocess.run([str(executable), mode, str(SOURCE), str(case), str(cutoff)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            if not is_source:
                raise SystemExit(f'native fault case={case} cutoff={cutoff}: exit={result.returncode}\n{result.stderr.decode(errors="replace")}')
            defects.append({'case': case, 'cutoff': cutoff, 'exit': result.returncode,
                            'stderr': result.stderr.decode(errors='replace')})
            injected += 1
            continue
        row = words(result.stdout, 6, f'{"C" if is_source else "native"} fault {case}/{cutoff}')
        if row[4] or row[5]:
            if not is_source:
                raise SystemExit(f'native fault case={case} cutoff={cutoff}: nonzero owner ledger {row}')
            defects.append({'case': case, 'cutoff': cutoff, 'ledger_bytes': row[4], 'ledger_blocks': row[5]})
        if row[0] > 1 or (row[1] and not row[3]):
            raise SystemExit(f'invalid fault/pending-exception contract: {row}')
        if row[0]:
            injected += 1
        else:
            if not injected or row[1] or row[3]:
                raise SystemExit(f'fault sweep lacks injected failure and clean success: {case}: {row}')
            return cutoff + 1
    raise SystemExit(f'fault sweep never reached non-injected success: case={case}, maximum={maximum}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--native', required=True, type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    parser.add_argument('--max-cutoff', type=int, default=4096)
    parser.add_argument('--source-defects', required=True, type=Path,
                        help='measured C crash/leak record; defects make this run non-passing')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    native, cc = executable_path(str(args.native)), executable_path(args.cc)
    defects, transcript = [], bytearray()
    with tempfile.TemporaryDirectory(prefix='silkjs-string-intrinsics-') as directory:
        temporary = Path(directory)
        (temporary / 'oracle.c').write_text(C_SOURCE)
        oracle = temporary / 'oracle'
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(reference), str(temporary / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(oracle)],
                600, owner='String intrinsic pinned-C consumer compilation')
        for case in range(len(EXPECTED)):
            expected_bytes = run([str(oracle), 'case', str(SOURCE), str(case)], f'C case {case}')
            actual_bytes = run([native, 'string-case', str(SOURCE), str(case)], f'native case {case}')
            expected = words(expected_bytes, 258, f'C case {case}')
            actual = words(actual_bytes, 258, f'native case {case}')
            behavior(case, expected, 'C')
            behavior(case, actual, 'native')
            if actual != expected:
                raise SystemExit(f'case={case}: pinned C/native UTF-16 observation mismatch')
            transcript.extend(actual_bytes)
        native_cutoffs = source_cutoffs = 0
        for case in SWEEPS:
            native_cutoffs += sweep(native, case, args.max_cutoff, False, defects)
            source_cutoffs += sweep(oracle, case, args.max_cutoff, True, defects)
    args.source_defects.write_text(json.dumps(defects, indent=2) + '\n')
    if defects:
        raise SystemExit(f'Native checks completed; {len(defects)} pinned-C allocator defects recorded at {args.source_defects}. No orphan recovery or source semantics repair applied.')
    print(f'PASS String intrinsics: {len(EXPECTED)} independent and pinned-C cases; {len(SWEEPS)} separate sweeps '
          f'({native_cutoffs} native, {source_cutoffs} C cutoffs); zero owner ledgers; {pins} pinned files; '
          f'SHA256={hashlib.sha256(transcript).hexdigest()}')


if __name__ == '__main__':
    main()
