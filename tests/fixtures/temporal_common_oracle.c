/* Independent transport for the pinned, unmodified shared Temporal C routines.
 * verify_temporal_common.py supplies extracted definitions and binary inputs.
 * JS stubs below provide string transport/allocation and discard exception text;
 * no parsing, calendar, timezone, arithmetic or rounding algorithm is stubbed.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <limits.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include "quickjs.h"
#include "cutils.h"
#include "temporal/temporal_private.h"

typedef struct { const char *bytes; size_t length; } OracleString;
const char *JS_ToCStringLen2(JSContext *ctx, size_t *length, JSValueConst value, JS_BOOL cesu8) {
    (void)ctx; (void)cesu8;
    const OracleString *s = JS_VALUE_GET_PTR(value);
    if (length) *length = s->length;
    return s->bytes;
}
void JS_FreeCString(JSContext *ctx, const char *s) { (void)ctx; (void)s; }
void *js_malloc(JSContext *ctx, size_t n) { (void)ctx; void *p = malloc(n); if (!p) abort(); return p; }
void js_free(JSContext *ctx, void *p) { (void)ctx; free(p); }
static int exception_kind;
JSValue JS_ThrowRangeError(JSContext *ctx, const char *fmt, ...) { (void)ctx; (void)fmt; exception_kind=1; return JS_EXCEPTION; }
JSValue JS_ThrowTypeError(JSContext *ctx, const char *fmt, ...) { (void)ctx; (void)fmt; exception_kind=2; return JS_EXCEPTION; }
JSValue JS_NewStringLen(JSContext *ctx, const char *s, size_t n) {
    (void)ctx; static OracleString result; result.bytes=s;result.length=n;
    return JS_MKPTR(JS_TAG_STRING,&result);
}
/* JS values here only transport borrowed fixture strings, never real objects. */
#define JS_FreeValue(ctx,value) ((void)(ctx),(void)(value))
static const char *observed_env,*observed_link,*observed_line;
static size_t observed_link_length,observed_line_length;
static int observed_offset,observed_closes;
static char *oracle_getenv(const char *name) { (void)name;return (char *)observed_env; }
static ssize_t oracle_readlink(const char *path,char *out,size_t capacity) {
    (void)path;size_t n=observed_link_length;if(n>capacity)n=capacity;
    memcpy(out,observed_link,n);return n?(ssize_t)n:-1;
}
static FILE *oracle_fopen(const char *path,const char *mode) {
    (void)path;(void)mode;return observed_line_length?(FILE *)&observed_closes:NULL;
}
static char *oracle_fgets(char *out,int capacity,FILE *stream) {
    (void)stream;size_t n=0;
    while(n<observed_line_length && n+1<(size_t)capacity) {out[n]=observed_line[n];n++;if(out[n-1]=='\n')break;}
    out[n]=0;return n?out:NULL;
}
static int oracle_fclose(FILE *stream) { (void)stream;observed_closes++;return 0; }
static time_t oracle_time(time_t *out) { if(out)*out=0;return 0; }
static struct tm *oracle_localtime_r(const time_t *time,struct tm *out) {
    (void)time;memset(out,0,sizeof(*out));out->tm_gmtoff=-(int64_t)observed_offset*60;return out;
}
#include "temporal_common_extracted.h"

