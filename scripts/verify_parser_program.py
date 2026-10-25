#!/usr/bin/env python3
"""Parse/assemble complete programs in pinned original C and native Silk.

No JS is executed, no module loader is installed, and no C is linked into Silk.
Both programs construct __JS_EvalInternal roots, call the real program parser,
serialize the recursive compiler tree, then call the real function assembler.
Atoms are compared as UTF-16 names, including operands inside bytecode. Every
other byte, scope, binding, constant, template descriptor and regexp bytecode is
compared without normalization. Records carry case/function/field paths.

Run: python3 scripts/verify_parser_program.py QUICKJS
"""
import argparse
from dataclasses import dataclass
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins

ROOT = Path(__file__).resolve().parents[1]
GRAMMAR_ERRORS = 'OutOfMemoryError | StringLengthError | BigIntError | LexError | SyntaxError | ParserStackOverflow | CompilerError | JsException'
ERRORS = GRAMMAR_ERRORS + ' | BytecodeError'


@dataclass(frozen=True)
class Case:
    name: str
    source: str
    module: bool | None = False  # None exercises each implementation's autodetector.
    strict: bool = False
    async_: bool = False
    validator: int = 0  # 0 absent, 1 accept, 2 throw the observable host exception
    success: bool = True


def cases():
    rows = [
        Case('root/empty', ''),
        Case('root/shebang-html-asi', '#!/usr/bin/env js\n<!-- script\nvar x=1\nx++\n--> end\nx'),
        Case('root/directive-prologue', '"other"; "use strict"; let x=1; x'),
        Case('root/strict-flag', 'let x=1; function f(){return this} f()', strict=True),
        Case('root/async-completion', 'await Promise.resolve(1); 42', async_=True),
        Case('operators/precedence', 'let a,b,c; a=1+2*3**2<<1; b=(a&3)^2|1; c=a<b===false; a?b:c; !a; ~b; void c; typeof missing;'),
        Case('operators/assignment-family', 'let x=1; x+=2;x-=2;x*=2;x/=2;x%=2;x**=2;x<<=2;x>>=2;x>>>=2;x&=2;x^=2;x|=2;++x;x--;'),
        Case('operators/logical-optional', 'let x,o; x&&=o?.x; x||=o?.[x]; x??=o?.m?.(x); delete o?.x; (o?.m)(x);'),
        Case('operators/calls-new-eval', 'function f(){eval("var x=1"); return new.target} new f(...args); (0,eval)("1"); import("m", {with:{type:"json"}});'),
        Case('literals/array-spread-holes', 'let a=[,1,,...xs,3,]; let b=[' + ','.join(map(str, range(40))) + '];'),
        Case('literals/object-methods', 'let x=1; ({x, [x+1]:2, "a":3, 4:5, ...rest, get p(){return 1}, set p(v){x=v}, m(a){return super.m(a)}, async n(){await x}, *g(){yield x}});'),
        Case('literals/numbers-strings', '0; -0; 2147483648; 1.25; 1e300; 0xff; 0b101; 0o71; 1_234; 123456789012345678901234567890n; "a\\0b\\u{1f600}\\ud800";'),
        Case('literals/regexp', '/(?<name>a+)(b|c)\\k<name>/dgiu; /[\\p{Letter}&&[^A-Z]]/v; /x\\/y/m;'),
        Case('literals/template', '`head${1+2}middle${name}tail`; tag`a\\n${x}b\\u{1f600}`; tag`\\unicode`;'),
        Case('functions/closures', 'function outer(a){let x=2; return function middle(b){return ()=>a+b+x+arguments.length}}'),
        Case('functions/default-rest-pattern', 'function f({x,y:z=1}={},[a,...b]=[],...rest){let {q,...r}=x; return [z,a,b,rest,r]}'),
        Case('functions/arrow-cover', 'let f=({a=1},[b,...c],...r)=>({a,b,c,r}); let g=async (x=()=>1)=>await x();'),
        Case('functions/generators', 'function* g(a){yield; yield a; yield* source; return a} async function* h(){yield await p; yield* g()}'),
        Case('functions/sloppy-annex-b', 'if(x) function f(){return 1} {function g(){}} function duplicate(a,a){return a}'),
        Case('functions/parameter-eval', 'function f(a=eval("1"), b=()=>a){var x; return b()}'),
        Case('patterns/assignment', 'let a,b,c,r; ({x:a=1,y:[b,...c],...r}=source); [a,,b=2,...r]=source;'),
        Case('classes/private-static', 'class C { #x=1; static #s=2; get #p(){return this.#x} set #p(v){this.#x=v} #m(){return this.#p} static { this.z=this.#s } has(o){return #x in o} m(){return ()=>this.#m()} }'),
        Case('classes/derived-super', 'class Base{}; class Derived extends Base { constructor(...args){super(...args);this.x=1} field=super.x; [key]=2; static method(){return super.method()} }'),
        Case('classes/anonymous-names', 'let A=class { x=()=>this; }; ({[key]:class extends A {}});'),
        Case('control/branches-switch', 'if(a){b()}else if(c)d(); else e(); switch(x){case 1: x++;break;case 2: default:x--;case 3:y()}'),
        Case('control/loops-labels', 'outer: for(let i=0;i<3;i++){while(x){if(y)continue outer;break} do{x--}while(x>0)}'),
        Case('control/for-in-of', 'for(var k in obj) use(k); for(let [a,b] of xs){if(a)continue;use(b)} for(const {x} of xs)use(x);'),
        Case('control/for-await', 'async function f(){for await(const x of xs){try{if(x)break;continue}finally{await close()}}}'),
        Case('control/try-finally', 'function f(){label:for(;;){try{if(x)return 1; if(y)break label;throw 2}catch({message:m}){continue}finally{cleanup()}}}'),
        Case('control/with-debugger', 'with(obj){ debugger; name=other; }'),
        Case('resources/using', '{using x=resource; using y=other; try{use(x)}finally{use(y)}}'),
        Case('resources/await-using', 'await using resource = acquire(); for await (const item of source) { await using x = item; }', module=True),
        Case('modules/imports', 'import "side"; import def,{x as y,"z" as z} from "a"; import * as ns from "b"; export {def,y as renamed,z,ns};', module=True),
        Case('modules/reexports', 'export * from "a"; export * as ns from "b"; export {x as y,z as "not-an-ident"} from "c";', module=True),
        Case('errors/string-local-reexport', 'export {"z" as name} from "c";', module=True, success=False),
        Case('modules/declarations', 'export let x=1; export const y=2; export function f(){return x} export class C{}; export default async function(){await y}', module=True),
        Case('modules/default-expression', 'export default {x:1}; import.meta.url; await task;', module=True),
        Case('modules/default-class', 'export default class extends Base {static { let x=1 }}', module=True),
        Case('attributes/accepted', 'import data from "data" with {type:"json", "mode":"strict",}; export {x} from "other" with {type:"json"};', module=True, validator=1),
        Case('attributes/empty-suppressed', 'import "data" with {}; export * from "other" with {};', module=True, validator=2),
        Case('attributes/rejected-at-close', 'import data from "data" with {type:"json"}; let unreachable=1;', module=True, validator=2, success=False),
        Case('attributes/rejection-before-close-check', 'import "data" with {type:"json" unexpected}', module=True, validator=2, success=False),
    ]
    failures = [
        ('strict/duplicate-parameter', '"use strict"; function f(a,a){}', False),
        ('strict/non-simple-directive', 'function f(a=1){"use strict";}', False),
        ('strict/with', '"use strict"; with(o){}', False),
        ('strict/delete-binding', '"use strict"; delete x;', False),
        ('strict/eval-binding', '"use strict"; let eval;', False),
        ('binding/lexical-collision', 'let x; let x;', False),
        ('binding/const-initializer', 'const x;', False),
        ('binding/rest-not-last', 'let [a,...b,c]=x;', False),
        ('binding/rest-default', 'function f(...x=[]){}', False),
        ('binding/invalid-shorthand', '({a=1});', False),
        ('operators/optional-assignment', 'o?.x=1;', False),
        ('operators/nullish-mixing', 'a??b||c;', False),
        ('operators/unary-exponent', '-2**2;', False),
        ('operators/new-optional', 'new o?.m();', False),
        ('control/top-return', 'return 1;', False),
        ('control/orphan-break', 'break;', False),
        ('control/continue-nonloop', 'label:{continue label;}', False),
        ('control/duplicate-label', 'label:label:while(1)break;', False),
        ('control/newline-throw', 'throw\n1;', False),
        ('control/duplicate-default', 'switch(x){default:;default:;}', False),
        ('control/for-await-sync', 'function f(){for await(x of xs){}}', False),
        ('functions/await-parameter', 'async function f(a=await x){}', False),
        ('functions/yield-parameter', 'function* f(a=yield 1){}', False),
        ('functions/arrow-newline', '(x)\n=>x', False),
        ('classes/duplicate-private', 'class C{#x;#x;}', False),
        ('classes/private-undeclared', 'class C{m(){return this.#missing}}', False),
        ('classes/duplicate-constructor', 'class C{constructor(){}constructor(){}}', False),
        ('classes/static-prototype', 'class C{static prototype(){}}', False),
        ('classes/static-return', 'class C{static{return 1}}', False),
        ('classes/static-await', 'class C{static{await x}}', False),
        ('classes/static-arguments', 'class C{static{arguments}}', False),
        ('classes/private-delete', 'class C{#x;m(){delete this.#x}}', False),
        ('classes/base-super-call', 'class C{constructor(){super()}}', False),
        ('modules/import-in-script', 'import x from "m";', False),
        ('modules/export-in-block', '{export let x=1;}', True),
        ('modules/duplicate-export', 'let x;export{x};export{x};', True),
        ('modules/missing-export', 'export {missing};', True),
        ('modules/unpaired-name', 'import {"\\ud800" as x} from "m";', True),
        ('attributes/duplicate', 'import "m" with {type:"json",type:"json"};', True),
        ('attributes/nonstring', 'import "m" with {type:1};', True),
        ('modules/html-comment', '<!-- forbidden\nexport {};', True),
        ('regexp/invalid', '/(/;', False),
        ('template/unclosed-unwind', 'function f(){tag`a${class C{#x=1}}', False),
        ('resources/missing-initializer', '{using x;}', False),
    ]
    rows += [Case('reject/' + name, source, module=module, success=False) for name, source, module in failures]
    # Explicit parser/assembler boundaries: scope table inline overflow, array
    # literal fast-path cutoff, and argument bytecode's one/two-byte transition.
    for count in (3, 4, 5, 31, 32, 33):
        rows.append(Case(f'boundary/scopes-{count}', '{let x=0;' * count + 'x;' + '}' * count))
    for count in (255, 256):
        rows.append(Case(f'boundary/arguments-{count}', 'function f(' + ','.join(f'a{i}' for i in range(count)) + '){return a0+a' + str(count-1) + '}'))
    return rows


