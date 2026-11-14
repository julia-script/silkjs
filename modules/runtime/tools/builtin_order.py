#!/usr/bin/env python3
"""Writes tools/builtin-order.txt: the built-in modules whose bytecode a start or a
server reads, which tools/build.py places first in the linked bytecode cache.

Usage: python3 tools/builtin_order.py path/to/silkjsruntime [touched.txt ...]
       python3 tools/builtin_order.py --shim

The cache holds every built-in, about 22 MB; a server reads under 3 MB of it, a module's
top level when the module loads and a function's body on its first call. In index order
those reads are spread over the whole cache, and the kernel maps file pages around each
read (64 KB, or a whole 256 KB folio of a file that was just written), so 7 MB of it was
resident. Placed together, the modules a server reads fill the pages they touch.

Runs the given release executable on the starts and the server script of
tools/startup_order.py and lists the cache entries each run read, then merges any
lists given after the executable. A list comes from a run of any program under the
shim this tool builds (`--shim` prints how): the committed list merged an
Express-over-HTTPS server, a node:http server and a serve() server, each under load.

Which entries a run read comes from the kernel: the shim, preloaded into the runtime,
asks for no read-around on the cache (MADV_RANDOM) and writes down which of its pages
are present. The executable runs as a copy whose pages are dropped from the page cache
first, so that only pages the run read are present. Linux only, like the order itself.
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import embed
import startup_order

ROOT = pathlib.Path(__file__).resolve().parents[1]
BOOTSTRAP = 'internal/bootstrap/silk'
SHIM = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static const unsigned char *data;
static size_t length;

static uint64_t word(size_t offset) { uint64_t value; memcpy(&value, data + offset, 8); return value; }
static int present(int pagemap, uintptr_t page) {
  uint64_t entry = 0;
  if (pread(pagemap, &entry, 8, (off_t)(page / 4096 * 8)) != 8) return 0;
  return (int)(entry >> 63);
}
/* An entry was read when a page it fills alone is present, or every page it shares is. */
static void dump(void) {
  const char *path = getenv("SILK_BUILTIN_TOUCHED");
  char temporary[4096];
  if (!path || !data || length < 80) return;
  int pagemap = open("/proc/self/pagemap", O_RDONLY);
  if (pagemap < 0) return;
  snprintf(temporary, sizeof temporary, "%s.%d", path, (int)getpid());
  FILE *out = fopen(temporary, "w");
  if (out) {
    uint64_t count = word(72);
    for (uint64_t i = 0; i < count && 80 + i * 16 + 16 <= length; i++) {
      uint64_t offset = word(80 + i * 16), size = word(80 + i * 16 + 8);
      if (size == 0 || offset + size > length) continue;
      uintptr_t start = (uintptr_t)data + offset, end = start + size;
      int inner = 0, all = 1;
      for (uintptr_t page = start & ~(uintptr_t)4095; page < end; page += 4096) {
        int here = present(pagemap, page);
        if (!here) all = 0;
        else if (page >= start && page + 4096 <= end) inner = 1;
      }
      if (inner || all) fprintf(out, "%llu\n", (unsigned long long)i);
    }
    fclose(out);
    rename(temporary, path);
  }
  close(pagemap);
}
static void *watch(void *unused) { (void)unused; for (;;) { usleep(100000); dump(); } return NULL; }

__attribute__((constructor)) static void start(void) {
  const unsigned char *(*where)(void) = (const unsigned char *(*)(void))dlsym(RTLD_DEFAULT, "silk_builtin_cache_data");
  size_t (*size)(void) = (size_t (*)(void))dlsym(RTLD_DEFAULT, "silk_builtin_cache_length");
  if (!where || !size) return;
  data = where();
  length = size();
  uintptr_t first = (uintptr_t)data & ~(uintptr_t)4095;
  madvise((void *)first, (uintptr_t)data + length - first, MADV_RANDOM);
  atexit(dump);
  pthread_t thread;
  pthread_create(&thread, NULL, watch, NULL);
}
'''


def names():
    return [name for name, _ in embed.sources()] + [BOOTSTRAP]


def build_shim(directory):
    source = directory / 'builtin_touched.c'
    source.write_text(SHIM)
    shim = directory / 'builtin_touched.so'
    subprocess.run([os.environ.get('CC', 'cc'), '-O2', '-shared', '-fPIC', '-o', str(shim), str(source), '-lpthread'], check=True)
    return shim


def cold_copy(executable, directory):
    """A copy of the executable with none of its pages in the page cache."""
    copy = directory / 'silkjsruntime'
    shutil.copyfile(executable, copy)
    copy.chmod(0o755)
    descriptor = os.open(copy, os.O_RDONLY)
    try:
        os.fsync(descriptor)
        os.posix_fadvise(descriptor, 0, 0, os.POSIX_FADV_DONTNEED)
    finally:
        os.close(descriptor)
    return copy


def merge(path, table, seen, order):
    for line in path.read_text().split():
        name = table[int(line)] if line.isdigit() else line
        if name not in seen:
            seen.add(name)
            order.append(name)


def touched(executable, shim, script, directory, table, seen, order):
    source = directory / 'main.js'
    source.write_text(script)
    (directory / 'dependency.js').write_text('module.exports = 1;\n')
    result = directory / 'touched.txt'
    result.unlink(missing_ok=True)
    environment = dict(os.environ, LD_PRELOAD=str(shim), SILK_BUILTIN_TOUCHED=str(result))
    environment.pop('NODE_OPTIONS', None)
    subprocess.run([str(executable), str(source)], check=True, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not result.exists():
        sys.exit('The run wrote no list: is this a release executable with its built-in bytecode linked in?')
    merge(result, table, seen, order)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == '--shim':
        directory = pathlib.Path(tempfile.mkdtemp(prefix='silk-builtin-order-'))
        shim = build_shim(directory)
        print(f'LD_PRELOAD={shim} SILK_BUILTIN_TOUCHED=touched.txt path/to/silkjsruntime server.js\n'
              'Run a copy of the executable that is not in the page cache (see cold_copy), put it under load,\n'
              'and pass touched.txt, which the run rewrites ten times a second, to this tool after the executable.')
        return
    table = names()
    seen, order = set(), []
    with tempfile.TemporaryDirectory() as directory:
        directory = pathlib.Path(directory)
        shim = build_shim(directory)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                        '-keyout', str(directory / 'key.pem'), '-out', str(directory / 'cert.pem')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for script in startup_order.SCRIPTS + [startup_order.SERVER]:
            executable = cold_copy(pathlib.Path(sys.argv[1]).resolve(), directory)
            touched(executable, shim, script, directory, table, seen, order)
    for extra in sys.argv[2:]:
        merge(pathlib.Path(extra), table, seen, order)
    (ROOT / 'tools/builtin-order.txt').write_text('\n'.join(order) + '\n')
    print(f'{len(order)} of {len(table)} built-in modules')


if __name__ == '__main__':
    main()
