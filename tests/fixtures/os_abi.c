/* Independent host ABI evidence for native Silk byte layouts; never linked into production. */
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/termios.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
int main(void) {
#ifdef __APPLE__
    _Static_assert(sizeof(struct stat) == 144, "Darwin stat size");
    _Static_assert(offsetof(struct stat, st_dev) == 0, "dev");
    _Static_assert(offsetof(struct stat, st_mode) == 4, "mode");
    _Static_assert(offsetof(struct stat, st_nlink) == 6, "nlink");
    _Static_assert(offsetof(struct stat, st_ino) == 8, "ino");
    _Static_assert(offsetof(struct stat, st_uid) == 16, "uid");
    _Static_assert(offsetof(struct stat, st_gid) == 20, "gid");
    _Static_assert(offsetof(struct stat, st_rdev) == 24, "rdev");
    _Static_assert(offsetof(struct stat, st_atimespec) == 32, "atime");
    _Static_assert(offsetof(struct stat, st_mtimespec) == 48, "mtime");
    _Static_assert(offsetof(struct stat, st_ctimespec) == 64, "ctime");
    _Static_assert(offsetof(struct stat, st_size) == 96, "size");
    _Static_assert(offsetof(struct stat, st_blocks) == 104, "blocks");
    _Static_assert(offsetof(struct dirent, d_name) == 21, "dirent name");
    _Static_assert(offsetof(struct termios, c_cc) + VMIN == 48, "VMIN");
    _Static_assert(offsetof(struct termios, c_cc) + VTIME == 49, "VTIME");
    _Static_assert((IGNBRK|BRKINT|PARMRK|ISTRIP|INLCR|IGNCR|ICRNL|IXON) == 0x3eb, "input mask");
    _Static_assert((ECHO|ECHONL|ICANON|IEXTEN) == 0x518, "local mask");
#else
    _Static_assert(offsetof(struct dirent, d_name) == 19, "dirent name");
    _Static_assert(offsetof(struct stat, st_size) == 48, "size");
    _Static_assert(offsetof(struct stat, st_blocks) == 64, "blocks");
    _Static_assert(offsetof(struct stat, st_atim) == 72, "atime");
    _Static_assert(offsetof(struct stat, st_mtim) == 88, "mtime");
    _Static_assert(offsetof(struct stat, st_ctim) == 104, "ctime");
    _Static_assert(offsetof(struct termios, c_cc) + VMIN == 23, "VMIN");
    _Static_assert(offsetof(struct termios, c_cc) + VTIME == 22, "VTIME");
    _Static_assert((IGNBRK|BRKINT|PARMRK|ISTRIP|INLCR|IGNCR|ICRNL|IXON) == 0x5eb, "input mask");
    _Static_assert((ECHO|ECHONL|ICANON|IEXTEN) == 0x804a, "local mask");
#endif
    _Static_assert(sizeof(struct termios) <= 128, "termios envelope");
    puts("os host ABI OK");
    return 0;
}
