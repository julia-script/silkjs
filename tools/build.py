#!/usr/bin/env python3
"""Compile the native Silk engine and embedded Node runtime as one executable."""
from pathlib import Path
import argparse
import filecmp
import os
import platform
import shutil
import subprocess
import tomllib
from embed import ROOT, generate
import build_native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/silkjsruntime')
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
    if platform.system() == 'Darwin' and shutil.which('brew'):
        paths = []
        for package in ['icu4c@78', 'sqlite']:
            prefix = subprocess.check_output(['brew', '--prefix', package], text=True).strip()
            paths.append(str(Path(prefix) / 'lib/pkgconfig'))
        if environment.get('PKG_CONFIG_PATH'):
            paths.append(environment['PKG_CONFIG_PATH'])
        environment['PKG_CONFIG_PATH'] = os.pathsep.join(paths)
    icu_version = subprocess.check_output(['pkg-config', '--modversion', 'icu-uc'], env=environment, text=True).strip()
    if icu_version.split('.')[0] != '78':
        raise SystemExit(f'The native Intl bindings require ICU 78; found {icu_version}.')
    generate(debug=not args.release, environment=environment)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    native = ROOT / 'build/native'
    native.mkdir(parents=True, exist_ok=True)
    for package, archive in [
        ('libuv', 'libuv.a'), ('libssl', 'libssl.a'), ('libcrypto', 'libcrypto.a'),
        ('libcares', 'libcares.a'), ('libbrotlienc', 'libbrotlienc.a'),
        ('libbrotlidec', 'libbrotlidec.a'), ('libbrotlicommon', 'libbrotlicommon.a'),
        ('libzstd', 'libzstd.a'), ('libnghttp2', 'libnghttp2.a'),
        ('sqlite3', 'libsqlite3.a'), ('icu-i18n', 'libicui18n.a'),
        ('icu-uc', 'libicuuc.a'), ('icu-uc', 'libicudata.a'),
    ]:
        libdir = Path(subprocess.check_output(['pkg-config', '--variable=libdir', package], env=environment, text=True).strip())
        source, destination = libdir / archive, native / archive
        if not source.is_file():
            raise SystemExit(f'Install the {package} development static archive: {source}')
        if not destination.exists() or not filecmp.cmp(source, destination, shallow=False):
            shutil.copyfile(source, destination)
    build_native.build(native, environment, release=args.release)
    # Source-file compilation keeps the generic engine in one native object.
    command = ['silk', '+' + version, 'build', 'src/main.silk', '-o', str(args.output.resolve()),
               '--debug', str(not args.release).lower(),
               '--clang', str(ROOT / 'tools/clang.py')]
    if args.release:
        command += ['--optimization', 'speed']
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == '__main__':
    main()
