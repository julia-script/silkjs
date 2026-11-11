#!/usr/bin/env python3
"""Exercise native libc loaders and a separate pinned QuickJS CLI oracle.

No production binary links the oracle. Both interpreters run the same fixtures;
both compilers build real executables, then their entire input tree is removed.
The latter proves bundled JSON/JSON5, cycles, TLA, dynamic -D, and Worker runtime
inheritance rather than merely inspecting generated arrays or checking exit zero.
Requires already-built CLI binaries; this verifier never builds Silk itself.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "libc_modules"


def execute(command, cwd, timeout=60):
    result = subprocess.run(
        [str(part) for part in command], cwd=cwd, capture_output=True,
        text=True, timeout=timeout, check=False,
    )
    return result


def success(command, cwd, expected):
    result = execute(command, cwd)
    if result.returncode != 0 or result.stdout != expected or result.stderr:
        raise AssertionError(
            f"{command}: exit={result.returncode}\n"
            f"stdout={result.stdout!r}\nstderr={result.stderr!r}\n"
            f"expected stdout={expected!r} and empty stderr"
        )
    return result.stdout


def failure(command, cwd, expected):
    result = execute(command, cwd)
    if result.returncode == 0 or expected not in result.stderr or result.stdout:
        raise AssertionError(
            f"{command}: expected nonzero exit and {expected!r}; "
            f"exit={result.returncode}, stdout={result.stdout!r}, stderr={result.stderr!r}"
        )


def compile_executable(compiler, cwd, root, dynamic, output, options=()):
    command = [compiler, *options, "-o", output]
    for module in dynamic:
        command.extend(["-D", module])
    command.append(root)
    result = execute(command, cwd, timeout=900)
    if result.returncode != 0:
        raise AssertionError(
            f"compiler {command}: exit={result.returncode}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    if not output.is_file():
        raise AssertionError(f"compiler did not create executable {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("native-qjs", "oracle-qjs", "native-qjsc", "oracle-qjsc"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    binaries = {name: path.expanduser().resolve(strict=True) for name, path in vars(args).items()}
    if binaries["native_qjs"] == binaries["oracle_qjs"]:
        raise SystemExit("native and C oracle interpreters must be separate executables")
    if binaries["native_qjsc"] == binaries["oracle_qjsc"]:
        raise SystemExit("native and C oracle compilers must be separate executables")
    graph_output = "modules:42:7:19:json5\n"
    worker_output = "worker:42\n"
    with tempfile.TemporaryDirectory(prefix="silkjs-libc-modules-") as temporary:
        work = Path(temporary).resolve()
        shutil.copytree(FIXTURES, work / "graph")
        (work / "alias").symlink_to("graph", target_is_directory=True)
        # Source path contains a symlink. Dependency URLs must use realpath,
        # while normalization retains leading/interior path source semantics.
        (work / "graph" / "realpath.mjs").write_text(
            "import {metadata} from './cycle-a.mjs';\n"
            "if (metadata.url.includes('/alias/') || !metadata.url.includes('/graph/')) "
            "throw Error('dependency realpath');\nprint('realpath:ok');\n"
        )
        for engine in ("oracle_qjs", "native_qjs"):
            qjs = binaries[engine]
            success([qjs, "graph/main.mjs"], work, graph_output)
            success([qjs, "alias/main.mjs"], work, graph_output)
            success([qjs, "alias/realpath.mjs"], work, "realpath:ok\n")
            success([qjs, "graph/worker-main.mjs"], work, worker_output)
            failure([qjs, "graph/unsupported.mjs"], work, "import attribute 'unsupported' is not supported")
            failure([qjs, "graph/invalid-json.mjs"], work, "SyntaxError")
        executables = []
        for engine in ("oracle_qjsc", "native_qjsc"):
            compiler = binaries[engine]
            graph_exe = work / (engine + "-graph")
            compile_executable(compiler, work, "graph/main.mjs", ["graph/dynamic.mjs"], graph_exe)
            executables.append((graph_exe, graph_output))
            worker_exe = work / (engine + "-worker")
            compile_executable(compiler, work, "graph/worker-main.mjs", ["graph/worker.mjs"], worker_exe)
            executables.append((worker_exe, worker_output))
            bundle_only = work / (engine + "-bundle-only")
            compile_executable(
                compiler, work, "graph/no-loader.mjs", [], bundle_only,
                options=("-fno-module-loader",),
            )
            # external.mjs exists: a missing file cannot falsely satisfy this.
            success([bundle_only], work, "bundle-only:40\n")
            executables.append((bundle_only, "bundle-only:40\n"))
        # No source fallback can rescue omitted module captures in either binary.
        (work / "alias").unlink()
        shutil.rmtree(work / "graph")
        for executable, expected in executables:
            success([executable], work, expected)
    print("libc modules: source, symlinks, attributes, JSON/JSON5, cycles, TLA, -D and source-free Worker bundles passed")


if __name__ == "__main__":
    main()
