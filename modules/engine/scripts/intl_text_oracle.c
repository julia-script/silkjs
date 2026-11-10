/* Independent host shim for extracted, unmodified pinned Intl algorithm bodies.
 * It supplies only JS storage/coercion/allocation envelopes, never text rules.
 * No part of this executable is linked into Silk. Generated includes live in tmp.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <limits.h>
#include "cutils.h"
#include "libunicode.h"
typedef void JSContext;
typedef struct {
    const uint16_t *units; int length; void *opaque;
    int number, present, index, segment_len, word, include_word;
} JSValue;
typedef JSValue JSValueConst;
#define JS_UNDEFINED ((JSValue){0})
#define JS_EXCEPTION ((JSValue){.present=-1})
static int js_collator_class_id=1, js_segmenter_class_id=2;
static int js_segments_class_id=3, js_segment_iterator_class_id=4;
static void *JS_GetOpaque2(JSContext *ctx,JSValue v,int id){(void)ctx;(void)id;return v.opaque;}
static void *JS_GetOpaque(JSValue v,int id){(void)id;return v.opaque;}
static JSValue JS_ToString(JSContext *ctx,JSValue v){(void)ctx;return v;}
static int JS_IsException(JSValue v){return v.present==-1;}
static JSValue JS_DupValue(JSContext *ctx,JSValue v){(void)ctx;return v;}
static void JS_FreeValue(JSContext *ctx,JSValue v){(void)ctx;(void)v;}
static JSValue JS_NewInt32(JSContext *ctx,int n){(void)ctx;return (JSValue){.number=n,.present=1};}
static int JS_ToInt32Sat(JSContext *ctx,int *out,JSValue v){(void)ctx;*out=v.number;return 0;}
static void *JS_GetRuntime(JSContext *ctx){return ctx;}
static void *js_malloc(JSContext *ctx,size_t n){(void)ctx;void *p=malloc(n);if(!p)abort();return p;}
static void js_free(JSContext *ctx,void *p){(void)ctx;free(p);}
/* Correct DynBuf ABI: JS runtime is opaque here, not a mismatched function cast. */
static void *js_realloc_rt(void *ctx,void *p,size_t n){(void)ctx;return realloc(p,n);}
static void *js_realloc(JSContext *ctx,void *p,size_t n){return js_realloc_rt(ctx,p,n);}
static int js_string_get_len(JSValue v){return v.length;}
static int js_string_getc(JSValue v,int *at){
    uint32_t c=v.units[(*at)++];
    if(c>=0xd800&&c<=0xdbff&&*at<v.length){uint32_t d=v.units[*at];if(d>=0xdc00&&d<=0xdfff){(*at)++;return 0x10000+((c-0xd800)<<10)+(d-0xdc00);}}
    return c;
}
static int JS_ToUTF32String(JSContext *ctx,uint32_t **out,JSValue v){
    *out=js_malloc(ctx,((size_t)v.length+1)*4);int at=0,n=0;
    while(at<v.length)(*out)[n++]=js_string_getc(v,&at);return n;
}
static JSValue create_segment_data(JSContext *ctx,JSValue input,int index,int length,int word,int include){
    (void)ctx;(void)input;return (JSValue){.present=1,.index=index,.segment_len=length,.word=word,.include_word=include};
}
#include "pinned_text.inc"
#include "text_cases.inc"
static void emit(uint32_t n){for(int i=0;i<4;i++)putchar((n>>(8*i))&255);}
static void segment(JSValue v){emit(v.present);if(v.present){emit(v.index);emit(v.segment_len);emit(!!v.word);emit(v.include_word);}}
int main(void){
    for(unsigned p=0;p<PAIR_COUNT;p++){
        JSValue args[]={inputs[pairs[p][0]],inputs[pairs[p][1]]};
        for(unsigned l=0;l<LOCALE_COUNT;l++)for(unsigned co=0;co<4;co++)
        for(int usage=0;usage<2;usage++)for(int sensitivity=0;sensitivity<4;sensitivity++)
        for(int first=0;first<3;first++)for(int numeric=0;numeric<2;numeric++)for(int punctuation=0;punctuation<2;punctuation++){
            JSCollatorData options={.locale=(char *)locales[l],.collation=(char *)collations[co],.usage=usage,.sensitivity=sensitivity,.caseFirst=first,.numeric=numeric,.ignorePunctuation=punctuation};
            JSValue data={.opaque=&options};JSValue result=js_collator_bound_compare(NULL,JS_UNDEFINED,2,args,0,&data);
            if(JS_IsException(result))abort();emit(result.number);
        }
    }
    for(unsigned n=0;n<INPUT_COUNT;n++)for(unsigned l=0;l<LOCALE_COUNT;l++)for(unsigned co=0;co<4;co++)for(int usage=0;usage<2;usage++)for(int punct=0;punct<2;punct++)for(int level=0;level<4;level++){
        JSCollatorData options={.locale=(char *)locales[l],.collation=(char *)collations[co],.usage=usage,.ignorePunctuation=punct};
        uint32_t *source,*key;int size=JS_ToUTF32String(NULL,&source,inputs[n]),length;
        key=transform_string(NULL,&options,source,size,&length,level);if(!key)abort();emit(length);for(int i=0;i<length;i++)emit(key[i]);free(key);free(source);
    }
    for(unsigned n=0;n<INPUT_COUNT;n++)for(int g=0;g<3;g++){
        JSSegmenterData options={.granularity=g};JSValue opt={.opaque=&options};
        JSSegmentsData segments={.segmenter=opt,.string=inputs[n]};JSValue seg={.opaque=&segments};
        JSSegmentIteratorData iterator={.segmenter=opt,.string=inputs[n]};JSValue iter={.opaque=&iterator};
        for(int i=0;i<inputs[n].length+2;i++){
            int done=-1;JSValue v=js_segment_iterator_next(NULL,iter,0,NULL,&done,0);emit(done);segment(v);
        }
        for(int i=-1;i<=inputs[n].length;i++){JSValue pos={.number=i};segment(js_segments_containing(NULL,seg,1,&pos));}
        JSValue pos={.number=INT_MIN};segment(js_segments_containing(NULL,seg,1,&pos));
        pos.number=INT_MAX;segment(js_segments_containing(NULL,seg,1,&pos));
    }
    /* Every Unicode point tests the full property-domain boundary; extender's
       previous-point branches are separately crossed with adversarial sequences. */
    for(uint32_t c=0;c<0x110000;c++){
        emit(is_combining_mark(c));emit(!!is_significant(c));emit(is_grapheme_extender(0,c));emit(hangul_jamo_type(c));
    }
    return ferror(stdout)?1:0;
}