def literal(data):
    if isinstance(data, str):
        data = data.encode()
    return 'b"' + ''.join(f'\\x{x:02x}' for x in data) + '"'


# This schema declares correspondence of stored fields only. It never computes
# expected compiler results; those come exclusively from the original C calls.
IR_FIELDS = [
    ('parentConstantPoolIndex', 'parent_cpool_idx', 'i'), ('parentScopeLevel', 'parent_scope_level', 'i'),
    *[(a, b, 'b') for a, b in (
        ('isEval','is_eval'),('isGlobalVar','is_global_var'),('isFuncExpr','is_func_expr'),
        ('hasHomeObject','has_home_object'),('hasPrototype','has_prototype'),('hasSimpleParameterList','has_simple_parameter_list'),
        ('hasParameterExpressions','has_parameter_expressions'),('hasUseStrict','has_use_strict'),('hasEvalCall','has_eval_call'),
        ('hasArgumentsBinding','has_arguments_binding'),('hasThisBinding','has_this_binding'),('newTargetAllowed','new_target_allowed'),
        ('superCallAllowed','super_call_allowed'),('superAllowed','super_allowed'),('argumentsAllowed','arguments_allowed'),
        ('isDerivedClassConstructor','is_derived_class_constructor'),('inFunctionBody','in_function_body'),('needHomeObject','need_home_object'),
        ('useShortOpcodes','use_short_opcodes'),('stripDebug','strip_debug'),('stripSource','strip_source'),('hasAwait','has_await'))],
    ('evalType','eval_type','i'), ('functionKind','func_kind','functionKind'), ('functionType','func_type','parseKind'),
    ('jsMode','js_mode','u8'), ('functionName','func_name','atom'), ('filename','filename','atom'), ('sourcePosition','source_pos','u32'),
    *[(a,b,'i') for a,b in (
        ('definedArgCount','defined_arg_count'),('varRefCount','var_ref_count'),('varObjectIndex','var_object_idx'),
        ('argVarObjectIndex','arg_var_object_idx'),('argumentsVarIndex','arguments_var_idx'),('argumentsArgIndex','arguments_arg_idx'),
        ('functionVarIndex','func_var_idx'),('evalReturnIndex','eval_ret_idx'),('thisVarIndex','this_var_idx'),
        ('newTargetVarIndex','new_target_var_idx'),('thisActiveFunctionVarIndex','this_active_func_var_idx'),('homeObjectVarIndex','home_object_var_idx'),
        ('scopeLevel','scope_level'),('scopeFirst','scope_first'),('bodyScope','body_scope'),('lastOpcodePosition','last_opcode_pos'))],
]
VAR_FIELDS = [('name','var_name','atom'), ('scopeLevel','scope_level','i'), ('scopeNext','scope_next','i'),
              ('isConst','is_const','b'), ('isLexical','is_lexical','b'), ('isCaptured','is_captured','b'),
              ('isStaticPrivate','is_static_private','b'), ('kind','var_kind','variableKind'),
              ('varRefIndex','var_ref_idx','u16'), ('functionPoolIndex','func_pool_idx','i')]
CLOSURE_FIELDS = [('name','var_name','atom'),('kind','closure_type','closureKind'),('variableIndex','var_idx','u16'),
                  ('isConst','is_const','b'),('isLexical','is_lexical','b'),('variableKind','var_kind','variableKind')]
GLOBAL_FIELDS = [('name','var_name','atom'),('constantPoolIndex','cpool_idx','i'),('forceInit','force_init','b'),
                 ('isLexical','is_lexical','b'),('isConst','is_const','b'),('scopeLevel','scope_level','i')]
FINAL_FIELDS = [('name','func_name','atom'),('mode','js_mode','u8'),('hasPrototype','has_prototype','b'),
                ('hasSimpleParameterList','has_simple_parameter_list','b'),('isDerivedClassConstructor','is_derived_class_constructor','b'),
                ('needsHomeObject','need_home_object','b'),('kind','func_kind','functionKind'),('newTargetAllowed','new_target_allowed','b'),
                ('superCallAllowed','super_call_allowed','b'),('superAllowed','super_allowed','b'),('argumentsAllowed','arguments_allowed','b'),
                ('isDirectOrIndirectEval','is_direct_or_indirect_eval','b'),
                ('readOnlyBytecode','read_only_bytecode','b'),
                *[(a,b,'u16') for a,b in (('argumentCount','arg_count'),('variableCount','var_count'),
                 ('definedArgumentCount','defined_arg_count'),('varRefCount','var_ref_count'),('stackSize','stack_size'))]]
