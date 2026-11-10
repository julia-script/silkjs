#!/usr/bin/env python3
"""Install the published Silk release pinned by this project.

Run with: python3 scripts/install_toolchain.py
Uses `silk use VERSION`, which installs the release and sets Silk's global default.
No compiler checkout, local patch, bootstrap build, or copied SDK is required.
"""
from pathlib import Path
import shutil
import subprocess

from toolchain import compiler_path, release_version, stdlib_path

ROOT = Path(__file__).resolve().parents[1]


def main():
    version = release_version()
    silk = shutil.which('silk')
    if silk is None:
        raise SystemExit('Install the Silk tool using install.sh from silk-lang/silk, then rerun this script')
    subprocess.run([silk, 'use', version], cwd=ROOT, check=True)
    compiler = compiler_path()
    library = stdlib_path()
    if not compiler.is_file() or not (library / 'compositions.json').is_file():
        raise SystemExit(f'Incomplete installed Silk {version} toolchain: {compiler}, {library}')
    if not (library / 'silk/stack.silk').is_file():
        raise SystemExit(f'The installed Silk {version} SDK is missing silk.stack')
    print(f'Ready: Silk {version} at {compiler}')
    print('Run: silk check && silk build && silk run')


if __name__ == '__main__':
    main()
