#!/usr/bin/env python3
"""Acquire pinned WAMR sources and apply the checked-in Silk embedding patches.

Preparation never configures or builds native code. Source and patch changes
are checked before an existing installation is reused.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import urllib.request

COMMIT = "25bd7eb63e828e4bd242cc9b38d260b4b31c6605"
SHA256 = "4ea552d9d979f3c3d5f9e298a1594150820d2b76e8328ad68779578edea7a873"
ROOT_NAME = f"wasm-micro-runtime-{COMMIT}"
PATCHED_ROOT_NAME = f"{ROOT_NAME}-silk"
ARTIFACT = f"{ROOT_NAME}.tar.gz"
URL = f"https://codeload.github.com/bytecodealliance/wasm-micro-runtime/tar.gz/{COMMIT}"
SIMDE_COMMIT = "71fd833d9666141edcd1d3c109a80e228303d8d7"
SIMDE_SHA256 = "72b2c14a487560b7eb203795f2c2fead5c7499662e639944cca2a9bb19f09029"
SIMDE_ROOT_NAME = f"simde-{SIMDE_COMMIT}"
SIMDE_URL = f"https://codeload.github.com/simd-everywhere/simde/tar.gz/{SIMDE_COMMIT}"
REPOSITORY = Path(__file__).resolve().parents[1]
PATCHES = REPOSITORY / "src" / "ext" / "wamr" / "patches"
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def _verified(data: bytes) -> bytes:
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError(f"Pinned WAMR source checksum mismatch: {ARTIFACT}")
    return data


def _patches() -> list[Path]:
    return sorted(PATCHES.glob("*.patch"))


def _files(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise RuntimeError(f"Source symlink escapes dependency: {path}")
            result[path.relative_to(root).as_posix()] = "symlink:" + os.readlink(path)
        elif path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _members(archive: tarfile.TarFile, root_name: str) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != root_name:
            raise RuntimeError(f"Unexpected dependency archive path: {member.name}")
        if member.issym() or member.islnk():
            target = PurePosixPath(member.linkname)
            if target.is_absolute():
                raise RuntimeError(f"Absolute dependency link: {member.name}")
            combined = path.parent / target if member.issym() else target
            parts = []
            for component in combined.parts:
                if component == "..":
                    if not parts:
                        raise RuntimeError(f"Escaping dependency link: {member.name}")
                    parts.pop()
                elif component != ".":
                    parts.append(component)
            if not parts or parts[0] != root_name:
                raise RuntimeError(f"Escaping dependency link: {member.name}")
        elif not (member.isfile() or member.isdir()):
            raise RuntimeError(f"Unsupported dependency archive member: {member.name}")
    return members

def prepare_simde(directory: Path | str | None = None) -> Path:
    """Acquire the pinned header-only SIMD dependency without configuring it."""
    destination = Path(directory) if directory is not None else REPOSITORY / "build" / "deps"
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / f"{SIMDE_ROOT_NAME}.tar.gz"
    if archive_path.exists():
        data = archive_path.read_bytes()
    else:
        request = urllib.request.Request(SIMDE_URL, headers={"User-Agent": "silkjsruntime-dependency-preparation"})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read(MAX_ARCHIVE_BYTES + 1)
    if hashlib.sha256(data).hexdigest() != SIMDE_SHA256:
        raise RuntimeError("Pinned SIMDe source checksum mismatch")
    if not archive_path.exists():
        with tempfile.NamedTemporaryFile(dir=destination, prefix=".simde-download-", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        try:
            os.replace(temporary, archive_path)
        finally:
            temporary.unlink(missing_ok=True)
    sources = destination / SIMDE_ROOT_NAME
    with tempfile.TemporaryDirectory(dir=destination, prefix=".simde-source-") as temporary:
        stage = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            archive.extractall(stage, members=_members(archive, SIMDE_ROOT_NAME), filter="data")
        staged = stage / SIMDE_ROOT_NAME
        if sources.exists():
            if _files(sources) != _files(staged):
                raise RuntimeError(f"Existing SIMDe sources differ from pinned source: {sources}")
        else:
            staged.rename(sources)
    return sources



def prepare(directory: Path | str | None = None) -> Path:
    """Return verified and patched sources; never invoke a compiler or CMake."""
    destination = Path(directory) if directory is not None else REPOSITORY / "build" / "deps"
    destination.mkdir(parents=True, exist_ok=True)
    prepare_simde(destination)
    archive_path = destination / ARTIFACT
    if archive_path.exists():
        data = _verified(archive_path.read_bytes())
    else:
        request = urllib.request.Request(URL, headers={"User-Agent": "silkjsruntime-dependency-preparation"})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = _verified(response.read(MAX_ARCHIVE_BYTES + 1))
        with tempfile.NamedTemporaryFile(dir=destination, prefix=".wamr-download-", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        try:
            os.replace(temporary, archive_path)
        finally:
            temporary.unlink(missing_ok=True)

    sources = destination / PATCHED_ROOT_NAME
    manifest_path = destination / f"{PATCHED_ROOT_NAME}.manifest.json"
    with tempfile.TemporaryDirectory(dir=destination, prefix=".wamr-source-") as temporary:
        stage = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            archive.extractall(stage, members=_members(archive, ROOT_NAME), filter="data")
        staged = stage / ROOT_NAME
        pristine = _files(staged)
        for patch in _patches():
            subprocess.run(
                ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(patch.resolve())],
                cwd=staged,
                check=True,
                stdin=subprocess.DEVNULL,
            )
        patched = _files(staged)
        if sources.exists():
            existing = _files(sources)
            if existing == patched:
                manifest_path.write_text(json.dumps(patched, sort_keys=True), encoding="utf-8")
                return sources
            previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
            if existing != pristine and existing != previous:
                raise RuntimeError(f"Existing WAMR sources contain changes outside preparation: {sources}")
            # Upgrade only a previously prepared, unmodified source tree.
            backup = stage / "previous-source"
            sources.rename(backup)
            try:
                staged.rename(sources)
            except BaseException:
                backup.rename(sources)
                raise
        else:
            staged.rename(sources)
        manifest_path.write_text(json.dumps(patched, sort_keys=True), encoding="utf-8")
    return sources


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    print(prepare(args.directory))
