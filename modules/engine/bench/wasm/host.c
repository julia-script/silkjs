/* C host layer for silkjs on wasm64-unknown-unknown.
 *
 * The engine's command line calls a C library for files, clocks, processes and terminals. The
 * freestanding WebAssembly target has none, and wasi-libc is 32-bit only, so this file is that
 * library: the calls a script run needs are implemented on WASI Preview 1 imports, and the rest
 * fail with ENOSYS. WASI takes 32-bit addresses; the module's memory stays below 4 GiB, so
 * narrowing a pointer is exact. Compile it freestanding: there are no headers to include.
 *
 * Supported: reading a script and other files (fopen, fread, fseeko, ftello, fgetc, fgets, open,
 * read, lseek), writing to any open descriptor, clocks, exit and command arguments.
 * Not supported: environment variables, directories, metadata, processes, threads, signals,
 * terminals, sleeping, std.printf formatting and dynamic loading. */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long i64;
typedef unsigned long usize;
typedef long isize;

#define NULL ((void *)0)
#define ENOENT 2
#define EBADF 9
#define EAGAIN 11
#define ENOMEM 12
#define EINVAL 22
#define ERANGE 34
#define ENOSYS 38
#define EOF (-1)

#define WASI(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(#name)))
WASI(args_sizes_get) u32 wasi_args_sizes_get(u32 count, u32 size);
WASI(args_get) u32 wasi_args_get(u32 pointers, u32 buffer);
WASI(fd_write) u32 wasi_fd_write(u32 fd, u32 iovs, u32 count, u32 written);
WASI(fd_read) u32 wasi_fd_read(u32 fd, u32 iovs, u32 count, u32 read);
WASI(fd_seek) u32 wasi_fd_seek(u32 fd, i64 offset, u32 whence, u32 result);
WASI(fd_close) u32 wasi_fd_close(u32 fd);
WASI(fd_prestat_get) u32 wasi_fd_prestat_get(u32 fd, u32 result);
WASI(fd_prestat_dir_name) u32 wasi_fd_prestat_dir_name(u32 fd, u32 path, u32 length);
WASI(path_open) u32 wasi_path_open(u32 dir, u32 dirflags, u32 path, u32 length, u32 oflags,
                                   u64 rights, u64 inheriting, u32 fdflags, u32 result);
WASI(clock_time_get) u32 wasi_clock_time_get(u32 clock, u64 precision, u32 result);
WASI(proc_exit) _Noreturn void wasi_proc_exit(u32 status);

/* Silk's runtime defines the allocator and the byte routines. */
void *malloc(usize bytes);
void free(void *pointer);
void *memcpy(void *to, const void *from, usize bytes);

struct WasiVector { u32 address; u32 length; };

static int error_value;
int *__errno_location(void) { return &error_value; }

static u32 narrow(const void *pointer) { return (u32)(usize)pointer; }

static usize text_length(const char *text)
{
    usize length = 0;
    while (text[length])
        length++;
    return length;
}

static int fail(int code)
{
    error_value = code;
    return -1;
}

/* ---- Command arguments ---- */

static u32 argument_count;
static u32 *argument_pointers;
static int arguments_loaded;

static void load_arguments(void)
{
    static u32 count, size;
    if (arguments_loaded)
        return;
    arguments_loaded = 1;
    if (wasi_args_sizes_get(narrow(&count), narrow(&size)) != 0 || count == 0)
        return;
    u32 *pointers = malloc((usize)count * sizeof(u32));
    char *buffer = malloc(size);
    if (!pointers || !buffer || wasi_args_get(narrow(pointers), narrow(buffer)) != 0)
        return;
    argument_pointers = pointers;
    argument_count = count;
}

usize silkjs_wasm_argument_count(void)
{
    load_arguments();
    return argument_count;
}

usize silkjs_wasm_argument_length(usize index)
{
    load_arguments();
    return text_length((const char *)(usize)argument_pointers[index]);
}

void silkjs_wasm_argument_copy(usize index, u8 *output)
{
    load_arguments();
    const char *text = (const char *)(usize)argument_pointers[index];
    memcpy(output, text, text_length(text));
}

/* ---- Descriptors ---- */

