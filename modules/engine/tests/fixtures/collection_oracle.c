/* Separate process only: unchanged pinned quickjs.c owns all collection behavior. */
#include "quickjs.c"
#undef malloc
#undef free
#undef realloc
#include <stddef.h>

typedef union { max_align_t align; size_t size; } CollectionHeader;
static size_t live_count, live_bytes, failures;
static long remaining = -1;
static int persistent;
static int fault(void) {
    if (remaining < 0) return 0;
    if (remaining) { remaining--; return 0; }
    failures++;
    if (!persistent) remaining = -1;
    return 1;
}
static void *collection_allocate(JSMallocState *s, size_t n) {
    if (!n || fault()) return NULL;
    CollectionHeader *h = malloc(sizeof(*h) + n);
    if (!h) return NULL;
    h->size = n; live_count++; live_bytes += n; s->malloc_count++; s->malloc_size += n;
    return h + 1;
}
static void collection_release(JSMallocState *s, void *p) {
    if (!p) return;
    CollectionHeader *h = (CollectionHeader *)p - 1;
    live_count--; live_bytes -= h->size; s->malloc_count--; s->malloc_size -= h->size;
    free(h);
}
static void *collection_resize(JSMallocState *s, void *p, size_t n) {
    if (!p) return collection_allocate(s, n);
    if (!n) { collection_release(s, p); return NULL; }
    if (fault()) return NULL;
    CollectionHeader *h = (CollectionHeader *)p - 1;
    size_t old = h->size;
    CollectionHeader *r = realloc(h, sizeof(*h) + n);
    if (!r) return NULL;
    r->size = n; live_bytes = live_bytes - old + n; s->malloc_size = s->malloc_size - old + n;
    return r + 1;
}
static size_t collection_usable(const void *p) { return p ? ((const CollectionHeader *)p - 1)->size : 0; }
static const JSMallocFunctions collection_allocator = { collection_allocate, collection_release, collection_resize, collection_usable };
static JSValue roots[64];
static uint32_t rec[16];
static unsigned scenario, mode, family;
static JSValue checked(JSValue v) { if (JS_IsException(v)) abort(); return v; }
static double number(JSValueConst v) { return JS_VALUE_GET_TAG(v) == JS_TAG_INT ? JS_VALUE_GET_INT(v) : JS_VALUE_GET_FLOAT64(v); }
static uint32_t mix(uint32_t h, uint32_t v) { return (h * 31 + v) & 65535; }
static JSValue dispatch(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv, int encoded) {
    int f = encoded >> 8, m = encoded & 255;
    switch (m) {
    case 0: return js_map_constructor(ctx, receiver, argc, argv, f);
    case 1: return js_map_set(ctx, receiver, argc, argv, f);
    case 2: return js_map_get(ctx, receiver, argc, argv, f);
    case 3: return js_map_has(ctx, receiver, argc, argv, f);
    case 4: return js_map_delete(ctx, receiver, argc, argv, f);
    case 5: return js_map_clear(ctx, receiver, argc, argv, f);
    case 6: return js_map_get_size(ctx, receiver, f);
    case 7: return js_map_forEach(ctx, receiver, argc, argv, f);
    case 8: return js_create_map_iterator(ctx, receiver, argc, argv, f);
    case 9: return js_create_map_iterator(ctx, receiver, argc, argv, ((f & 1 ? JS_ITERATOR_KIND_KEY : JS_ITERATOR_KIND_VALUE) << 2) | f);
    case 10: return js_create_map_iterator(ctx, receiver, argc, argv, (JS_ITERATOR_KIND_KEY_AND_VALUE << 2) | f);
    case 12: case 13: return js_map_getOrInsert(ctx, receiver, argc, argv, ((JS_CLASS_MAP + f) << 1) | (m == 13));
    case 14: return JS_DupValue(ctx, receiver);
    case 15: return js_object_groupBy(ctx, receiver, argc, argv, 1);
    case 16: return js_set_isDisjointFrom(ctx, receiver, argc, argv);
    case 17: return js_set_isSubsetOf(ctx, receiver, argc, argv);
    case 18: return js_set_isSupersetOf(ctx, receiver, argc, argv);
    case 19: return js_set_intersection(ctx, receiver, argc, argv);
    case 20: return js_set_difference(ctx, receiver, argc, argv);
    case 21: return js_set_symmetricDifference(ctx, receiver, argc, argv);
    case 22: return js_set_union(ctx, receiver, argc, argv);
    default: abort();
    }
}
static JSValue getter(JSContext *ctx, JSValueConst receiver, int magic) { return js_map_get_size(ctx, receiver, magic >> 8); }
static JSValue next(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv, int *done, int magic) {
    return js_map_iterator_next(ctx, receiver, argc, argv, done, magic >> 8);
}
static JSValue invoke(JSContext *ctx, unsigned method, JSValueConst receiver, int argc, JSValueConst *argv) {
    JSValue function = roots[32 + method];
    return js_call_c_function(ctx, function, method == 0 ? function : receiver, argc, argv, method == 0 ? JS_CALL_FLAG_CONSTRUCTOR : 0);
}
static int discard(JSContext *ctx, unsigned method, JSValueConst receiver, int argc, JSValueConst *argv) {
    JSValue result = invoke(ctx, method, receiver, argc, argv);
    if (JS_IsException(result)) return -1;
    JS_FreeValue(ctx, result); return 0;
}
static int put(JSContext *ctx, JSValueConst obj, JSAtom atom, JSValueConst value) {
    return JS_DefinePropertyValue(ctx, obj, atom, JS_DupValue(ctx, value), JS_PROP_C_W_E);
}
static JSValue observed(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv, int id) {
    rec[3]++; rec[4] = (rec[4] * 17 + id - 1000) & 65535;
    JS_RunGC(ctx->rt);
    JSValue target = roots[0], args[2];
    if (id == 1000) {
        double key = number(argv[1]); rec[8] = rec[8] * 10 + key;
        if (JS_VALUE_GET_PTR(argv[2]) == JS_VALUE_GET_PTR(target)) rec[9]++;
        if (key == 1) {
            args[0] = JS_NewInt32(ctx, 2); if (discard(ctx, 4, target, 1, args)) return JS_EXCEPTION;
            args[0] = JS_NewInt32(ctx, 4); args[1] = JS_NewInt32(ctx, 40); if (discard(ctx, 1, target, 2, args)) return JS_EXCEPTION;
        }
        if (key == 3) {
            if (discard(ctx, 5, target, 0, NULL)) return JS_EXCEPTION;
            args[0] = JS_NewInt32(ctx, 5); args[1] = JS_NewInt32(ctx, 50); if (discard(ctx, 1, target, 2, args)) return JS_EXCEPTION;
        }
        return JS_UNDEFINED;
    }
    if (id == 1001) {
        double key = number(argv[0]); rec[8] = key == 0 && !signbit(key);
        args[0] = argv[0]; args[1] = JS_NewInt32(ctx, 90); if (discard(ctx, 1, target, 2, args)) return JS_EXCEPTION;
        args[0] = JS_NewInt32(ctx, 3); args[1] = JS_NewInt32(ctx, 30); if (discard(ctx, 1, target, 2, args)) return JS_EXCEPTION;
        return JS_NewInt32(ctx, 99);
    }
    if (id == 1002) {
        if (mode == 4) return JS_Throw(ctx, JS_NewInt32(ctx, 707));
        if (mode == 2 && !rec[10]) {
            rec[10] = 1; args[0] = JS_NewInt32(ctx, 2); if (discard(ctx, 4, target, 1, args)) return JS_EXCEPTION;
            args[0] = JS_NewInt32(ctx, 4); if (discard(ctx, 1, target, 1, args)) return JS_EXCEPTION;
        }
        return JS_NewBool(ctx, JS_IsNumber(argv[0]) && (number(argv[0]) == 2 || number(argv[0]) == 4));
    }
    if (id == 1003) return JS_DupValue(ctx, roots[10]);
    if (id == 1004) {
        rec[6]++;
        if (mode == 3 && rec[6] == 2) return JS_Throw(ctx, JS_NewInt32(ctx, 707));
        int done = rec[6] > 3;
        return js_create_iterator_result(ctx, JS_DupValue(ctx, done ? JS_UNDEFINED : roots[10 + rec[6]]), done);
    }
    if (id == 1005) { rec[5]++; if(scenario==6 || mode==5)return JS_Throw(ctx, JS_NewInt32(ctx, 909)); return JS_DupValue(ctx,roots[10]); }
    if (id == 1006) {
        if (mode == 2) return JS_Throw(ctx, JS_NewInt32(ctx, 707));
        return js_map_set(ctx, receiver, argc, argv, 0);
    }
    if (id == 1007) return JS_NewInt32(ctx, (int)number(argv[0]) & 1);
    abort();
}
static JSValue callback(JSContext *ctx, unsigned id) { return checked(JS_NewCFunctionMagic(ctx, observed, "collection callback", 3, JS_CFUNC_generic_magic, id)); }
static void install_callback(JSContext *ctx, JSValue obj, JSAtom atom, unsigned id) {
    JSValue fn = callback(ctx, id); if (put(ctx, obj, atom, fn) < 0) abort(); JS_FreeValue(ctx, fn);
}
static uint32_t digest(JSContext *ctx, JSValueConst value, unsigned depth) {
    if (JS_IsNumber(value)) {
        double n = number(value); if (isnan(n)) return 8;
        if (!n) return signbit(n) ? 7 : 6;
        return 1000 + (uint32_t)n;
    }
    if (JS_IsString(value)) {
        JSString *s = JS_VALUE_GET_STRING(value); uint32_t h = 100;
        for (unsigned i = 0; i < s->len; i++) h = mix(h, s->is_wide_char ? s->u.str16[i] : s->u.str8[i]);
        return h;
    }
    if (!JS_IsObject(value)) {
        if (JS_IsUndefined(value)) return 1;
        if (JS_IsNull(value)) return 4;
        if (JS_IsBool(value)) return 2 + JS_VALUE_GET_BOOL(value);
        return 40;
    }
    if (!depth) return 30;
    JSObject *p = JS_VALUE_GET_OBJ(value);
    if (p->class_id >= JS_CLASS_MAP && p->class_id <= JS_CLASS_WEAKSET) {
        unsigned f = p->class_id - JS_CLASS_MAP; JSMapState *s = p->u.map_state;
        if (f >= 2) return 12 + s->record_count;
        uint32_t h = 10 + f; struct list_head *el;
        list_for_each(el, &s->records) {
            JSMapRecord *mr = list_entry(el, JSMapRecord, link);
            if (mr->empty) continue;
            h = mix(h, digest(ctx, mr->key, depth - 1));
            if (!f) h = mix(h, digest(ctx, mr->value, depth - 1));
        }
        return h;
    }
    if (p->class_id == JS_CLASS_ARRAY) {
        JSValue length = checked(JS_GetProperty(ctx, value, JS_ATOM_length));
        unsigned n = number(length); JS_FreeValue(ctx, length); uint32_t h = 20;
        for (unsigned i = 0; i < n; i++) { JSValue item = checked(JS_GetPropertyUint32(ctx, value, i)); h = mix(h, digest(ctx, item, depth - 1)); JS_FreeValue(ctx, item); }
        return h;
    }
    return 30;
}
static void setup(JSContext *ctx) {
    family = scenario >= 16 ? 1 : scenario == 4 ? 2 + mode : 0;
    if (scenario == 13 && mode >= 2) family = 1;
    if (scenario == 14 || scenario == 15) family = scenario - 12;
    for (unsigned m = 0; m < 23; m++) {
        JSCFunctionType fn = { .generic_magic = dispatch }; int protocol = JS_CFUNC_generic_magic;
        if (!m) protocol = JS_CFUNC_constructor_magic;
        if (m == 6) { fn.getter_magic = getter; protocol = JS_CFUNC_getter_magic; }
        if (m == 11) { fn.iterator_next = next; protocol = JS_CFUNC_iterator_next; }
        if (m == 14) { fn.getter = js_get_this; protocol = JS_CFUNC_getter; }
        if (m >= 16) {
            protocol = JS_CFUNC_generic;
            switch (m) {
            case 16: fn.generic = js_set_isDisjointFrom; break;
            case 17: fn.generic = js_set_isSubsetOf; break;
            case 18: fn.generic = js_set_isSupersetOf; break;
            case 19: fn.generic = js_set_intersection; break;
            case 20: fn.generic = js_set_difference; break;
            case 21: fn.generic = js_set_symmetricDifference; break;
            case 22: fn.generic = js_set_union; break;
            }
        }
        roots[32 + m] = checked(JS_NewCFunction2(ctx, fn.generic, "collection intrinsic", 2, protocol, (family << 8) | m));
    }
    roots[0] = checked(invoke(ctx, 0, JS_UNDEFINED, 0, NULL)); JSValue target = roots[0], args[2];
    if (scenario == 0 || scenario == 2 || scenario == 13 || scenario >= 16) {
        for (int i = 1; i <= 3; i++) { args[0] = JS_NewInt32(ctx, i); args[1] = JS_NewInt32(ctx, i * 10); if (discard(ctx, 1, target, 2, args)) abort(); }
    }
    if (scenario == 3 || scenario == 11) { args[0] = JS_NewInt32(ctx, 2); args[1] = JS_NewInt32(ctx, 20); if (discard(ctx, 1, target, 2, args)) abort(); }
    if (scenario == 1) {
        roots[2] = checked(JS_NewString(ctx, "same-content")); roots[3] = checked(JS_NewString(ctx, "same-content"));
        roots[4] = checked(JS_Eval(ctx, "18446744073709551617n", 21, "collection-bigint", JS_EVAL_TYPE_GLOBAL));
        roots[5] = checked(JS_Eval(ctx, "18446744073709551617n", 21, "collection-bigint", JS_EVAL_TYPE_GLOBAL));
    }
    if (scenario == 4 || scenario == 14 || scenario == 15) {
        roots[6] = checked(JS_NewObject(ctx)); roots[7] = checked(JS_NewObject(ctx));
        args[0] = roots[6]; args[1] = roots[7]; if (discard(ctx, 1, target, 2, args)) abort();
    }
    if (scenario == 2 || scenario == 3 || scenario == 7 || scenario == 11) roots[8] = callback(ctx, scenario == 2 ? 1000 : scenario == 7 ? 1007 : 1001);
    if (scenario >= 16 || scenario == 6 || scenario == 7) {
        roots[9] = checked(JS_NewObject(ctx)); roots[10] = checked(JS_NewObject(ctx));
        if (put(ctx, roots[9], JS_ATOM_size, JS_NewInt32(ctx, mode == 1 || mode == 2 ? 9 : 2)) < 0) abort();
        install_callback(ctx, roots[9], JS_ATOM_has, 1002); install_callback(ctx, roots[9], JS_ATOM_keys, 1003);
        install_callback(ctx, roots[9], JS_ATOM_Symbol_iterator, 1003); install_callback(ctx, roots[10], JS_ATOM_next, 1004);
        install_callback(ctx, roots[10], JS_ATOM_return, 1005);
        roots[11] = JS_NewInt32(ctx, 2); roots[12] = JS_NewInt32(ctx, 2); roots[13] = JS_NewInt32(ctx, 4);
        if (scenario == 6) {
            for (int i = 11; i < 14; i++) {
                roots[i] = checked(JS_NewObject(ctx));
                if (JS_DefinePropertyValueUint32(ctx, roots[i], 0, JS_NewInt32(ctx, i - 10), 7) < 0 || JS_DefinePropertyValueUint32(ctx, roots[i], 1, JS_NewInt32(ctx, i), 7) < 0) abort();
            }
            if (mode == 1) { JS_FreeValue(ctx, roots[12]); roots[12] = JS_NewInt32(ctx, 12); }
            roots[14] = checked(JS_NewObject(ctx)); install_callback(ctx, roots[14], JS_ATOM_set, 1006);
            if (put(ctx, roots[32], JS_ATOM_prototype, roots[14]) < 0) abort();
        }
    }
}
#define DO(m,n,...) do { JSValue a_[] = {__VA_ARGS__}; if (discard(ctx,m,target,n,a_)) return JS_EXCEPTION; } while (0)
static JSValue perform(JSContext *ctx) {
    JSValue target = roots[0], args[2];
    if (scenario == 0) {
        roots[1] = invoke(ctx, 8, target, 0, NULL); if (JS_IsException(roots[1])) { roots[1] = JS_UNDEFINED; return JS_EXCEPTION; }
        roots[15] = invoke(ctx, 11, roots[1], 0, NULL); if (JS_IsException(roots[15])) { roots[15] = JS_UNDEFINED; return JS_EXCEPTION; }
        DO(4,1,JS_NewInt32(ctx,1)); DO(4,1,JS_NewInt32(ctx,2)); DO(1,2,JS_NewInt32(ctx,1),JS_NewInt32(ctx,11));
        roots[16] = invoke(ctx, 11, roots[1], 0, NULL); if (JS_IsException(roots[16])) { roots[16] = JS_UNDEFINED; return JS_EXCEPTION; }
        if (discard(ctx, 5, target, 0, NULL)) return JS_EXCEPTION;
        DO(1,2,JS_NewInt32(ctx,4),JS_NewInt32(ctx,44));
        for (int i = 17; i < 19; i++) { roots[i] = invoke(ctx,11,roots[1],0,NULL); if (JS_IsException(roots[i])) { roots[i]=JS_UNDEFINED; return JS_EXCEPTION; } }
        DO(1,2,JS_NewInt32(ctx,5),JS_NewInt32(ctx,55));
        roots[19] = invoke(ctx,11,roots[1],0,NULL); if (JS_IsException(roots[19])) { roots[19]=JS_UNDEFINED; return JS_EXCEPTION; }
        return JS_UNDEFINED;
    }
    if (scenario == 1) {
        DO(1,2,roots[2],JS_NewInt32(ctx,11)); DO(1,2,roots[3],JS_NewInt32(ctx,12));
        DO(1,2,roots[4],JS_NewInt32(ctx,21)); DO(1,2,roots[5],JS_NewInt32(ctx,22));
        DO(1,2,JS_NewFloat64(ctx,-0.0),JS_NewInt32(ctx,31)); DO(1,2,JS_NewInt32(ctx,0),JS_NewInt32(ctx,32));
        DO(1,2,JS_NewFloat64(ctx,NAN),JS_NewInt32(ctx,41)); DO(1,2,JS_NewFloat64(ctx,NAN),JS_NewInt32(ctx,42));
        args[0]=roots[2]; roots[15]=invoke(ctx,2,target,1,args); if(JS_IsException(roots[15])){roots[15]=JS_UNDEFINED;return JS_EXCEPTION;}
        args[0]=roots[4]; roots[16]=invoke(ctx,2,target,1,args); if(JS_IsException(roots[16])){roots[16]=JS_UNDEFINED;return JS_EXCEPTION;}
        return invoke(ctx,6,target,0,NULL);
    }
    if (scenario == 2) { args[0]=roots[8]; args[1]=JS_NewInt32(ctx,77); return invoke(ctx,7,target,2,args); }
    if (scenario == 3) { args[0]=JS_NewFloat64(ctx,-0.0); args[1]=roots[8]; return invoke(ctx,13,target,2,args); }
    if (scenario == 4) {
        rec[8] = __js_rc(JS_VALUE_GET_PTR(roots[6]))->ref_count == 1;
        rec[9] = __js_rc(JS_VALUE_GET_PTR(roots[7]))->ref_count == (family == 2 ? 2 : 1);
        JS_FreeValue(ctx,roots[6]); roots[6]=JS_UNDEFINED; JS_RunGC(ctx->rt);
        rec[10] = __js_rc(JS_VALUE_GET_PTR(roots[7]))->ref_count == 1;
        return JS_UNDEFINED;
    }
    if (scenario == 6) { args[0]=roots[9]; return invoke(ctx,0,JS_UNDEFINED,1,args); }
    if (scenario == 7) { args[0]=roots[9]; args[1]=roots[8]; return invoke(ctx,15,JS_UNDEFINED,2,args); }
    if (scenario == 8) { for(int i=0;i<40;i++){DO(1,2,JS_NewInt32(ctx,i),JS_NewInt32(ctx,i+10));} return invoke(ctx,6,target,0,NULL); }
    if (scenario == 9) { DO(1,2,target,target); roots[0]=JS_UNDEFINED; JS_FreeValue(ctx,target); JS_RunGC(ctx->rt); return JS_UNDEFINED; }
    if (scenario == 10) { DO(12,2,JS_NewInt32(ctx,1),JS_NewInt32(ctx,11)); args[0]=JS_NewInt32(ctx,1);args[1]=JS_NewInt32(ctx,99);return invoke(ctx,12,target,2,args); }
    if (scenario == 11) { args[0]=JS_NewInt32(ctx,2);args[1]=mode==1?JS_NewInt32(ctx,0):roots[8];return invoke(ctx,13,target,2,args); }
    if (scenario == 12) return invoke(ctx,14,target,0,NULL);
    if (scenario == 13) {
        roots[1]=invoke(ctx,9+(mode&1),target,0,NULL);if(JS_IsException(roots[1])){roots[1]=JS_UNDEFINED;return JS_EXCEPTION;}
        for(unsigned i=15;i<19;i++){roots[i]=invoke(ctx,11,roots[1],0,NULL);if(JS_IsException(roots[i])){roots[i]=JS_UNDEFINED;return JS_EXCEPTION;}}
        return JS_UNDEFINED;
    }
    if (scenario == 14 || scenario == 15) {
        args[0]=roots[6];roots[15]=invoke(ctx,3,target,1,args);if(JS_IsException(roots[15])){roots[15]=JS_UNDEFINED;return JS_EXCEPTION;}
        if(scenario==14){roots[16]=invoke(ctx,2,target,1,args);if(JS_IsException(roots[16])){roots[16]=JS_UNDEFINED;return JS_EXCEPTION;}}
        roots[17]=invoke(ctx,4,target,1,args);if(JS_IsException(roots[17])){roots[17]=JS_UNDEFINED;return JS_EXCEPTION;}
        roots[18]=invoke(ctx,3,target,1,args);if(JS_IsException(roots[18])){roots[18]=JS_UNDEFINED;return JS_EXCEPTION;}
        args[0]=JS_NewInt32(ctx,7);return invoke(ctx,3,target,1,args);
    }
    if (scenario >= 16) { args[0]=roots[9]; return invoke(ctx,scenario,target,1,args); }
    abort();
}
static unsigned error_kind(JSContext *ctx, JSValueConst error) {
    if (!JS_IsObject(error)) return 99;
    JSObject *p = JS_VALUE_GET_OBJ(error);
    for (unsigned i=0;i<9;i++) if (JS_IsObject(ctx->native_error_proto[i]) && p->shape->proto == JS_VALUE_GET_OBJ(ctx->native_error_proto[i])) return i;
    return 99;
}
static void word(uint32_t value) { for(unsigned i=0;i<4;i++) putchar((value>>(i*8))&255); }
static void run_case(unsigned s, unsigned m, long cutoff, int hard) {
    scenario=s;mode=m;remaining=-1;persistent=hard;failures=0;
    memset(rec,0,sizeof(rec)); for(unsigned i=0;i<64;i++)roots[i]=JS_UNDEFINED;
    JSRuntime *rt=JS_NewRuntime2(&collection_allocator,NULL);if(!rt)abort();
    JSContext *ctx=JS_NewContext(rt);if(!ctx)abort(); setup(ctx);
    remaining=cutoff; JSValue result=perform(ctx); remaining=-1;
    rec[12]=failures; rec[13]=JS_HasException(ctx);
    if(JS_IsException(result)) { JSValue error=JS_GetException(ctx);rec[7]=JS_IsNumber(error)?(unsigned)number(error):100+error_kind(ctx,error);JS_FreeValue(ctx,error); }
    else { rec[0]=1;rec[1]=digest(ctx,result,5);if(scenario==12)rec[8]=JS_VALUE_GET_PTR(result)==JS_VALUE_GET_PTR(roots[0]);JS_FreeValue(ctx,result); }
    if(JS_HasException(ctx)){JSValue pending=JS_GetException(ctx);rec[7]=JS_IsNumber(pending)?(unsigned)number(pending):100+error_kind(ctx,pending);JS_FreeValue(ctx,pending);}
    rec[2]=digest(ctx,roots[0],5);
    if(scenario==0 || scenario==13) {
        unsigned h=0;for(unsigned i=15;i<20;i++)if(JS_IsObject(roots[i])){
            JSValue v=checked(JS_GetProperty(ctx,roots[i],JS_ATOM_value)),d=checked(JS_GetProperty(ctx,roots[i],JS_ATOM_done));
            h=mix(h,digest(ctx,v,1));h=mix(h,digest(ctx,d,1));JS_FreeValue(ctx,v);JS_FreeValue(ctx,d);
        }rec[8]=h;
    }
    if(scenario==1){rec[8]=digest(ctx,roots[15],1);rec[9]=digest(ctx,roots[16],1);}
    if(scenario==14 || scenario==15)for(unsigned i=0;i<4;i++)rec[8+i]=digest(ctx,roots[15+i],1);
    for(unsigned i=0;i<64;i++)JS_FreeValue(ctx,roots[i]);
    JS_RunGC(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);
    rec[14]=live_count;rec[15]=live_bytes;
    for(unsigned i=0;i<16;i++)word(rec[i]);
    if(live_count||live_bytes){fprintf(stderr,"collection C leak scenario=%u mode=%u cutoff=%ld hard=%d count=%zu bytes=%zu\n",s,m,cutoff,hard,live_count,live_bytes);exit(1);}
}
int main(void) {
    /* COLLECTION_CALLS */
    return 0;
}
