"""Build the pinned interpreter, WASI adapter, and HTTP parser archives."""
from pathlib import Path
import hashlib
import json
import os
import platform
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

from embed import ROOT
import prepare_wamr

UVWASI_COMMIT = 'e76edba54038e097aa58f55eef5ad34cb258b817'
UVWASI_SHA256 = '79991fa7147b1ebb15d9b3f5738e90d8a3e07c78a4f1cbfe63d43b594e2fb431'


def tree_hashes(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob('*')) if path.is_file()}


def prepare_uvwasi():
    deps = ROOT / 'build/deps'
    deps.mkdir(parents=True, exist_ok=True)
    patch = ROOT / 'ext/node/internal/wasi/uvwasi-0.0.23-ownership.patch'
    patch_hash = hashlib.sha256(patch.read_bytes()).hexdigest()
    name = f'uvwasi-{UVWASI_COMMIT}'
    source = deps / f'{name}-silk-{patch_hash[:16]}'
    manifest = source.with_name(source.name + '.manifest.json')
    if source.exists():
        if not manifest.is_file() or json.loads(manifest.read_text()) != tree_hashes(source):
            raise RuntimeError(f'Preserving modified uvwasi sources at {source}; move them aside or update the checked-in patch before rebuilding.')
        return source
    archive = deps / f'{name}.tar.gz'
    if not archive.exists():
        url = f'https://codeload.github.com/nodejs/uvwasi/tar.gz/{UVWASI_COMMIT}'
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(32 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != UVWASI_SHA256:
            raise RuntimeError('Pinned uvwasi source checksum mismatch')
        archive.write_bytes(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != UVWASI_SHA256:
        raise RuntimeError(f'Pinned uvwasi source checksum mismatch: {archive}')
    with tempfile.TemporaryDirectory(prefix='uvwasi-', dir=deps) as temporary:
        with tarfile.open(archive, 'r:gz') as packed:
            packed.extractall(temporary, filter='data')
        extracted = Path(temporary) / name
        subprocess.run(['patch', '-p1', '--batch', '-i', str(patch)], cwd=extracted, check=True)
        hashes = tree_hashes(extracted)
        extracted.rename(source)
        manifest.write_text(json.dumps(hashes, sort_keys=True) + '\n')
    return source


def cmake_build(source, directory, target, definitions, environment, release):
    command = ['cmake', '-S', str(source), '-B', str(directory),
               '-DCMAKE_BUILD_TYPE=' + ('Release' if release else 'Debug'),
               '-DCMAKE_POSITION_INDEPENDENT_CODE=ON']
    if platform.system() == 'Darwin':
        command += ['-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0',
                    '-DCMAKE_OSX_SYSROOT=' + environment['SDKROOT']]
    command += ['-D' + key + '=' + str(value) for key, value in definitions.items()]
    subprocess.run(command, env=environment, check=True)
    subprocess.run(['cmake', '--build', str(directory), '--target', target,
                    '--parallel', str(os.cpu_count() or 1)], env=environment, check=True)


def build_http_parser(native, environment, release):
    directory = ROOT / 'build/http-parser'
    directory.mkdir(parents=True, exist_ok=True)
    vendor = ROOT / 'vendor/llhttp'
    compiler = shlex.split(environment.get('CC', 'cc'))
    flags = ['-std=gnu11', '-fPIC', '-I' + str(vendor / 'include'), '-O2' if release else '-O0', '-g']
    if platform.system() == 'Darwin':
        flags += ['-isysroot', environment['SDKROOT'], '-mmacosx-version-min=11.0']
    callbacks = ('message_begin', 'header_value_complete', 'headers_complete',
                 'message_complete', 'chunk_header', 'chunk_complete')
    renames = [f'-Dllhttp__on_{name}=silk_llhttp_base_on_{name}' for name in callbacks]
    objects = []
    for source in (vendor / 'src/llhttp.c', vendor / 'src/api.c', vendor / 'src/http.c',
                   ROOT / 'src/ext/http_parser_bridge.c'):
        destination = directory / (source.stem + '.o')
        command = compiler + flags + (renames if source.name == 'api.c' else [])
        subprocess.run(command + ['-c', str(source), '-o', str(destination)], env=environment, check=True)
        objects.append(str(destination))
    archive = native / 'libsilk_http_parser.a'
    archive.unlink(missing_ok=True)
    subprocess.run(shlex.split(environment.get('AR', 'ar')) + ['rcs', str(archive), *objects],
                   env=environment, check=True)


def build_sea(native, environment, release):
    directory = ROOT / 'build/sea'
    directory.mkdir(parents=True, exist_ok=True)
    compiler = shlex.split(environment.get('CC', 'cc'))
    flags = ['-std=c11', '-pthread', '-fPIC', '-O2' if release else '-O0', '-g']
    if platform.system() == 'Darwin':
        flags += ['-isysroot', environment['SDKROOT'], '-mmacosx-version-min=11.0']
    destination = directory / 'sea_bridge.o'
    subprocess.run(compiler + flags + ['-c', str(ROOT / 'src/ext/sea_bridge.c'), '-o', str(destination)],
                   env=environment, check=True)
    archive = native / 'libsilk_sea.a'
    archive.unlink(missing_ok=True)
    subprocess.run(shlex.split(environment.get('AR', 'ar')) + ['rcs', str(archive), str(destination)],
                   env=environment, check=True)


def build_util(native, uv_include, environment, release):
    directory = ROOT / 'build/util'
    directory.mkdir(parents=True, exist_ok=True)
    compiler = shlex.split(environment.get('CC', 'cc'))
    flags = ['-std=gnu11', '-pthread', '-fPIC', '-I' + uv_include,
             '-O2' if release else '-O0', '-g']
    flags += shlex.split(subprocess.check_output(
        ['pkg-config', '--cflags', 'openssl'], env=environment, text=True))
    if platform.system() == 'Darwin':
        flags += ['-isysroot', environment['SDKROOT'], '-mmacosx-version-min=11.0']
    objects = []
    for name in ('util_error_bridge', 'process_diagnostics', 'inspector_transport'):
        destination = directory / (name + '.o')
        subprocess.run(compiler + flags + ['-c', str(ROOT / 'src/ext' / (name + '.c')),
                                          '-o', str(destination)], env=environment, check=True)
        objects.append(str(destination))
    archive = native / 'libsilk_util.a'
    archive.unlink(missing_ok=True)
    subprocess.run(shlex.split(environment.get('AR', 'ar')) + ['rcs', str(archive), *objects],
                   env=environment, check=True)

def build_napi(native, uv_include, environment, release):
    directory = ROOT / 'build/napi'
    directory.mkdir(parents=True, exist_ok=True)
    compiler = shlex.split(environment.get('CC', 'cc'))
    flags = ['-std=gnu11', '-pthread', '-fPIC', '-fvisibility=default',
             '-I' + uv_include, '-I' + str(ROOT / 'vendor/node-api'),
             '-O2' if release else '-O0', '-g']
    if platform.system() == 'Darwin':
        flags += ['-isysroot', environment['SDKROOT'], '-mmacosx-version-min=11.0']
    objects = []
    for name in ('napi_core', 'napi_values', 'napi_async'):
        destination = directory / (name + '.o')
        subprocess.run(compiler + flags + ['-c', str(ROOT / 'src/ext' / (name + '.c')),
                                          '-o', str(destination)], env=environment, check=True)
        objects.append(str(destination))
    archive = native / 'libsilk_napi.a'
    archive.unlink(missing_ok=True)
    subprocess.run(shlex.split(environment.get('AR', 'ar')) + ['rcs', str(archive), *objects],
                   env=environment, check=True)



def build(native, environment, release=False):
    wamr = ROOT / 'build/wamr'
    cmake_build(ROOT / 'src/ext/wamr', wamr, 'silk_wamr', {
        'WAMR_ROOT_DIR': prepare_wamr.prepare(),
        'SIMDE_SOURCE_DIR': prepare_wamr.prepare_simde(),
    }, environment, release)
    shutil.copyfile(wamr / 'libsilk_wamr.a', native / 'libsilk_wamr.a')
    uv_include = subprocess.check_output(['pkg-config', '--variable=includedir', 'libuv'],
                                         env=environment, text=True).strip()
    wasi = ROOT / 'build/uvwasi'
    cmake_build(prepare_uvwasi(), wasi, 'uvwasi_a', {
        'BUILD_TESTING': 'OFF', 'INSTALL_UVWASI': 'OFF',
        'LIBUV_INCLUDE_DIR': uv_include, 'LIBUV_LIBRARIES': native / 'libuv.a',
    }, environment, release)
    shutil.copyfile(wasi / 'libuvwasi.a', native / 'libuvwasi.a')
    build_http_parser(native, environment, release)
    build_sea(native, environment, release)
    build_util(native, uv_include, environment, release)
    build_napi(native, uv_include, environment, release)
