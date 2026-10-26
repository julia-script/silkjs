#!/usr/bin/env python3
"""Build genuine Silk plugins and exercise native qjs/qjsc, with a separate C oracle.

No checks execute on import. --build-only produces fixture.so for other suites.
The compiler currently rejects package.kind=shared-library. We use its supported
object-form LLVM emission, then invoke the platform linker with PIC and an exact
export list. The resulting Darwin dylib intentionally keeps the .so suffix used
by the module loader. Only the optional oracle target includes QuickJS headers.
The default compiler and standard library come from the pinned installed release.
The entry wrapper invokes the exported factory through a typed C function pointer:
direct Silk calls to C exports are unsupported, while actual C ABI calls are supported.

Run after shared integration, for example:
  python3 scripts/verify_libc_plugins.py --qjs build/qjs --qjsc build/qjsc
ABI and ownership documentation lives in src/js_libc_plugins_abi.silk.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time
import toolchain

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "scripts/fixtures/libc_plugins"
DEFAULT_REFERENCE = Path("/private/tmp/silkjs-quickjs-reference-20261023")


def invoke(argv, *, cwd, env, expected=0, stdout=None, stderr=None, timeout=180):
    result = subprocess.run([str(x) for x in argv], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    assert result.returncode == expected, (argv, result.returncode, result.stdout, result.stderr)
    if stdout is not None:
        assert result.stdout == stdout, (argv, result.stdout, stdout, result.stderr)
    if stderr is not None:
        assert result.stderr == stderr, (argv, result.stderr, stderr)
    return result


def shared_flags(clang, output, *, oracle=False):
    flags = [str(clang)]
    if sys.platform == "darwin":
        flags += ["-isysroot", toolchain.sdkroot(), "-dynamiclib"]
        if oracle:
            flags += ["-Wl,-undefined,dynamic_lookup"]
        else:
            flags += ["-Wl,-exported_symbol,_silkjs_plugin_v1"]
    else:
        flags += ["-shared"]
    return flags + ["-o", str(output)]


def build_plugin(output, compiler, stdlib, clang, env, *, variant="valid",
                 module="js_libc_plugins_fixture", filename="fixture.so"):
    package = output / ("package-" + module + "-" + variant)
    source = package / "src"
    source.mkdir(parents=True, exist_ok=True)
    (package / "silk.toml").write_text(
        '[package]\nname = "native-plugin-fixture"\nversion = "0.1.0"\n'
        'kind = "object"\nmain = "entry.silk"\n')
    for source_module in ("js_libc_plugins_abi", module):
        shutil.copyfile(ROOT / "src" / (source_module + ".silk"), source / (source_module + ".silk"))
    symbol = "silkjs_plugin_v1" if variant != "missing-symbol" else "different_plugin_entry"
    after = ""
    extra = ""
    if variant == "bad-version":
        after = "let mut descriptor = unsafe Pointer.read(out) descriptor.version = 999 unsafe Pointer.write(out, descriptor)"
    elif variant == "factory-failure":
        after = "let descriptor = unsafe Pointer.read(out) unsafe descriptor.shutdown(descriptor.state) return 77"
    elif variant == "bad-export":
        extra = ('export "C" fn rejectedExport(state: ?*mut u8, index: u32, out: *mut Export) -> i32 '
                 'as "silkjs_fixture_rejected_export" { return 1 }\n')
        after = "let mut descriptor = unsafe Pointer.read(out) descriptor.describe = rejectedExport unsafe Pointer.write(out, descriptor)"
    ending = "" if variant == "factory-failure" else "return 0"
    (source / "entry.silk").write_text(
        'import js_libc_plugins_abi { Descriptor, Export }\n'
        f'import {module}\n'
        'import silk.pointer { Pointer }\n'
        'import silk.i32\n'
        + extra +
        f'export "C" fn entry(out: *mut Descriptor) -> i32 as "{symbol}" {{\n'
        f'  let initialize: extern "C" fn(*mut Descriptor) -> i32 = {module}.initialize\n'
        '  let status = unsafe initialize(out)\n'
        '  if status != 0 { return status }\n'
        f'  {after}\n  {ending}\n}}\n')
    ir = package / "plugin.ll"
    invoke([compiler, "build", source / "entry.silk", "-o", ir, "--emit", "llvm-ir",
            "--stdlib", stdlib, "--optimization", "speed", "--debug", "false"],
           cwd=package, env=env, timeout=1800)
    obj = package / "plugin.o"
    compile_args = [clang, "-fPIC", "-O2", "-c", ir, "-o", obj]
    if sys.platform == "darwin":
        compile_args += ["-isysroot", env.get("SDKROOT") or toolchain.sdkroot()]
    invoke(compile_args, cwd=package, env=env)
    result = output / (filename if variant == "valid" else variant + ".so")
    link = shared_flags(clang, result)
    if variant == "missing-symbol" and sys.platform == "darwin":
        link.remove("-Wl,-exported_symbol,_silkjs_plugin_v1")
        link.append("-Wl,-exported_symbol,_different_plugin_entry")
    if sys.platform != "darwin":
        exports = package / "exports.map"
        exports.write_text("{ global: " + symbol + "; local: *; };\n")
        link += ["-Wl,--version-script=" + str(exports)]
    invoke([*link, obj], cwd=package, env=env)
    return result


def build_bjson_plugin(output, compiler, stdlib, clang, env):
    """Build the native binary-serialization plugin for unchanged upstream tests."""
    return build_plugin(output, compiler, stdlib, clang, env,
                        module="js_libc_bjson_plugin", filename="bjson.so")


def module_file(directory, name, import_name, body, *, std=False):
    path = directory / name
    prefix = "import * as p from " + json.dumps(import_name) + ";\n"
    if std:
        prefix += "import * as std from 'std';\n"
    path.write_text(prefix + body)
    return path


def workers(directory, import_name, stem):
    child = module_file(directory, stem + "-child.mjs", import_name,
                        "import { Worker } from 'os';\n"
                        "Worker.parent.postMessage([p.next(),p.add(20,22)]);\n")
    parent = module_file(directory, stem + "-parent.mjs", import_name,
                         "import { Worker } from 'os';\n"
                         "import * as std from 'std';\n"
                         "if(p.next()!==1) throw Error('parent initial plugin state');\n"
                         f"const worker=new Worker('./{child.name}');\n"
                         "worker.onmessage=({data})=>{\n"
                         " if(data[0]!==1||data[1]!==42||p.next()!==2) throw Error('worker plugin isolation');\n"
                         " console.log('plugin worker received');\n"
                         " if(std.in.getline()!=='finish') throw Error('host release missing');\n"
                         " print('plugin worker ok');worker.onmessage=null;\n};\n")
    return parent, child


def invoke_worker(argv, *, cwd, env):
    # A source Worker is detached. Keep the parent genuinely blocked until its
    # child has published native plugin shutdown, rather than assuming that a
    # posted JS message also means the child runtime has already been freed.
    process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    observed = {process.stdout: bytearray(), process.stderr: bytearray()}
    expected = {process.stdout: b"plugin worker received\n",
                process.stderr: b"plugin-shutdown\n"}
    deadline = time.monotonic() + 30
    try:
        while any(bytes(observed[stream]) != expected[stream] for stream in observed):
            remaining = deadline - time.monotonic()
            assert remaining > 0, ("plugin Worker shutdown handshake timeout", observed)
            ready, _, _ = select.select(list(observed), [], [], remaining)
            assert ready, ("plugin Worker shutdown handshake timeout", observed)
            for stream in ready:
                data = os.read(stream.fileno(), 4096)
                assert data, ("plugin Worker exited before host release", observed)
                observed[stream].extend(data)
                assert expected[stream].startswith(observed[stream]), observed
        output, error = process.communicate(b"finish\n", timeout=30)
        output = bytes(observed[process.stdout]) + output
        error = bytes(observed[process.stderr]) + error
        assert process.returncode == 0, (process.returncode, output, error)
        assert output == b"plugin worker received\nplugin worker ok\n", output
        assert error == b"plugin-shutdown\nplugin-shutdown\n", error
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def suite(args, output, env):
    qjs, qjsc = args.qjs.resolve(), args.qjsc.resolve()
    trace = dict(env, SILKJS_PLUGIN_TRACE="1")
    common = (FIXTURES / "behavior.js").read_text()
    lifecycle = (FIXTURES / "lifecycle.js").read_text()
    dynamic = module_file(output, "dynamic.mjs", "./fixture.so", common)
    invoke([qjs, "-m", dynamic], cwd=output, env=trace,
           stdout=b"plugin behavior ok\n", stderr=b"plugin-shutdown\n")
    dynamic_lifecycle = module_file(output, "lifecycle.mjs", "./fixture.so", lifecycle, std=True)
    invoke([qjs, "-m", dynamic_lifecycle], cwd=output, env=trace,
           stdout=b"plugin lifecycle ok\n", stderr=b"plugin-shutdown\n")

    # One loaded library can serve two runtimes without sharing the factory state.
    parent, child = workers(output, "./fixture.so", "dynamic-worker")
    invoke_worker([qjs, "-m", parent], cwd=output, env=trace)

    # The same factory is linked statically into a native generated executable.
    static = module_file(output, "static.mjs", "fixture", common + lifecycle, std=True)
    executable = output / "static-plugin-app"
    invoke([qjsc, "-M", "fixture,js_libc_plugins_fixture", "-o", executable, static],
           cwd=output, env=env, timeout=1800)
    invoke([executable], cwd=output, env=trace,
           stdout=b"plugin behavior ok\nplugin lifecycle ok\n", stderr=b"plugin-shutdown\n")
    static_parent, static_child = workers(output, "fixture", "static-worker")
    worker_executable = output / "static-worker-app"
    invoke([qjsc, "-M", "fixture,js_libc_plugins_fixture", "-D", "./" + static_child.name,
            "-o", worker_executable, static_parent], cwd=output, env=env, timeout=1800)
    invoke_worker([worker_executable], cwd=output, env=trace)

    # Compilation declares .so dependencies without opening them. The artifact is
    # then executed only after a real module has been made available.
    absent = module_file(output, "absent.mjs", "./late.so", common)
    generated = output / "late.silk"
    invoke([qjsc, "-c", "-o", generated, absent], cwd=output, env=env, timeout=1800)
    late_exe = output / "late-app"
    invoke([qjsc, "-o", late_exe, absent], cwd=output, env=env, timeout=1800)
    shutil.copyfile(output / "fixture.so", output / "late.so")
    invoke([late_exe], cwd=output, env=trace,
           stdout=b"plugin behavior ok\n", stderr=b"plugin-shutdown\n")
    # Unused -M declarations must not require a corresponding Silk source module.
    unused = output / "unused.mjs"
    unused.write_text("print('unused declaration ok');\n")
    unused_exe = output / "unused-app"
    invoke([qjsc, "-M", "unused,this_module_does_not_exist", "-o", unused_exe, unused],
           cwd=output, env=env, timeout=1800)
    invoke([unused_exe], cwd=output, env=env, stdout=b"unused declaration ok\n")
    # -D dynamic native preload is also a declaration at compile time.
    dynamic_exe = output / "dynamic-plugin-app"
    invoke([qjsc, "-D", "./fixture.so", "-o", dynamic_exe, dynamic],
           cwd=output, env=env, timeout=1800)
    invoke([dynamic_exe], cwd=output, env=trace,
           stdout=b"plugin behavior ok\n", stderr=b"plugin-shutdown\n")

    for variant, expected_text in (("bad-version", b"incompatible SilkJS native plugin ABI"),
                                   ("factory-failure", b"native plugin initialization failed"),
                                   ("bad-export", b"native plugin export declaration failed"),
                                   ("missing-symbol", b"silkjs_plugin_v1")):
        build_plugin(output, args.compiler, args.stdlib, args.clang, env, variant=variant)
        failed = output / (variant + ".mjs")
        failed.write_text("import './" + variant + ".so';\n")
        result = subprocess.run([str(qjs), "-m", str(failed)], cwd=output, env=trace,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        assert result.returncode != 0, (variant, result.stdout, result.stderr)
        assert expected_text in result.stderr, (variant, result.stderr)
        if variant != "missing-symbol":
            assert result.stderr.count(b"plugin-shutdown\n") == 1, result.stderr
        assert b"plugin-leaked-invocation" not in result.stderr, result.stderr

    # An independent, separate QuickJS process is the observable-semantics oracle.
    oracle_module = output / "oracle.so"
    invoke([*shared_flags(args.clang, oracle_module, oracle=True), "-fPIC", "-O2",
            "-I", args.reference, FIXTURES / "oracle.c"], cwd=output, env=env)
    oracle_script = module_file(output, "oracle.mjs", "./oracle.so", common)
    invoke([args.reference / "qjs", "-m", oracle_script], cwd=output, env=env,
           stdout=b"plugin behavior ok\n", stderr=b"")
    print("native Silk plugin behavior/static/dynamic/worker/error ownership scenarios passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qjs", type=Path)
    parser.add_argument("--qjsc", type=Path)
    parser.add_argument("--compiler", type=Path, default=toolchain.compiler_path())
    parser.add_argument("--stdlib", type=Path, default=toolchain.stdlib_path())
    parser.add_argument("--clang", type=Path, default=Path(toolchain.clang_path()))
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--build-only", action="store_true")
    args = parser.parse_args()
    if not args.build_only and (args.qjs is None or args.qjsc is None):
        parser.error("--qjs and --qjsc are required unless --build-only is selected")
    args.compiler, args.stdlib, args.clang = args.compiler.resolve(), args.stdlib.resolve(), args.clang.resolve()
    args.reference = args.reference.resolve()
    (ROOT / "build").mkdir(exist_ok=True)
    output = args.output or Path(tempfile.mkdtemp(prefix="native-libc-plugins-", dir=ROOT / "build"))
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    env = dict(toolchain.host_environment(), SILK_CLANG=str(args.clang), SILK_VERIFY_MIR="1",
               SILKJS_SOURCE_DIR=str(ROOT / "src"), SILKJS_COMPILER=str(args.compiler),
               SILKJS_STDLIB=str(args.stdlib))
    fixture = build_plugin(output, args.compiler, args.stdlib, args.clang, env)
    if args.build_only:
        print(fixture)
    else:
        suite(args, output, env)


if __name__ == "__main__":
    main()