isize write(int fd, const void *data, usize length)
{
    static struct WasiVector vector;
    static u32 written;
    vector.address = narrow(data);
    vector.length = (u32)length;
    u32 status = wasi_fd_write((u32)fd, narrow(&vector), 1, narrow(&written));
    if (status != 0)
        return fail((int)status);
    return (isize)written;
}

isize read(int fd, void *data, usize length)
{
    static struct WasiVector vector;
    static u32 count;
    vector.address = narrow(data);
    vector.length = (u32)length;
    u32 status = wasi_fd_read((u32)fd, narrow(&vector), 1, narrow(&count));
    if (status != 0)
        return fail((int)status);
    return (isize)count;
}

i64 lseek(int fd, i64 offset, int whence)
{
    static u64 position;
    u32 status = wasi_fd_seek((u32)fd, offset, (u32)whence, narrow(&position));
    if (status != 0)
        return fail((int)status);
    return (i64)position;
}

int close(int fd)
{
    u32 status = wasi_fd_close((u32)fd);
    return status == 0 ? 0 : fail((int)status);
}

/* The preopened directory that holds an absolute path: the one with the longest name that is a
 * prefix of it. A relative path resolves in the first preopened directory. On success *rest is
 * the path inside that directory. */
static int preopened_directory(const char *path, const char **rest)
{
    static u8 prestat[8];
    static char name[1024];
    int best = -1;
    usize best_length = 0;
    for (u32 fd = 3; wasi_fd_prestat_get(fd, narrow(prestat)) == 0; fd++) {
        u32 length = *(u32 *)(prestat + 4);
        if (prestat[0] != 0 || length >= sizeof name)
            continue;
        if (wasi_fd_prestat_dir_name(fd, narrow(name), length) != 0)
            continue;
        name[length] = 0;
        if (path[0] != '/') {
            *rest = path;
            return (int)fd;
        }
        usize at = 0;
        while (at < length && path[at] == name[at])
            at++;
        if (at != length || (best >= 0 && length <= best_length))
            continue;
        if (length > 1 && path[length] != '/' && path[length] != 0)
            continue;
        best = (int)fd;
        best_length = length;
    }
    if (best < 0)
        return -1;
    const char *inside = path + best_length;
    while (*inside == '/')
        inside++;
    *rest = *inside ? inside : ".";
    return best;
}

#define O_ACCMODE 3
#define O_WRONLY 1
#define O_RDWR 2
#define O_CREAT 0100
#define O_EXCL 0200
#define O_TRUNC 01000
#define O_APPEND 02000

static int open_path(const char *path, int flags)
{
    static u32 opened;
    const char *rest;
    int directory = preopened_directory(path, &rest);
    if (directory < 0)
        return fail(ENOENT);
    u32 oflags = 0;
    if (flags & O_CREAT) oflags |= 1;
    if (flags & O_EXCL) oflags |= 4;
    if (flags & O_TRUNC) oflags |= 8;
    /* fd_read, fd_seek, fd_tell and fd_filestat_get; fd_write and friends when writing. */
    u64 rights = (1ull << 1) | (1ull << 2) | (1ull << 5) | (1ull << 21);
    if ((flags & O_ACCMODE) != 0 || (flags & (O_CREAT | O_TRUNC | O_APPEND)))
        rights |= (1ull << 6) | (1ull << 0) | (1ull << 4) | (1ull << 22);
    u32 status = wasi_path_open((u32)directory, 1, narrow(rest), (u32)text_length(rest), oflags,
                                rights, rights, (flags & O_APPEND) ? 1 : 0, narrow(&opened));
    if (status != 0)
        return fail((int)status);
    return (int)opened;
}

int open(const char *path, int flags, ...) { return open_path(path, flags); }

/* ---- Streams: unbuffered, so every call reaches the descriptor at once ---- */

typedef struct FILE { int fd; int end; int failed; } FILE;

static FILE standard_streams[3] = {{0, 0, 0}, {1, 0, 0}, {2, 0, 0}};
FILE *stdin = &standard_streams[0];
FILE *stdout = &standard_streams[1];
FILE *stderr = &standard_streams[2];

FILE *fdopen(int fd, const char *mode)
{
    FILE *file = malloc(sizeof(FILE));
    if (!file) {
        error_value = ENOMEM;
        return NULL;
    }
    file->fd = fd;
    file->end = 0;
    file->failed = 0;
    return file;
}

