#!/usr/bin/env python3
"""Exercise property copying against unchanged QuickJS, including independent OOM sweeps."""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib
from verify_bytecode import SUPPORT, executable_path, process, validate_pins
from verify_bound_functions import ALLOCATOR_SOURCE
import toolchain

ROOT = Path(__file__).resolve().parents[1]
CASES = [(mode, assignment) for mode in range(24) for assignment in range(2)]
FAULT_MODES = (0, 1, 11, 14, 19, 23)
FIELDS = 19
C_SOURCE = ALLOCATOR_SOURCE + r'''
typedef struct { JSAtom atom; int flags,seed; JSValue value,getter,setter; } Entry;
typedef struct { int count; Entry entries[5]; } Stored;
static uint32_t rec[19]; static int mode,fail_own;
static int exotic_mode(int m){return m==11||m==12||m==13||m==14||m==19||m==22;}
static unsigned numeric(JSValueConst v){
 if(JS_VALUE_GET_TAG(v)==JS_TAG_INT)return JS_VALUE_GET_INT(v);
 if(JS_IsString(v))return 100+JS_VALUE_GET_STRING(v)->len;
 return 0;
}
static JSAtom atom(JSContext *ctx,const char *s,int kind){
 if(!kind)return JS_NewAtom(ctx,s);
 JSValue v=kind==2?JS_NewSymbolInternal(ctx,JS_VALUE_GET_STRING(checked(JS_NewString(ctx,s))),JS_ATOM_TYPE_PRIVATE):JS_NewSymbol(ctx,s,FALSE);
 v=checked(v);JSAtom a=JS_DupAtom(ctx,js_symbol_to_atom(ctx,v));JS_FreeValue(ctx,v);return a;
}
static void finalizer(JSRuntime *rt,JSValue object){
 Stored *s=JS_GetOpaque(object,67);if(!s)return;
 for(int i=0;i<s->count;i++){Entry *e=&s->entries[i];JS_FreeAtomRT(rt,e->atom);JS_FreeValueRT(rt,e->value);JS_FreeValueRT(rt,e->getter);JS_FreeValueRT(rt,e->setter);}
 js_free_rt(rt,s);
}
static void marker(JSRuntime *rt,JSValueConst object,JS_MarkFunc *mark){
 Stored *s=JS_GetOpaque(object,67);if(!s)return;
 for(int i=0;i<s->count;i++){JS_MarkValue(rt,s->entries[i].value,mark);JS_MarkValue(rt,s->entries[i].getter,mark);JS_MarkValue(rt,s->entries[i].setter,mark);}
}
static int own_keys(JSContext *ctx,JSPropertyEnum **tab,uint32_t *len,JSValueConst object){
 JS_RunGC(ctx->rt);Stored *s=JS_GetOpaque(object,67);
 *tab=js_malloc(ctx,s->count*sizeof(**tab));if(!*tab)return -1;*len=s->count;
 for(int i=0;i<s->count;i++){(*tab)[i].atom=JS_DupAtom(ctx,s->entries[i].atom);(*tab)[i].is_enumerable=s->entries[i].seed;}
 return 0;
}
static int own_desc(JSContext *ctx,JSPropertyDescriptor *d,JSValueConst object,JSAtom key){
 rec[12]++;JS_RunGC(ctx->rt);if(fail_own){JS_ThrowTypeError(ctx,"exotic failed");return -1;}
 Stored *s=JS_GetOpaque(object,67);
 for(int i=0;i<s->count;i++)if(s->entries[i].atom==key){Entry *e=&s->entries[i];
  if(d){d->flags=e->flags;d->value=JS_DupValue(ctx,e->value);d->getter=JS_DupValue(ctx,e->getter);d->setter=JS_DupValue(ctx,e->setter);}return 1;}
 return 0;
}
static JSClassExoticMethods exotic={.get_own_property=own_desc,.get_own_property_names=own_keys};
static const JSClassDef definition={.class_name="StoredKeys",.finalizer=finalizer,.gc_mark=marker,.exotic=&exotic};
static void store(JSContext *ctx,JSValue object,JSAtom key,int flags,int seed,JSValue value,JSValue getter){
 Stored *s=JS_GetOpaque(object,67);s->entries[s->count++]=(Entry){JS_DupAtom(ctx,key),flags,seed,JS_DupValue(ctx,value),JS_DupValue(ctx,getter),JS_UNDEFINED};
}
static void put(JSContext *ctx,JSValue object,JSAtom key,JSValue value,int flags,int is_exotic,int seed){
 if(is_exotic)store(ctx,object,key,flags,seed,value,JS_UNDEFINED);
 else {JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),key,flags);if(!p)abort();p->u.value=JS_DupValue(ctx,value);}
}
static JSValue callback(JSContext *ctx,JSValueConst receiver,int argc,JSValueConst *argv,int body,JSValue *data){
 if(body==4){rec[11]++;if(argc!=1)abort();if(JS_DefinePropertyValue(ctx,receiver,JS_ATOM_value,JS_DupValue(ctx,argv[0]),7)<0)return JS_EXCEPTION;JS_RunGC(ctx->rt);return JS_UNDEFINED;}
 rec[10]++;
 if(body==3&&JS_SetProperty(ctx,receiver,JS_ATOM_name,JS_NewInt32(ctx,99))<0)return JS_EXCEPTION;
 if(body==6){
  if(JS_VALUE_GET_OBJ(receiver)->class_id==67){Stored *s=JS_GetOpaque(receiver,67);for(int i=0;i<s->count;i++)if(s->entries[i].atom==JS_ATOM_name)s->entries[i].flags&=~JS_PROP_ENUMERABLE;}
  else if(JS_DefineProperty(ctx,receiver,JS_ATOM_name,JS_UNDEFINED,JS_UNDEFINED,JS_UNDEFINED,JS_PROP_HAS_ENUMERABLE)<0)return JS_EXCEPTION;
 }
 JS_RunGC(ctx->rt);if(body==1)return JS_Throw(ctx,JS_DupValue(ctx,data[0]));return JS_DupValue(ctx,data[0]);
}
static void getter(JSContext *ctx,JSValue object,JSAtom key,int body,int result,int is_exotic){
 JSValue data=JS_NewInt32(ctx,result),fn=checked(JS_NewCFunctionData(ctx,callback,0,body,1,&data));
 if(is_exotic)store(ctx,object,key,21,1,JS_UNDEFINED,fn);
 else if(JS_DefineProperty(ctx,object,key,JS_UNDEFINED,fn,JS_UNDEFINED,JS_PROP_HAS_GET|JS_PROP_HAS_CONFIGURABLE|JS_PROP_HAS_ENUMERABLE|5)<0)abort();
 JS_FreeValue(ctx,fn);
}
static void tdz(JSContext *ctx,JSValue object){
 JSVarRef *cell=js_create_var_ref(ctx,TRUE);if(!cell)abort();
 JSProperty *p=add_property(ctx,JS_VALUE_GET_OBJ(object),JS_ATOM_value,39);if(!p)abort();p->u.var_ref=cell;
}
static void physical(JSValueConst object,JSAtom atom,unsigned *present,unsigned *flags,unsigned *value){
 *present=*flags=*value=0;if(!JS_IsObject(object))return;
 JSProperty *p;JSShapeProperty *sp=find_own_property(&p,JS_VALUE_GET_OBJ(object),atom);if(!sp)return;
 *present=1;*flags=sp->flags;if(!(sp->flags&JS_PROP_TMASK))*value=numeric(p->u.value);
}
static int error_kind(JSContext *ctx,JSValueConst error){
 if(!JS_IsObject(error)||JS_VALUE_GET_OBJ(error)->class_id!=JS_CLASS_ERROR)abort();
 for(int i=0;i<9;i++)if(JS_VALUE_GET_OBJ(error)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))return 10+i;
 abort();
}
static unsigned one(int scenario,int assignment,int cutoff,int emit){
 memset(rec,0,sizeof(rec));mode=scenario;fail_own=0;
 JSRuntime *rt=JS_NewRuntime2(&allocator,NULL);if(!rt)abort();JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
 if(JS_NewClass(rt,67,&definition))abort();
 JSValue target=checked(JS_NewObjectProto(ctx,JS_NULL)),source=JS_NULL,excluded,proto=JS_NULL;
 int is_exotic=exotic_mode(mode);
 if(mode==7)source=checked(JS_NewString(ctx,"abc"));
 else if(mode!=15){source=checked(JS_NewObjectProtoClass(ctx,JS_NULL,is_exotic?67:JS_CLASS_OBJECT));
  if(is_exotic){Stored *s=js_mallocz(ctx,sizeof(*s));if(!s)abort();JS_SetOpaque(source,s);}}
 JSAtom symbol=atom(ctx,"symbol",1),hidden=atom(ctx,"hidden",0),private_name=atom(ctx,"private",2);
 if(mode==4){proto=checked(JS_NewObjectProto(ctx,JS_NULL));put(ctx,proto,JS_ATOM_value,JS_NewInt32(ctx,1),7,0,1);}
 excluded=checked(JS_NewObjectProto(ctx,proto));JS_FreeValue(ctx,proto);
 if(JS_IsObject(source)){
  if(mode==16)tdz(ctx,source);
  else if(mode==2||mode==3||mode==4||mode==5||mode==6||mode==10||mode==14||mode==17||mode==18||mode==19){
   int body=0,result=11;if(mode==3||mode==5||mode==6||mode==10){body=1;result=37;}
   if(mode==17)body=3;if(mode==18||mode==19)body=6;getter(ctx,source,JS_ATOM_value,body,result,is_exotic);
  } else if(mode==23){JSValue text=checked(JS_NewString(ctx,"owned"));put(ctx,source,JS_ATOM_value,text,7,0,1);JS_FreeValue(ctx,text);}
  else put(ctx,source,JS_ATOM_value,JS_NewInt32(ctx,1),7,is_exotic,mode!=22);
  if(mode==21)getter(ctx,source,JS_ATOM_name,1,37,0);else put(ctx,source,JS_ATOM_name,JS_NewInt32(ctx,2),7,is_exotic,mode!=22);
  put(ctx,source,symbol,JS_NewInt32(ctx,3),7,is_exotic,mode!=22);
  put(ctx,source,hidden,JS_NewInt32(ctx,9),3,is_exotic,0);put(ctx,source,private_name,JS_NewInt32(ctx,8),7,is_exotic,1);
 }
 if(mode==3||mode==13||mode==16)put(ctx,excluded,JS_ATOM_value,JS_NULL,7,0,1);
 if(mode==5)getter(ctx,excluded,JS_ATOM_value,1,77,0);
 if(mode==6){static const JSCFunctionListEntry entry=JS_PROP_INT32_DEF("value",7,7);
  if(JS_DefineAutoInitProperty(ctx,excluded,JS_ATOM_value,JS_AUTOINIT_ID_PROP,(void*)&entry,7)<0)abort();}
 if(mode==12)tdz(ctx,excluded);if(mode==12||mode==13)fail_own=1;
 if(mode==8)JS_VALUE_GET_OBJ(target)->extensible=0;
 if(mode==9)put(ctx,target,JS_ATOM_value,JS_NewInt32(ctx,9),0,0,1);
 if(mode==1||mode==20){JSValue data=JS_NewInt32(ctx,77),fn=checked(JS_NewCFunctionData(ctx,callback,1,mode==20?1:4,1,&data));
  if(JS_DefineProperty(ctx,target,JS_ATOM_value,JS_UNDEFINED,JS_UNDEFINED,fn,JS_PROP_HAS_SET|JS_PROP_HAS_CONFIGURABLE|JS_PROP_HAS_ENUMERABLE|5)<0)abort();JS_FreeValue(ctx,fn);}
 fault_after=cutoff;int result=JS_CopyDataProperties(ctx,target,source,excluded,assignment);fault_after=-1;
 rec[0]=result==0;if(JS_HasException(ctx)){JSValue error=JS_GetException(ctx);if(JS_VALUE_GET_TAG(error)==JS_TAG_INT){rec[1]=1;rec[2]=JS_VALUE_GET_INT(error);}else rec[1]=error_kind(ctx,error);JS_FreeValue(ctx,error);}
 unsigned p,f,v;physical(target,JS_ATOM_value,&p,&f,&v);rec[3]=p;rec[4]=v;rec[13]=f;
 physical(target,JS_ATOM_name,&p,&f,&v);rec[5]=p;rec[6]=v;physical(target,symbol,&p,&f,&v);rec[7]=p;rec[8]=v;
 physical(target,hidden,&p,&f,&v);rec[9]=p;physical(excluded,JS_ATOM_value,&p,&f,&v);rec[15]=p&&(f&JS_PROP_TMASK)==JS_PROP_AUTOINIT;
 physical(target,private_name,&p,&f,&v);rec[16]=p;
 if(is_exotic){Stored *s=JS_GetOpaque(source,67);for(int i=0;i<s->count;i++)if(s->entries[i].atom==JS_ATOM_name)rec[17]=(s->entries[i].flags&4)!=0;}
 else {physical(source,JS_ATOM_name,&p,&f,&v);rec[17]=p&&(f&4)!=0;}
 rec[18]=JS_VALUE_GET_OBJ(target)->shape->prop_count;
 JS_FreeValue(ctx,target);JS_FreeValue(ctx,source);JS_FreeValue(ctx,excluded);
 JS_FreeAtom(ctx,symbol);JS_FreeAtom(ctx,hidden);JS_FreeAtom(ctx,private_name);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 if(live_count||live_bytes)abort();if(emit)for(int i=0;i<19;i++)word(rec[i]);return result<0;
}
int main(void){
 for(int m=0;m<24;m++)for(int assignment=0;assignment<2;assignment++)one(m,assignment,-1,1);
 unsigned attempts=0,failed=0;int modes[]={0,1,11,14,19,23};
 for(int i=0;i<6;i++)for(int assignment=0;assignment<2;assignment++)for(int cutoff=0;cutoff<48;cutoff++){failed+=one(modes[i],assignment,cutoff,0);attempts++;}
 word(attempts);word(failed);word(attempts-failed);word(live_count);word(live_bytes);return 0;
}
'''
SILK_SOURCE = r'''
import silk.allocator {Allocator,OutOfMemoryError}
import silk.effect {Effect}
import silk.writer {Writer,WriterError}
import silk.os_writer {StdoutWriter}
import silk.u32
import byte_buffer {ByteBuffer}
import js_string_types {StringLengthError}
import js_copy_data_properties_test_support as fixture
pub effect fn main()->i32 ! OutOfMemoryError | StringLengthError | WriterError {
 let mut allocator=Allocator.systemAllocatorProvider() let mut out=ByteBuffer.make()
 let mut mode:u32=0
 while mode<24 {
  let mut assignment:u32=0
  while assignment<2 {
   let record=run fixture.runCase(mode,assignment!=0,-1)
   let mut field:usize=0 while field<record.length {run out.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut allocator) field=field+1}
   assignment=assignment+1
  }
  mode=mode+1
 }
 let modes:[u32;6]=[0,1,11,14,19,23] let mut at:usize=0 let mut attempts:u32=0 let mut failed:u32=0
 while at<modes.length {
  let mut assignment:u32=0
  while assignment<2 {
   let mut cutoff:i32=0
   while cutoff<48 {
    let record=run fixture.runCase(modes[at],assignment!=0,cutoff)
    if record[0]==0 {failed=failed+1} attempts=attempts+1 cutoff=cutoff+1
   }
   assignment=assignment+1
  }
  at=at+1
 }
 run out.writeU32(attempts) |> Effect.provideMut<Allocator>(&mut allocator)
 run out.writeU32(failed) |> Effect.provideMut<Allocator>(&mut allocator)
 run out.writeU32(attempts-failed) |> Effect.provideMut<Allocator>(&mut allocator)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 run out.writeU32(0) |> Effect.provideMut<Allocator>(&mut allocator)
 let mut writer=StdoutWriter.make() run Writer.writeAll(out.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
 return 0
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='/usr/bin/cc')
    args = parser.parse_args()
    reference = args.reference.resolve()
    pins = validate_pins(reference)
    with tempfile.TemporaryDirectory(prefix='silkjs-copy-data-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(C_SOURCE)
        process([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char',
                 '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-D__SANITIZE_ADDRESS__',
                 '-DCONFIG_VERSION="differential"', '-I', str(reference), str(temp / 'oracle.c'),
                 *(str(reference / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')],
                600, owner='Copy C compilation')
        expected = process([str(temp / 'oracle')], 600, owner='Independent C copying consumer')
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(SILK_SOURCE)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="copy-data-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        actual = process(command,
                         1200, owner='Independent native copying consumer', cwd=temp)
        semantic_size = len(CASES) * FIELDS * 4
        summaries = []
        for label, data in (('C', expected), ('Silk', actual)):
            if len(data) != semantic_size + 20:
                raise SystemExit(f'{label} copying record size {len(data)} != {semantic_size + 20}')
            summary = struct.unpack('<5I', data[semantic_size:])
            if summary[0] != len(FAULT_MODES) * 2 * 48 or summary[1] == 0 or summary[2] == 0 or summary[3:] != (0, 0):
                raise SystemExit(f'{label} invalid independent fault/ledger summary: {summary}')
            summaries.append(summary)
        if actual[:semantic_size] != expected[:semantic_size]:
            for offset in range(0, semantic_size, 4):
                c, native = struct.unpack_from('<I', expected, offset)[0], struct.unpack_from('<I', actual, offset)[0]
                if c != native:
                    case, field = divmod(offset // 4, FIELDS)
                    raise SystemExit(f'Copy mode/assignment={CASES[case]} field={field}: C={c}, Silk={native}')
        print(f'PASS CopyDataProperties: {len(CASES)} independent records; {pins} pinned files; '
              f'sha256={hashlib.sha256(actual[:semantic_size]).hexdigest()}')
        print(f'OOM: {summaries[0][0]} isolated attempts/engine; failures C={summaries[0][1]} native={summaries[1][1]}; every final ledger zero')

if __name__ == '__main__':
    main()
