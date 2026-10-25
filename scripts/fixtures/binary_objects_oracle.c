/* Independent pinned-C process: never linked into the native executable. */
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#if JS_LIMB_BITS != 32 || !SHORT_OPCODES
#error Required pinned 32-bit-limb short-opcode profile
#endif
#include <stddef.h>
typedef union Allocation { struct { size_t size; } h; max_align_t alignment; } Allocation;
static size_t live_count, live_bytes, shared_count;
static long fault_after = -1;
static unsigned faults;
static int refuse(void) {
    if (fault_after == 0) { fault_after = -1; faults++; return 1; }
    if (fault_after > 0) fault_after--;
    return 0;
}
static void *counted_malloc(JSMallocState *s, size_t size) {
    if (!size || refuse()) return NULL;
    Allocation *p = malloc(sizeof(*p) + size);
    if (!p) return NULL;
    p->h.size = size; live_count++; live_bytes += size;
    s->malloc_count++; s->malloc_size += size;
    return p + 1;
}
static void counted_free(JSMallocState *s, void *ptr) {
    if (!ptr) return;
    Allocation *p = (Allocation *)ptr - 1;
    live_count--; live_bytes -= p->h.size;
    s->malloc_count--; s->malloc_size -= p->h.size;
    free(p);
}
static void *counted_realloc(JSMallocState *s, void *ptr, size_t size) {
    if (!ptr) return counted_malloc(s, size);
    if (!size) { counted_free(s, ptr); return NULL; }
    if (refuse()) return NULL;
    Allocation *p = (Allocation *)ptr - 1;
    size_t old = p->h.size;
    p = realloc(p, sizeof(*p) + size);
    if (!p) return NULL;
    p->h.size = size; live_bytes = live_bytes - old + size;
    s->malloc_size = s->malloc_size - old + size;
    return p + 1;
}
static size_t counted_usable(const void *ptr) { return ptr ? ((const Allocation *)ptr - 1)->h.size : 0; }
static const JSMallocFunctions allocator = { counted_malloc, counted_free, counted_realloc, counted_usable };
typedef union Shared { struct { size_t references; } h; max_align_t alignment; } Shared;
static void *shared_alloc(void *opaque, size_t size) {
    Shared *p = calloc(1, sizeof(*p) + (size ? size : 1));
    if (!p) return NULL;
    p->h.references = 1; shared_count++; return p + 1;
}
static void shared_dup(void *opaque, void *ptr) { if (ptr) ((Shared *)ptr - 1)->h.references++; }
static void shared_free(void *opaque, void *ptr) {
    if (!ptr) return;
    Shared *p = (Shared *)ptr - 1;
    if (!--p->h.references) { shared_count--; free(p); }
}
static uint32_t getword(void) {
    uint32_t result = 0;
    for (unsigned i=0;i<4;i++) { int c=getchar(); if(c==EOF) abort(); result|=(uint32_t)c<<(8*i); }
    return result;
}
static void word(uint32_t value) { for (unsigned i=0;i<4;i++) putchar(value>>(8*i)); }
static uint8_t *getblob(size_t *size) {
    *size=getword(); uint8_t *p=malloc(*size+1); if(!p)abort();
    if(fread(p,1,*size,stdin)!=*size)abort(); p[*size]=0; return p;
}
static void blob(const uint8_t *data,size_t size) { word(size); if(size)fwrite(data,1,size,stdout); }
static unsigned error_kind(JSContext *ctx) {
    if (!JS_HasException(ctx)) return 100;
    JSValue e=JS_GetException(ctx); unsigned result=99;
    if(JS_IsObject(e)&&JS_VALUE_GET_OBJ(e)->class_id==JS_CLASS_ERROR)
        for(unsigned i=0;i<9;i++)if(JS_VALUE_GET_OBJ(e)->shape->proto==JS_VALUE_GET_OBJ(ctx->native_error_proto[i]))result=i;
    JS_FreeValue(ctx,e); return result;
}
int main(void) {
    size_t source_len,check_len,input_len;
    uint8_t *source=getblob(&source_len),*check=getblob(&check_len),*input=getblob(&input_len);
    unsigned eval_flags=getword(),flags=getword(),mode=getword(),cutoff=getword();
    unsigned relocation_count=getword();
    uint32_t *offsets=calloc(relocation_count?relocation_count:1,sizeof(*offsets));
    uint32_t *indices=calloc(relocation_count?relocation_count:1,sizeof(*indices));
    for(unsigned i=0;i<relocation_count;i++){offsets[i]=getword();indices[i]=getword();}
    uint32_t row[10]={0};
    JSRuntime *rt=JS_NewRuntime2(&allocator,NULL); if(!rt)abort();
    JSSharedArrayBufferFunctions sab_funcs={shared_alloc,shared_free,shared_dup,NULL};
    JS_SetSharedArrayBufferFunctions(rt,&sab_funcs);
    JSContext *ctx=JS_NewContext(rt);if(!ctx)abort();
    JSValue value=JS_UNDEFINED,decoded=JS_UNDEFINED;
    uint8_t *written=NULL,*rewritten=NULL,**shared=NULL,**shared2=NULL;
    size_t written_len=0,rewritten_len=0,shared_len=0,shared2_len=0;
    int failed=0,needs_source=mode==0||mode==3||relocation_count;
    if((eval_flags&JS_EVAL_TYPE_MODULE)&&mode!=2){
        const char *names[]={"dep","other","data"};
        const char *sources[]={"export default 41; export const x=42,z=43;","export const q=1;","export default {answer:42};"};
        for(unsigned i=0;i<3;i++){
            JSValue module=JS_Eval(ctx,sources[i],strlen(sources[i]),names[i],JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY);
            if(JS_IsException(module)){failed=1;row[0]=1;row[2]=error_kind(ctx);break;}
            JS_FreeValue(ctx,module);
        }
    }
    if(!failed&&needs_source){
        row[0]=1;value=JS_Eval(ctx,(char*)source,source_len,"binary-fixture.js",eval_flags);
        if(JS_IsException(value)){value=JS_UNDEFINED;failed=1;row[2]=error_kind(ctx);}
    }
    if(!failed&&needs_source){
        row[0]=2;if(mode==3)fault_after=cutoff;
        written=JS_WriteObject2(ctx,&written_len,value,flags,&shared,&shared_len);fault_after=-1;
        if(!written){failed=1;row[2]=error_kind(ctx);}
    }
    row[5]=shared_len;
    if(!failed){
        for(unsigned i=0;i<relocation_count;i++){
            if(offsets[i]>input_len||input_len-offsets[i]<8||indices[i]>=shared_len)abort();
            put_u64(input+offsets[i],(uintptr_t)shared[indices[i]]);
        }
        row[0]=3;if(mode==4)fault_after=cutoff;
        const uint8_t *bytes=input;size_t size=input_len;
        if(mode==0||mode==3){bytes=written;size=written_len;}
        unsigned read_flags=flags;
        if(mode==0||mode==3)read_flags&=~JS_READ_OBJ_ROM_DATA;
        decoded=JS_ReadObject(ctx,bytes,size,read_flags);fault_after=-1;
        if(JS_IsException(decoded)){decoded=JS_UNDEFINED;failed=1;row[2]=error_kind(ctx);}
        else if(JS_VALUE_GET_TAG(decoded)==JS_TAG_FUNCTION_BYTECODE)row[6]=((JSFunctionBytecode*)JS_VALUE_GET_PTR(decoded))->read_only_bytecode;
    }
    if(!failed&&mode!=2){
        row[0]=4;rewritten=JS_WriteObject2(ctx,&rewritten_len,decoded,flags,&shared2,&shared2_len);
        if(!rewritten){failed=1;row[2]=error_kind(ctx);}
    }
    if(!failed&&mode!=2&&check_len&&(eval_flags&JS_EVAL_FLAG_COMPILE_ONLY)&&JS_VALUE_GET_TAG(decoded)==JS_TAG_MODULE){
        row[0]=5;
        if(JS_ResolveModule(ctx,decoded)<0){failed=1;row[2]=error_kind(ctx);}
    }
    if(!failed&&mode!=2&&check_len){
        row[0]=5;JSValue result=JS_DupValue(ctx,decoded);
        if(eval_flags&JS_EVAL_FLAG_COMPILE_ONLY)result=JS_EvalFunction(ctx,result);
        if(JS_IsException(result)){failed=1;row[2]=error_kind(ctx);}
        else if(JS_SetPropertyStr(ctx,ctx->global_obj,"__binary",result)<0){failed=1;row[2]=error_kind(ctx);}
        else {
            JSValue tested=JS_Eval(ctx,(char*)check,check_len,"binary-check.js",0);
            if(JS_IsException(tested)){failed=1;row[2]=error_kind(ctx);}
            else {row[3]=JS_IsBool(tested)&&JS_VALUE_GET_INT(tested);JS_FreeValue(ctx,tested);}
        }
    }
    if(!failed&&!check_len)row[3]=1;
    row[1]=!failed;row[4]=faults;
    blob(written,written_len);blob(rewritten,rewritten_len);
    js_free(ctx,written);js_free(ctx,rewritten);js_free(ctx,shared);js_free(ctx,shared2);
    JS_FreeValue(ctx,decoded);JS_FreeValue(ctx,value);
    JSValue pending=JS_GetException(ctx);JS_FreeValue(ctx,pending);
    JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
    row[7]=shared_count;row[8]=live_count;row[9]=live_bytes;
    for(unsigned i=0;i<10;i++)word(row[i]);
    free(offsets);free(indices);free(source);free(check);free(input);
    return 0;
}
