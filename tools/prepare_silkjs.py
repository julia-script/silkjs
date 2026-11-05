#!/usr/bin/env python3
"""Prepare the manifest's pinned SilkJS archive before embedding or compilation."""
from pathlib import Path
import hashlib
import io
import os
import re
import tarfile
import tempfile
import urllib.request

from prepare_wamr import MAX_ARCHIVE_BYTES, _files, _members

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/julia-script/silkjs'


def prepare(manifest):
    dependency = manifest['dependencies']['silkjs']
    if 'git' in dependency or 'path' not in dependency:
        raise RuntimeError('SilkJS must use the explicit source path prepared by tools/build.py.')
    source = (ROOT / dependency['path']).resolve()
    pin = manifest.get('tool', {}).get('silkjs-source')
    if pin is not None:
        revision = pin['rev']
        checksum = pin['sha256']
        if pin['git'] != REPOSITORY:
            raise RuntimeError(f'SilkJS source repository must be {REPOSITORY}')
        if not re.fullmatch(r'[0-9a-f]{40}', revision):
            raise RuntimeError('SilkJS source rev must be a full lowercase Git commit hash.')
        if not re.fullmatch(r'[0-9a-f]{64}', checksum):
            raise RuntimeError('SilkJS source sha256 must be a full lowercase archive checksum.')
        root_name = f'silkjs-{revision}'
        directory = ROOT / 'build/deps'
        expected = directory / root_name
        if dependency['path'] != expected.relative_to(ROOT).as_posix() or source != expected:
            raise RuntimeError(f'SilkJS dependency path must be {expected.relative_to(ROOT)}')
        directory.mkdir(parents=True, exist_ok=True)
        archive_path = directory / f'{root_name}.tar.gz'
        if archive_path.exists():
            data = archive_path.read_bytes()
        else:
            url = f'https://codeload.github.com/julia-script/silkjs/tar.gz/{revision}'
            request = urllib.request.Request(url, headers={'User-Agent': 'silkjsruntime-dependency-preparation'})
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) > MAX_ARCHIVE_BYTES or hashlib.sha256(data).hexdigest() != checksum:
            raise RuntimeError(f'Pinned SilkJS source checksum mismatch: {archive_path}')
        if not archive_path.exists():
            with tempfile.NamedTemporaryFile(dir=directory, prefix='.silkjs-download-', delete=False) as output:
                temporary = Path(output.name)
                output.write(data)
            try:
                os.replace(temporary, archive_path)
            finally:
                temporary.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(dir=directory, prefix='.silkjs-source-') as temporary:
            stage = Path(temporary)
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                archive.extractall(stage, members=_members(archive, root_name), filter='data')
            staged = stage / root_name
            if source.exists():
                if _files(source) != _files(staged):
                    raise RuntimeError(f'Existing SilkJS sources differ from pinned source: {source}')
            else:
                staged.rename(source)
    if not (source / 'silk.toml').is_file():
        raise RuntimeError(f'SilkJS dependency manifest is missing: {source / "silk.toml"}')
    return source
