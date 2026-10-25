#!/usr/bin/env python3
"""Independent native/C module graph, namespace, host and allocation consumers.

C includes the pinned, unchanged quickjs.c; no algorithm is translated into the
oracle. JS module compilation/closure creation is real in both consumers. Module
execution is not emulated here: the VM consumer owns linking/evaluating JS bodies.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, validate_pins
from verify_compiler_state import execute
from verify_closures import C_SOURCE as CLOSURE_HARNESS

ROOT = Path(__file__).resolve().parents[1]
C_SOURCE = CLOSURE_HARNESS.split('static JSClosureVar cv(')[0] + r'''
static unsigned normalizes,loads,initializers,events;static int last_attribute;
static int initialize(JSContext *ctx,JSModuleDef *m){
 initializers++;JS_SetModulePrivateValue(ctx,m,JS_NewInt32(ctx,73));JS_RunGC(ctx->rt);
 return JS_SetModuleExport(ctx,m,"z",JS_NewInt32(ctx,42));
}
static int initialize_empty(JSContext *ctx,JSModuleDef *m){return 0;}
static int initialize_failure(JSContext *ctx,JSModuleDef *m){
 initializers++;JS_SetModulePrivateValue(ctx,m,JS_NewInt32(ctx,73));JS_RunGC(ctx->rt);JS_Throw(ctx,JS_NewInt32(ctx,819));return -1;
}
static char *normalize(JSContext *ctx,const char *base,const char *name,void *opaque){normalizes++;events=events*10+2;return js_default_module_normalize_name(ctx,base,name);}
static int validate_attributes(JSContext *ctx,void *opaque,JSValueConst attributes){events=events*10+1;return 0;}
static JSModuleDef *load2(JSContext *ctx,const char *name,void *opaque,JSValueConst attr){loads++;last_attribute=JS_VALUE_GET_TAG(attr);return JS_NewCModule(ctx,name,initialize_empty);}
static JSModuleDef *load1(JSContext *ctx,const char *name,void *opaque){return load2(ctx,name,opaque,JS_UNDEFINED);}
static int req(JSContext *ctx,JSModuleDef *m,JSModuleDef *target){int i=add_req_module_entry(ctx,m,target->module_name);if(i<0)abort();m->req_module_entries[i].module=target;return i;}
static void star(JSContext *ctx,JSModuleDef *m,int i){if(add_star_export_entry(ctx,m,i))abort();}
static int indirect(JSContext *ctx,JSModuleDef *m,JSAtom local,JSAtom name,int target){JSExportEntry *e=add_export_entry2(ctx,NULL,m,local,name,JS_EXPORT_TYPE_INDIRECT);if(!e)abort();e->u.req_module_idx=target;return e-m->export_entries;}
static unsigned resolve(JSContext *ctx,JSModuleDef *m,JSAtom name){JSModuleDef *owner;JSExportEntry *entry;return js_resolve_export(ctx,&owner,&entry,m,name);}
static void semantic(void){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=JS_NewContext(rt);uint32_t r[40]={0};
 JSModuleDef *a=JS_NewCModule(ctx,"dir/a",initialize),*b=JS_NewCModule(ctx,"dir/b",initialize_empty);
 JSModuleDef *root=JS_NewCModule(ctx,"dir/root",initialize_empty),*cycle=JS_NewCModule(ctx,"dir/cycle",initialize_empty);
 if(JS_AddModuleExport(ctx,a,"z")||JS_AddModuleExport(ctx,a,"a")||JS_AddModuleExport(ctx,a,"default")||JS_AddModuleExport(ctx,b,"a"))abort();
 int ra=req(ctx,root,a),rb=req(ctx,root,b),rc=req(ctx,root,cycle),cr=req(ctx,cycle,root);
 star(ctx,root,ra);star(ctx,root,rb);star(ctx,root,rc);star(ctx,cycle,cr);
 JSAtom z=JS_NewAtom(ctx,"z"),aa=JS_NewAtom(ctx,"a"),alias=JS_NewAtom(ctx,"alias"),ns=JS_NewAtom(ctx,"ns"),missing=JS_NewAtom(ctx,"missing");
 indirect(ctx,root,z,alias,ra);indirect(ctx,root,JS_ATOM__star_,ns,ra);
 r[0]=resolve(ctx,root,z);r[1]=resolve(ctx,root,aa);r[2]=resolve(ctx,root,JS_ATOM_default);r[3]=resolve(ctx,root,alias);
 int bad=indirect(ctx,cycle,missing,missing,cr);r[4]=resolve(ctx,root,missing);
 if(js_create_module_function(ctx,root))abort();r[5]=js_link_module(ctx,root)<0&&JS_HasException(ctx);
 JS_FreeValue(ctx,JS_GetException(ctx));r[6]=root->status==JS_MODULE_STATUS_UNLINKED;r[7]=cycle->status==JS_MODULE_STATUS_UNLINKED;
 JS_FreeAtom(ctx,cycle->export_entries[bad].local_name);cycle->export_entries[bad].local_name=JS_DupAtom(ctx,z);
 if(js_link_module(ctx,root))abort();r[8]=root->status==JS_MODULE_STATUS_LINKED;
 JSValue space=checked(JS_GetModuleNamespace(ctx,root)),again=checked(JS_GetModuleNamespace(ctx,root));
 r[9]=JS_VALUE_GET_PTR(space)==JS_VALUE_GET_PTR(again);JS_FreeValue(ctx,again);
 JSObject *p=JS_VALUE_GET_OBJ(space);r[10]=!p->extensible;r[11]=!p->shape->proto;r[12]=p->shape->prop_count;
 JSShapeProperty *props=get_shape_prop(p->shape);r[13]=props[0].atom==alias&&props[1].atom==missing&&props[2].atom==ns&&props[3].atom==z;
 r[14]=!JS_HasProperty(ctx,space,aa)&&JS_HasProperty(ctx,space,z);
 JS_SetModuleExport(ctx,a,"z",JS_NewInt32(ctx,11));JSValue v=checked(JS_GetProperty(ctx,space,alias));r[15]=number(v);JS_FreeValue(ctx,v);
 JS_SetModuleExport(ctx,a,"z",JS_NewInt32(ctx,12));v=checked(JS_GetProperty(ctx,space,z));r[16]=number(v);JS_FreeValue(ctx,v);r[17]=attrs(space,z);
 v=checked(JS_GetProperty(ctx,space,ns));JSValue expected=checked(JS_GetModuleNamespace(ctx,a));r[18]=JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(expected);JS_FreeValue(ctx,v);JS_FreeValue(ctx,expected);
 JS_SetModuleExport(ctx,a,"z",JS_UNINITIALIZED);r[19]=JS_HasProperty(ctx,space,z);v=JS_GetProperty(ctx,space,z);r[20]=JS_IsException(v)&&JS_HasException(ctx);JS_FreeValue(ctx,JS_GetException(ctx));
 if(initialize(ctx,a))abort();v=checked(JS_GetProperty(ctx,space,z));r[21]=number(v);JS_FreeValue(ctx,v);v=JS_GetModulePrivateValue(ctx,a);r[22]=number(v);JS_FreeValue(ctx,v);
 v=checked(JS_GetImportMeta(ctx,a));again=checked(JS_GetImportMeta(ctx,a));r[23]=JS_VALUE_GET_PTR(v)==JS_VALUE_GET_PTR(again);r[24]=!JS_VALUE_GET_OBJ(v)->shape->proto&&JS_VALUE_GET_OBJ(v)->extensible;JS_FreeValue(ctx,v);JS_FreeValue(ctx,again);
 JSAtom name=JS_GetModuleName(ctx,a);r[25]=js_find_loaded_module(ctx,name)==a;JS_FreeAtom(ctx,name);
 JSModuleDef *failure=JS_NewCModule(ctx,"failure",initialize_failure);initialize_failure(ctx,failure);v=JS_GetException(ctx);r[26]=number(v);JS_FreeValue(ctx,v);v=JS_GetModulePrivateValue(ctx,failure);r[27]=number(v);JS_FreeValue(ctx,v);
 JS_SetModuleLoaderFunc2(rt,normalize,load2,NULL,NULL);
 JSModuleDef *loaded=js_host_resolve_imported_module(ctx,"dir/root","./loaded",JS_NewInt32(ctx,4));
 JSModuleDef *cached=js_host_resolve_imported_module(ctx,"dir/root","./loaded",JS_NewInt32(ctx,5));
 r[28]=loaded==cached;r[29]=normalizes;r[30]=loads;r[31]=last_attribute;
 JS_SetModuleLoaderFunc(rt,NULL,load1,NULL);js_host_resolve_imported_module(ctx,"dir/root","legacy",JS_NewInt32(ctx,4));r[32]=last_attribute;
 r[33]=JS_GetScriptOrModuleName(ctx,0)==JS_ATOM_NULL;r[34]=JS_SetModuleExport(ctx,a,"absent",JS_NewInt32(ctx,5))<0;
 JSPropertyDescriptor d;if(JS_GetOwnProperty(ctx,&d,space,z)!=1)abort();r[35]=d.flags;r[36]=number(d.value);js_free_desc(ctx,&d);
 r[37]=JS_DefineProperty(ctx,space,z,JS_NewInt32(ctx,99),JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_VALUE)==0;
 v=checked(JS_GetProperty(ctx,space,JS_ATOM_Symbol_toStringTag));r[38]=JS_IsString(v);JS_FreeValue(ctx,v);r[39]=initializers;
 JS_FreeValue(ctx,space);JS_FreeAtom(ctx,z);JS_FreeAtom(ctx,aa);JS_FreeAtom(ctx,alias);JS_FreeAtom(ctx,ns);JS_FreeAtom(ctx,missing);
 for(int i=0;i<40;i++)word(r[i]);
 events=0;JS_SetModuleLoaderFunc2(rt,normalize,load2,validate_attributes,NULL);
 const char *source="import {z as imported} from 'dir/a' with {type:'json'}; export {imported}; export let local; export * as ns from 'dir/a';";
 JSValue compiled=checked(JS_Eval(ctx,source,strlen(source),"program.js",JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY));
 JSModuleDef *m=JS_VALUE_GET_PTR(compiled);if(js_create_module_function(ctx,m))abort();
 uint32_t c[8]={0};c[0]=m->func_created&&m->resolved;c[1]=m->export_entries_count;c[2]=m->import_entries_count;
 JSObject *fn=JS_VALUE_GET_OBJ(m->func_obj);JSFunctionBytecode *code=fn->u.func.function_bytecode;
 c[3]=fn->u.func.var_refs[m->import_entries[0].var_idx]==NULL;c[4]=code->byte_code_len>0;
 for(int i=0;i<code->closure_var_count;i++)if(code->closure_var[i].closure_type==JS_CLOSURE_MODULE_DECL&&code->closure_var[i].is_lexical)c[5]=tdz(*fn->u.func.var_refs[i]->pvalue);
 c[6]=code->has_debug;
 JSStackFrame sf={0};sf.cur_func=m->func_obj;rt->current_stack_frame=&sf;
 JSAtom script_name=JS_GetScriptOrModuleName(ctx,0),module_name=JS_GetModuleName(ctx,m);
 c[6]=c[6]&&script_name==module_name&&JS_GetScriptOrModuleName(ctx,1)==JS_ATOM_NULL;
 JS_FreeAtom(ctx,script_name);JS_FreeAtom(ctx,module_name);
 JSValue dynamic_meta=checked(js_import_meta(ctx));rt->current_stack_frame=NULL;
 JSValue direct_meta=checked(JS_GetImportMeta(ctx,m));c[6]=c[6]&&JS_VALUE_GET_PTR(dynamic_meta)==JS_VALUE_GET_PTR(direct_meta);
 JS_FreeValue(ctx,dynamic_meta);JS_FreeValue(ctx,direct_meta);
 c[7]=events;for(int i=0;i<8;i++)word(c[i]);JS_FreeValue(ctx,compiled);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);word(live_count==0&&live_bytes==0);
}
static void normalize_case(const char *base,const char *name){JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=JS_NewContext(rt);char *s=js_default_module_normalize_name(ctx,base,name);if(!s)abort();word(strlen(s));for(char *p=s;*p;p++)word((unsigned char)*p);js_free(ctx,s);JS_FreeContext(ctx);JS_FreeRuntime(rt);word(!live_count&&!live_bytes);}
static void fault(int cutoff,int phase){
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);JSContext *ctx=JS_NewContext(rt);JSModuleDef *m=JS_NewCModule(ctx,"fault",initialize_empty);
 if(JS_AddModuleExport(ctx,m,"z")||JS_AddModuleExport(ctx,m,"a"))abort();JSAtom z=JS_NewAtom(ctx,"z");
 if(phase&&js_create_module_function(ctx,m))abort();fault_after=cutoff;int success=0;
 if(!phase)success=js_create_module_function(ctx,m)==0;
 else if(phase==1){JSValue v=JS_GetModuleNamespace(ctx,m);success=!JS_IsException(v);JS_FreeValue(ctx,v);}
 else{JSModuleDef *target;JSExportEntry *entry;success=js_resolve_export(ctx,&target,&entry,m,z)==JS_RESOLVE_RES_FOUND;}
 int denied_allocation=fault_after==0&&!success;fault_after=-1;JS_FreeValue(ctx,JS_GetException(ctx));
 JS_FreeAtom(ctx,z);JS_FreeContext(ctx);JS_FreeRuntime(rt);word(success);word(denied_allocation);word(!live_count&&!live_bytes);
}
int main(void){semantic();
 normalize_case("a/b/root.js",".././dep.js");normalize_case("a/b/root.js","./x/../dep.js");normalize_case("a/b/root.js","package/../dep");normalize_case("root.js","../../dep");normalize_case("../root.js","../dep");normalize_case("./root.js","../dep");normalize_case("/root.js","./dep");normalize_case("a/root.js",".");
 for(int phase=0;phase<3;phase++)for(int cutoff=0;cutoff<48;cutoff++)fault(cutoff,phase);return 0;}
'''
SILK_SOURCE = r'''
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
import silk.os_writer { StdoutWriter }
import silk.usize
import silk.u8
import byte_buffer { ByteBuffer }
import runtime_memory { RuntimeAllocator }
import native_stack { currentFrameAddress }
import js_runtime as runtime
import js_gc as gc
import js_array_storage_test_support as storage
import js_modules_test_support { Hooks }
import js_modules_test_support as fixture
import js_module_loader as loader
import js_module_metadata { ModuleMetadataError }
import js_string_types { StringLengthError }
import js_bigint { BigIntError }
import js_exceptions { JsException }
import js_tokens { LexError }
import js_parser_diagnostics { SyntaxError }
import js_parser_core { ParserStackOverflow }
import js_compiler_types { CompilerError }
import js_bytecode { BytecodeError }
effect fn normalize(out: &mut ByteBuffer, base: &[u8], name: &[u8]) -> () ! OutOfMemoryError ? &mut Allocator {
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider())
 let value = run loader.defaultNormalize(base, name) |> Effect.provideMut<Allocator>(&mut memory)
 run out.writeU32(usize.toU32(value.length())) let mut index: usize = 0
 while index < value.length() { run out.writeU32(u8.toU32(value.get(index))) index = index + 1 }
 drop value run out.writeU32(fixture.flag(memory.stats().usedBytes == 0 && memory.stats().allocationCount == 0))
}
effect fn probe() -> () ! OutOfMemoryError | StringLengthError | ModuleMetadataError | BigIntError | JsException | LexError | SyntaxError | ParserStackOverflow | CompilerError | BytecodeError | WriterError ? &mut Allocator | &mut Writer {
 let mut out = ByteBuffer.make()
 let mut memory = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let observer = run memory.observe()
 let rt = run runtime.allocateRuntimeStorage(currentFrameAddress()) |> Effect.provideMut<Allocator>(&mut memory)
 let ctx = run unsafe storage.context(rt) |> Effect.provideMut<Allocator>(&mut memory) let mut hooks = Hooks.make(&observer)
 run unsafe fixture.prepare(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let record = run unsafe fixture.observe(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 let mut index: usize = 0 while index < record.length { run out.writeU32(record[index]) index = index + 1 }
 let compiled = run unsafe fixture.compiled(&mut hooks, &observer, ctx) |> Effect.provideMut<Allocator>(&mut memory)
 index = 0 while index < compiled.length { run out.writeU32(compiled[index]) index = index + 1 }
 unsafe gc.releaseHeader(&mut hooks, rt, ctx) run unsafe gc.destroyRuntime(&mut hooks, rt) |> Effect.provideMut<Allocator>(&mut memory)
 run out.writeU32(fixture.flag(observer.stats().usedBytes == 0 && observer.stats().allocationCount == 0))
 run normalize(&mut out,b"a/b/root.js",b".././dep.js") run normalize(&mut out,b"a/b/root.js",b"./x/../dep.js")
 run normalize(&mut out,b"a/b/root.js",b"package/../dep") run normalize(&mut out,b"root.js",b"../../dep")
 run normalize(&mut out,b"../root.js",b"../dep") run normalize(&mut out,b"./root.js",b"../dep")
 run normalize(&mut out,b"/root.js",b"./dep") run normalize(&mut out,b"a/root.js",b".")
 let mut phase: u32 = 0 while phase < 3 { let mut cutoff: usize = 0 while cutoff < 48 {
  let fault = run fixture.fault(cutoff, phase) index = 0 while index < fault.length { run out.writeU32(fault[index]) index = index + 1 } cutoff = cutoff + 1
 } phase = phase + 1 }
 run Writer.writeAll(out.asSlice())
}
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | ModuleMetadataError | BigIntError | JsException | LexError | SyntaxError | ParserStackOverflow | CompilerError | BytecodeError | WriterError {
 let mut allocator = run RuntimeAllocator.make(Allocator.systemAllocatorProvider()) let mut writer = StdoutWriter.make()
 run probe() |> Effect.provideMut<Allocator>(&mut allocator) |> Effect.provideMut<Writer>(&mut writer)
 if allocator.stats().usedBytes != 0 || allocator.stats().allocationCount != 0 { return 7 } return 0
}
'''


def inspect(data: bytes, engine: str) -> tuple[int, ...]:
    if len(data) % 4:
        raise SystemExit(f'{engine}: incomplete word output')
    words = struct.unpack(f'<{len(data)//4}I', data)
    if len(words) < 49 or words[48] != 1:
        raise SystemExit(f'{engine}: module graph allocation ledger is not zero')
    offset = 49
    for _ in range(8):
        if offset >= len(words):
            raise SystemExit(f'{engine}: missing normalization record')
        size = words[offset]
        offset += size + 2
        if offset > len(words) or words[offset - 1] != 1:
            raise SystemExit(f'{engine}: normalization ledger is not zero')
    if len(words) != offset + 3 * 48 * 3:
        raise SystemExit(f'{engine}: incomplete allocation sweep records')
    for phase in range(3):
        rows = [words[offset + (phase * 48 + n) * 3:offset + (phase * 48 + n + 1) * 3] for n in range(48)]
        if not any(r[0] == 0 for r in rows) or not any(r[0] == 1 for r in rows):
            raise SystemExit(f'{engine}: phase {phase} does not cross failure/success')
        for cutoff, (success, allocation_failed, zero) in enumerate(rows):
            if zero != 1 or (not success and not allocation_failed):
                raise SystemExit(f'{engine}: phase {phase} cutoff {cutoff}: {(success, allocation_failed, zero)}')
    return words[:offset]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default='silk')
    parser.add_argument('--stdlib', type=Path)
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    with tempfile.TemporaryDirectory(prefix='silkjs-modules-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__', '-DCONFIG_VERSION="differential"',
                 '-I', str(upstream), str(temp / 'oracle.c'),
                 *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="modules-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        cwords, swords = inspect(expected, 'C'), inspect(actual, 'Silk')
        if len(cwords) != len(swords):
            raise SystemExit('semantic record count differs')
        for index, (cword, sword) in enumerate(zip(cwords, swords)):
            if cword != sword:
                raise SystemExit(f'module observation word {index}: C={cword}, Silk={sword}')
        print(f'PASS modules: {len(cwords)} matched semantic/ledger words; 144 independent fault attempts per engine; '
              f'{pins} pinned files; sha256={hashlib.sha256(actual[:len(cwords)*4]).hexdigest()}')


if __name__ == '__main__':
    main()
