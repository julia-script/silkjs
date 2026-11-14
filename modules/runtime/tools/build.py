#!/usr/bin/env python3
"""Compile the native Silk engine and embedded Node runtime as one executable."""
from pathlib import Path
import argparse
import filecmp
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib
from embed import ROOT, generate
import build_native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/silkjsruntime')
    # What a program that embeds the runtime (src/runtime/embed.silk) needs before it builds:
    # src/runtime/embedded.silk and the native archives in build/native, without the executable.
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    manifest = tomllib.loads((ROOT / 'silk.toml').read_text())
    version = manifest['package']['silk-version']
    environment = os.environ.copy()
    if platform.system() == 'Darwin' and 'SDKROOT' not in environment:
        # Keep the build SDK compatible with the compiler's deployment target.
        # SDK 27 no longer supports the macOS 11 baseline.
        candidate = Path('/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk')
        if candidate.is_dir():
            environment['SDKROOT'] = str(candidate)
        else:
            raise SystemExit('Set SDKROOT to a macOS SDK supporting the pinned compiler\'s macOS 11 deployment target.')
    if not shutil.which('silk'):
        raise SystemExit('Install the Silk launcher and run silk use in this repository.')
    generate(debug=not args.release, environment=environment)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    native = ROOT / 'build/native'
    native.mkdir(parents=True, exist_ok=True)
    for package, archive in [
        ('libuv', 'libuv.a'), ('libssl', 'libssl.a'), ('libcrypto', 'libcrypto.a'),
        ('libbrotlienc', 'libbrotlienc.a'),
        ('libbrotlidec', 'libbrotlidec.a'), ('libbrotlicommon', 'libbrotlicommon.a'),
        ('libzstd', 'libzstd.a'), ('libnghttp2', 'libnghttp2.a'),
    ]:
        libdir = Path(subprocess.check_output(['pkg-config', '--variable=libdir', package], env=environment, text=True).strip())
        source, destination = libdir / archive, native / archive
        if not source.is_file():
            raise SystemExit(f'Install the {package} development static archive: {source}')
        if not destination.exists() or not filecmp.cmp(source, destination, shallow=False):
            shutil.copyfile(source, destination)
    build_native.build(native, environment, release=args.release)
    if args.prepare:
        return
    # Source-file compilation keeps the generic engine in one native object.
    command = ['silk', '+' + version, 'build', 'src/main.silk', '-o', str(args.output.resolve()),
               '--debug', str(not args.release).lower(),
               '--clang', str(ROOT / 'tools/clang.py')]
    if args.release:
        command += ['--optimization', 'speed']
    subprocess.run(command, cwd=ROOT, env=environment, check=True)
    embed_builtin_cache(args.output.resolve(), native, environment)
    embed_heap_image(args.output.resolve())


def embed_builtin_cache(output, native, environment):
    """Link again with the built-ins' bytecode, which the first link's executable writes.

    Without it the runtime still works: built-ins compile from source at startup. That is
    what a build for another machine gets, since its executable cannot run here.
    """
    record = ROOT / 'build/link-command.json'
    cache = ROOT / 'build/builtin-cache/builtins.bin'
    cache.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(cache, 'wb') as destination:
            subprocess.run([str(output), '--silk-write-builtin-cache'], stdout=destination, env=environment, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'Built-in bytecode not embedded ({error}); built-ins will compile at startup')
        return
    build_native.build_builtin_cache(native, environment, cache)
    link = json.loads(record.read_text())
    arguments = link['arguments']
    arguments[arguments.index('-o') + 1] = str(output)
    arguments += startup_order(arguments)
    subprocess.run([link['compiler'], *arguments], cwd=link['directory'], env=environment, check=True)
    print(f'Embedded {cache.stat().st_size} bytes of built-in bytecode')