FILE *fopen(const char *path, const char *mode)
{
    int flags = 0;
    if (mode[0] == 'w') flags = O_WRONLY | O_CREAT | O_TRUNC;
    else if (mode[0] == 'a') flags = O_WRONLY | O_CREAT | O_APPEND;
    for (const char *at = mode + 1; *at; at++)
        if (*at == '+') flags = (flags & ~O_ACCMODE) | O_RDWR;
    int fd = open_path(path, flags);
    if (fd < 0)
        return NULL;
    FILE *file = fdopen(fd, mode);
    if (!file)
        close(fd);
    return file;
}

int fclose(FILE *file)
{
    int status = close(file->fd);
    if (file < standard_streams || file >= standard_streams + 3)
        free(file);
    return status == 0 ? 0 : EOF;
}

usize fread(void *data, usize size, usize count, FILE *file)
{
    usize wanted = size * count, done = 0;
    while (done < wanted) {
        isize got = read(file->fd, (u8 *)data + done, wanted - done);
        if (got < 0) { file->failed = 1; break; }
        if (got == 0) { file->end = 1; break; }
        done += (usize)got;
    }
    return size ? done / size : 0;
}

usize fwrite(const void *data, usize size, usize count, FILE *file)
{
    usize wanted = size * count, done = 0;
    while (done < wanted) {
        isize put = write(file->fd, (const u8 *)data + done, wanted - done);
        if (put <= 0) { file->failed = 1; break; }
        done += (usize)put;
    }
    return size ? done / size : 0;
}

int fgetc(FILE *file)
{
    u8 byte;
    return fread(&byte, 1, 1, file) == 1 ? byte : EOF;
}

int fputc(int value, FILE *file)
{
    u8 byte = (u8)value;
    return fwrite(&byte, 1, 1, file) == 1 ? byte : EOF;
}

char *fgets(char *buffer, int capacity, FILE *file)
{
    int length = 0;
    while (length + 1 < capacity) {
        int byte = fgetc(file);
        if (byte == EOF)
            break;
        buffer[length++] = (char)byte;
        if (byte == '\n')
            break;
    }
    if (length == 0)
        return NULL;
    buffer[length] = 0;
    return buffer;
}

int fflush(FILE *file) { return 0; }
int feof(FILE *file) { return file->end; }
int ferror(FILE *file) { return file->failed; }
void clearerr(FILE *file) { file->end = 0; file->failed = 0; }
int fileno(FILE *file) { return file->fd; }
i64 ftello(FILE *file) { return lseek(file->fd, 0, 1); }

int fseeko(FILE *file, i64 offset, int whence)
{
    if (lseek(file->fd, offset, whence) < 0)
        return -1;
    file->end = 0;
    return 0;
}

/* ---- Clocks, exit and the process ---- */

struct timespec { i64 seconds; i64 nanoseconds; };

int clock_gettime(int clock, struct timespec *out)
{
    static u64 now;
    u32 status = wasi_clock_time_get(clock == 0 ? 0 : 1, 1, narrow(&now));
    if (status != 0)
        return fail((int)status);
    out->seconds = (i64)(now / 1000000000ull);
    out->nanoseconds = (i64)(now % 1000000000ull);
    return 0;
}

/* Microseconds of monotonic time: WASI hosts do not all have a processor-time clock. */
isize clock(void)
{
    struct timespec now;
    if (clock_gettime(1, &now) != 0)
        return -1;
    return (isize)(now.seconds * 1000000 + now.nanoseconds / 1000);
}

_Noreturn void _exit(int status) { wasi_proc_exit((u32)status); }
_Noreturn void exit(int status) { wasi_proc_exit((u32)status); }

/* Silk's standalone WebAssembly runtime exports the program as main; WASI commands start at _start. */
int main(void);
void _start(void) { wasi_proc_exit((u32)main()); }
int getpid(void) { return 1; }
int isatty(int fd) { return 0; }
/* One processor, and one of anything else a caller sizes itself by. */
isize sysconf(int name) { return 1; }
int __cxa_atexit(void (*callback)(void *), void *argument, void *dso) { return 0; }

static char *no_environment[1];
char **environ = no_environment;
char *getenv(const char *name) { return NULL; }
char *strerror(int code) { return "error"; }

