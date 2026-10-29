#!/usr/bin/env python3
"""Differentially exercise native Lexer against original pinned QuickJS C32.

Usage: python3 scripts/verify_lexer.py QUICKJS [--silk COMPILER] [--stdlib SDK]

The separate C executable includes quickjs.c and calls its static lexical
operations, not JS_Eval or a replacement tokenizer. Fixtures contain bytes,
lexical contexts and explicit parser actions; neither side supplies expectations
for the other. Exact UTF16 contents, binary64 bits, signed normalized BigInt
limbs, token boundaries, line-feed flags, source coordinates and lookahead
results are compared. The bounded Silk input has no sentinel; only the C input
has the padding required by its original scanner.

Errors retain their exact messages and coordinates. C exposes one-based
line/column rather than byte offsets; native offsets are additionally reported
and converted to those same coordinates by Lexer.location. Only the explicit
native %c error detail is formatted to match C. Unknown errors, allocation
failures, protocol failures and absent C error coordinates fail closed.

Snapshot replay calls the original C get/seek helpers without substituting
parser-controlled regexp or template rescans. High snapshot-argument bits change
strict mode between save and seek, as directive parsing does. No native-derived
golden data is used.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
from pathlib import Path
import random
import shutil
import struct
import tempfile
import tomllib

# Reuse the established recursive source-pin validator and process launcher,
# not any semantic fixture, native output, or oracle implementation.
from verify_strings import ROOT, SUPPORT, executable_path, process, validate_pins
import toolchain

REVISION = '7d1c13c5d8f8c6b32893786ed35cdcebd88194d2'
SCAN, NEXT, REGEXP, TEMPLATE, SNAPSHOT, REPARSE, PEEK, PARENS, LOCATION, MODULE, ASI = range(11)

C_SOURCE = r'''
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || JS_SHORT_BIG_INT_BITS != 32
#error This probe requires the pinned C32 BigInt profile
#endif
static unsigned fixture, count, capacity;
static uint32_t *output;
static void die(const char *message) {
    fprintf(stderr,"lexer oracle fixture %u: %s\n",fixture,message); exit(1);
}
static uint32_t word(void) {
    uint32_t n=0;
    for(unsigned i=0;i<4;i++) { int c=getchar(); if(c==EOF) die("truncated input"); n|=(uint32_t)c<<(i*8); }
    return n;
}
static void put(uint32_t n) { for(unsigned i=0;i<4;i++) putchar((n>>(8*i))&255); }
static void emit(uint32_t n) {
    if(count==capacity) {
        capacity=capacity?capacity*2:256;
        void *p=realloc(output,(size_t)capacity*sizeof(*output)); if(!p) die("adapter OOM"); output=p;
    }
    output[count++]=n;
}
static void text(JSValueConst value) {
    if(!JS_IsString(value)) die("expected flat string");
    JSString *p=JS_VALUE_GET_STRING(value); emit(p->len);
    for(unsigned i=0;i<p->len;i++) emit(string_get(p,i));
}
static JSToken duplicate(JSContext *ctx,JSToken token) {
    switch(token.val) {
    case TOK_NUMBER: token.u.num.val=JS_DupValue(ctx,token.u.num.val); break;
    case TOK_STRING: case TOK_TEMPLATE: token.u.str.str=JS_DupValue(ctx,token.u.str.str); break;
    case TOK_REGEXP:
        token.u.regexp.body=JS_DupValue(ctx,token.u.regexp.body);
        token.u.regexp.flags=JS_DupValue(ctx,token.u.regexp.flags); break;
    default:
        if(token.val==TOK_IDENT || token.val==TOK_PRIVATE_NAME ||
           (token.val>=TOK_FIRST_KEYWORD && token.val<=TOK_LAST_KEYWORD))
            token.u.ident.atom=JS_DupAtom(ctx,token.u.ident.atom);
    }
    return token;
}
static void clear_exception(JSContext *ctx) { JS_FreeValue(ctx,JS_GetException(ctx)); }
static void error(JSParseState *s) {
    JSContext *ctx=s->ctx; JSValue e=JS_GetException(ctx);
    JSValue message=JS_GetPropertyStr(ctx,e,"message");
    JSValue line=JS_GetPropertyStr(ctx,e,"lineNumber");
    JSValue column=JS_GetPropertyStr(ctx,e,"columnNumber");
    int32_t l,c;
    if(!JS_IsString(message) || JS_IsUndefined(line) || JS_IsUndefined(column) ||
       JS_ToInt32(ctx,&l,line) || JS_ToInt32(ctx,&c,column)) die("unclassified/nonlexical exception");
    emit(1); emit(0); emit(l); emit(c); emit(UINT32_MAX); emit(0); text(message);
    JS_FreeValue(ctx,message); JS_FreeValue(ctx,line); JS_FreeValue(ctx,column); JS_FreeValue(ctx,e);
}
static void token(JSParseState *s) {
    JSToken *t=&s->token; JSContext *ctx=s->ctx;
    emit(0); emit(t->val+256); emit(t->ptr-s->buf_start); emit(s->buf_ptr-s->buf_start); emit(s->got_lf);
    if(t->val==TOK_NUMBER) {
        JSValue v=t->u.num.val;
        if(JS_IsBigInt(ctx,v)) {
            JSBigIntBuf b; JSBigInt *a=JS_ToBigIntBuf(ctx,&b,v); if(!a) die("BigInt conversion");
            int n=a->len; while(n>1 && (a->tab[n-1]==0 || a->tab[n-1]==UINT32_MAX) &&
                (a->tab[n-1]&1)==(a->tab[n-2]>>31)) n--;
            emit(2); emit(n); for(int i=0;i<n;i++) emit(a->tab[i]);
        } else {
            double d; uint64_t bits; if(JS_ToFloat64(ctx,&d,v)) die("numeric conversion");
            memcpy(&bits,&d,8); emit(1); emit(bits); emit(bits>>32);
        }
    } else if(t->val==TOK_STRING) { emit(3); emit(t->u.str.sep); text(t->u.str.str); }
    else if(t->val==TOK_TEMPLATE) {
        emit(4); emit(t->u.str.sep); text(t->u.str.str);
        JSToken cooked={.val=TOK_ERROR}; const uint8_t *end;
        int status=js_parse_string(s,'`',FALSE,t->ptr+1,&cooked,&end);
        emit(status==0);
        if(!status) { text(cooked.u.str.str); free_token(s,&cooked); }
        else clear_exception(ctx);
    } else if(t->val==TOK_REGEXP) { emit(6); text(t->u.regexp.body); text(t->u.regexp.flags); }
    else if(t->val==TOK_IDENT || t->val==TOK_PRIVATE_NAME ||
            (t->val>=TOK_FIRST_KEYWORD && t->val<=TOK_LAST_KEYWORD)) {
        emit(5); emit(t->u.ident.has_escape); emit(t->u.ident.is_reserved);
        JSValue name=JS_AtomToString(ctx,t->u.ident.atom); text(name); JS_FreeValue(ctx,name);
    } else emit(0);
}
static void scalar(unsigned operation,unsigned a,unsigned b) { emit(2); emit(operation); emit(a); emit(b); }
static int next(JSParseState *s,int json) { return json?json_next_token(s):next_token(s); }
static int action(JSParseState *s,int json,unsigned op,unsigned arg) {
    int rc=0;
    if(op==0) {
        for(unsigned i=0;i<arg;i++) {
            if(next(s,json)) { error(s); return 1; }
            token(s); if(s->token.val==TOK_EOF) return 0;
        }
        die("scanner exceeded fixture byte bound");
    } else if(op==1) { rc=next(s,json); }
    else if(op==2) { s->buf_ptr=s->token.ptr; rc=js_parse_regexp(s); if(rc) s->token.val=TOK_ERROR; }
    else if(op==3) {
        free_token(s,&s->token); s->token.val=TOK_ERROR; s->got_lf=FALSE;
        rc=js_parse_template_part(s,s->buf_ptr);
    } else if(op==4) {
        JSParsePos position; js_parse_get_pos(s,&position);
        JSToken old=duplicate(s->ctx,s->token); const uint8_t *end=s->buf_ptr; BOOL lf=s->got_lf;
        for(unsigned i=0;i<(arg&0xffff);i++) { if(next(s,json)) { rc=-1; break; } }
        if(arg&0x10000) s->cur_func->js_mode |= JS_MODE_STRICT;
        if(arg&0x20000) s->cur_func->js_mode &= ~JS_MODE_STRICT;
        if(!rc) {
            if(json) {
                s->buf_ptr=position.ptr; s->got_lf=position.got_lf; rc=json_next_token(s);
            } else rc=js_parse_seek_token(s,&position);
        }
        if(rc) { error(s); free_token(s,&old); return 1; }
        token(s);
        /* Both independently retained owners must still be readable. */
        JSParseState saved=*s; saved.token=old; saved.buf_ptr=end; saved.got_lf=lf; token(&saved);
        free_token(s,&old); return 0;
    } else if(op==5) { reparse_ident_token(s,(int)arg-1); }
    else if(op==6) { const uint8_t *p=s->buf_ptr; scalar(op,simple_next_token(&p,arg!=0)+256,0); return 0; }
    else if(op==7) {
        int bits=0; int kind=js_parse_skip_parens_token(s,&bits,arg!=0);
        scalar(op,kind+256,bits); clear_exception(s->ctx); token(s); return 0;
    } else if(op==8) {
        int col; size_t size=s->buf_end-s->buf_start; if(arg>size) arg=size;
        int line=get_line_col_cached(&s->get_line_col_cache,&col,s->buf_start+arg);
        scalar(op,line,col); return 0;
    } else if(op==9) { scalar(op,JS_DetectModule((const char *)s->buf_start,s->buf_end-s->buf_start),0); return 0; }
    else if(op==10) {
        JSParseState probe=*s; probe.token=duplicate(s->ctx,s->token);
        int status=js_parse_expect_semi(&probe); scalar(op,status==0,0);
        free_token(&probe,&probe.token); clear_exception(s->ctx); return 0;
    } else die("unknown action");
    if(rc) { error(s); return 1; } token(s); return 0;
}
int main(void) {
    JSRuntime *rt=JS_NewRuntime(); if(!rt) die("runtime OOM");
    JSContext *ctx=JS_NewContext(rt); if(!ctx) die("context OOM");
    unsigned fixtures=word(); put(fixtures);
    for(fixture=0;fixture<fixtures;fixture++) {
        unsigned flags=word(), size=word();
        uint8_t *source=calloc((size_t)size+16,1); if(!source) die("source OOM");
        if(fread(source,1,size,stdin)!=size) die("truncated source");
        JSParseState s; js_parse_init(ctx,&s,(const char *)source,size,"lexer.js");
        JSFunctionDef fd={0}, parent={0};
        fd.js_mode=(flags&1)?JS_MODE_STRICT:0;
        fd.func_kind=((flags&2)?JS_FUNC_GENERATOR:0)|((flags&4)?JS_FUNC_ASYNC:0);
        if(flags&128) { parent.func_kind=JS_FUNC_GENERATOR|JS_FUNC_ASYNC; fd.parent=&parent; fd.func_type=JS_PARSE_FUNC_ARROW; }
        if(flags&256) fd.func_type=JS_PARSE_FUNC_CLASS_STATIC_INIT;
        s.cur_func=&fd; s.is_module=(flags&8)!=0; s.allow_html_comments=(flags&16)!=0; s.ext_json=(flags&64)!=0;
        int json=(flags&32)!=0; if(!json) skip_shebang(&s.buf_ptr,s.buf_end);
        unsigned actions=word(); count=0; int failed=0;
        for(unsigned i=0;i<actions;i++) {
            unsigned op=word(),arg=word(); if(!failed) failed=action(&s,json,op,arg);
        }
        put(count); for(unsigned i=0;i<count;i++) put(output[i]); fflush(stdout);
        free_token(&s,&s.token); clear_exception(ctx); free(source);
    }
    free(output); JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
}
'''

SILK_SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.core.result { Result }
import silk.option { Option }
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
import byte_buffer { ByteBuffer, readU32 }
import js_lexer { Lexer, LexicalContext }
import js_tokens { Token, TokenPayload, LexError }
import js_tokens as tok
import js_bigint { BigIntError }
import js_atoms { AtomTable }
import js_value { ValueBits }
import js_strings { Strings }
import js_string_types { StringOwner, StringLengthError }
struct Input { data:&'static [u8], at:usize }
impl Input {
  fn word(self:&mut Self)->u32 { let n=readU32(self.data,self.at) self.at=self.at+4 return n }
  fn bytes(self:&mut Self,n:usize)->&'static [u8] { let data=Slice.view<u8>(self.data,self.at,n) self.at=self.at+n return data }
}
fn flag(value:bool)->u32 { if value { return 1 } return 0 }
effect fn text(out:&mut ByteBuffer,value:ValueBits)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(usize.toU32(Strings.length(value))) let mut i:usize=0
  while i<Strings.length(value) { run out.writeU32(u16.toU32(Strings.codeUnit(value,i))) i=i+1 }
}
effect fn token(out:&mut ByteBuffer,value:&Token)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(0) run out.writeU32(i32.toU32(value.kind+256))
  run out.writeU32(usize.toU32(value.start)) run out.writeU32(usize.toU32(value.end)) run out.writeU32(flag(value.gotLineFeed))
  match &value.payload {
    TokenPayload.Empty => { run out.writeU32(0) }
    TokenPayload.Number { value:number } => { run out.writeU32(1) run out.writeU64(f64.toBits(number)) }
    TokenPayload.BigInt { value:big } => {
      run out.writeU32(2) run out.writeU32(usize.toU32(big.length())) let mut i:usize=0
      while i<big.length() { run out.writeU32(big.limb(i)) i=i+1 }
    }
    TokenPayload.String { value:owner, separator } => { run out.writeU32(3) run out.writeU32(separator) run text(&mut out,owner.get()) }
    TokenPayload.Template { raw, cooked, separator } => {
      run out.writeU32(4) run out.writeU32(separator) run text(&mut out,raw.get())
      match &cooked {
        Option<StringOwner>.None => { run out.writeU32(0) }
        Option<StringOwner>.Some { value:owner } => { run out.writeU32(1) run text(&mut out,owner.get()) }
      }
    }
    TokenPayload.Identifier { atom:_, owner, hasEscape, isReserved } => {
      run out.writeU32(5) run out.writeU32(flag(hasEscape)) run out.writeU32(flag(isReserved)) run text(&mut out,owner.get())
    }
    TokenPayload.RegExp { body, flags } => { run out.writeU32(6) run text(&mut out,body.get()) run text(&mut out,flags.get()) }
  }
}
effect fn scalar(out:&mut ByteBuffer,op:u32,a:u32,b:u32)->() ! OutOfMemoryError ? &mut Allocator {
  run out.writeU32(2) run out.writeU32(op) run out.writeU32(a) run out.writeU32(b)
}
effect fn action<'src>(out:&mut ByteBuffer,lexer:&mut Lexer<'src>,table:&mut AtomTable,current:&mut Token,op:u32,arg:u32)->()
  ! LexError | BigIntError | OutOfMemoryError | StringLengthError ? &mut Allocator {
  if op==0 {
    let mut i:u32=0
    while i<arg {
      current.*=run lexer.next(&mut table) run token(&mut out,&current.*)
      if current.kind==tok.TOK_EOF { return () } i=i+1
    }
    fail LexError.at(lexer.offset,"scanner exceeded fixture byte bound")
  } else if op==1 { current.*=run lexer.next(&mut table) }
  else if op==2 { current.*=run lexer.rescanRegExp(&current.*) }
  else if op==3 { current.*=run lexer.continueTemplate(&current.*) }
  else if op==4 {
    let position=lexer.save(&current.*) let mut i:u32=0
    while i<(arg&0xffff) { let advanced=run lexer.next(&mut table) drop advanced i=i+1 }
    if (arg&0x10000)!=0 { lexer.context.strict=true }
    if (arg&0x20000)!=0 { lexer.context.strict=false }
    let restored=run lexer.seek(position,&mut table)
    run token(&mut out,&restored) run token(&mut out,&current.*)
    current.*=move restored return ()
  } else if op==5 {
    // Move the affine token through a replacement, never copy its owners.
    let old=Intrinsic.replace(current.*,Token.empty(tok.TOK_EOF,0,0))
    current.*=lexer.reparseIdentifier(move old,u32.toI32(arg)-1)
  } else if op==6 { run scalar(&mut out,op,i32.toU32(lexer.peek(arg!=0)+256),0) return () }
  else if op==7 {
    let result=run lexer.skipParens(&current.*,&mut table,arg!=0)
    run scalar(&mut out,op,i32.toU32(result.kind+256),result.bits) run token(&mut out,&current.*) return ()
  } else if op==8 {
    let result=lexer.location(u32.toUsize(arg))
    run scalar(&mut out,op,i32.toU32(result.line),i32.toU32(result.column)) return ()
  } else if op==9 { run scalar(&mut out,op,flag(Lexer.detectModule(lexer.sourceBytes())),0) return () }
  else if op==10 { run scalar(&mut out,op,flag(lexer.canInsertSemicolon(&current.*)),0) return () }
  run token(&mut out,&current.*)
}
effect fn operate(input:&mut Input,out:&mut ByteBuffer)->()
  ! BigIntError | OutOfMemoryError | StringLengthError ? &mut Allocator {
  let flags=input.word() let size=u32.toUsize(input.word()) let source=input.bytes(size)
  let mut context=LexicalContext.script()
  if (flags&8)!=0 { context=LexicalContext.moduleSource() }
  if (flags&32)!=0 { context=LexicalContext.jsonSource((flags&64)!=0) }
  if (flags&128)!=0 { context=context.functionContext(false,true,true,false,false) }
  context=context.functionContext((flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&128)!=0,(flags&256)!=0)
  context.allowHtmlComments=(flags&16)!=0
  let mut lexer=Lexer.make(source,context) let mut table=run AtomTable.make()
  let mut current=Token.empty(32,0,0) let count=input.word() let mut i:u32=0 let mut failed=false
  while i<count {
    let op=input.word() let arg=input.word()
    if !failed {
      let result=run Effect.result(action(&mut out,&mut lexer,&mut table,&mut current,op,arg))
      match move result {
        Result<(),LexError | BigIntError | OutOfMemoryError | StringLengthError>.Success { value } => { drop value }
        Result<(),LexError | BigIntError | OutOfMemoryError | StringLengthError>.Failure { error } => {
          match move error {
            BigIntError e => { fail move e }
            OutOfMemoryError e => { fail move e }
            StringLengthError e => { fail move e }
            LexError e => {
              failed=true let point=lexer.location(e.offset)
              run out.writeU32(1) run out.writeU32(1) run out.writeU32(i32.toU32(point.line+1)) run out.writeU32(i32.toU32(point.column+1))
              run out.writeU32(usize.toU32(e.offset)) run out.writeU32(e.detail)
              let message=Intrinsic.stringUtf8Bytes(e.message) run out.writeU32(usize.toU32(message.length)) let mut p:usize=0
              while p<message.length { run out.writeU32(u8.toU32(message[p])) p=p+1 }
            }
          }
        }
      }
    }
    i=i+1
  }
  // current drops before table; snapshots also retain their independent owners.
}
effect fn probe()->() ! BigIntError | OutOfMemoryError | StringLengthError | WriterError ? &mut Allocator | &mut Writer {
  let mut input=Input { data:FIXTURE_DATA,at:0 } let count=input.word()
  let mut header=ByteBuffer.make() run header.writeU32(count) run Writer.writeAll(header.asSlice())
  let mut out=ByteBuffer.make() let mut i:u32=0
  while i<count {
    out.clear() run operate(&mut input,&mut out) header.clear() run header.writeU32(usize.toU32(out.length()/4))
    run Writer.writeAll(header.asSlice()) run Writer.writeAll(out.asSlice()) i=i+1
  }
}
pub effect fn main()->i32 ! BigIntError | OutOfMemoryError | StringLengthError | WriterError {
  let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
  run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''

@dataclass(frozen=True)
class Case:
    label: str
    source: bytes
    flags: int = 16
    actions: tuple = ()

    def wire(self):
        actions = self.actions or ((SCAN, len(self.source) + 2),)
        return (struct.pack('<II', self.flags, len(self.source)) + self.source +
                struct.pack('<I', len(actions)) +
                b''.join(struct.pack('<II', op, arg) for op, arg in actions))


def fixtures(seed, random_cases):
    cases = []

    def add(label, source, flags=16, actions=()):
        if isinstance(source, str):
            source = source.encode()
        cases.append(Case(label, source, flags, tuple(actions)))

    contexts = {'script': 16, 'strict': 17, 'generator': 18, 'async': 20,
                'async-generator': 22, 'module': 9, 'strict-generator': 19,
                'arrow-ancestor': 144, 'static-initializer': 272}
    keywords = ('null false true if else return var this delete void typeof new in instanceof do while '
                'for break continue switch case default throw try catch finally function debugger with '
                'class const enum export extends import super implements interface let package private '
                'protected public static yield await of using async get set from as target meta arguments eval').split()
    for context, flags in contexts.items():
        add(f'keywords/{context}', ' '.join(keywords), flags)
        for name in keywords:
            escaped = '\\u%04x%s' % (ord(name[0]), name[1:])
            add(f'escaped/{context}/{name}', escaped, flags)
        for name in ('yield', 'await', 'let', '\\u0079ield', '\\u0061wait', 'ordinary'):
            add(f'reparse/{context}/{name}', name, flags,
                [(NEXT, 0)] + [(REPARSE, kind + 1) for kind in (-1, 0, 1, 2, 3, -1)])
    operators = ('+ - * / % ** ++ -- << >> >>> < <= > >= == === != !== & | ^ ! ~ && || ?? '
                 '= += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??= => ... ?. ? : ; , '
                 '( ) [ ] { } . @ \\').split()
    for op in operators:
        add(f'operator/{op}', op)
        for suffix in ('=', '.', '0', 'x'):
            add(f'operator-boundary/{op}/{suffix}', op + suffix)
    add('optional-chain/decimal', 'a?.3:0 a?.b a?...x')
    for name in ('x', '$', '_', 'café', 'π', '变量', '𐐀', 'a\u200cb', 'a\u200db', 'á',
                 '\\u0061', '\\u{10400}', '\\u{110000}', '\\uD800', '\\u0030',
                 'a\\u0020', 'a\\u00xx', 'a' * 400, '#x', '#π', '#\\u0061', '#', '#0', '#\\u0030'):
        add(f'identifier/{name[:50]}', name)
    numbers = ['0', '1', '.5', '1.', '1.e2', '1e+2', '1e-2', '0x0', '0Xff', '0o77', '0b101',
               '00', '077', '08', '09', '00.1', '08.5', '000e2', '1_000', '0xA_B', '0b1_0', '0o7_1',
               '0n', '1n', '0xffn', '0b101n', '0o777n', '1_000n', '00n', '01n', '1.0n', '1e2n',
               '0x', '0b2', '0o8', '0x_1', '1_', '1__0', '1._0', '1e_2', '1e', '1e+',
               '0_0', '0x1g', '1foo', '1π', '1\u200c', '1\\u0061', '1e309', '1e-400',
               '2.2250738585072014e-308', '5e-324', '9007199254740993', '18446744073709551615']
    for bits in (31, 32, 33, 53, 63, 64, 65, 127, 128, 255, 1024, 4096):
        for delta in (-1, 0, 1):
            n = (1 << bits) + delta
            numbers.extend((str(n) + 'n', hex(n) + 'n', bin(n) + 'n', oct(n) + 'n'))
    for number in numbers:
        for name, flags in (('script', 16), ('strict', 17)):
            add(f'number/{name}/{number[:65]}', number, flags)
    strings = [b'""', b"''", b'"a\\n\\t\\b\\f\\v\\r\\0z"', b'"\\x41\\u0042\\u{1f600}"',
               b'"\\uD800\\uDC00\\uDFFF"', b'"\\8\\9"', b'"\\123\\400"', b'"\\01"',
               b'"\\xZ0"', b'"\\u12"', b'"\\u{110000}"', b'"\\z"', b'"a\x00b"',
               b'"a\nb"', b'"a\rb"', b'"abc', b'"abc\\', b'"a\\\nb"', b'"a\\\r\nb"',
               '"a\u2028b\u2029c"'.encode(), '"a\\\u2028b"'.encode()]
    for source in strings:
        for name, flags in (('script', 16), ('strict', 17), ('json', 32), ('extended-json', 96)):
            add(f'string/{name}/{source!r}', source, flags)
    for whitespace in (' ', '\t', '\v', '\f', '\r', '\n', '\r\n', '\u00a0', '\ufeff', '\u2028', '\u2029', '\u2007'):
        source = 'a' + whitespace + 'b'
        add(f'trivia/{whitespace!r}', source, actions=[(NEXT, 0), (PEEK, 0), (PEEK, 1), (NEXT, 0), (ASI, 0)])
    for source in ('/*x*/x', '/*\n*/x', '/*\r*/x', '/*\u2028*/x', '/*', '/*a', '//x', '//x\ny',
                   '<!--x\ny', '-->x\ny', 'a --> x\ny', 'a\n-->x\ny', '#! /usr/bin/js\nx', '#!x',
                   '\ufeff#!x\ny', '/**//**/x', 'a/*\n*/b', 'a//\u2028b'):
        for name, flags in (('script', 16), ('module', 9), ('json', 32), ('extended-json', 96)):
            add(f'comment/{name}/{source!r}', source, flags)
    # Every byte at EOF, in identifier tails, strings and templates. Every prefix
    # of representative multibyte sequences makes padding/bounds observable.
    for byte in range(256):
        for prefix, suffix, domain in ((b'', b'', 'bare'), (b'a', b'', 'tail'),
                                       (b'"', b'"', 'string'), (b'`', b'`', 'template')):
            add(f'byte/{domain}/{byte:02x}', prefix + bytes([byte]) + suffix)
    sequences = [bytes.fromhex(x) for x in ('c080', 'c2a0', 'dfbf', 'e08080', 'eda080', 'efbbbf',
                                           'e280a8', 'e280a9', 'f0908080', 'f4908080', 'f888808080', 'fc8480808080')]
    for sequence in sequences:
        for n in range(1, len(sequence) + 1):
            for prefix in (b'', b'a', b'"', b'`', b'/*', b'/a'):
                source = prefix + sequence[:n]
                actions = () if prefix != b'/a' else ((NEXT, 0), (REGEXP, 0))
                add(f'utf8/{source.hex()}', source, actions=actions)
    for raw in ('', 'hello', '\\n\\t', '\\u{1f600}', '\\uD800', '\\8', '\\01', '\\xzz', '\\u{}',
                'a\rb\r\nc', 'a\\\r\nb', '\\`', '\\${x}', '\x00', '\u2028'):
        add(f'template/{raw!r}', '`' + raw + '`')
        add(f'template-continuation/{raw!r}', '`a${x}' + raw + '`',
            actions=[(NEXT, 0), (NEXT, 0), (NEXT, 0), (TEMPLATE, 0), (SNAPSHOT, 0), (NEXT, 0)])
    add('template/multiple', '`a${x}b${y}c`', actions=[(NEXT, 0)] * 3 + [(TEMPLATE, 0)] + [(NEXT, 0)] * 2 + [(TEMPLATE, 0), (NEXT, 0)])
    regexps = [b'/a/g', b'/=/uy', b'/[a/b]/g', b'/\\//', b'/[]]/', b'/a/gg', b'/a/unknown',
               '/π/π'.encode(), b'/a/\\u0067', b'/a/0_$', b'/a', b'/[a/', b'/a\\', b'/a\nb/',
               '/a\u2028b/'.encode(), b'/\xff/', b'/a/\xff', b'/a\x00b/', b'/a/;']
    for source in regexps:
        add(f'regexp/{source!r}', source, actions=[(NEXT, 0), (REGEXP, 0), (SNAPSHOT, 0), (NEXT, 0)])
    for source in ('a/b/c', 'a/=b', 'a / b / c', '/=/', '/**/x'):
        add(f'division/{source}', source)
    jsons = ['{"a":[1,-0,true,false,null]}', "{'a':.5, unquoted:+Infinity, trailing:NaN,}",
             '+1', '-1', '-0', '.5', '1.', '1e', '1e-', '01', '-01', '0x1', '-0x1', '+0o77', '0b2',
             '-Infinity', '+NaN', '-NaN', '-x', '-', '\u00a0true', 'π', 'true false null Infinity NaN',
             '"\\x41"', '"\\v"', '"\\\n"', '"\\0"', '"\\u0000"', '"\\uD800"']
    for source in jsons:
        for name, flags in (('strict', 32), ('extended', 96)):
            add(f'json/{name}/{source!r}', source, flags)
    for source in ('x y z', '\nidentifier 1 2', '"str" x y', '123n x y', 'π x y', '`a` x y'):
        add(f'snapshot/{source!r}', source, actions=[(NEXT, 0), (SNAPSHOT, 2), (NEXT, 0), (NEXT, 0)])
    for source in ('implements 1 2', '\\u0069mplements 1 2', '010 1 2', '"\\1" 1 2'):
        add(f'snapshot-mode/strict/{source!r}', source,
            actions=[(NEXT, 0), (SNAPSHOT, 0x10002)])
    add('snapshot-mode/sloppy', 'implements 1 2', 17,
        actions=[(NEXT, 0), (SNAPSHOT, 0x20002)])
    add('snapshot/regexp-raw-token', '/x/g 1',
        actions=[(NEXT, 0), (REGEXP, 0), (SNAPSHOT, 0), (NEXT, 0)])
    add('snapshot/template-continuation-raw-token', '`a${1}tail` 2',
        actions=[(NEXT, 0), (NEXT, 0), (NEXT, 0), (TEMPLATE, 0), (SNAPSHOT, 0), (NEXT, 0)])
    for source in ('x', '; x', '} x', '\nx', '/*\n*/x', ''):
        add(f'asi/{source!r}', source, actions=[(NEXT, 0), (ASI, 0)])
    for source in ('(x) =>', '(a,...b) =>', '(a=1) x', '(a;b;c) x', '(a,{b:[c]}) of',
                   '(x)\ny', '(x)\ry', '(x)\u2028y', '(x/*\n*/) y', '(/a/g) =>',
                   '(a/b) =>', '(`a${x}b`) =>', '(`a${{x:1}}b`) =>', '(x', '(]', '(...x=)',
                   '(/unterminated)', '(' * 256 + ')' * 256, '(' * 254 + ')' * 254 + '=>'):
        for no_lf in (0, 1):
            add(f'parens/{no_lf}/{source[:70]!r}', source, actions=[(NEXT, 0), (PARENS, no_lf), (NEXT, 0)])
    for source in ('export {}', 'import x from "x"', 'import("x")', 'import.meta', 'import /*x*/ ("x")',
                   'import\n.meta', 'exported', 'imported', '\\u0069mport x', '//x\nexport {}',
                   '#!x\nexport {}', '<!--x\nexport {}', '', '/*', 'async function x() {}'):
        add(f'module/{source!r}', source, actions=[(MODULE, 0), (PEEK, 0), (PEEK, 1)])
    for source in (b'', b'a\r\nb\rc\nd', 'π𐐀\u2028x\nβ'.encode(), b'a\xff\x80\xc0\x00\nb'):
        offsets = list(range(len(source) + 1)) + list(reversed(range(len(source) + 1))) + [len(source) + 3, 0]
        add(f'locations/{source!r}', source, actions=[(LOCATION, n) for n in offsets])
    rng = random.Random(seed)
    pieces = [x.encode() for x in operators + keywords] + [x.encode() for x in numbers[:65]] + strings
    for i in range(random_cases):
        source = b' '.join(rng.choice(pieces) for _ in range(rng.randrange(1, 24)))
        add(f'seeded/tokens/{i}', source, rng.choice(tuple(contexts.values())))
        raw = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40)))
        add(f'seeded/bytes/{i}', raw)
    return cases


class Reader:
    def __init__(self, words, owner):
        self.words, self.at, self.owner = words, 0, owner

    def word(self):
        if self.at >= len(self.words):
            raise SystemExit(f'{self.owner}: truncated semantic event at word {self.at}')
        n = self.words[self.at]
        self.at += 1
        return n

    def array(self):
        size = self.word()
        if size > len(self.words) - self.at:
            raise SystemExit(f'{self.owner}: truncated array at word {self.at}')
        result = tuple(self.words[self.at:self.at + size])
        self.at += size
        return result


def decode(words, owner):
    reader, events, diagnostics = Reader(words, owner), [], []
    while reader.at < len(words):
        tag = reader.word()
        if tag == 0:
            event = {'event': 'token', 'kind': reader.word() - 256,
                     'start': reader.word(), 'end': reader.word(), 'linefeed': reader.word()}
            payload = reader.word()
            event['payload'] = payload
            if payload == 1:
                event['number.bits'] = reader.word() | reader.word() << 32
            elif payload == 2:
                event['bigint.words'] = reader.array()
            elif payload in (3, 4):
                event['separator'] = reader.word()
                event['raw' if payload == 4 else 'string'] = reader.array()
                if payload == 4:
                    event['cooked.present'] = reader.word()
                    if event['cooked.present']:
                        event['cooked'] = reader.array()
            elif payload == 5:
                event['identifier.escape'] = reader.word()
                event['identifier.reserved'] = reader.word()
                event['identifier.units'] = reader.array()
            elif payload == 6:
                event['regexp.body'] = reader.array()
                event['regexp.flags'] = reader.array()
            elif payload != 0:
                raise SystemExit(f'{owner}: unknown payload {payload}')
        elif tag == 1:
            origin, line, column, offset, detail = (reader.word() for _ in range(5))
            message = ''.join(chr(x) for x in reader.array())
            diagnostics.append({'event-index': len(events), 'origin': origin, 'offset': offset,
                                'detail': detail, 'message': message})
            if origin == 1:
                if message == "Unexpected token '%c'":
                    if detail > 255:
                        raise SystemExit(f'{owner}: invalid byte error detail {detail}')
                    # C vsnprintf terminates JS's subsequent C-string at NUL.
                    message = ("Unexpected token '" + chr(detail) + "'").split('\0', 1)[0]
                elif detail:
                    raise SystemExit(f'{owner}: unrecognized structured error detail {detail}: {message!r}')
            elif origin != 0:
                raise SystemExit(f'{owner}: invalid error origin {origin}')
            event = {'event': 'error', 'message': message, 'line': line, 'column': column}
        elif tag == 2:
            event = {'event': 'scalar', 'operation': reader.word(), 'first': reader.word(), 'second': reader.word()}
        else:
            raise SystemExit(f'{owner}: unknown event {tag}')
        events.append(event)
    return events, diagnostics


def records(data, cases, owner):
    at = 0

    def take():
        nonlocal at
        if at + 4 > len(data):
            raise SystemExit(f'{owner}: truncated record header at byte {at}')
        n, = struct.unpack_from('<I', data, at)
        at += 4
        return n

    count = take()
    if count != len(cases):
        raise SystemExit(f'{owner}: fixture count {count}, expected {len(cases)}')
    result = []
    for i, case in enumerate(cases):
        size = take()
        label = f'{owner} #{i} [{case.label}]'
        if size > (len(data) - at) // 4:
            raise SystemExit(f'{label}: truncated record at byte {at}')
        result.append(decode(struct.unpack_from(f'<{size}I', data, at), label))
        at += size * 4
    if at != len(data):
        raise SystemExit(f'{owner}: unexpected trailing {len(data) - at} bytes')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--seed', type=lambda x: int(x, 0), default=0x1E7E2026)
    parser.add_argument('--random-cases', type=int, default=256)
    parser.add_argument('--timeout', type=int, default=900)
    parser.add_argument('--max-mismatches', type=int, default=25)
    args = parser.parse_args()
    if args.random_cases < 0 or args.timeout <= 0 or args.max_mismatches <= 0:
        parser.error('random-cases must be nonnegative; timeout/max-mismatches must be positive')
    manifest = tomllib.loads((ROOT / 'upstream.toml').read_text())
    if manifest['revision'] != REVISION:
        raise SystemExit(f'This oracle requires revision {REVISION}, not {manifest["revision"]}')
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    silk, cc = executable_path(args.silk), executable_path(args.cc)
    stdlib = args.stdlib.expanduser().resolve() if args.stdlib else None
    cases = fixtures(args.seed, args.random_cases)
    data = struct.pack('<I', len(cases)) + b''.join(case.wire() for case in cases)
    with tempfile.TemporaryDirectory(prefix='silkjs-lexer-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([cc, '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream),
                 str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT),
                 '-lm', '-lpthread', '-o', str(temp / 'oracle')], args.timeout, owner='C32 lexer compilation')
        print(f'Lexer oracle: {len(cases):,} fixtures, {pins} source pins, seed={args.seed:#x}', flush=True)
        oracle = process([str(temp / 'oracle')], args.timeout, owner='C32 lexer', data=data)
        expected = records(oracle, cases, 'C32 lexer')
        shutil.copytree(ROOT / 'src', temp / 'src')
        literal = 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'
        (temp / 'src/main.silk').write_text(SILK_SOURCE.replace('FIXTURE_DATA', literal))
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="lexer-differential"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [silk, 'run', '--quiet', '--release']
        if stdlib:
            command.extend(('--stdlib', str(stdlib)))
        native = process(command, args.timeout, owner='Native lexer', cwd=temp)
        observed = records(native, cases, 'Native lexer')
        failures = Counter()
        mismatches = 0
        for i, (case, (want, c_errors), (got, native_errors)) in enumerate(zip(cases, expected, observed, strict=True)):
            if want == got:
                continue
            mismatches += 1
            failures[case.label.split('/')[0]] += 1
            if mismatches > args.max_mismatches:
                continue
            print(f'MISMATCH #{i} [{case.label}] flags={case.flags:#x} source={case.source!r}')
            print(f'  actions={case.actions or "scan-to-EOF"}; fixture-sha256={hashlib.sha256(case.wire()).hexdigest()}')
            if len(want) != len(got):
                print(f'  event-count: C32={len(want)} Silk={len(got)}')
            for index in range(max(len(want), len(got))):
                a = want[index] if index < len(want) else {'missing': True}
                b = got[index] if index < len(got) else {'missing': True}
                if a != b:
                    for field in sorted(a.keys() | b.keys()):
                        if a.get(field) != b.get(field):
                            print(f'  event[{index}].{field}: C32={a.get(field)!r}; Silk={b.get(field)!r}')
                    break
            if c_errors or native_errors:
                print(f'  original errors: C32={c_errors!r}; Silk={native_errors!r}')
        if mismatches:
            raise SystemExit(f'{mismatches} lexer fixture mismatches: {dict(failures)}')
        counts = Counter(case.label.split('/')[0] for case in cases)
        print(f'PASS: {len(cases):,} independent lexer fixtures; domains={dict(counts)}; native SHA256={hashlib.sha256(native).hexdigest()}')


if __name__ == '__main__':
    main()
