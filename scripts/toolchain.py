"""Installed release paths and host tools shared by the verification scripts."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def release_version() -> str:
    return tomllib.loads((ROOT / "upstream.toml").read_text())["silk-toolchain"]["version"]


def compiler_path() -> Path:
    home = Path(os.environ.get("SILK_HOME") or "~/.silk").expanduser().resolve()
    return home / "toolchains" / release_version() / "bin/silkc"


def stdlib_path() -> Path:
    return compiler_path().parent.parent / "lib/silk/stdlib"


def clang_path() -> str:
    override = os.environ.get("SILK_CLANG")
    if override:
        return shutil.which(override) or str(Path(override).expanduser().resolve())
    version = str(tomllib.loads((ROOT / "upstream.toml").read_text())["silk-toolchain"]["clang-version"])
    major = version.split(".", 1)[0]
    candidates = [f"clang-{major}", f"/usr/lib/llvm-{major}/bin/clang"]
    if sys.platform == "darwin":
        candidates += [f"/opt/homebrew/opt/llvm@{major}/bin/clang", "/opt/homebrew/opt/llvm/bin/clang"]
    candidates.append("clang")
    for candidate in candidates:
        executable = shutil.which(candidate)
        if executable:
            return executable
    raise SystemExit(f"Clang {version} is required; install it or set SILK_CLANG")


def sdkroot() -> str | None:
    if sys.platform != "darwin":
        return None
    return os.environ.get("SDKROOT") or subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True
    ).strip()


def host_environment() -> dict[str, str]:
    environment = dict(os.environ, SILK_CLANG=clang_path())
    sdk = sdkroot()
    if sdk:
        environment["SDKROOT"] = sdk
    else:
        environment.pop("SDKROOT", None)
    return environment