FINAL_VAR_FIELDS = [field for field in VAR_FIELDS if field[0] not in ('scopeLevel','isStaticPrivate','functionPoolIndex')] + [('hasScope','has_scope','b')]


def fields(schema, cvar, svar):
    c, s = [], []
    for native, original, kind in schema:
        cv, sv = f'{cvar}->{original}', f'{svar}.{native}'
        if kind == 'atom':
            c.append(f'atom(ctx,"{native}",{cv});')
            s.append(f'run atom(&mut out,rt,b"{native}",{sv})')
        else:
            expression = sv if kind == 'u32' else f'bits({sv})' if kind == 'i' else f'flag({sv})' if kind == 'b' else f'{kind}.toU32({sv})' if kind in ('u8','u16') else f'{kind}({sv})'
            c.append(f'field("{native}",{cv});')
            s.append(f'run field(&mut out,b"{native}",{expression})')
    return '\n'.join(c), '\n'.join(s)


C_BASE = r'''
#include "quickjs.c"
#if JS_LIMB_BITS != 32
#error oracle requires pinned 32-bit bigint limbs
#endif
static void word(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static void name(const char *s){word(strlen(s));while(*s)word((unsigned char)*s++);}
static void begin(const char *s){word(0);name(s);}
static void end(void){word(1);}
static void header(const char *s,unsigned n){word(2);name(s);word(n);}
static void field(const char *s,uint32_t n){header(s,1);word(n);}
static void bytes(const char *s,const uint8_t *p,size_t n){header(s,n);for(size_t i=0;i<n;i++)word(p[i]);}
static void string(const char *name,JSValueConst value){
 if(!JS_IsString(value))abort();JSString *s=JS_VALUE_GET_STRING(value);
 header(name,s->len);for(int i=0;i<s->len;i++)word(string_get(s,i));
}
static void atom(JSContext *ctx,const char *name,JSAtom a){
 begin(name);field("present",a!=0);if(a){JSValue text=JS_AtomToString(ctx,a);string("text",text);JS_FreeValue(ctx,text);}end();
}
static void final(JSContext *ctx,JSFunctionBytecode *b);
static void value(JSContext *ctx,JSValueConst v){
 int tag=JS_VALUE_GET_TAG(v);field("tag",tag);
 switch(tag){
 case JS_TAG_INT:case JS_TAG_BOOL:case JS_TAG_SHORT_BIG_INT:field("payload",JS_VALUE_GET_INT(v));break;
 case JS_TAG_FLOAT64:{union{double d;uint64_t u;}x={.d=JS_VALUE_GET_FLOAT64(v)};header("bits",2);word(x.u);word(x.u>>32);break;}
 case JS_TAG_STRING:string("utf16",v);break;
 case JS_TAG_BIG_INT:{JSBigInt *p=JS_VALUE_GET_PTR(v);header("limbs",p->len);for(unsigned i=0;i<p->len;i++)word(p->tab[i]);break;}
 case JS_TAG_FUNCTION_BYTECODE:begin("function");final(ctx,JS_VALUE_GET_PTR(v));end();break;
 case JS_TAG_OBJECT:{JSObject *o=JS_VALUE_GET_OBJ(v);JSShape *sh=o->shape;
  field("class",o->class_id);field("extensible",o->extensible);field("fastArray",o->fast_array);
  field("prototype",sh->proto==NULL?0:sh->proto==JS_VALUE_GET_OBJ(ctx->class_proto[JS_CLASS_ARRAY])?2:sh->proto==JS_VALUE_GET_OBJ(ctx->class_proto[JS_CLASS_OBJECT])?1:3);
  field("properties",sh->prop_count);
  JSShapeProperty *p=get_shape_prop(sh);
  for(int i=0;i<sh->prop_count;i++){begin("property");atom(ctx,"name",p[i].atom);field("flags",p[i].flags);
   if(p[i].atom){if(p[i].flags&JS_PROP_TMASK)abort();value(ctx,o->prop[i].u.value);}end();}
  if(o->fast_array){header("elements",1);word(o->u.array.count);for(unsigned i=0;i<o->u.array.count;i++){begin("element");value(ctx,o->u.array.u.values[i]);end();}}
  break;}
 case JS_TAG_NULL:case JS_TAG_UNDEFINED:case JS_TAG_UNINITIALIZED:break;
 default:fprintf(stderr,"unsupported constant tag %d\n",tag);abort();
 }
}
static void code(JSContext *ctx,const uint8_t *data,size_t length,int short_ops){
 field("byteLength",length);size_t pc=0;
 while(pc<length){unsigned op=data[pc];const JSOpCode *info=short_ops?&short_opcode_info(op):&opcode_info[op];
  if(!info->size||pc+info->size>length)abort();begin("instruction");field("pc",pc);field("opcode",op);
  unsigned first=1;if(info->fmt>=OP_FMT_atom&&info->fmt<=OP_FMT_atom_label_u16){atom(ctx,"atom",get_u32(data+pc+1));first=5;}
  bytes("operands",data+pc+first,info->size-first);end();pc+=info->size;
 }
}
static void module(JSContext *ctx,JSModuleDef *m){
 atom(ctx,"name",m->module_name);field("topLevelAwait",m->has_tla);
 field("requestedCount",m->req_module_entries_count);
 for(int i=0;i<m->req_module_entries_count;i++){begin("requested");atom(ctx,"name",m->req_module_entries[i].module_name);begin("attributes");value(ctx,m->req_module_entries[i].attributes);end();end();}
 field("exportCount",m->export_entries_count);
 for(int i=0;i<m->export_entries_count;i++){JSExportEntry *e=&m->export_entries[i];begin("export");atom(ctx,"local",e->local_name);atom(ctx,"exported",e->export_name);field("kind",e->export_type);field("index",e->export_type==JS_EXPORT_TYPE_LOCAL?e->u.local.var_idx:e->u.req_module_idx);end();}
 field("starCount",m->star_export_entries_count);for(int i=0;i<m->star_export_entries_count;i++){begin("star");field("index",m->star_export_entries[i].req_module_idx);end();}
 field("importCount",m->import_entries_count);for(int i=0;i<m->import_entries_count;i++){JSImportEntry *e=&m->import_entries[i];begin("import");atom(ctx,"name",e->import_name);field("variable",e->var_idx);field("star",e->is_star);field("requested",e->req_module_idx);end();}
}
static void diagnostic(JSContext *ctx){
 JSValue error=JS_GetException(ctx);
 if(JS_VALUE_GET_TAG(error)==JS_TAG_INT){field("hostException",JS_VALUE_GET_INT(error));JS_FreeValue(ctx,error);return;}
 JSValue message=JS_GetPropertyStr(ctx,error,"message"),line=JS_GetPropertyStr(ctx,error,"lineNumber"),column=JS_GetPropertyStr(ctx,error,"columnNumber");
 string("message",message);int32_t l=0,c=0;if(!JS_IsUndefined(line))JS_ToInt32(ctx,&l,line);if(!JS_IsUndefined(column))JS_ToInt32(ctx,&c,column);
 field("line",l);field("column",c);JS_FreeValue(ctx,message);JS_FreeValue(ctx,line);JS_FreeValue(ctx,column);JS_FreeValue(ctx,error);
}
static struct {int reject,calls,count,null_proto,strings,dispatch;uint8_t marker;} hooks;
static int validate(JSContext *ctx,void *opaque,JSValueConst attrs){
 hooks.calls++;hooks.dispatch&=opaque==&hooks.marker&&*(uint8_t*)opaque==90;
 JSObject *p=JS_VALUE_GET_OBJ(attrs);hooks.null_proto&=p->shape->proto==NULL;JSShapeProperty *sp=get_shape_prop(p->shape);
 for(int i=0;i<p->shape->prop_count;i++)if(sp[i].atom){hooks.count++;JSValue v=p->prop[i].u.value;hooks.strings&=JS_IsString(v)&&JS_VALUE_GET_STRING(v)->len>0;}
 if(hooks.reject){JS_Throw(ctx,JS_NewInt32(ctx,90210));return -1;}return 0;
}
'''

