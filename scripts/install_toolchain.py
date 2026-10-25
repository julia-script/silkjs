#!/usr/bin/env python3
"""Install this project's verified compiler and SDK without changing Silk's default.

Run once with: python3 scripts/install_toolchain.py
The compiler/SDK artifacts named in upstream.toml must already exist. The installed
copy lives outside build/, so `silk clean` cannot remove the project's toolchain.
"""
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def file_digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def tree_digest(directory):
    digest = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            digest.update(path.relative_to(directory).as_posix().encode() + b'\0')
            digest.update(file_digest(path).encode() + b'\0')
    return digest.hexdigest()


def main():
    config = tomllib.loads((ROOT / 'upstream.toml').read_text())['silk-toolchain']
    package = tomllib.loads((ROOT / 'silk.toml').read_text())['package']
    version = config['installed-version']
    if package['silk-version'] != version:
        raise SystemExit('silk.toml does not select the toolchain recorded in upstream.toml')
    compiler = ROOT / config['compiler']
    library = ROOT / config['stdlib']
    if not compiler.is_file() or not (library / 'compositions.json').is_file():
        raise SystemExit(f'Missing verified compiler/SDK artifacts: {compiler}, {library}')
    if file_digest(compiler) != config['compiler-sha256']:
        raise SystemExit('Compiler digest differs from upstream.toml; refusing to mislabel it')
    if not (library / 'silk/stack.silk').is_file():
        raise SystemExit('The verified SDK must include silk.stack')
    home = Path(os.environ.get('SILK_HOME') or Path.home() / '.silk').expanduser().resolve()
    store = home / 'toolchains'
    destination = store / version
    if destination.exists():
        installed = destination / 'bin/silkc'
        sdk = destination / 'lib/silk/stdlib'
        if (installed.is_file() and file_digest(installed) == config['compiler-sha256']
                and sdk.is_dir() and tree_digest(sdk) == tree_digest(library)):
            print(f'Already installed: {destination}; global default unchanged')
            return
        raise SystemExit(f'Refusing to overwrite a different existing toolchain: {destination}')
    store.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f'.{version}-', dir=store) as temporary:
        staged = Path(temporary)
        (staged / 'bin').mkdir()
        # Copy, not symlink: silkc discovers the SDK beside its resolved executable.
        shutil.copy2(compiler, staged / 'bin/silkc')
        shutil.copytree(library, staged / 'lib/silk/stdlib')
        staged.rename(destination)
    print(f'Installed: {destination}; global default unchanged')
    print('Run: silk run')


if __name__ == '__main__':
    main()
