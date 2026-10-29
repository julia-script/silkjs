#!/usr/bin/env python3
"""Compare native strings, ropes, atoms and symbols with pinned QuickJS C32.

Usage: python3 scripts/verify_strings.py QUICKJS [--silk COMPILER] [--stdlib SDK]

The oracle is a separate executable; no C objects, bindings or oracle results
enter the native package. Identical deterministic binary inputs drive both
programs. Expectations come only from QuickJS. Records contain exact scalar
results and length-delimited FNV-1a digests of code units, code points and bytes;
Python compares every field and reports its fixture and semantic field name.

Every Latin1 byte, every isolated UTF16 code unit, and every two-byte UTF8 input
is mandatory. Additional fixtures exercise malformed/extended UTF8, surrogate
pairs across leaves, widening, rope construction/alias/flatten/rebalance/slice
histories, ordering, numeric property names, predefined atoms, table growth and
reuse, and local/private/global symbols. Dynamic atom IDs and storage layout
are deliberately not compared. Live string/symbol owners outlive the native
table handle; the C counterpart destroys the context but keeps its runtime
(the atom registry owner) alive until all retained values are released.

All generated files live in a canonicalized TemporaryDirectory. Failures never
skip fixtures or fall back to expected data. No allocator-layout equivalence is
asserted: allocation-failure rollback belongs to the permanent native tests.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
from pathlib import Path, PurePosixPath
import random
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib
import toolchain

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = ('cutils.c', 'dtoa.c', 'libregexp.c', 'libunicode.c')
INITIAL = 14695981039346656037
OPS = ('string', 'history', 'compare', 'atom', 'integer-atom', 'predefined',
       'symbol', 'churn', 'outlive', 'atom-concat')
SNAPSHOT = ('length', 'units.fnv', 'iterator.fnv', 'leaves.fnv',
            'codepoints.count', 'codepoints.fnv',
            'utf8.length', 'utf8.fnv', 'utf8.cstring.fnv',
            'cesu8.length', 'cesu8.fnv', 'cesu8.cstring.fnv',
            'nonnull.ok', 'nonnull.utf8.fnv', 'nonnull.cesu8.fnv')
BASIC = ('length', 'units.fnv')
ATOM = ('constant-id', 'integer', 'property-kind', 'storage-kind',
        'has-description', 'array-index.present', 'array-index.value',
        'numeric-index.present', 'numeric-index.bits', 'value.is-symbol',
        'string.length', 'string.units.fnv')

C_SOURCE = r'''
#include "quickjs.c"
/* quickjs.c forbids its own direct libc allocation; this adapter owns its
   fixture buffers independently, outside QuickJS's implementation. */
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || JS_SHORT_BIG_INT_BITS != 32
#error The differential oracle requires the pinned 32-bit profile
#endif
static unsigned fixture;
static uint64_t fields[256];
static unsigned field_count;
static void die(const char *s) {
    fprintf(stderr, "C strings oracle fixture %u: %s\n", fixture, s); exit(1);
}
static void *allocate(size_t n) { void *p=malloc(n?n:1); if(!p) die("adapter OOM"); return p; }
static unsigned byte(void) { int c=getchar(); if(c==EOF) die("truncated input"); return c; }
static uint32_t word(void) { uint32_t n=0; for(unsigned i=0;i<4;i++) n|=(uint32_t)byte()<<(i*8); return n; }
static uint64_t wide(void) { uint64_t lo=word(); return lo|((uint64_t)word()<<32); }
static void put32(uint32_t n) { for(unsigned i=0;i<4;i++) putchar((n>>(i*8))&255); }
static void put64(uint64_t n) { put32(n); put32(n>>32); }
static void emit(uint64_t n) { if(field_count==256) die("record too large"); fields[field_count++]=n; }
static uint64_t mix(uint64_t h,uint64_t n) { return (h^n)*UINT64_C(1099511628211); }
#define INITIAL UINT64_C(14695981039346656037)
static uint64_t bytes_hash(const uint8_t *p,size_t n) { uint64_t h=INITIAL; for(size_t i=0;i<n;i++) h=mix(h,p[i]); return h; }
static JSValue checked(JSContext *ctx,JSValue v) {
    if(JS_IsException(v)) {
        JSValue e=JS_GetException(ctx); const char *s=JS_ToCString(ctx,e);
        fprintf(stderr,"C strings oracle fixture %u: %s\n",fixture,s?s:"unprintable exception");
        JS_FreeCString(ctx,s); JS_FreeValue(ctx,e); die("unexpected QuickJS exception");
    }
    return v;
}
static JSAtom checked_atom(JSAtom a) { if(!a) die("unexpected null atom"); return a; }
static JSValue flat(JSContext *ctx,JSValue v) {
    if(JS_VALUE_GET_TAG(v)==JS_TAG_STRING_ROPE)
        return checked(ctx,js_linearize_string_rope(ctx,JS_DupValue(ctx,v)));
    return JS_DupValue(ctx,v);
}
static uint64_t units_hash(JSValue v) {
    uint64_t h=INITIAL; unsigned n=string_rope_get_len(v);
    for(unsigned i=0;i<n;i++) h=mix(h,string_rope_get(v,i)); return h;
}
static void basic(JSValue v) { emit(string_rope_get_len(v)); emit(units_hash(v)); }
static void snapshot(JSContext *ctx,JSValue v) {
    basic(v);
    for(unsigned pass=0;pass<2;pass++) {
        JSStringRopeIter it; JSString *p; uint64_t h=INITIAL;
        string_rope_iter_init(&it,v);
        while((p=string_rope_iter_next(&it)))
            for(unsigned i=0;i<p->len;i++) h=mix(h,string_get(p,i));
        emit(h);
    }
    JSValue f=flat(ctx,v); JSString *p=JS_VALUE_GET_STRING(f);
    int at=0; unsigned count=0; uint64_t h=INITIAL;
    while(at<p->len) { int cp=string_getc(p,&at); h=mix(mix(h,cp),at); count++; }
    emit(count); emit(h);
    const char *encoded[2]; size_t sizes[2];
    for(unsigned mode=0;mode<2;mode++) {
        encoded[mode]=JS_ToCStringLen2(ctx,&sizes[mode],v,mode);
        if(!encoded[mode]) die("UTF8 conversion failed");
        emit(sizes[mode]); emit(bytes_hash((const uint8_t *)encoded[mode],sizes[mode]));
        emit(bytes_hash((const uint8_t *)encoded[mode],sizes[mode]+1));
    }
    const char *nz=JS_ToCStringNZ(ctx,v);
    emit(nz!=NULL);
    if(nz) {
        emit(bytes_hash((const uint8_t *)nz,strlen(nz)+1));
        emit(bytes_hash((const uint8_t *)encoded[1],sizes[1]+1));
        JS_FreeCString(ctx,nz);
    } else {
        JSValue e=JS_GetException(ctx); const char *s=JS_ToCString(ctx,e);
        if(!s || !strstr(s,"embedded null")) die("unexpected nonnull conversion failure");
        JS_FreeCString(ctx,s); JS_FreeValue(ctx,e); emit(0); emit(0);
    }
    for(unsigned mode=0;mode<2;mode++) JS_FreeCString(ctx,encoded[mode]);
    JS_FreeValue(ctx,f);
}
static JSValue piece(JSContext *ctx,StringBuffer *builder) {
    unsigned kind=byte(), n=word(); JSValue v;
    if(kind<=2) {
        uint8_t *data=allocate((size_t)n+1);
        if(fread(data,1,n,stdin)!=n) die("truncated piece"); data[n]=0;
        if(kind==0) {
            if(builder) { if(string_buffer_write8(builder,data,n)) die("builder Latin1 failure"); v=JS_UNDEFINED; }
            else v=js_new_string8_len(ctx,(const char *)data,n);
        } else if(kind==1) {
            if(n&1) die("odd UTF16 input"); uint16_t *units=allocate(n);
            for(unsigned i=0;i<n/2;i++) units[i]=(unsigned)data[i*2]|((unsigned)data[i*2+1]<<8);
            if(builder) { if(string_buffer_write16(builder,units,n/2)) die("builder UTF16 failure"); v=JS_UNDEFINED; }
            else v=js_new_string16_len(ctx,units,n/2);
            free(units);
        } else {
            v=checked(ctx,JS_NewStringLen(ctx,(const char *)data,n));
            if(builder) { if(string_buffer_concat_value(builder,v)) die("builder string failure"); JS_FreeValue(ctx,v); v=JS_UNDEFINED; }
        }
        free(data);
    } else if(kind==3 || kind==4) {
        unsigned unit=word(); StringBuffer local;
        StringBuffer *b=builder?builder:&local;
        if(!builder && string_buffer_init(ctx,b,0)) die("builder allocation failure");
        if(kind==3) { if(string_buffer_fill(b,unit,n)) die("builder fill failure"); }
        else { if(n!=1 || string_buffer_putc(b,unit)) die("builder codepoint failure"); }
        v=builder?JS_UNDEFINED:string_buffer_end(b);
    } else { die("unknown piece kind"); return JS_EXCEPTION; }
    return checked(ctx,v);
}
static JSValue recipe(JSContext *ctx) {
    unsigned style=byte(), n=word();
    if(style==5) {
        StringBuffer b; if(string_buffer_init(ctx,&b,13)) die("builder allocation failure");
        for(unsigned i=0;i<n;i++) piece(ctx,&b);
        return checked(ctx,string_buffer_end(&b));
    }
    JSValue *parts=allocate((size_t)(n?n:1)*sizeof(*parts));
    for(unsigned i=0;i<n;i++) parts[i]=piece(ctx,NULL);
    if(!n) { free(parts); return checked(ctx,js_new_string8(ctx,"")); }
    if(style==0) { if(n!=1) die("flat recipe with multiple parts"); JSValue v=parts[0]; free(parts); return v; }
    if(style==3) {
        while(n>1) {
            unsigned out=0;
            for(unsigned i=0;i<n;i+=2) {
                if(i+1<n) parts[out++]=checked(ctx,JS_ConcatString(ctx,parts[i],parts[i+1]));
                else parts[out++]=parts[i];
            }
            n=out;
        }
        JSValue v=parts[0]; free(parts); return v;
    }
    JSValue v=parts[0];
    for(unsigned i=1;i<n;i++) {
        if(style==2 || (style==4 && (i&1))) v=checked(ctx,JS_ConcatString(ctx,parts[i],v));
        else if(style==6) {
            JSValue next=checked(ctx,JS_ConcatString(ctx,JS_DupValue(ctx,v),JS_DupValue(ctx,parts[i])));
            JS_FreeValue(ctx,v); JS_FreeValue(ctx,parts[i]); v=next;
        } else v=checked(ctx,JS_ConcatString(ctx,v,parts[i]));
    }
    free(parts); return v;
}
static int sign(int n) { return (n>0)-(n<0); }
static unsigned storage_kind(JSContext *ctx,JSAtom a) {
    if(__JS_AtomIsTaggedInt(a)) return 0;
    JSAtomStruct *p=ctx->rt->atom_array[a];
    if(p->atom_type==JS_ATOM_TYPE_STRING) return 0;
    if(p->atom_type==JS_ATOM_TYPE_GLOBAL_SYMBOL) return 2;
    return p->hash==JS_ATOM_HASH_PRIVATE?3:1;
}
static void atom_metadata(JSContext *ctx,JSAtom a) {
    checked_atom(a);
    emit(__JS_AtomIsConst(a)?a:0); emit(__JS_AtomIsTaggedInt(a));
    JSAtomKindEnum kind=JS_AtomGetKind(ctx,a);
    emit(kind==JS_ATOM_KIND_STRING?0:kind==JS_ATOM_KIND_SYMBOL?1:2);
    emit(storage_kind(ctx,a)); emit(JS_AtomSymbolHasDescription(ctx,a));
    uint32_t index=0; int present=JS_AtomIsArrayIndex(ctx,&index,a);
    emit(present); emit(present?index:0);
    JSValue num=checked(ctx,JS_AtomIsNumericIndex1(ctx,a));
    emit(!JS_IsUndefined(num));
    double d=0; if(!JS_IsUndefined(num) && JS_ToFloat64(ctx,&d,num)) die("numeric index conversion");
    emit(isnan(d)?UINT64_C(0x7ff8000000000000):float64_as_uint64(d)); JS_FreeValue(ctx,num);
    JSValue value=checked(ctx,__JS_AtomToValue(ctx,a,FALSE)); emit(JS_IsSymbol(value)); JS_FreeValue(ctx,value);
    value=checked(ctx,__JS_AtomToValue(ctx,a,TRUE)); basic(value); JS_FreeValue(ctx,value);
}
static JSAtom intern(JSContext *ctx,JSValue v,unsigned method) {
    JSValue f=flat(ctx,v); JSAtom a;
    if(method==0) {
        size_t n; const char *s=JS_ToCStringLen(ctx,&n,f); if(!s) die("atom UTF8 conversion");
        a=JS_NewAtomLen(ctx,s,n); JS_FreeCString(ctx,s);
    } else if(method==1) {
        unsigned n=string_rope_get_len(f); uint16_t *units=allocate((size_t)n*2);
        for(unsigned i=0;i<n;i++) units[i]=string_rope_get(f,i);
        JSValue copy=checked(ctx,js_new_string16_len(ctx,units,n)); free(units);
        a=JS_NewAtomStr(ctx,JS_VALUE_GET_STRING(copy));
    } else { a=JS_NewAtomStr(ctx,JS_VALUE_GET_STRING(JS_DupValue(ctx,f))); }
    JS_FreeValue(ctx,f); return checked_atom(a);
}
static void atom_lifetime(JSContext *ctx,JSValue text) {
    JSAtom a=intern(ctx,text,0); atom_metadata(ctx,a);
    for(unsigned method=1;method<4;method++) {
        JSAtom b=intern(ctx,text,method); emit(a==b); JS_FreeAtom(ctx,b);
    }
    JSAtom duplicate=JS_DupAtom(ctx,a); emit(duplicate==a);
    JSValue held=checked(ctx,__JS_AtomToValue(ctx,a,TRUE));
    JS_FreeAtom(ctx,a); JS_FreeAtom(ctx,duplicate); basic(held);
    JSAtom b=intern(ctx,text,2); emit(b==a); JS_FreeAtom(ctx,b); JS_FreeValue(ctx,held);
    b=intern(ctx,text,3); atom_metadata(ctx,b); JS_FreeAtom(ctx,b);
}
static JSValue symbol(JSContext *ctx,JSValue description,unsigned kind,unsigned absent) {
    if(absent) return checked(ctx,JS_NewSymbol(ctx,NULL,kind==2));
    JSValue f=flat(ctx,description);
    return checked(ctx,JS_NewSymbolInternal(ctx,JS_VALUE_GET_STRING(f),
        kind==2?JS_ATOM_TYPE_GLOBAL_SYMBOL:kind==3?JS_ATOM_TYPE_PRIVATE:JS_ATOM_TYPE_SYMBOL));
}
static void maybe_description(JSContext *ctx,JSAtom atom,JSValue sym,unsigned key) {
    JSValue v=JS_UNDEFINED;
    if(key) v=checked(ctx,js_symbol_keyFor(ctx,JS_UNDEFINED,1,&sym));
    else if(JS_AtomSymbolHasDescription(ctx,atom)) v=checked(ctx,js_symbol_get_description(ctx,sym));
    emit(!JS_IsUndefined(v));
    if(JS_IsUndefined(v)) { emit(0); emit(0); } else basic(v);
    JS_FreeValue(ctx,v);
}
static void symbols(JSContext *ctx,JSValue text,unsigned kind,unsigned absent) {
    /* Distinct storage forces the global-symbol content hash path, not merely
       the already-interned-string fast path. */
    StringBuffer builder;
    if(string_buffer_init(ctx,&builder,0) || string_buffer_concat_value(&builder,text))
        die("symbol description copy");
    JSValue description=checked(ctx,string_buffer_end(&builder));
    JSValue a=symbol(ctx,text,kind,absent), b=symbol(ctx,description,kind,absent);
    JS_FreeValue(ctx,description);
    JSAtom aa=JS_ValueToAtom(ctx,a), ba=JS_ValueToAtom(ctx,b);
    atom_metadata(ctx,aa); emit(aa==ba);
    JSValue copy=JS_DupValue(ctx,a); JSAtom ca=JS_ValueToAtom(ctx,copy); emit(ca==aa);
    maybe_description(ctx,aa,a,0); maybe_description(ctx,aa,a,1);
    JSValue ordinary=checked(ctx,__JS_AtomToValue(ctx,aa,TRUE)); JSAtom oa=intern(ctx,ordinary,2); emit(oa==aa);
    JS_FreeAtom(ctx,oa); JS_FreeValue(ctx,ordinary); JS_FreeValue(ctx,copy); JS_FreeAtom(ctx,ca);
    JS_FreeAtom(ctx,aa); JS_FreeValue(ctx,a);
    atom_metadata(ctx,ba); maybe_description(ctx,ba,b,1);
    JSValue key=checked(ctx,js_symbol_keyFor(ctx,JS_UNDEFINED,1,&b));
    if(JS_IsUndefined(key)) emit(0);
    else {
        JSValue again=symbol(ctx,key,2,0); JSAtom ka=JS_ValueToAtom(ctx,again);
        emit(ka==ba); JS_FreeAtom(ctx,ka); JS_FreeValue(ctx,again);
    }
    JS_FreeValue(ctx,key);
    JSValue other=symbol(ctx,text,kind==1?2:1,absent);
    JSAtom other_atom=JS_ValueToAtom(ctx,other); emit(other_atom==ba);
    JS_FreeAtom(ctx,other_atom); JS_FreeValue(ctx,other);
    JS_FreeAtom(ctx,ba); JS_FreeValue(ctx,b);
}
static void churn(JSContext *ctx,unsigned n) {
    JSAtom prefix=checked_atom(JS_NewAtom(ctx,"churn-"));
    JSAtom *ids=allocate((size_t)n*sizeof(*ids)); JSValue *values=allocate((size_t)n*sizeof(*values));
    uint64_t distinct=INITIAL, stable=INITIAL, held=INITIAL, reinserted=INITIAL;
    for(unsigned i=0;i<n;i++) {
        ids[i]=checked_atom(js_atom_concat_num(ctx,prefix,i));
        values[i]=checked(ctx,JS_AtomToString(ctx,ids[i]));
        if(i) distinct=mix(distinct,ids[i]!=ids[i-1]);
    }
    for(unsigned i=0;i<n;i+=2) JS_FreeAtom(ctx,ids[i]);
    for(unsigned i=0;i<n;i++) {
        JSAtom a=intern(ctx,values[i],2); stable=mix(stable,a==ids[i]);
        JS_FreeAtom(ctx,a); held=mix(held,units_hash(values[i]));
        if(i&1) JS_FreeAtom(ctx,ids[i]);
    }
    for(unsigned i=0;i<n;i++) JS_FreeValue(ctx,values[i]);
    for(unsigned i=n;i>0;i--) {
        JSAtom a=checked_atom(js_atom_concat_num(ctx,prefix,i-1));
        JSValue v=checked(ctx,JS_AtomToString(ctx,a));
        reinserted=mix(reinserted,units_hash(v)); JS_FreeValue(ctx,v); JS_FreeAtom(ctx,a);
    }
    emit(distinct); emit(stable); emit(held); emit(reinserted);
    free(values); free(ids); JS_FreeAtom(ctx,prefix);
}
static void outlive(JSContext *outer,JSValue text,unsigned kind) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt) die("lifetime runtime OOM");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("lifetime context OOM");
    /* Copy across runtimes; no atom/ValueBits crosses registry ownership. */
    unsigned n=string_rope_get_len(text); uint16_t *units=allocate((size_t)n*2);
    for(unsigned i=0;i<n;i++) units[i]=string_rope_get(text,i);
    JSValue description=checked(ctx,js_new_string16_len(ctx,units,n)); free(units);
    JSValue sym=JS_UNDEFINED; JSAtom a;
    if(kind) { sym=symbol(ctx,description,kind,0); a=JS_ValueToAtom(ctx,sym); }
    else a=intern(ctx,description,2);
    JSValue held=checked(ctx,JS_AtomToString(ctx,a)); JS_FreeAtom(ctx,a);
    JS_FreeValue(ctx,description); JS_FreeContext(ctx);
    ctx=JS_NewContext(rt); if(!ctx) die("replacement context OOM");
    snapshot(ctx,held); JS_FreeValue(ctx,sym);
    JSValue copy=JS_DupValue(ctx,held); JS_FreeValue(ctx,held); snapshot(ctx,copy);
    JS_FreeValue(ctx,copy); JS_FreeContext(ctx); JS_FreeRuntime(rt); (void)outer;
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt) die("runtime OOM");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context OOM");
    unsigned count=word(); put32(count);
    for(fixture=0;fixture<count;fixture++) {
        unsigned op=byte(); field_count=0;
        if(op==0) { JSValue v=recipe(ctx); snapshot(ctx,v); JS_FreeValue(ctx,v); }
        else if(op==1) {
            unsigned start=word(), end=word(); JSValue v=recipe(ctx), alias=JS_DupValue(ctx,v);
            snapshot(ctx,v);
            JSValue f=flat(ctx,v); JSValue sub=checked(ctx,js_sub_string(ctx,JS_VALUE_GET_STRING(f),start,end));
            snapshot(ctx,sub); JS_FreeValue(ctx,sub); JS_FreeValue(ctx,f);
            JSValue balanced=checked(ctx,js_rebalancee_string_rope(ctx,v)); snapshot(ctx,balanced); JS_FreeValue(ctx,balanced);
            f=flat(ctx,v); snapshot(ctx,f); JS_FreeValue(ctx,f); JS_FreeValue(ctx,v);
            snapshot(ctx,alias); f=flat(ctx,alias); JS_FreeValue(ctx,alias); snapshot(ctx,f); JS_FreeValue(ctx,f);
        } else if(op==2) {
            unsigned x=word(), y=word(), n=word(); JSValue a=recipe(ctx), b=recipe(ctx);
            emit(sign(js_string_rope_compare(ctx,a,b,FALSE))+1);
            emit(js_string_rope_compare(ctx,a,b,TRUE)==0);
            JSValue af=flat(ctx,a), bf=flat(ctx,b);
            emit(sign(js_string_memcmp(JS_VALUE_GET_STRING(af),x,JS_VALUE_GET_STRING(bf),y,n))+1);
            emit(sign(js_string_compare(ctx,JS_VALUE_GET_STRING(af),JS_VALUE_GET_STRING(bf)))+1);
            JS_FreeValue(ctx,af); JS_FreeValue(ctx,bf); JS_FreeValue(ctx,a); JS_FreeValue(ctx,b);
        } else if(op==3) { JSValue v=recipe(ctx); atom_lifetime(ctx,v); JS_FreeValue(ctx,v); }
        else if(op==4) {
            unsigned is_signed=byte(); uint64_t bits=wide();
            JSAtom a=checked_atom(is_signed?JS_NewAtomInt64(ctx,(int64_t)bits):JS_NewAtomUInt32(ctx,(uint32_t)bits));
            atom_metadata(ctx,a); JSValue v=checked(ctx,JS_AtomToString(ctx,a)); JSAtom b=intern(ctx,v,0);
            emit(a==b); JS_FreeAtom(ctx,b); JS_FreeValue(ctx,v); JS_FreeAtom(ctx,a);
        } else if(op==5) { JSAtom a=word(); if(a==0 || a>=JS_ATOM_END) die("bad predefined atom"); atom_metadata(ctx,a); }
        else if(op==6) {
            unsigned kind=byte(), absent=byte(); JSValue text=recipe(ctx);
            symbols(ctx,text,kind,absent); JS_FreeValue(ctx,text);
        } else if(op==7) churn(ctx,word());
        else if(op==8) { unsigned kind=byte(); JSValue text=recipe(ctx); outlive(ctx,text,kind); JS_FreeValue(ctx,text); }
        else if(op==9) {
            unsigned number=word(); JSValue text=recipe(ctx); unsigned n=word(); char *suffix=allocate((size_t)n+1);
            if(fread(suffix,1,n,stdin)!=n) die("truncated atom suffix"); suffix[n]=0;
            if(strlen(suffix)!=n) die("embedded null suffix outside C API");
            JSAtom a=intern(ctx,text,2), b=checked_atom(js_atom_concat_str(ctx,a,suffix)), c=checked_atom(js_atom_concat_num(ctx,a,number));
            atom_metadata(ctx,b); atom_metadata(ctx,c); JS_FreeAtom(ctx,a); JS_FreeAtom(ctx,b); JS_FreeAtom(ctx,c);
            JS_FreeValue(ctx,text); free(suffix);
        } else die("unknown operation");
        put32(field_count); for(unsigned i=0;i<field_count;i++) put64(fields[i]);
    }
    if(getchar()!=EOF) die("trailing input");
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    if(fflush(stdout) || ferror(stdout)) die("output write failed"); return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.core.result { Result }
import silk.option { Option }
import silk.collections.list { List }
import silk.collections.slice { Slice }
import silk.io.writer_native { StdoutWriter }
import silk.io.writer { Writer, WriterError }
import silk.num.f64
import silk.num.i32
import silk.num.u8
import silk.num.u16
import silk.num.u32
import silk.num.u64
import silk.num.usize
import byte_buffer { ByteBuffer, readU16, readU32 }
import js_value { ValueBits }
import js_strings { Strings, StringBuilder }
import js_string_types { StringOwner, StringLengthError, EmbeddedNullError, AtomKind }
import js_string_rope { RopeIterator }
import js_atoms { AtomTable }
const INITIAL:u64=14695981039346656037
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn byte(self:&mut Self)->u8 { let n=self.data[self.at] self.at=self.at+1 return n }
  fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
  fn wide(self:&mut Self)->u64 { let low=self.word() let high=self.word() return u32.toU64(low)|u64.shiftLeft(u32.toU64(high),32) }
  fn bytes(self:&mut Self,n:usize)->&'static [u8] { let data=Slice.view<u8>(self.data,self.at,n) self.at=self.at+n return data }
}
fn mix(h:u64,n:u64)->u64 { return u64.wrappingMultiply(h^n,1099511628211) }
fn bytesHash(bytes:&[u8])->u64 {
  let mut h=INITIAL let mut i:usize=0
  while i<bytes.length { h=mix(h,u8.toU64(bytes[i])) i=i+1 }
  return h
}
fn unitsHash(value:ValueBits)->u64 {
  let mut h=INITIAL let mut i:usize=0
  while i<Strings.length(value) { h=mix(h,u16.toU64(Strings.codeUnit(value,i))) i=i+1 }
  return h
}
fn flag(value:bool)->u64 { if value { return 1 } return 0 }
fn sign(value:i32)->u64 { if value<0 { return 0 } if value>0 { return 2 } return 1 }
fn signed(bits:u64)->i64 { if bits>=0x8000000000000000 { return -1-u64.toI64(bits^0xffffffffffffffff) } return u64.toI64(bits) }
effect fn basic(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU64(usize.toU64(Strings.length(value))) run out.writeU64(unitsHash(value))
}
effect fn nonnull(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  let result=run Effect.result(Strings.toCString(value,false,true))
  match move result {
    Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Success { value:bytes } => {
      run out.writeU64(1) run out.writeU64(bytesHash(bytes.asSlice()))
      let cesu=run Effect.result(Strings.toCString(value,true,true))
      match move cesu {
        Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Success { value:data } => { run out.writeU64(bytesHash(data.asSlice())) }
        Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Failure { error } => {
          match move error { OutOfMemoryError e => { fail move e } EmbeddedNullError e => { drop e run out.writeU64(0) } }
        }
      }
    }
    Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Failure { error } => {
      match move error {
        OutOfMemoryError e => { fail move e }
        EmbeddedNullError e => {
          drop e run out.writeU64(0) run out.writeU64(0)
          let cesu=run Effect.result(Strings.toCString(value,true,true))
          match move cesu {
            Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Success { value:data } => { run out.writeU64(bytesHash(data.asSlice())) }
            Result<List<u8>,OutOfMemoryError | EmbeddedNullError>.Failure { error:other } => {
              match move other { OutOfMemoryError innerOom => { fail move innerOom } EmbeddedNullError innerNull => { drop innerNull run out.writeU64(0) } }
            }
          }
        }
      }
    }
  }
}
effect fn snapshot(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError | EmbeddedNullError ? &mut Allocator {
  run basic(&mut out,value)
  let mut iterator=RopeIterator.make(&value) let mut h=INITIAL
  while true {
    match iterator.next() {
      Option<u16>.None => { break }
      Option<u16>.Some { value:unit } => { h=mix(h,u16.toU64(unit)) }
    }
  }
  drop iterator run out.writeU64(h)
  let mut leaves=RopeIterator.make(&value) h=INITIAL
  while true {
    match leaves.nextLeaf() {
      Option<ValueBits>.None => { break }
      Option<ValueBits>.Some { value:leaf } => {
        let mut i:usize=0
        while i<Strings.length(leaf) { h=mix(h,u16.toU64(Strings.codeUnit(leaf,i))) i=i+1 }
      }
    }
  }
  drop leaves run out.writeU64(h)
  let mut at:usize=0 let mut count:u64=0 h=INITIAL
  while at<Strings.length(value) {
    let point=Strings.codePoint(value,&mut at)
    h=mix(mix(h,u32.toU64(point)),usize.toU64(at)) count=count+1
  }
  run out.writeU64(count) run out.writeU64(h)
  let mut mode:u32=0
  while mode<2 {
    let bytes=run Strings.toUtf8(value,mode!=0)
    run out.writeU64(usize.toU64(bytes.length())) run out.writeU64(bytesHash(bytes.asSlice()))
    let cstring=run Strings.toCString(value,mode!=0,false)
    run out.writeU64(bytesHash(cstring.asSlice())) mode=mode+1
  }
  run nonnull(&mut out,value)
}
effect fn piece(input:&mut Input,builder:&mut StringBuilder,direct:bool)->ValueBits
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let kind=input.byte() let n=u32.toUsize(input.word())
  if kind<=2 {
    let bytes=input.bytes(n)
    if kind==0 {
      if direct { run builder.appendLatin1(bytes) return ValueBits.Undefined }
      return run Strings.fromLatin1(bytes)
    }
    if kind==1 {
      let mut units=List<u16>.make() run units.reserve(n/2) let mut i:usize=0
      while i<n { run units.append(readU16(bytes,i)) i=i+2 }
      if direct { run builder.appendUtf16(units.asSlice()) return ValueBits.Undefined }
      return run Strings.fromUtf16(units.asSlice())
    }
    let mut owner=StringOwner.adopt(run Strings.fromUtf8(bytes))
    if direct { run builder.append(owner.get()) return ValueBits.Undefined }
    return owner.take()
  }
  let unit=input.word()
  if kind==4 {
    if direct { run builder.appendCodePoint(unit) return ValueBits.Undefined }
    return run Strings.fromCodePoint(unit)
  }
  if direct { run builder.fill(u32.toU16(unit),n) return ValueBits.Undefined }
  let mut filled=StringBuilder.make() run filled.fill(u32.toU16(unit),n)
  return run filled.finish()
}
effect fn recipe(input:&mut Input)->ValueBits ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let style=input.byte() let n=u32.toUsize(input.word()) let mut builder=StringBuilder.make()
  if style==5 {
    run builder.reserve(13,false) let mut i:usize=0
    while i<n { let unused=run piece(&mut input,&mut builder,true) i=i+1 }
    return run builder.finish()
  }
  let mut parts=List<ValueBits>.make() run parts.reserve(n) let mut i:usize=0
  while i<n { run parts.append(run piece(&mut input,&mut builder,false)) i=i+1 }
  if n==0 { return run Strings.fromLatin1(b"") }
  if style==0 { return parts.get(0) }
  if style==3 {
    let mut count=n
    while count>1 {
      let mut target:usize=0 i=0
      while i<count {
        if i+1<count {
          let joined=run Strings.concatOwned(parts.get(i),parts.get(i+1)) parts.set(target,joined)
        } else { let remaining=parts.get(i) parts.set(target,remaining) }
        target=target+1 i=i+2
      }
      count=target
    }
    return parts.get(0)
  }
  let mut result=StringOwner.adopt(parts.get(0)) i=1
  while i<n {
    let part=parts.get(i)
    if style==2 || (style==4 && i%2==1) { result=StringOwner.adopt(run Strings.concatOwned(part,result.take())) }
    else if style==6 {
      let next=run Strings.concat(result.get(),part) Strings.release(part) result=StringOwner.adopt(next)
    } else { result=StringOwner.adopt(run Strings.concatOwned(result.take(),part)) }
    i=i+1
  }
  return result.take()
}
fn kindCode(kind:AtomKind)->u64 {
  return match kind { AtomKind.String => 0 AtomKind.Symbol => 1 AtomKind.GlobalSymbol => 2 AtomKind.Private => 3 }
}
effect fn atomMetadata(out:&mut ByteBuffer,table:&AtomTable,atom:u32)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut constant:u64=0 if AtomTable.isConstant(atom) { constant=u32.toU64(atom) }
  run out.writeU64(constant) run out.writeU64(flag(AtomTable.isInteger(atom)))
  let mut property=kindCode(table.propertyKind(atom)) if property==3 { property=2 }
  run out.writeU64(property) run out.writeU64(kindCode(table.kind(atom))) run out.writeU64(flag(table.hasDescription(atom)))
  match table.arrayIndex(atom) {
    Option<u32>.None => { run out.writeU64(0) run out.writeU64(0) }
    Option<u32>.Some { value } => { run out.writeU64(1) run out.writeU64(u32.toU64(value)) }
  }
  let number=table.numericIndex(atom) let mut bits:u64=0
  if number.isNumber() {
    let value=number.numericValue() bits=f64.toBits(value)
    if value!=value { bits=0x7ff8000000000000 }
  }
  run out.writeU64(flag(number.isNumber())) run out.writeU64(bits)
  let value=StringOwner.adopt(run table.toValue(atom,false)) run out.writeU64(flag(value.get().tag()== -8))
  let text=StringOwner.adopt(run table.toValue(atom,true)) run basic(&mut out,text.get())
}
effect fn intern(table:&mut AtomTable,value:ValueBits,method:u32)->u32 ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  if method==0 { let bytes=run Strings.toUtf8(value,false) return run table.internUtf8(bytes.asSlice()) }
  if method==1 {
    let mut units=List<u16>.make() let mut i:usize=0 run units.reserve(Strings.length(value))
    while i<Strings.length(value) { run units.append(Strings.codeUnit(value,i)) i=i+1 }
    return run table.internUtf16(units.asSlice())
  }
  if method==2 { return run table.intern(value) }
  return run table.internOwned(run Strings.flatten(value))
}
effect fn atomLifetime(out:&mut ByteBuffer,table:&mut AtomTable,text:ValueBits)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let atom=run intern(&mut table,text,0) run atomMetadata(&mut out,&table.*,atom)
  let mut method:u32=1
  while method<4 {
    let other=run intern(&mut table,text,method) run out.writeU64(flag(atom==other)) table.release(other) method=method+1
  }
  let duplicate=table.duplicate(atom) run out.writeU64(flag(duplicate==atom))
  let held=StringOwner.adopt(run table.toValue(atom,true)) table.release(atom) table.release(duplicate)
  run basic(&mut out,held.get())
  let other=run intern(&mut table,text,2) run out.writeU64(flag(other==atom)) table.release(other) drop held
  let reinserted=run intern(&mut table,text,3) run atomMetadata(&mut out,&table.*,reinserted) table.release(reinserted)
}
effect fn symbol(table:&mut AtomTable,text:ValueBits,kind:u8,absent:bool)->ValueBits ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut description=Option<ValueBits>.none() if !absent { description=Option<ValueBits>.some(text) }
  if kind==2 { return run table.globalSymbol(move description) }
  if kind==3 { return run table.privateSymbol(text) }
  return run table.uniqueSymbol(move description)
}
effect fn maybeDescription(out:&mut ByteBuffer,description:Option<ValueBits>)->() ! OutOfMemoryError ? &mut Allocator {
  match move description {
    Option<ValueBits>.None => { run out.writeU64(0) run out.writeU64(0) run out.writeU64(0) }
    Option<ValueBits>.Some { value } => { let owned=StringOwner.adopt(value) run out.writeU64(1) run basic(&mut out,owned.get()) }
  }
}
effect fn symbols(out:&mut ByteBuffer,table:&mut AtomTable,text:ValueBits,kind:u8,absent:bool)->()
  ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let mut builder=StringBuilder.make() run builder.append(text)
  let description=StringOwner.adopt(run builder.finish())
  let a=StringOwner.adopt(run symbol(&mut table,text,kind,absent))
  let b=StringOwner.adopt(run symbol(&mut table,description.get(),kind,absent)) drop description
  let aa=table.symbolAtom(a.get()) let ba=table.symbolAtom(b.get())
  run atomMetadata(&mut out,&table.*,aa) run out.writeU64(flag(aa==ba))
  let copy=StringOwner.borrowed(a.get()) let ca=table.symbolAtom(copy.get()) run out.writeU64(flag(ca==aa))
  run maybeDescription(&mut out,table.description(a.get())) run maybeDescription(&mut out,table.globalKey(a.get()))
  let ordinary=StringOwner.adopt(run table.toValue(aa,true)) let oa=run intern(&mut table,ordinary.get(),2)
  run out.writeU64(flag(oa==aa)) table.release(oa) drop ordinary drop copy table.release(ca)
  table.release(aa) drop a run atomMetadata(&mut out,&table.*,ba)
  run maybeDescription(&mut out,table.globalKey(b.get()))
  match table.globalKey(b.get()) {
    Option<ValueBits>.None => { run out.writeU64(0) }
    Option<ValueBits>.Some { value:key } => {
      let keyOwner=StringOwner.adopt(key)
      let again=StringOwner.adopt(run symbol(&mut table,keyOwner.get(),2,false))
      let ka=table.symbolAtom(again.get()) run out.writeU64(flag(ka==ba)) table.release(ka)
    }
  }
  let mut otherKind:u8=1 if kind==1 { otherKind=2 }
  let other=StringOwner.adopt(run symbol(&mut table,text,otherKind,absent))
  let otherAtom=table.symbolAtom(other.get()) run out.writeU64(flag(otherAtom==ba))
  table.release(otherAtom) table.release(ba)
}
effect fn churn(out:&mut ByteBuffer,table:&mut AtomTable,n:usize)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
  let prefix=run table.internUtf8(b"churn-") let mut ids=List<u32>.make() let mut values=List<ValueBits>.make()
  run ids.reserve(n) run values.reserve(n)
  let mut distinct=INITIAL let mut stable=INITIAL let mut held=INITIAL let mut reinserted=INITIAL let mut i:usize=0
  while i<n {
    let atom=run table.concatNumber(prefix,usize.toU32(i)) run ids.append(atom) run values.append(run table.toValue(atom,true))
    if i!=0 { distinct=mix(distinct,flag(atom!=ids.get(i-1))) } i=i+1
  }
  i=0 while i<n { table.release(ids.get(i)) i=i+2 }
  i=0 while i<n {
    let atom=run intern(&mut table,values.get(i),2) stable=mix(stable,flag(atom==ids.get(i))) table.release(atom)
    held=mix(held,unitsHash(values.get(i))) if i%2==1 { table.release(ids.get(i)) } i=i+1
  }
  i=0 while i<n { Strings.release(values.get(i)) i=i+1 }
  i=n while i>0 {
    let atom=run table.concatNumber(prefix,usize.toU32(i-1)) let value=StringOwner.adopt(run table.toValue(atom,true))
    reinserted=mix(reinserted,unitsHash(value.get())) table.release(atom) i=i-1
  }
  run out.writeU64(distinct) run out.writeU64(stable) run out.writeU64(held) run out.writeU64(reinserted) table.release(prefix)
}
effect fn outlive(out:&mut ByteBuffer,text:ValueBits,kind:u8)->() ! OutOfMemoryError | StringLengthError | EmbeddedNullError ? &mut Allocator {
  let mut table=run AtomTable.make() let mut sym=StringOwner.adopt(ValueBits.Undefined) let mut atom:u32=0
  // Never transfer an already-interned value between registries.
  let mut units=List<u16>.make() let mut i:usize=0
  while i<Strings.length(text) { run units.append(Strings.codeUnit(text,i)) i=i+1 }
  let description=StringOwner.adopt(run Strings.fromUtf16(units.asSlice()))
  if kind!=0 { sym=StringOwner.adopt(run symbol(&mut table,description.get(),kind,false)) atom=table.symbolAtom(sym.get()) }
  else { atom=run intern(&mut table,description.get(),2) }
  let held=StringOwner.adopt(run table.toValue(atom,true)) table.release(atom) drop description drop table
  run snapshot(&mut out,held.get()) drop sym
  let copy=StringOwner.borrowed(held.get()) drop held run snapshot(&mut out,copy.get())
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer,table:&mut AtomTable)->()
  ! OutOfMemoryError | StringLengthError | EmbeddedNullError ? &mut Allocator {
  let op=input.byte()
  if op==0 { let value=StringOwner.adopt(run recipe(&mut input)) run snapshot(&mut out,value.get()) }
  else if op==1 {
    let start=u32.toUsize(input.word()) let end=u32.toUsize(input.word())
    let value=StringOwner.adopt(run recipe(&mut input)) let alias=StringOwner.borrowed(value.get())
    run snapshot(&mut out,value.get())
    let sub=StringOwner.adopt(run Strings.substring(value.get(),start,end)) run snapshot(&mut out,sub.get()) drop sub
    let balanced=StringOwner.adopt(run Strings.rebalance(value.get())) run snapshot(&mut out,balanced.get()) drop balanced
    let flat=StringOwner.adopt(run Strings.flatten(value.get())) run snapshot(&mut out,flat.get()) drop flat drop value
    run snapshot(&mut out,alias.get())
    let second=StringOwner.adopt(run Strings.flatten(alias.get())) drop alias run snapshot(&mut out,second.get())
  } else if op==2 {
    let x=u32.toUsize(input.word()) let y=u32.toUsize(input.word()) let n=u32.toUsize(input.word())
    let a=StringOwner.adopt(run recipe(&mut input)) let b=StringOwner.adopt(run recipe(&mut input))
    run out.writeU64(sign(Strings.compare(a.get(),b.get()))) run out.writeU64(flag(Strings.equal(a.get(),b.get())))
    run out.writeU64(sign(Strings.compareRange(a.get(),x,b.get(),y,n)))
    let af=StringOwner.adopt(run Strings.flatten(a.get())) let bf=StringOwner.adopt(run Strings.flatten(b.get()))
    run out.writeU64(sign(Strings.compare(af.get(),bf.get())))
  } else if op==3 {
    let value=StringOwner.adopt(run recipe(&mut input)) run atomLifetime(&mut out,&mut table,value.get())
  } else if op==4 {
    let isSigned=input.byte()!=0 let bits=input.wide() let mut atom:u32=0
    if isSigned { atom=run table.internInt64(signed(bits)) } else { atom=run table.internUInt32(u64.toU32(bits)) }
    run atomMetadata(&mut out,&table.*,atom)
    let value=StringOwner.adopt(run table.toValue(atom,true)) let other=run intern(&mut table,value.get(),0)
    run out.writeU64(flag(atom==other)) table.release(other) table.release(atom)
  } else if op==5 { let atom=input.word() run atomMetadata(&mut out,&table.*,atom) }
  else if op==6 {
    let kind=input.byte() let absent=input.byte()!=0 let text=StringOwner.adopt(run recipe(&mut input))
    run symbols(&mut out,&mut table,text.get(),kind,absent)
  } else if op==7 { let count=u32.toUsize(input.word()) run churn(&mut out,&mut table,count) }
  else if op==8 {
    let kind=input.byte() let text=StringOwner.adopt(run recipe(&mut input)) run outlive(&mut out,text.get(),kind)
  } else if op==9 {
    let number=input.word() let text=StringOwner.adopt(run recipe(&mut input)) let n=u32.toUsize(input.word()) let suffix=input.bytes(n)
    let atom=run intern(&mut table,text.get(),2) let b=run table.concatUtf8(atom,suffix) let c=run table.concatNumber(atom,number)
    run atomMetadata(&mut out,&table.*,b) run atomMetadata(&mut out,&table.*,c) table.release(atom) table.release(b) table.release(c)
  }
}
effect fn probe()->() ! OutOfMemoryError | StringLengthError | EmbeddedNullError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word() let mut table=run AtomTable.make()
  let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice()) let mut i:u32=0
  let mut out=ByteBuffer.make() let mut size=ByteBuffer.make()
  while i<count {
    out.clear() size.clear() run operate(&mut input,&mut out,&mut table)
    run size.writeU32(usize.toU32(out.length()/8))
    run Writer.writeAll(size.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
}
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | EmbeddedNullError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def u32(n):
    return struct.pack('<I', n)


def latin1(data):
    return b'\0' + u32(len(data)) + bytes(data)


def utf16(units):
    data = struct.pack(f'<{len(units)}H', *units)
    return b'\1' + u32(len(data)) + data


def utf8(data):
    return b'\2' + u32(len(data)) + data


def fill(unit, count):
    return b'\3' + u32(count) + u32(unit)


def point(cp):
    return b'\4' + u32(1) + u32(cp)


def recipe(*pieces, style=0):
    if style == 0 and len(pieces) > 1:
        raise ValueError('flat recipe must have at most one piece')
    return bytes((style,)) + u32(len(pieces)) + b''.join(pieces)


def prefixed(prefix, names):
    return tuple(f'{prefix}.{name}' for name in names)


@dataclass(frozen=True)
class Case:
    label: str
    op: int
    payload: bytes

    def wire(self):
        return bytes((self.op,)) + self.payload

    def fields(self):
        if self.op == 0:
            return SNAPSHOT
        if self.op == 1:
            return sum((prefixed(stage, SNAPSHOT) for stage in
                        ('original', 'slice', 'rebalanced', 'flattened', 'surviving-alias', 'second-flatten')), ())
        if self.op == 2:
            return ('ordering', 'equality', 'range-ordering', 'flat-ordering')
        if self.op == 3:
            return (prefixed('initial', ATOM) + ('utf16.same', 'borrowed.same', 'owned.same', 'duplicate.same')
                    + prefixed('value-after-release', BASIC) + ('reintern-held.same',) + prefixed('reinserted', ATOM))
        if self.op == 4:
            return ATOM + ('decimal-intern.same',)
        if self.op == 5:
            return ATOM
        if self.op == 6:
            return (prefixed('first', ATOM) + ('second.same', 'duplicate.same', 'description.present')
                    + prefixed('description', BASIC) + ('global-key.present',) + prefixed('global-key', BASIC)
                    + ('ordinary-atom.same',) + prefixed('survivor', ATOM) + ('survivor-key.present',)
                    + prefixed('survivor-key', BASIC) + ('key-roundtrip.same', 'other-kind.same'))
        if self.op == 7:
            return ('distinct.fnv', 'live-identity.fnv', 'held-content.fnv', 'reinserted-content.fnv')
        if self.op == 8:
            return prefixed('after-table-drop', SNAPSHOT) + prefixed('after-original-drop', SNAPSHOT)
        return prefixed('suffix', ATOM) + prefixed('number', ATOM)


def fixtures(seed, random_cases):
    cases = []

    def add(op, label, payload):
        cases.append(Case(label, op, payload))

    def string(label, value):
        add(0, label, value)

    # These exhaustive domains are unconditional, even with --random-cases=0.
    string('empty/latin1', recipe(latin1(b'')))
    string('empty/utf16', recipe(utf16(())))
    string('empty/utf8', recipe(utf8(b'')))
    for unit in range(256):
        string(f'latin1/{unit:02x}', recipe(latin1(bytes((unit,)))))
        string(f'utf8/single-{unit:02x}', recipe(utf8(bytes((unit,)))))
    string('latin1/all-256', recipe(latin1(bytes(range(256)))))
    for unit in range(65536):
        string(f'utf16/isolated-{unit:04x}', recipe(utf16((unit,))))
    string('utf16/all-65536', recipe(utf16(tuple(range(65536)))))
    for pair in range(65536):
        data = bytes((pair >> 8, pair & 255))
        string(f'utf8/two-bytes-{data.hex()}', recipe(utf8(data)))
    utf8_edges = [
        b'\0a\0', b'\x80\x81A', b'\x80\x81A\x80B', b'\xc0\x80', b'\xc1\xbf',
        b'\xe0\x80\x80', b'\xe0\x9f\xbf', b'\xe0\xa0\x80', b'\xed\x9f\xbf',
        b'\xed\xa0\x80', b'\xed\xbf\xbf', b'\xef\xbf\xbf', b'\xf0\x80\x80\x80',
        b'\xf0\x8f\xbf\xbf', b'\xf0\x90\x80\x80', b'\xf4\x8f\xbf\xbf', b'\xf4\x90\x80\x80',
        b'\xf7\xbf\xbf\xbf', b'\xf8\x88\x80\x80\x80', b'\xfb\xbf\xbf\xbf\xbf',
        b'\xfc\x84\x80\x80\x80\x80', b'\xfd\xbf\xbf\xbf\xbf\xbf', b'\xfe\xff\x80A',
        b'\xed\xa0\xbd\xed\xb8\x80', b'A\xe2\x82B\x80C',
    ]
    for i, data in enumerate(utf8_edges):
        for cut in range(len(data) + 1):
            string(f'utf8/edge-{i}/prefix-{cut}/{data[:cut].hex()}', recipe(utf8(data[:cut])))
    for hi in (0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000):
        for lo in (0, 0x41, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000):
            string(f'utf16/pair-{hi:04x}-{lo:04x}', recipe(utf16((hi, lo))))
    for cp in sorted({0, 127, 128, 255, 256, 2047, 2048, 0xd7ff, 0xd800, 0xdfff,
                      0xe000, 0xffff, 0x10000, 0x10001, 0x10ffff}
                     | {plane * 65536 + delta for plane in range(1, 17) for delta in (-1, 0, 1)}):
        string(f'codepoint/{cp:06x}', recipe(point(cp)))

    rng = random.Random(seed)
    for i in range(random_cases):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(3, 257)))
        string(f'utf8/random-invalid-{i}/{data[:16].hex()}', recipe(utf8(data)))
        units = tuple(rng.randrange(65536) for _ in range(rng.randrange(1, 129)))
        string(f'utf16/random-{i}', recipe(utf16(units)))
        cps = [rng.randrange(0x110000) for _ in range(rng.randrange(1, 65))]
        valid = ''.join(map(chr, cps)).encode('utf-8', 'surrogatepass')
        string(f'utf8/random-valid-{i}', recipe(utf8(valid)))
        cp = rng.randrange(0x110000)
        string(f'codepoint/random-{i}/{cp:06x}', recipe(point(cp)))

    # Flat/owned/borrowed/left-heavy/right-heavy/balanced/alternating histories.
    # No width, tree shape, allocation count, or pointer address is an expected field.
    histories = []
    for left in (0, 1, 511, 512, 513, 8191, 8192, 8193):
        for right in (0, 1, 511, 512, 513, 8192, 8193):
            for style in (1, 2, 3, 6):
                pieces = (fill(0x61, left), fill(0xd83d, 1), fill(0xde00, 1), fill(0x100, right))
                total = left + right + 2
                histories.append((f'threshold/{left}+pair+{right}/style-{style}', recipe(*pieces, style=style), total))
    for style in (1, 2, 3, 4, 6):
        for count in (59, 60, 61, 62, 127, 257):
            pieces = tuple(fill((0x61, 0x100, 0xd800, 0xdc00, 0, 0xffff)[i % 6], 513 + i % 3) for i in range(count))
            histories.append((f'deep/{count}/style-{style}', recipe(*pieces, style=style), sum(513+i%3 for i in range(count))))
    for label, value, total in histories:
        start = max(0, min(total, total // 2 - 3))
        end = min(total, start + 17)
        add(1, label, u32(start) + u32(end) + value)
    # Explicit empty/full/cross-leaf/high-only/low-only slices.
    split = recipe(fill(0x61, 8193), utf16((0xd83d,)), utf16((0xde00,)), fill(0x62, 513), style=1)
    for start, end in ((0, 0), (0, 8708), (8192, 8196), (8193, 8194), (8194, 8195), (8708, 8708)):
        add(1, f'slice/{start}:{end}', u32(start) + u32(end) + split)
    for n in (0, 1, 12, 13, 14, 255, 512, 8192):
        for wide in (0x100, 0xd800, 0xdc00, 0xffff):
            parts = (latin1(b'prefix\0'), fill(0xe9, n), utf16((wide,)), latin1(b'after'), point(0x1f600), utf8(b'\xed\xa0\x80'), fill(0x7f, 3))
            string(f'builder/widen-{wide:04x}/at-{n}', recipe(*parts, style=5))

    compare_inputs = [('', ()), ('ascii', (65,)), ('latin1', (233,)), ('wide', (256,)),
                      ('high', (0xd800,)), ('low', (0xdc00,)), ('pair', (0xd800, 0xdc00)),
                      ('nul', (0,)), ('prefix', (65, 0)), ('non-bmp-order', (0xe000,))]
    for an, a in compare_inputs:
        for bn, b in compare_inputs:
            add(2, f'compare/{an}/{bn}', u32(0)*2 + u32(min(len(a), len(b))) + recipe(utf16(a)) + recipe(utf16(b)))
    for length in (511, 512, 513, 8192, 8193, 32769):
        for delta in (-1, 0, 1):
            a = recipe(fill(0x61, length), utf16((0xd800, 0xdc00)), fill(0xff, 513), style=1)
            b = recipe(fill(0x61, length), utf16((0xd800, 0xdc00 + delta)), fill(0xff, 513), style=3)
            add(2, f'compare/rope/{length}/delta-{delta}', u32(length-1)*2 + u32(4) + a + b)

    numeric = {
        '', '0', '-0', '+0', '00', '01', '1', '-1', '+1', '1.0', '1.', '.1', '0.1', '-0.0',
        'NaN', 'nan', '-NaN', '+NaN', 'Infinity', '-Infinity', '+Infinity', 'inf',
        '1e-7', '1e-6', '0.000001', '0.0000001', '1e+20', '1e20', '1e+21', '1e21',
        '100000000000000000000', '1000000000000000000000', '1000000000000000100',
        '5e-324', '4.9406564584124654e-324', '2.2250738585072014e-308',
        '1.7976931348623157e+308', '1.7976931348623159e+308', '1e309', '-1e309',
        '0x0', '0xff', '0b1', '0o7', '1_000', ' 1', '1 ', '\t0', '0\n', '1\0',
        '1e+00', '1E+21', '1e-07', '-0.000001', '-1e-7', '1.0000000000000002',
    }
    for bit in (8, 16, 30, 31, 32, 53, 63, 64):
        for delta in (-2, -1, 0, 1, 2):
            numeric.update((str((1 << bit) + delta), str(-((1 << bit) + delta))))
    for i in range(random_cases):
        bits = rng.getrandbits(64)
        number = struct.unpack('<d', struct.pack('<Q', bits))[0]
        for precision in (1, 6, 15, 16, 17):
            numeric.add(format(number, f'.{precision}g'))
    for text in sorted(numeric):
        add(3, f'atom/numeric/{text!r}', recipe(utf8(text.encode())))
    for units in ((0,), (65, 0, 66), (0xd800,), (0xdc00,), (0xd83d, 0xde00), (0xff11,), (0x31, 0x300), (0x49, 0x6e, 0x66, 0xffff)):
        add(3, f'atom/utf16/{units}', recipe(utf16(units)))
    for text in ('name', 'length', '__proto__', 'constructor', 'private-identifier', 'é', '𝒜'):
        add(3, f'atom/text/{text}', recipe(utf8(text.encode())))
    add(3, 'atom/rope', recipe(fill(0x61, 8193), utf16((0xd800, 0xdc00)), fill(0xe9, 513), style=1))
    for number in (0, 1, 0x7ffffffe, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff):
        add(4, f'atom/uint32/{number}', b'\0' + struct.pack('<Q', number))
    for number in (-(1 << 63), -(1 << 53)-1, -2147483649, -2147483648, -1, 0, 1, 2147483647, 2147483648, 4294967295, (1 << 53)+1, (1 << 63)-1):
        add(4, f'atom/int64/{number}', b'\1' + struct.pack('<Q', number & 0xffffffffffffffff))
    for atom in range(1, 253):
        add(5, f'atom/predefined/{atom}', u32(atom))
    descriptions = [recipe(latin1(b'')), recipe(utf8(b'undefined')), recipe(utf8(b'0')),
                    recipe(utf8(b'name')), recipe(utf8(b'a\0b')), recipe(utf16((0xd800,))),
                    recipe(utf16((0xdc00,))), recipe(utf16((0xd83d, 0xde00))), recipe(utf8('é'.encode()))]
    for kind in (1, 2, 3):
        for i, text in enumerate(descriptions):
            add(6, f'symbol/kind-{kind}/description-{i}', bytes((kind, 0)) + text)
        if kind != 3:
            add(6, f'symbol/kind-{kind}/absent-description', bytes((kind, 1)) + recipe())
    for count in (1, 511, 1023, 1024, 1025, 4097, 8193):
        add(7, f'atom/churn-{count}', u32(count))
    for kind in (0, 1, 2, 3):
        for i, text in enumerate((recipe(utf8(b'name')), recipe(utf16((0xd800, 0, 0xe9, 0xdc00))))):
            add(8, f'owner/outlive/kind-{kind}/{i}', bytes((kind,)) + text)
    for base in (b'', b'0', b'2147483647', b'name', b'a\0b', b'\xed\xa0\x80'):
        for suffix in (b'', b'0', b'\xc3\xa9', b'\xed\xb0\x80', b'\x80A'):
            for number in (0, 2147483648, 4294967295):
                add(9, f'atom/concat/{base!r}/{suffix!r}/{number}',
                    u32(number) + recipe(utf8(base)) + u32(len(suffix)) + suffix)
    return cases


def validate_pins(upstream):
    pins = tomllib.loads((ROOT / 'upstream.toml').read_text())['source-sha256']
    pending, seen = ['quickjs.c', *SUPPORT], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise SystemExit(f'Unsafe upstream include path: {name}')
        seen.add(name)
        if name not in pins:
            raise SystemExit(f'Missing upstream.toml source-sha256 pin: {name}')
        source = upstream / name
        if not source.is_file():
            raise SystemExit(f'Missing pinned upstream source: {source}')
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != pins[name]:
            raise SystemExit(f'Wrong upstream source {name}:\n  pinned {pins[name]}\n  actual {digest}')
        for include in re.findall(rb'^\s*#\s*include\s+"([^"\r\n]+)"', data, re.MULTILINE):
            pending.append(str(relative.parent / include.decode('utf-8')))
    return len(seen)


def records(data, cases, owner):
    at = 0

    def take(n, label):
        nonlocal at
        if n > len(data) - at:
            raise SystemExit(f'{owner}: truncated output at {label}, byte {at}; wanted {n} bytes, have {len(data)-at}')
        result = data[at:at+n]
        at += n
        return result

    count, = struct.unpack('<I', take(4, 'record count'))
    if count != len(cases):
        raise SystemExit(f'{owner}: record count {count}, expected {len(cases)}')
    output = []
    for i, case in enumerate(cases):
        label = f'fixture #{i} [{case.label}]'
        count, = struct.unpack('<I', take(4, label))
        wanted = len(case.fields())
        if count != wanted:
            raise SystemExit(f'{owner}: {label}: {count} fields, expected {wanted}')
        output.append(struct.unpack(f'<{count}Q', take(count*8, label)))
    if at != len(data):
        raise SystemExit(f'{owner}: {len(data)-at} unexpected trailing output bytes')
    return output


def executable_path(value):
    candidate = Path(value).expanduser()
    if candidate.exists() or '/' in value:
        return str(candidate.resolve())
    found = shutil.which(value)
    if not found:
        raise SystemExit(f'Executable not found: {value}')
    return str(Path(found).resolve())


def incomplete_record(data, cases):
    if cases is None:
        return ''
    if len(data) < 4:
        return '; no protocol header (compilation/startup or first-record failure)'
    count, = struct.unpack_from('<I', data)
    if count != len(cases):
        return f'; invalid protocol header {count}, expected {len(cases)}'
    at = 4
    for i, case in enumerate(cases):
        size = len(case.fields())
        if at + 4 > len(data):
            return f'; first unreported fixture #{i} [{case.label}]'
        actual, = struct.unpack_from('<I', data, at)
        if actual != size or at + 4 + actual * 8 > len(data):
            return f'; incomplete fixture #{i} [{case.label}]'
        at += 4 + actual * 8
    return '; all fixture records emitted; failure during teardown'


def process(command, timeout, *, owner, cwd=None, data=None, cases=None):
    try:
        result = subprocess.run(command, cwd=cwd, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        stderr = (error.stderr or b'').decode(errors='replace')
        position = incomplete_record(error.stdout or b'', cases)
        raise SystemExit(f'{owner}: timed out after {timeout}s{position}\n{stderr}') from None
    except OSError as error:
        raise SystemExit(f'{owner}: cannot execute {command[0]}: {error}') from None
    stderr = result.stderr.decode(errors='replace')
    if result.returncode:
        position = incomplete_record(result.stdout, cases)
        raise SystemExit(f'{owner}: exited {result.returncode}; captured {len(result.stdout)} stdout bytes{position}\n{stderr}')
    if stderr:
        print(f'{owner} stderr:\n{stderr}', end='' if stderr.endswith('\n') else '\n')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()), help='native compiler executable')
    parser.add_argument('--stdlib', type=Path, help='source standard library for this compiler', default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc', help='independent C compiler executable')
    parser.add_argument('--seed', type=lambda value: int(value, 0), default=0x571A6501)
    parser.add_argument('--random-cases', type=int, default=256, help='additional seeded cases; exhaustive domains are always enabled')
    parser.add_argument('--timeout', type=int, default=900, help='seconds per compiler/probe subprocess')
    parser.add_argument('--max-mismatches', type=int, default=20)
    args = parser.parse_args()
    if args.random_cases < 0 or args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('random-cases must be nonnegative; timeout/max-mismatches must be positive')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    cases = fixtures(args.seed, args.random_cases)
    data = u32(len(cases)) + b''.join(case.wire() for case in cases)
    with tempfile.TemporaryDirectory(prefix='silkjs-strings-') as directory:
        # /var aliases are not accepted by the local compiler's source discovery.
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE',
                 '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread',
                 '-o', str(temp / 'oracle')], args.timeout, owner='C32 oracle compilation')
        print(f'Independent C32 strings oracle: {len(cases):,} records; {pins} recursively validated source hashes; seed={args.seed:#x}', flush=True)
        oracle = process([str(temp / 'oracle')], args.timeout, owner='C32 oracle', data=data, cases=cases)
        expected = records(oracle, cases, 'C32 oracle')
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="strings-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if stdlib is not None:
            command.extend(('--stdlib', str(stdlib)))
        print('Building and running native Silk strings probe (no C linkage)...', flush=True)
        native = process(command, args.timeout, owner='Native Silk probe', cwd=temp, cases=cases)
        actual = records(native, cases, 'Native Silk probe')
        failures = Counter()
        mismatch_count = 0
        for i, (case, reference, observed) in enumerate(zip(cases, expected, actual, strict=True)):
            if reference == observed:
                continue
            mismatch_count += 1
            failures[OPS[case.op]] += 1
            if mismatch_count <= args.max_mismatches:
                print(f'MISMATCH #{i} [{case.label}] input-sha256={hashlib.sha256(case.wire()).hexdigest()}')
                for name, want, got in zip(case.fields(), reference, observed, strict=True):
                    if want != got:
                        print(f'  {name}: C32={want} ({want:#018x}); Silk={got} ({got:#018x})')
        if mismatch_count:
            raise SystemExit(f'{mismatch_count} string/rope/atom/symbol mismatches ({dict(failures)}); showing first {min(mismatch_count,args.max_mismatches)}')
        totals = Counter(OPS[case.op] for case in cases)
        print(f'PASS: {len(cases):,} independent records. Operations: {dict(totals)}. Output SHA256: {hashlib.sha256(native).hexdigest()}')


if __name__ == '__main__':
    main()