char *getcwd(char *buffer, usize size)
{
    if (!buffer) {
        buffer = malloc(2);
        size = 2;
    }
    if (!buffer || size < 2) {
        error_value = buffer ? ERANGE : ENOMEM;
        return NULL;
    }
    buffer[0] = '/';
    buffer[1] = 0;
    return buffer;
}

/* The working directory is "/" and nothing here follows links, so a path resolves to itself. */
char *realpath(const char *path, char *output)
{
    usize length = text_length(path);
    usize prefix = path[0] == '/' ? 0 : 1;
    if (!output)
        output = malloc(length + prefix + 1);
    if (!output) {
        error_value = ENOMEM;
        return NULL;
    }
    if (prefix)
        output[0] = '/';
    memcpy(output + prefix, path, length + 1);
    return output;
}

/* ---- Threads and signals: one thread, no signals ---- */

int pthread_attr_init(void *attributes) { return 0; }
int pthread_attr_destroy(void *attributes) { return 0; }
int pthread_attr_setdetachstate(void *attributes, int state) { return 0; }
int pthread_attr_setstacksize(void *attributes, usize size) { return 0; }
int pthread_create(void *thread, const void *attributes, void *(*entry)(void *), void *argument) { return EAGAIN; }
int pthread_sigmask(int how, const void *set, void *previous) { return 0; }
int sigemptyset(void *set) { return 0; }
int sigfillset(void *set) { return 0; }
int sigaddset(void *set, int signal) { return 0; }
int sigismember(const void *set, int signal) { return 0; }
void *signal(int number, void *handler) { return NULL; }

/* ---- Everything else is absent ---- */

int chdir(const char *path) { return fail(ENOSYS); }
int closedir(void *directory) { return fail(ENOSYS); }
int dlclose(void *handle) { return -1; }
char *dlerror(void) { return "dynamic loading is not supported"; }
void *dlopen(const char *path, int flags) { return NULL; }
void *dlsym(void *handle, const char *name) { return NULL; }
int dup(int fd) { return fail(ENOSYS); }
int dup2(int from, int to) { return fail(ENOSYS); }
int execv(const char *path, char *const *arguments) { return fail(ENOSYS); }
int execve(const char *path, char *const *arguments, char *const *environment) { return fail(ENOSYS); }
int fork(void) { return fail(ENOSYS); }
int ioctl(int fd, unsigned long request, ...) { return fail(ENOSYS); }
int kill(int pid, int signal) { return fail(ENOSYS); }
int lstat(const char *path, void *out) { return fail(ENOSYS); }
int mkdir(const char *path, u32 mode) { return fail(ENOSYS); }
int nanosleep(const void *duration, void *remaining) { return fail(ENOSYS); }
void *opendir(const char *path) { error_value = ENOSYS; return NULL; }
int pclose(FILE *file) { return fail(ENOSYS); }
int pipe(int *fds) { return fail(ENOSYS); }
int poll(void *fds, unsigned long count, int timeout) { return fail(ENOSYS); }
FILE *popen(const char *command, const char *mode) { error_value = ENOSYS; return NULL; }
int ppoll(void *fds, unsigned long count, const void *timeout, const void *mask) { return fail(ENOSYS); }
void *readdir(void *directory) { error_value = ENOSYS; return NULL; }
isize readlink(const char *path, char *buffer, usize size) { return fail(ENOSYS); }
int remove(const char *path) { return fail(ENOSYS); }
int rename(const char *from, const char *to) { return fail(ENOSYS); }
int setenv(const char *name, const char *value, int overwrite) { return fail(ENOSYS); }
int setgid(u32 id) { return fail(ENOSYS); }
int setuid(u32 id) { return fail(ENOSYS); }
int snprintf(char *buffer, usize size, const char *format, ...) { return fail(ENOSYS); }
int stat(const char *path, void *out) { return fail(ENOSYS); }
double strtod(const char *text, char **end) { if (end) *end = (char *)text; return 0.0; }
int symlink(const char *target, const char *path) { return fail(ENOSYS); }
int tcgetattr(int fd, void *out) { return fail(ENOSYS); }
int tcsetattr(int fd, int actions, const void *in) { return fail(ENOSYS); }
FILE *tmpfile(void) { error_value = ENOSYS; return NULL; }
int unsetenv(const char *name) { return fail(ENOSYS); }
int utimes(const char *path, const void *times) { return fail(ENOSYS); }
int waitpid(int pid, int *status, int flags) { return fail(ENOSYS); }