def startup_order(arguments):
    """Linker flags that place the functions a start runs next to each other.

    A start runs under 3 MB of a 27 MB text section. Left where the compiler put them,
    its functions touch several times as many pages as they fill, and each page is a
    fault. tools/startup-order.txt lists them (tools/startup_order.py writes it); a name
    that no longer exists is skipped. Only lld takes the list.
    """
    order = ROOT / 'tools/startup-order.txt'
    if platform.system() != 'Linux' or not any(a.startswith('--ld-path=') and 'lld' in a for a in arguments):
        return []
    return ['-Wl,--symbol-ordering-file=' + str(order), '-Wl,--no-warn-symbol-ordering']


HEAP_IMAGE_MAGIC = int.from_bytes(b'SILKIMG1', 'little')
# Starts whose writes lay out the heap image (lay_out_heap_image).
HEAP_IMAGE_STARTS = ROOT / 'tools/heap-image-starts'


def embed_heap_image(output):
    """Append the bootstrapped runtime's heap to the executable (src/ext/heap_image.silk).

    The executable writes the image itself, with no environment, so the image depends on
    the executable alone; with address randomization off where the host allows it, so
    that the bytes no start reads are the same in every build too. Without an image the
    runtime still works: each start runs the bootstrap. That is what an executable that
    cannot run here gets. Stripping the executable afterwards removes the image.

    An executable that runs but fails to write its image, or a layout start that fails,
    is a bug in the runtime (a bootstrap that reads the environment while the image
    warms, a start that throws): the build fails, rather than ship an executable whose
    every start runs the bootstrap.

    A start copies each image page it writes, so the image is laid out by the pages
    starts write (lay_out_heap_image).
    """
    if platform.system() != 'Linux':
        return
    image = ROOT / 'build/heap-image.bin'
    try:
        work = Path(tempfile.mkdtemp(prefix='heap-image-', dir=ROOT / 'build'))
        try:
            layout = lay_out_heap_image(output, work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        write_heap_image(output, image, layout)
    except subprocess.CalledProcessError as error:
        sys.exit(f'Heap image not built ({error}); see the error above')
    except OSError as error:
        print(f'Heap image not embedded: the executable cannot run here ({error}); every start will run the bootstrap')
        return
    data = image.read_bytes()
    append_heap_image(output, data)
    ranges = written_page_ranges(output)
    append_heap_image_ranges(output, ranges)
    print(f'Embedded a heap image of {len(data)} bytes; a start copies in {sum(n for _, n in ranges)} of its pages at once')


def write_heap_image(executable, image, layout=None):
    """Has executable write its heap image to image, laid out by layout: None, or the
    (ids, mode) of RuntimeAllocator.placeForImage."""
    command = [str(executable), '--silk-write-heap-image', str(image)]
    if layout is not None:
        ids, mode = layout
        words = image.with_suffix('.layout')
        words.write_bytes(b''.join(struct.pack('<Q', id) for id in sorted(ids)))
        command += [str(words), mode]
    fixed = ['setarch', platform.machine(), '-R', *command]
    if not shutil.which('setarch') or subprocess.run(fixed, env={}, cwd='/').returncode != 0:
        subprocess.run(command, env={}, cwd='/', check=True)


def append_heap_image(executable, data):
    with open(executable, 'ab') as handle:
        handle.write(bytes(-handle.tell() % 4096))
        offset = handle.tell()
        handle.write(data)
        handle.write(struct.pack('<QQQQ', offset, len(data), 0, HEAP_IMAGE_MAGIC))


# heap_image.silk: a range word is its first page above RANGE_PAGE_BITS and its page
# count below; the loader reads at most MAX_RANGES of them.
RANGE_PAGE_BITS = 24
MAX_RANGES = 1024


def written_page_ranges(executable):
    """The image pages every start in tools/heap-image-starts writes, as (first page,
    count) runs. A start from the image has the kernel copy these in at once
    (heap_image.load), which costs less than the read fault and then the
    copy-on-write fault each would take; only pages every start writes are listed,
    so no start copies a page it would have left alone."""
    common = None
    with tempfile.TemporaryDirectory(dir=ROOT / 'build') as directory:
        profile = Path(directory) / 'pages'
        for start in sorted(HEAP_IMAGE_STARTS.iterdir()):
            if start.suffix not in ('.js', '.cjs', '.mjs'):
                continue
            for output_to in (subprocess.DEVNULL, subprocess.PIPE):
                subprocess.run([str(executable), start.name], cwd=HEAP_IMAGE_STARTS, check=True,
                               env={'SILKJS_HEAP_IMAGE_PAGES': str(profile)},
                               stdin=subprocess.DEVNULL, stdout=output_to, stderr=subprocess.DEVNULL)
                data = profile.read_bytes()
                pages = set(struct.unpack(f'<{len(data) // 8}Q', data))
                common = pages if common is None else common & pages
    ranges = []
    for page in sorted(common or ()):
        if ranges and ranges[-1][0] + ranges[-1][1] == page:
            ranges[-1][1] += 1
        else:
            ranges.append([page, 1])
    # Past the loader's limit, join the runs closest together.
    while len(ranges) > MAX_RANGES:
        gaps = [ranges[i + 1][0] - ranges[i][0] - ranges[i][1] for i in range(len(ranges) - 1)]
        i = gaps.index(min(gaps))
        ranges[i][1] = ranges[i + 1][0] + ranges[i + 1][1] - ranges[i][0]
        del ranges[i + 1]
    return [(first, count) for first, count in ranges]


def append_heap_image_ranges(executable, ranges):
    """Puts ranges between the executable's image and its trailer."""
    with open(executable, 'r+b') as handle:
        handle.seek(-32, 2)
        offset, length, _, magic = struct.unpack('<QQQQ', handle.read(32))
        handle.seek(-32, 2)
        handle.truncate()
        handle.write(b''.join(struct.pack('<Q', (first << RANGE_PAGE_BITS) | count) for first, count in ranges))
        handle.write(struct.pack('<QQQQ', offset, length, len(ranges), magic))


def lay_out_heap_image(output, work):
    """The layout for output's heap image: the small blocks that the starts in
    tools/heap-image-starts write go to arenas of their own, packed into as few pages
    as their bytes need. Every block is named by its placed allocation id: its
    requested size and how many blocks of that size came before it, which each build
    of the image hands out the same even where a cache or a collection makes a build
    allocate a little more or less elsewhere. A first image keeps every block where the
    bootstrap puts it, and the pages its starts write name the candidates; a second
    puts each candidate alone on its pages, and the pages written then name the
    blocks."""
    def written(layout, name):
        image = work / (name + '.bin')
        write_heap_image(output, image, layout)
        executable = work / name
        shutil.copyfile(output, executable)
        shutil.copymode(output, executable)
        append_heap_image(executable, image.read_bytes())
        ids = set()
        for start in sorted(HEAP_IMAGE_STARTS.iterdir()):
            if start.suffix not in ('.js', '.cjs', '.mjs'):
                continue
            # Output to a file and to a pipe take different paths.
            for output_to in (subprocess.DEVNULL, subprocess.PIPE):
                profile = work / (name + '.ids')
                result = subprocess.run([str(executable), start.name], cwd=HEAP_IMAGE_STARTS,
                                        env={'SILKJS_HEAP_IMAGE_PROFILE': str(profile)},
                                        stdin=subprocess.DEVNULL, stdout=output_to, stderr=subprocess.PIPE)
                if result.returncode != 0:
                    sys.stderr.buffer.write(result.stderr)
                    raise subprocess.CalledProcessError(result.returncode, result.args)
                data = profile.read_bytes()
                ids.update(struct.unpack(f'<{len(data) // 8}Q', data))
        return ids
    candidates = written((set(), 'pack'), 'plain')
    written_ids = written((candidates, 'probe'), 'probe') & candidates
    print(f'Heap image: {len(written_ids)} of {len(candidates)} candidate blocks written by a start')
    return written_ids, 'pack'


if __name__ == '__main__':
    main()
