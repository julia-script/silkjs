#!/usr/bin/env python3
"""Reproduce dev.17 rejecting a symlinked output directory (both builds should pass).

Run: python3 scripts/repro_compiler_output_symlink.py
The program is only `pub fn main() -> i32 { return 0 }`; no SilkJS code is involved.
"""
from pathlib import Path
import subprocess
import tempfile

from toolchain import compiler_path, release_version


def main():
    compiler = compiler_path()
    with tempfile.TemporaryDirectory(prefix='silk-output-symlink-') as directory:
        root = Path(directory).resolve()
        source = root / 'src/main.silk'
        source.parent.mkdir()
        source.write_text('pub fn main() -> i32 { return 0 }\n')
        (root / 'silk.toml').write_text(
            '[package]\nname = "output_symlink_repro"\nversion = "0.0.0"\n'
            f'silk-version = "{release_version()}"\n'
        )
        real = root / 'real'
        real.mkdir()
        linked = root / 'linked'
        linked.symlink_to(real, target_is_directory=True)
        for label, output in [('canonical control', real / 'control'), ('symlinked output', linked / 'program')]:
            command = [str(compiler), 'build', str(source), '-o', str(output)]
            print(f'{label}: {command}', flush=True)
            result = subprocess.run(command, cwd=root)
            print(f'{label}: exit {result.returncode}', flush=True)
            if result.returncode != 0:
                return result.returncode
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