static uint64_t read_word(FILE *in) {
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; i++) { int c = fgetc(in); if (c == EOF) abort(); value |= (uint64_t)c << (8*i); }
    return value;
}
static void write_word(uint64_t value) { for (unsigned i = 0; i < 8; i++) putchar((value >> (8*i)) & 255); }
static js_int128_t wide(const uint64_t *a) { return (js_int128_t)((js_uint128_t)a[0] | (js_uint128_t)a[1] << 64); }
static void wide_out(uint64_t *r, js_int128_t v) { r[0] = (uint64_t)v; r[1] = (uint64_t)((js_uint128_t)v >> 64); }
static JSDurationData duration(const uint64_t *a) {
    JSDurationData d = {0};
    d.years=(int64_t)a[0]; d.months=(int64_t)a[1]; d.weeks=(int64_t)a[2]; d.days=(int64_t)a[3];
    d.hours=(int64_t)a[4]; d.minutes=(int64_t)a[5]; d.seconds=(int64_t)a[6]; d.milliseconds=(int64_t)a[7];
    d.microseconds.int128_value=wide(a+8); d.nanoseconds.int128_value=wide(a+10); return d;
}
static void duration_out(uint64_t *r, const JSDurationData *d) {
    r[0]=d->years; r[1]=d->months; r[2]=d->weeks; r[3]=d->days;
    r[4]=d->hours; r[5]=d->minutes; r[6]=d->seconds; r[7]=d->milliseconds;
    wide_out(r+8,d->microseconds.int128_value); wide_out(r+10,d->nanoseconds.int128_value);
}
#define DATE(a) (int)(a)[0],(int)(a)[1],(int)(a)[2]
#define DATETIME(a) DATE(a),(int)(a)[3],(int)(a)[4],(int)(a)[5],(int)(a)[6],(int)(a)[7],(int)(a)[8]
#define DUR(d) (d).years,(d).months,(d).weeks,(d).days,(d).hours,(d).minutes,(d).seconds,(d).milliseconds,(d).microseconds.int128_value,(d).nanoseconds.int128_value
static void bytes_out(uint64_t *r, const unsigned char *bytes, size_t n) {
    for (size_t i=0;i<n;i++) r[i/8] |= (uint64_t)bytes[i] << (8*(i%8));
}
static void run(unsigned op, const uint64_t *a, char *text, size_t length, uint64_t *r) {
    int y=0,m=0,day=0,h=0,min=0,s=0,ms=0,us=0,ns=0,status=0;
    int64_t yy=0,mm=0,ww=0,dd=0;
    JSDurationData d={0};
    OracleString string={text,length}; JSValue value=JS_MKPTR(JS_TAG_STRING,&string);
    exception_kind=0;
    switch (op) {
    case 0:
        r[0]=ti_unit_to_ns((int)a[0]); r[1]=ti_precision_from_smallest_unit((int)a[0]);
        /* Native enum API transports the same 32 bits in an i32. */
        r[2]=(int32_t)ti_negate_rounding_mode((int)a[1]); r[3]=ti_calendar_enforces_month_monthcode_agreement((int)a[2]); break;
    case 1:
        /* a[2] marks subtraction-overflow C cases: only divrem remains defined. */
        if (!a[2]) r[0]=floor_div64((int64_t)a[0],a[1]);
        r[1]=floor_divrem64(&dd,(int64_t)a[0],a[1]); r[2]=dd;
        if (a[3]) r[3]=floor_div32((int32_t)a[0],(uint32_t)a[1]); break;
    case 2: {
        JSTimeSpec ts={(int64_t)a[0],(uint32_t)a[1]};
        wide_out(r,ti_sec_nsec_to_ns(ts.secs,ts.nsecs)); wide_out(r+2,ti_timespec_to_ns(&ts));
        r[4]=is_valid_epoch_timespec(&ts); double v=timespec_to_ms(&ts); memcpy(r+5,&v,8); break;
    }
    case 3: { JSTimeSpec ts; ti_ns_to_timespec(wide(a),&ts); r[0]=ts.secs; r[1]=ts.nsecs; break; }
    case 4:
        r[0]=ti_round_to_increment((int64_t)a[0],(int64_t)a[1],(int)a[2]);
        r[1]=ti_round_to_increment_as_if_positive((int64_t)a[0],(int64_t)a[1],(int)a[2]); break;
    case 5:
        wide_out(r,ti_round_to_increment128(wide(a),wide(a+2),(int)a[4]));
        wide_out(r+2,ti_round_to_increment_as_if_positive128(wide(a),wide(a+2),(int)a[4])); break;
    case 6: r[0]=ti_is_date_within_iso_limits(DATE(a)); break;
    case 7:
        status=ti_iso_calendar_date_add(DATE(a),(int64_t)a[3],(int64_t)a[4],(int64_t)a[5],(int64_t)a[6],&y,&m,&day);
        r[0]=status; if (!status) { r[1]=y; r[2]=m; r[3]=day; } break;
    case 8:
        ti_iso_calendar_date_until(DATE(a),DATE(a+3),(int)a[6],&yy,&mm,&ww,&dd);
        r[0]=yy; r[1]=mm; r[2]=ww; r[3]=dd; break;
    case 9:
        d=duration(a+9); status=ti_iso_datetime_add_duration(DATETIME(a),DUR(d),&y,&m,&day,&h,&min,&s,&ms,&us,&ns);
        r[0]=status; if (!status) { r[1]=y; r[2]=m; r[3]=day; r[4]=h; r[5]=min; r[6]=s; r[7]=ms; r[8]=us; r[9]=ns; } break;
    case 10:
        if ((int64_t)a[19]<0) ti_iso_datetime_difference(DATETIME(a),DATETIME(a+9),(int)a[18],&d);
        else ti_calendar_datetime_difference((int)a[19],DATETIME(a),DATETIME(a+9),(int)a[18],&d);
        duration_out(r,&d); break;
    case 11:
        d=duration(a); wide_out(r+12,ti_duration_time_fields_to_ns(&d));
        ti_balance_time_duration(&d,(int)a[12]); duration_out(r,&d); break;
    case 12: {
        JSDurationData input=duration(a+9);
        status=ti_round_relative_duration_iso(NULL,DATETIME(a),&input,(int)a[21],(int)a[22],(int64_t)a[23],(int)a[24],(int)a[25],&d);
        r[0]=status; if (!status) duration_out(r+1,&d); break;
    }
    case 13:
        status=ti_round_iso_date_duration(NULL,DATE(a),DATE(a+9),(int64_t)a[22],(int64_t)a[23],(int64_t)a[18],(int64_t)a[19],(int64_t)a[20],(int64_t)a[21],(int)a[24],(int)a[25],(int64_t)a[26],(int)a[27],(int)a[28],(int)a[29],&yy,&mm,&ww,&dd);
        r[0]=status; if (!status) { r[1]=yy; r[2]=mm; r[3]=ww; r[4]=dd; } break;
    case 14: {
        TISODateTimeParseResult p; status=ti_parse_iso_datetime_string(NULL,text,&p,(int)a[0]); r[0]=status;
        if (!status) {
#define FIELD(i,n) r[i]=p.n
            FIELD(1,has_date);FIELD(2,has_yearmonth);FIELD(3,has_monthday);FIELD(4,year);FIELD(5,month);FIELD(6,day);
            FIELD(7,has_time);FIELD(8,hour);FIELD(9,minute);FIELD(10,second);FIELD(11,millisecond);FIELD(12,microsecond);FIELD(13,nanosecond);
            FIELD(14,has_utc);FIELD(15,has_tz_offset);FIELD(16,tz_offset_seconds);FIELD(17,tz_offset_nanoseconds);FIELD(18,tz_offset_has_seconds);
            FIELD(19,has_calendar);FIELD(20,calendar);FIELD(21,calendar_critical);FIELD(22,has_unknown_critical);FIELD(23,has_tz_annotation);
#undef FIELD
            bytes_out(r+24,(const unsigned char *)p.tz_annotation,64);
        } break;
    }
    case 15:
        status=ti_parse_temporal_timezone_string(text,&dd); r[0]=status; if (!status) r[1]=dd;
        r[2]=ti_is_minus_zero_year(text); r[3]=ti_is_valid_plain_offset_string(text);
        r[4]=ti_string_to_unit(text,length); r[5]=ti_calendar_string_to_enum_with_aliases(text); break;
    case 16: case 17: {
        CalendarType cal=77;
        status=op==16?ti_canonicalize_calendar(NULL,value,&cal):ti_parse_temporal_calendar_string(NULL,value,&cal);
        r[0]=status; if (!status) r[1]=cal; break;
    }
    case 18: case 19: case 20: {
        char buffer[128]; memset(buffer,0x5a,sizeof(buffer));
        if (op==18) ti_format_canonical_timezone((int64_t)a[0],(int)a[1],buffer,(size_t)a[2]);
        else if (op==19) r[0]=ti_canonicalize_timezone_identifier(text,(int64_t)a[0],buffer,(size_t)a[1]);
        else { pstrcpy(buffer,(int)a[2],text); ti_append_calendar_annotation(buffer,(int)a[2],(int)a[0],(int)a[1]); }
        bytes_out(r+1,(const unsigned char *)buffer,sizeof(buffer)); break;
    }
    case 21: {
        TIPreparedFields f; ti_prepared_fields_init(&f);
        f.calendar=(int)a[0];f.year=(int64_t)a[1];f.month=(int)a[2];f.day=(int)a[3];f.month_from_code=(int)a[4];f.month_code_has_l=(int)a[5];f.era=(int)a[6];f.era_year=(int64_t)a[7];f.present_mask=(uint32_t)a[8];
        day=(int)a[11]; status=ti_resolve_date_from_fields(NULL,&f,(int)a[9],&y,&m,&day,(int)a[10]);
        r[0]=status && exception_kind==2 ? -2 : status; if (!status) {r[1]=y;r[2]=m;r[3]=day;} break;
    }
    case 22: {
        JSPlainMonthDayData md={.iso_year=(int)a[1],.iso_month=(int)a[2],.iso_day=(int)a[3],.calendar=(int)a[0]};
        JSPlainYearMonthData ym={.iso_year=(int)a[1],.iso_month=(int)a[2],.iso_day=(int)a[3],.calendar=(int)a[0]};
        pmd_get_calendar_date(&md,&y,&m,&day);r[0]=y;r[1]=m;r[2]=day;
        pym_get_calendar_date(&ym,&y,&m,&day);r[3]=y;r[4]=m;r[5]=day;break;
    }
    case 23: {
        CalendarType cal=77;status=ti_validate_constructor_calendar(NULL,value,&cal);
        r[0]=status;if(!status)r[1]=cal;break;
    }
    case 24: {
        const char *out=NULL;status=ti_validate_timezone_identifier(NULL,value,&out);r[0]=status;
        if(status==1){r[1]=strlen(out);for(size_t i=0;i<r[1];i++)r[2]=r[2]*31+(unsigned char)out[i];}break;
    }
    case 25:r[0]=ti_named_tz_is_available(text,length);break;
    case 26: {
        char buffer[128];memset(buffer,0x5a,sizeof(buffer));
        observed_env=text;observed_link=text+a[0]+1;observed_line=observed_link+a[1]+1;
        observed_link_length=a[1];observed_line_length=a[2];observed_offset=(int)a[3];observed_closes=0;
        ti_get_default_timezone(buffer,(size_t)a[4]);
        if(observed_closes>1)abort(); /* Upstream double-close is not a defined case. */
        bytes_out(r+1,(const unsigned char *)buffer,sizeof(buffer));break;
    }
    case 27: {
        TIPreparedFields f;ti_prepared_fields_init(&f);r[0]=f.calendar;
        /* Every other initialized logical field, independent of struct padding. */
        r[1]=f.year;r[2]=f.month;r[3]=f.day;r[4]=f.hour;r[5]=f.minute;r[6]=f.second;
        r[7]=f.millisecond;r[8]=f.microsecond;r[9]=f.nanosecond;r[10]=f.era_year;
        r[11]=f.month_from_code;r[12]=f.month_code_has_l;r[13]=f.offset_ns;r[14]=f.era;r[15]=f.present_mask;
        bytes_out(r+16,(const unsigned char *)f.time_zone,128);break;
    }
    case 28: {
        char buffer[128];memset(buffer,0x5a,sizeof(buffer));oracle_default_host(buffer,sizeof(buffer));
        bytes_out(r+1,(const unsigned char *)buffer,sizeof(buffer));break;
    }
    case 29:break; /* memset-zero ISO parse result constructor */
    default: abort();
    }
}
/* These are isolated sanitizer controls, never oracle expectations. */
static int undefined_control(unsigned id) {
    volatile int64_t low=INT64_MIN, high=INT64_MAX, zero=0;
    if (id==0) write_word(floor_div64(low,2));
    if (id==1) write_word(floor_div32(INT32_MIN,2));
    if (id==2) write_word(ti_round_to_increment(high,2,ROUND_CEIL));
    if (id==3) write_word(ti_round_to_increment(1,zero,ROUND_CEIL));
    if (id==4) {char b[128];ti_format_canonical_timezone(low,0,b,sizeof(b));write_word((unsigned char)b[0]);}
    if (id==5) {uint64_t a[32]={0},r[40]={0};a[0]=2024;a[1]=1;a[2]=1;a[13]=high;run(9,a,"",0,r);write_word(r[0]);}
    return 0;
}
int main(int argc,char **argv) {
    if (argc==3 && !strcmp(argv[1],"--undefined")) return undefined_control((unsigned)atoi(argv[2]));
    if (argc!=2) return 2;
    FILE *in=fopen(argv[1],"rb");if(!in)return 2;
    uint64_t count=read_word(in);
    for(uint64_t i=0;i<count;i++) {
        unsigned op=(unsigned)read_word(in);uint64_t a[32]={0},r[40]={0};
        size_t arguments=(size_t)read_word(in),length=(size_t)read_word(in);
        if(arguments>32)abort();
        for(size_t j=0;j<arguments;j++)a[j]=read_word(in);
        char *text=calloc(length+32,1);if(!text)abort();
        if(fread(text,1,length,in)!=length)abort();
        run(op,a,text,length,r);free(text);
        for(unsigned j=0;j<40;j++)write_word(r[j]);
    }
    if(fgetc(in)!=EOF)abort();fclose(in);return ferror(stdout)?2:0;
}