S_BASE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.option { Option }
import silk.pointer { Pointer }
import silk.result { Result }
import silk.u8
import silk.u16
import silk.u32
import silk.u64
import silk.i32
import silk.i64
import silk.usize
import silk.f64
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_heap { HeapCell, HeapHeader }
import js_core_types { RuntimeState, ContextState, FunctionKind, VariableKind, ClosureKind, ObjectData,
  ObjectPayload, ShapeData, PropertySlot, FunctionBytecode, ByteStorage, FunctionDebugInfo, ModuleDef, ExportBinding }
import js_compiler_types { FunctionDef, ParseFunctionKind, CompilerError, CompilerErrorKind }
import js_compiler_state as state
import js_compiler_finish { createFunction }
import js_bytecode { BytecodeError }
import js_opcode_data as op
import js_gc as gc
import js_runtime as runtime
import js_parser_core { Parser, ParserStackOverflow }
import js_lexer { Lexer }
import js_parser_program { parseProgram }
import js_exceptions { JsException }
import js_parser_diagnostics { SyntaxError }
import js_parser_program_test_support as fixture
import js_parser_program_test_support { Hooks, trap, reference }
import js_tokens { LexError }
import js_bigint { BigInt, BigIntError }
import js_strings { Strings }
import js_string_types { StringOwner, StringLengthError }
import js_value { Value }
import js_class_data as classes
import js_debug_positions { SourcePositionCache }
import runtime_memory { RuntimeAllocator, AllocationObserver }
import native_stack { currentFrameAddress }
fn bits(n:i32)->u32 { let mut v=i32.toI64(n) if v<0 {v=v+4294967296} return i64.toU32(v) }
fn flag(b:bool)->u32 {if b{return 1}return 0}
fn functionKind(k:FunctionKind)->u32 {return match k {FunctionKind.Normal=>0 FunctionKind.Generator=>1 FunctionKind.Async=>2 FunctionKind.AsyncGenerator=>3}}
fn parseKind(k:ParseFunctionKind)->u32 {return match k {ParseFunctionKind.Statement=>0 ParseFunctionKind.Var=>1 ParseFunctionKind.Expression=>2 ParseFunctionKind.Arrow=>3 ParseFunctionKind.Getter=>4 ParseFunctionKind.Setter=>5 ParseFunctionKind.Method=>6 ParseFunctionKind.ClassStaticInit=>7 ParseFunctionKind.ClassConstructor=>8 ParseFunctionKind.DerivedClassConstructor=>9}}
fn closureKind(k:ClosureKind)->u32 {return match k {ClosureKind.Local=>0 ClosureKind.Argument=>1 ClosureKind.Reference=>2 ClosureKind.GlobalReference=>3 ClosureKind.GlobalDeclaration=>4 ClosureKind.Global=>5 ClosureKind.ModuleDeclaration=>6 ClosureKind.ModuleImport=>7}}
fn variableKind(k:VariableKind)->u32 {return match k {VariableKind.Normal=>0 VariableKind.FunctionDeclaration=>1 VariableKind.NewFunctionDeclaration=>2 VariableKind.Catch=>3 VariableKind.FunctionName=>4 VariableKind.PrivateField=>5 VariableKind.PrivateMethod=>6 VariableKind.PrivateGetter=>7 VariableKind.PrivateSetter=>8 VariableKind.PrivateGetterSetter=>9 VariableKind.GlobalFunctionDeclaration=>10 VariableKind.Using=>11 VariableKind.UsingMethod=>12}}
fn present(p:?*mut HeapHeader)->*mut HeapHeader {return unsafe Intrinsic.pointerRequalify<?*mut HeapHeader,*mut HeapHeader>(p)}
effect fn name(out:&mut ByteBuffer,s:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
 run out.writeU32(usize.toU32(s.length)) let mut i:usize=0 while i<s.length {run out.writeU32(u8.toU32(s[i])) i=i+1}
}
effect fn begin(out:&mut ByteBuffer,s:&[u8])->() ! OutOfMemoryError ? &mut Allocator {run out.writeU32(0) run name(&mut out,s)}
effect fn end(out:&mut ByteBuffer)->() ! OutOfMemoryError ? &mut Allocator {run out.writeU32(1)}
effect fn header(out:&mut ByteBuffer,s:&[u8],n:usize)->() ! OutOfMemoryError ? &mut Allocator {run out.writeU32(2) run name(&mut out,s) run out.writeU32(usize.toU32(n))}
effect fn field(out:&mut ByteBuffer,s:&[u8],n:u32)->() ! OutOfMemoryError ? &mut Allocator {run header(&mut out,s,1) run out.writeU32(n)}
effect fn bytes(out:&mut ByteBuffer,s:&[u8],data:&[u8])->() ! OutOfMemoryError ? &mut Allocator {
 run header(&mut out,s,data.length) let mut i:usize=0 while i<data.length {run out.writeU32(u8.toU32(data[i])) i=i+1}
}
effect fn string(out:&mut ByteBuffer,s:&[u8],value:Value)->() ! OutOfMemoryError ? &mut Allocator {
 if !value.isString(){trap()} run header(&mut out,s,Strings.length(value)) let mut i:usize=0
 while i<Strings.length(value){run out.writeU32(u16.toU32(Strings.codeUnit(value,i))) i=i+1}
}
effect fn atom(out:&mut ByteBuffer,rt:*mut HeapHeader,s:&[u8],a:u32)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 run begin(&mut out,s) run field(&mut out,b"present",flag(a!=0))
 if a!=0 {let anchor=() let table=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  let text=run table.atoms.toValue(a,true) drop table run string(&mut out,b"text",text)
  let mut hooks=Hooks.make(false) unsafe gc.release(&mut hooks,rt,text)}
 run end(&mut out)
}
effect fn value(out:&mut ByteBuffer,rt:*mut HeapHeader,ctx:*mut HeapHeader,v:Value)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 run field(&mut out,b"tag",bits(v.tag()))
 match v {
  Value.Int {value:n}=>{run field(&mut out,b"payload",bits(n))}
  Value.Bool {value:b}=>{run field(&mut out,b"payload",flag(b))}
  Value.ShortBigInt {value:n}=>{run field(&mut out,b"payload",bits(n))}
  Value.Float64 {value:n}=>{let v=f64.toBits(n) run header(&mut out,b"bits",2) run out.writeU32(u64.toU32(v&0xffffffff)) run out.writeU32(u64.toU32(u64.shiftRight(v,32)))}
  Value.String {..}=>{run string(&mut out,b"utf16",v)}
  Value.BigInt {reference:p}=>{let anchor=() let n=unsafe HeapCell.payload<BigInt,()>(&anchor,p) run header(&mut out,b"limbs",n.length()) let mut i:usize=0 while i<n.length(){run out.writeU32(n.limbs()[i]) i=i+1}}
  Value.FunctionBytecode {reference:p}=>{run begin(&mut out,b"function") run final(&mut out,rt,ctx,p) run end(&mut out)}
  Value.Object {reference:p}=>{
   let anchor=() let o=unsafe HeapCell.payload<ObjectData,()>(&anchor,p) let sh=unsafe HeapCell.payload<ShapeData,()>(&anchor,o.shape)
   run field(&mut out,b"class",o.classId) run field(&mut out,b"extensible",flag(o.extensible)) run field(&mut out,b"fastArray",flag(o.fastArray))
   let mut prototype:u32=0
   if !Pointer.isNull<HeapHeader>(sh.prototype){
    let context=unsafe HeapCell.payload<ContextState,()>(&anchor,ctx)
    if Pointer.address<HeapHeader>(sh.prototype)==Pointer.address<HeapHeader>(reference(context.classPrototypes.get(u32.toUsize(classes.JS_CLASS_ARRAY)))){prototype=2}
    else if Pointer.address<HeapHeader>(sh.prototype)==Pointer.address<HeapHeader>(reference(context.classPrototypes.get(u32.toUsize(classes.JS_CLASS_OBJECT)))){prototype=1}else{prototype=3}
   }
   run field(&mut out,b"prototype",prototype) run field(&mut out,b"properties",usize.toU32(sh.properties.length()))
   let mut i:usize=0 while i<sh.properties.length(){let prop=sh.properties.get(i)
    run begin(&mut out,b"property") run atom(&mut out,rt,b"name",prop.atom) run field(&mut out,b"flags",u8.toU32(prop.flags))
    if prop.atom!=0 {match o.properties.get(i){PropertySlot.Value {value:item}=>{run value(&mut out,rt,ctx,item)} _=>trap()}}
    run end(&mut out) i=i+1
   }
   if o.fastArray {match &o.payload {ObjectPayload.FastArray {array}=>{
    run field(&mut out,b"elements",usize.toU32(array.values.length())) i=0
    while i<array.values.length(){run begin(&mut out,b"element") run value(&mut out,rt,ctx,array.values.get(i)) run end(&mut out) i=i+1}
   } _=>trap()}}
  }
  Value.Null=>() Value.Undefined=>() Value.Uninitialized=>() _=>trap()
 }
}
effect fn code(out:&mut ByteBuffer,rt:*mut HeapHeader,data:&ByteStorage,short:bool)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 run field(&mut out,b"byteLength",usize.toU32(data.length())) let mut pc:usize=0
 while pc<data.length(){let opcode=unsafe data.byte(pc) let info=op.opcodeInfo(opcode,short) let size=u8.toUsize(info.size)
  if size==0||pc+size>data.length(){trap()} run begin(&mut out,b"instruction") run field(&mut out,b"pc",usize.toU32(pc)) run field(&mut out,b"opcode",u8.toU32(opcode))
  let mut first:usize=1
  if info.format>=op.OP_FMT_atom&&info.format<=op.OP_FMT_atom_label_u16 {
   let a=u8.toU32(unsafe data.byte(pc+1))|u32.shiftLeft(u8.toU32(unsafe data.byte(pc+2)),8)|u32.shiftLeft(u8.toU32(unsafe data.byte(pc+3)),16)|u32.shiftLeft(u8.toU32(unsafe data.byte(pc+4)),24)
   run atom(&mut out,rt,b"atom",a) first=5
  }
  run header(&mut out,b"operands",size-first) let mut i=first while i<size{run out.writeU32(u8.toU32(unsafe data.byte(pc+i))) i=i+1}
  run end(&mut out) pc=pc+size
 }
}
effect fn module(out:&mut ByteBuffer,rt:*mut HeapHeader,ctx:*mut HeapHeader,cell:*mut HeapHeader)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {
 let anchor=() let m=unsafe HeapCell.payload<ModuleDef,()>(&anchor,cell)
 run atom(&mut out,rt,b"name",m.name) run field(&mut out,b"topLevelAwait",flag(m.hasTopLevelAwait))
 run field(&mut out,b"requestedCount",usize.toU32(m.requestedModules.length())) let mut i:usize=0
 while i<m.requestedModules.length(){let e=&m.requestedModules.asSlice()[i] run begin(&mut out,b"requested") run atom(&mut out,rt,b"name",e.name)
  run begin(&mut out,b"attributes") run value(&mut out,rt,ctx,e.attributes) run end(&mut out) run end(&mut out) i=i+1}
 run field(&mut out,b"exportCount",usize.toU32(m.exports.length())) i=0
 while i<m.exports.length(){let e=m.exports.get(i) run begin(&mut out,b"export") run atom(&mut out,rt,b"local",e.localName) run atom(&mut out,rt,b"exported",e.exportName)
  match e.binding {ExportBinding.Local {variableIndex,..}=>{run field(&mut out,b"kind",0) run field(&mut out,b"index",bits(variableIndex))}
   ExportBinding.Indirect {requestedModuleIndex}=>{run field(&mut out,b"kind",1) run field(&mut out,b"index",bits(requestedModuleIndex))}}
  run end(&mut out) i=i+1}
 run field(&mut out,b"starCount",usize.toU32(m.starExports.length())) i=0
 while i<m.starExports.length(){run begin(&mut out,b"star") run field(&mut out,b"index",bits(m.starExports.get(i).requestedModuleIndex)) run end(&mut out) i=i+1}
 run field(&mut out,b"importCount",usize.toU32(m.imports.length())) i=0
 while i<m.imports.length(){let e=m.imports.get(i) run begin(&mut out,b"import") run atom(&mut out,rt,b"name",e.importName)
  run field(&mut out,b"variable",bits(e.variableIndex)) run field(&mut out,b"star",flag(e.isStar)) run field(&mut out,b"requested",bits(e.requestedModuleIndex)) run end(&mut out) i=i+1}
}
effect fn syntax(out:&mut ByteBuffer,error:SyntaxError)->() ! OutOfMemoryError ? &mut Allocator {
 run string(&mut out,b"message",error.message.get()) run field(&mut out,b"line",bits(error.location.line)) run field(&mut out,b"column",bits(error.location.column))
}
'''


def serializers():
    c, s = [], []

    def stored_loop(label, schema, ctype, carray, ccount, sarray):
        cf, sf = fields(schema, 'v', 'v')
        return (
            f'field("{label}Count",{ccount});for(int i=0;i<{ccount};i++){{begin("{label}");{ctype} *v=&{carray}[i];{cf}end();}}',
            f'run field(&mut out,b"{label}Count",usize.toU32({sarray}.length())) i=0\n'
            f'while i<{sarray}.length(){{run begin(&mut out,b"{label}") let v={sarray}.get(i)\n{sf}\nrun end(&mut out) i=i+1}}')

    cf, sf = fields(IR_FIELDS, 'fd', 'fd')
    c.append('static void ir(JSContext *ctx,JSFunctionDef *fd){' + cf)
    s.append('effect fn ir(out:&mut ByteBuffer,rt:*mut HeapHeader,ctx:*mut HeapHeader,cell:*mut HeapHeader)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {\nlet anchor=() let fd=unsafe HeapCell.payload<FunctionDef,()>(&anchor,cell) let mut i:usize=0\n' + sf)
    for args in [
        ('argument', VAR_FIELDS, 'JSVarDef', 'fd->args', 'fd->arg_count', 'fd.args'),
        ('variable', VAR_FIELDS, 'JSVarDef', 'fd->vars', 'fd->var_count', 'fd.vars'),
        ('closure', CLOSURE_FIELDS, 'JSClosureVar', 'fd->closure_var', 'fd->closure_var_count', 'fd.closureVars'),
        ('global', GLOBAL_FIELDS, 'JSGlobalVar', 'fd->global_vars', 'fd->global_var_count', 'fd.globalVars'),
        ('scope', [('parent','parent','i'),('first','first','i')], 'JSVarScope', 'fd->scopes', 'fd->scope_count', 'fd.scopes'),
        ('label', [('referenceCount','ref_count','i'),('position','pos','i'),('position2','pos2','i'),('address','addr','i')],
         'LabelSlot', 'fd->label_slots', 'fd->label_count', 'fd.labels'),
        ('jump', [('opcode','op','i'),('size','size','i'),('position','pos','i'),('label','label','i')],
         'JumpSlot', 'fd->jump_slots', 'fd->jump_count', 'fd.jumps'),
        ('line', [('pc','pc','u32'),('sourcePosition','source_pos','u32')],
         'LineNumberSlot', 'fd->line_number_slots', 'fd->line_number_count', 'fd.lineNumbers'),
    ]:
        a, b = stored_loop(*args)
        c.append(a)
        s.append(b)
    c.append(r'''
 field("lastOpcodeSourcePosition",fd->last_opcode_source_ptr-fd->get_line_col_cache->buf_start);
 field("lineNumberLast",fd->line_number_last);field("lineNumberLastPc",fd->line_number_last_pc);
 field("activeBreak",fd->top_break!=NULL);
 bytes("source",(const uint8_t*)fd->source,fd->source_len);bytes("pcToLine",fd->pc2line.buf,fd->pc2line.size);
 begin("code");code(ctx,fd->byte_code.buf,fd->byte_code.size,fd->use_short_opcodes);end();
 field("constantCount",fd->cpool_count);for(int i=0;i<fd->cpool_count;i++){begin("constant");value(ctx,fd->cpool[i]);end();}
 struct list_head *el;int n=0;list_for_each(el,&fd->child_list)n++;field("childCount",n);
 list_for_each(el,&fd->child_list){begin("child");ir(ctx,list_entry(el,JSFunctionDef,link));end();}
}
''')
    s.append(r'''
 run field(&mut out,b"lastOpcodeSourcePosition",fd.lastOpcodeSourcePosition)
 run field(&mut out,b"lineNumberLast",fd.lineNumberLast) run field(&mut out,b"lineNumberLastPc",fd.lineNumberLastPc)
 run field(&mut out,b"activeBreak",flag(fd.topBreak>=0))
 run bytes(&mut out,b"source",fd.source.asSlice()) run bytes(&mut out,b"pcToLine",fd.pc2line.asSlice())
 run begin(&mut out,b"code")
 if fd.bytecode.length()==0 {run field(&mut out,b"byteLength",0)}
 else {let storage=ByteStorage.Borrowed {data:Pointer.fromRef<u8>(&fd.bytecode.asSlice()[0]),length:fd.bytecode.length()} run code(&mut out,rt,&storage,fd.useShortOpcodes)}
 run end(&mut out)
 run field(&mut out,b"constantCount",usize.toU32(fd.constants.length())) i=0
 while i<fd.constants.length(){run begin(&mut out,b"constant") run value(&mut out,rt,ctx,fd.constants.get(i)) run end(&mut out) i=i+1}
 let mut child=fd.firstChild let mut count:u32=0
 while !Pointer.isNull<HeapHeader>(child){let nested=unsafe HeapCell.payload<FunctionDef,()>(&anchor,present(child)) count=count+1 child=nested.nextSibling}
 run field(&mut out,b"childCount",count) child=fd.firstChild
 while !Pointer.isNull<HeapHeader>(child){run begin(&mut out,b"child") run ir(&mut out,rt,ctx,present(child)) run end(&mut out)
  let nested=unsafe HeapCell.payload<FunctionDef,()>(&anchor,present(child)) child=nested.nextSibling}
}
''')
    cf, sf = fields(FINAL_FIELDS, 'b', 'b')
    c.append('static void final(JSContext *ctx,JSFunctionBytecode *b){' + cf)
    s.append('effect fn final(out:&mut ByteBuffer,rt:*mut HeapHeader,ctx:*mut HeapHeader,cell:*mut HeapHeader)->() ! OutOfMemoryError | StringLengthError ? &mut Allocator {\nlet anchor=() let b=unsafe HeapCell.payload<FunctionBytecode,()>(&anchor,cell) let mut i:usize=0\n' + sf)
    for args in [
        ('variable', FINAL_VAR_FIELDS, 'JSBytecodeVarDef', 'b->vardefs', 'b->arg_count+b->var_count', 'b.varDefs'),
        ('closure', CLOSURE_FIELDS, 'JSClosureVar', 'b->closure_var', 'b->closure_var_count', 'b.closureVars'),
    ]:
        a, b = stored_loop(*args)
        c.append(a)
        s.append(b)
    c.append(r'''
 field("realmMatchesContext",b->realm==ctx);
 begin("code");code(ctx,b->byte_code_buf,b->byte_code_len,1);end();field("hasDebug",b->has_debug);
 if(b->has_debug){begin("debug");atom(ctx,"filename",b->debug.filename);field("hasSource",b->debug.source!=NULL);
  bytes("source",(const uint8_t*)b->debug.source,b->debug.source_len);bytes("pcToLine",b->debug.pc2line_buf,b->debug.pc2line_len);end();}
 field("constantCount",b->cpool_count);for(int i=0;i<b->cpool_count;i++){begin("constant");value(ctx,b->cpool[i]);end();}
}
''')
    s.append(r'''
 run field(&mut out,b"realmMatchesContext",flag(Pointer.address<HeapHeader>(b.realm)==Pointer.address<HeapHeader>(ctx)))
 run begin(&mut out,b"code") run code(&mut out,rt,&b.code,true) run end(&mut out)
 match &b.debug {
  Option<FunctionDebugInfo>.None=>{run field(&mut out,b"hasDebug",0)}
  Option<FunctionDebugInfo>.Some {value:d}=>{
   run field(&mut out,b"hasDebug",1) run begin(&mut out,b"debug") run atom(&mut out,rt,b"filename",d.filename)
   match &d.source {
    Option<ByteStorage>.None=>{run field(&mut out,b"hasSource",0) run header(&mut out,b"source",0)}
    Option<ByteStorage>.Some {value:text}=>{run field(&mut out,b"hasSource",1) run header(&mut out,b"source",text.length()) i=0
     while i<text.length(){run out.writeU32(u8.toU32(unsafe text.byte(i))) i=i+1}}
   }
   run header(&mut out,b"pcToLine",d.pcToLine.length()) i=0
   while i<d.pcToLine.length(){run out.writeU32(u8.toU32(unsafe d.pcToLine.byte(i))) i=i+1}
   run end(&mut out)
  }
 }
 run field(&mut out,b"constantCount",usize.toU32(b.constants.length())) i=0
 while i<b.constants.length(){run begin(&mut out,b"constant") run value(&mut out,rt,ctx,b.constants.get(i)) run end(&mut out) i=i+1}
}
''')
    return '\n'.join(c), '\n'.join(s)


S_COMPILER_ERROR = r'''
effect fn compilerDiagnostic(out:&mut ByteBuffer,error:CompilerError)->() ! OutOfMemoryError ? &mut Allocator {
 let kind:u32=match error.kind {
  CompilerErrorKind.TooManyLocals=>0 CompilerErrorKind.TooManyArguments=>1 CompilerErrorKind.TooManyClosures=>2
  CompilerErrorKind.LexicalRedefinition=>3 CompilerErrorKind.ParameterRedefinition=>4
  CompilerErrorKind.VariableRedefinition=>5 CompilerErrorKind.GlobalRedefinition=>6
  CompilerErrorKind.UndefinedPrivateField=>7 CompilerErrorKind.MissingExport=>8
 }
 run field(&mut out,b"compilerKind",kind)
 if kind>=7 {match &error.name {Option<StringOwner>.Some {value:n}=>{run string(&mut out,b"compilerName",n.get())} _=>trap()}}
}
'''


def native_failure(parser=True):
    return f'''match move error {{
 SyntaxError e=>{{run syntax(&mut out,move e)}}
 LexError e=>{{let diagnostic=run parser.lexicalError(move e) run syntax(&mut out,move diagnostic)}}
 CompilerError e=>{{run compilerDiagnostic(&mut out,move e)}}
 JsException e=>{{let anchor=() let data=unsafe HeapCell.payload<RuntimeState,()>(&anchor,rt)
  match data.currentException {{Value.Int {{value:n}}=>{{run field(&mut out,b"hostException",bits(n))}} _=>trap()}}}}
 OutOfMemoryError e=>{{fail move e}} StringLengthError e=>{{fail move e}} BigIntError e=>{{fail move e}} ParserStackOverflow e=>{{fail move e}}
}}''' if parser else '''match move error {
 CompilerError e=>{run compilerDiagnostic(&mut out,move e)}
 OutOfMemoryError e=>{fail move e} StringLengthError e=>{fail move e} BytecodeError e=>{fail move e}
}'''


def sources(rows):
    ci, si = serializers()
    c, s = [C_BASE, ci], [S_BASE, si, S_COMPILER_ERROR]
    for number, case in enumerate(rows):
        source = case.source.encode()
        c_module = 'JS_DetectModule((const char*)source,sizeof(source)-1)' if case.module is None else str(int(case.module))
        native_module = 'Lexer.detectModule(source)' if case.module is None else str(case.module).lower()
        c.append(f'''static void case_{number}(void){{
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 hooks.reject={int(case.validator == 2)};hooks.calls=hooks.count=0;hooks.null_proto=hooks.strings=hooks.dispatch=1;hooks.marker=90;
 if({case.validator})JS_SetModuleLoaderFunc2(rt,NULL,NULL,validate,&hooks.marker);
 const uint8_t source[]={{{','.join(map(str, source + bytes([0])))}}};JSParseState ps,*p=&ps;
 js_parse_init(ctx,p,(const char*)source,sizeof(source)-1,"program.js");skip_shebang(&p->buf_ptr,p->buf_end);
 const BOOL is_module={c_module};
 JSModuleDef *m=NULL;if(is_module)m=js_new_module_def(ctx,JS_NewAtom(ctx,"program.js"));
 JSFunctionDef *fd=js_new_function_def(ctx,NULL,TRUE,FALSE,"program.js",p->buf_start,&p->get_line_col_cache);if(!fd)abort();
 p->cur_func=fd;fd->eval_type=is_module;fd->has_this_binding=TRUE;fd->new_target_allowed=FALSE;
 fd->super_call_allowed=FALSE;fd->super_allowed=FALSE;fd->arguments_allowed=TRUE;
 fd->js_mode=is_module||{int(case.strict)};fd->func_name=JS_DupAtom(ctx,JS_ATOM__eval_);fd->module=m;
 if(is_module||{int(case.async_)}){{fd->in_function_body=TRUE;fd->func_kind=JS_FUNC_ASYNC;}}
 p->is_module=is_module;p->allow_html_comments=!p->is_module;
 push_scope(p);fd->body_scope=fd->scope_level;
 begin("{case.name}");int err=js_parse_program(p);field("parseSuccess",err==0);
 field("token",p->token.val);field("tokenStart",p->token.ptr-p->buf_start);field("cursor",p->buf_ptr-p->buf_start);
 int success=err==0;
 if(err){{begin("diagnostic");diagnostic(ctx);end();free_token(p,&p->token);js_free_function_def(ctx,fd);}}
 else{{
  if(m)m->has_tla=fd->has_await;
  begin("ir");ir(ctx,fd);end();
  if(m){{begin("moduleBefore");module(ctx,m);end();}}
  JSValue compiled=js_create_function(ctx,fd);success=!JS_IsException(compiled);field("assemblySuccess",success);
  if(success){{begin("bytecode");final(ctx,JS_VALUE_GET_PTR(compiled));end();JS_FreeValue(ctx,compiled);}}
  else{{begin("diagnostic");diagnostic(ctx);end();}}
  if(m){{begin("moduleAfter");module(ctx,m);end();}}
  free_token(p,&p->token);
 }}
 field("validatorCalls",hooks.calls);field("attributeCount",hooks.count);field("nullPrototype",hooks.null_proto);
 field("validStrings",hooks.strings);field("registeredDispatch",hooks.dispatch);field("success",success);end();
 if(success!={int(case.success)}){{fprintf(stderr,"C case {case.name}: unexpected acceptance=%d\\n",success);exit(5);}}
 JS_FreeContext(ctx);JS_FreeRuntime(rt);
}}''')
        # Each case owns a separate allocator/context. Its observation ledger is
        # checked by main only after the exported record buffer has been dropped.
        s.append(f'''effect fn case{number}(out:&mut ByteBuffer)->AllocationObserver ! {ERRORS} ? &mut Allocator {{
 let mut memory=run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer=run memory.observe()
 run body{number}(&mut out,&observer) |> Effect.provideMut<Allocator>(&mut memory)
 return move observer
}}
effect fn body{number}(out:&mut ByteBuffer,memory:&AllocationObserver)->() ! {ERRORS} ? &mut Allocator {{
 let rt=run runtime.allocateRuntimeStorage(currentFrameAddress()) let mut hooks=Hooks.make({str(case.validator == 2).lower()})
 let ctx=run unsafe fixture.context(&mut hooks,memory,rt) let mut marker:u8=90
 if {str(bool(case.validator)).lower()} {{unsafe fixture.registerValidator(rt,Pointer.fromMutRef<u8>(&mut marker))}}
 let mut cache=SourcePositionCache.make()
 let source={literal(source)}
 let isModule={native_module}
 let root=run unsafe fixture.root(ctx,isModule,{str(case.strict).lower()},{str(case.async_).lower()},Pointer.fromMutRef<SourcePositionCache>(&mut cache))
 let mut parser=run unsafe Parser.make(source,root,isModule,!isModule)
 run begin(&mut out,{literal(case.name)})
 let outcome=run Effect.result(unsafe parseProgram(&mut parser,&mut hooks,memory))
 let mut success=false
 match move outcome {{
  Result<(),{GRAMMAR_ERRORS}>.Success {{..}}=>{{success=true run field(&mut out,b"parseSuccess",1)}}
  Result<(),{GRAMMAR_ERRORS}>.Failure {{error}}=>{{
   run field(&mut out,b"parseSuccess",0) run field(&mut out,b"token",bits(parser.token.kind))
   run field(&mut out,b"tokenStart",usize.toU32(parser.token.start)) run field(&mut out,b"cursor",usize.toU32(parser.lexer.offset))
   run begin(&mut out,b"diagnostic") {native_failure()} run end(&mut out)
  }}
 }}
 if success {{
  run field(&mut out,b"token",bits(parser.token.kind)) run field(&mut out,b"tokenStart",usize.toU32(parser.token.start))
  run field(&mut out,b"cursor",usize.toU32(parser.lexer.offset))
  let mut anchor=() let fd=unsafe HeapCell.payload<FunctionDef,()>(&anchor,root) let moduleCell=fd.module let awaitUsed=fd.hasAwait drop fd
  if !Pointer.isNull<HeapHeader>(moduleCell){{let m=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut anchor,present(moduleCell)) m.hasTopLevelAwait=awaitUsed}}
  run begin(&mut out,b"ir") run ir(&mut out,rt,ctx,root) run end(&mut out)
  if !Pointer.isNull<HeapHeader>(moduleCell){{run begin(&mut out,b"moduleBefore") run module(&mut out,rt,ctx,present(moduleCell)) run end(&mut out)}}
  let assembled=run Effect.result(unsafe createFunction(&mut hooks,root,source))
  match move assembled {{
   Result<Value,OutOfMemoryError | StringLengthError | CompilerError | BytecodeError>.Success {{value:compiled}}=>{{
    run field(&mut out,b"assemblySuccess",1) run begin(&mut out,b"bytecode")
    match compiled {{Value.FunctionBytecode {{reference:p}}=>{{run final(&mut out,rt,ctx,p)}} _=>trap()}}
    run end(&mut out) unsafe gc.release(&mut hooks,rt,compiled)
   }}
   Result<Value,OutOfMemoryError | StringLengthError | CompilerError | BytecodeError>.Failure {{error}}=>{{
    success=false run field(&mut out,b"assemblySuccess",0) run begin(&mut out,b"diagnostic")
    {native_failure(parser=False)} run end(&mut out)
   }}
  }}
  if !Pointer.isNull<HeapHeader>(moduleCell){{run begin(&mut out,b"moduleAfter") run module(&mut out,rt,ctx,present(moduleCell)) run end(&mut out)}}
 }} else {{unsafe state.destroyFunction(&mut hooks,root)}}
 drop parser
 run field(&mut out,b"validatorCalls",usize.toU32(hooks.calls)) run field(&mut out,b"attributeCount",usize.toU32(hooks.attributeCount))
 run field(&mut out,b"nullPrototype",flag(hooks.nullPrototype)) run field(&mut out,b"validStrings",flag(hooks.validStrings))
 run field(&mut out,b"registeredDispatch",flag(hooks.dispatched)) run field(&mut out,b"success",flag(success)) run end(&mut out)
 unsafe gc.releaseHeader(&mut hooks,rt,ctx) run unsafe gc.destroyRuntime(&mut hooks,rt)
}}
''')
    c.append('int main(void){' + ''.join(f'case_{i}();' for i in range(len(rows))) + 'return 0;}')
    s.append(f'''pub effect fn main()->i32 ! {ERRORS} | WriterError {{
 let mut allocator=Allocator.systemAllocatorProvider() let mut writer=StdoutWriter.make()
 let mut out=ByteBuffer.make()
''' + '\n'.join(f'let ledger{i}=run case{i}(&mut out) |> Effect.provideMut<Allocator>(&mut allocator)' for i in range(len(rows))) + '''
 run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 drop out
''' + '\n'.join(f'if ledger{i}.stats().usedBytes!=0||ledger{i}.stats().allocationCount!=0{{trap()}}' for i in range(len(rows))) + '\nreturn 0\n}')
    return '\n'.join(c), '\n'.join(s)


def decode(data, owner):
    if not data or len(data) % 4:
        raise SystemExit(f'{owner}: empty or truncated word stream ({len(data)} bytes)')
    words = struct.unpack('<' + 'I' * (len(data) // 4), data)
    cursor = 0

    def take():
        nonlocal cursor
        if cursor >= len(words):
            raise SystemExit(f'{owner}: truncated record at word {cursor}')
        result = words[cursor]
        cursor += 1
        return result

    def text():
        count = take()
        return ''.join(chr(take()) for _ in range(count))

    def group(nested=False):
        records = []
        while cursor < len(words):
            tag = take()
            if tag == 1:
                if not nested:
                    raise SystemExit(f'{owner}: unmatched end at word {cursor}')
                return records
            if tag not in (0, 2):
                raise SystemExit(f'{owner}: invalid record tag {tag} at word {cursor}')
            label = text()
            payload = group(True) if tag == 0 else tuple(take() for _ in range(take()))
            records.append((label, payload))
        if nested:
            raise SystemExit(f'{owner}: unterminated group')
        return records

    return group()


def normalize(records):
    """Normalize the structured native compiler-error ABI, not syntax failures.

    CompilerError intentionally has no C parser stacktrace/coordinates. The
    enclosing tokenStart/cursor is still compared exactly. SyntaxError retains
    complete message and line/column, including absent locations encoded as zero.
    """
    import re
    templates = [
        (r'too many local variables', 0), (r'too many arguments', 1),
        (r'too many closure variables', 2), (r'invalid redefinition of lexical identifier', 3),
        (r'invalid redefinition of parameter name', 4), (r'invalid redefinition of a variable', 5),
        (r'invalid redefinition of global identifier', 6),
        (r"undefined private field '(.*)'", 7),
        (r"exported variable '(.*)' does not exist", 8),
    ]
    result = []
    for label, payload in records:
        if isinstance(payload, list):
            payload = normalize(payload)
            if label == 'diagnostic':
                fields = dict(payload)
                if 'message' in fields:
                    text = ''.join(chr(n) for n in fields['message'])
                    for pattern, kind in templates:
                        match = re.fullmatch(pattern, text)
                        if match:
                            payload = [('compilerKind', (kind,))]
                            if match.groups():
                                payload.append(('compilerName', tuple(ord(c) for c in match[1])))
                            break
        result.append((label, payload))
    return result


def compare(expected, actual, path='programs'):
    if len(expected) != len(actual):
        raise SystemExit(f'{path}: record counts C={len(expected)} Silk={len(actual)}; '
                         f'C fields={[x[0] for x in expected]} Silk fields={[x[0] for x in actual]}')
    occurrences = {}
    for (left_name, left), (right_name, right) in zip(expected, actual):
        index = occurrences.get(left_name, 0)
        occurrences[left_name] = index + 1
        here = f'{path}/{left_name}[{index}]'
        if left_name != right_name:
            raise SystemExit(f'{here}: field name C={left_name!r} Silk={right_name!r}')
        if isinstance(left, list) and isinstance(right, list):
            compare(left, right, here)
        elif left != right:
            differing = next((i for i, (a, b) in enumerate(zip(left, right)) if a != b), min(len(left), len(right)))
            raise SystemExit(f'{here}: first differing unit {differing}; C={left[max(0,differing-8):differing+12]!r} '
                             f'Silk={right[max(0,differing-8):differing+12]!r}; lengths={len(left)}/{len(right)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--case', action='append', default=[], help='select named-case substrings; repeatable')
    parser.add_argument('--upstream-tests', action='store_true', help='also compile every upstream tests/*.js source with module autodetection')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    rows = cases()
    if args.upstream_tests:
        rows.extend(Case('upstream/' + path.name, path.read_text(), module=None)
                    for path in sorted((upstream / 'tests').glob('*.js')))
    rows = [case for case in rows if not args.case or any(term in case.name for term in args.case)]
    if not rows:
        raise SystemExit('No parser cases selected')
    c, native = sources(rows)
    with tempfile.TemporaryDirectory(prefix='silkjs-parser-program-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c)
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Program parser C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Original program parser')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(native)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="parser-program-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = process(command, 1800, owner='Native program parser', cwd=temp)
        compare(normalize(decode(expected, 'C')), normalize(decode(actual, 'Silk')))
        print(f'PASS program grammar: {len(rows)} named cases; recursive IR/final bytecode/constants/modules; '
              f'{pins} pins; C sha256={hashlib.sha256(expected).hexdigest()}; Silk sha256={hashlib.sha256(actual).hexdigest()}')


if __name__ == '__main__':
    main()
