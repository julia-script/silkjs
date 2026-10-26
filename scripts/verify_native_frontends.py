#!/usr/bin/env python3
"""Exercise native qjs/qjsc as processes; no mock VM or C production fallback.

Builds are opt-in so integration owners can finish shared modules first. Each
assertion observes exit status, output, terminal behavior, or generated native
execution. Upstream tests are unmodified; failures remain failures.
"""
from __future__ import annotations

import argparse
from collections import Counter
import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import subprocess
import tempfile
import termios
import time
from verify_libc_plugins import build_bjson_plugin
import toolchain

ROOT = Path(__file__).resolve().parents[1]


def invoke(argv, *, cwd=ROOT, expected=0, stdout=None, stderr=None, timeout=90, env=None):
    result = subprocess.run([str(x) for x in argv], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    assert result.returncode == expected, (argv, result.returncode, result.stdout, result.stderr)
    if stdout is not None:
        assert result.stdout == stdout, (argv, result.stdout, stdout, result.stderr)
    if stderr is not None:
        assert result.stderr == stderr, (argv, result.stderr, stderr)
    return result


def build(compiler, stdlib, source, output, env):
    invoke([compiler, "build", source, "-o", output, "--stdlib", stdlib,
            "--optimization", "speed", "--debug", "false"], timeout=1800, env=env)


def terminal(qjs, env):
    master, slave = pty.openpty()
    original_terminal = termios.tcgetattr(slave)
    terminal_observer = os.dup(slave)
    process = subprocess.Popen([str(qjs)], stdin=slave, stdout=slave, stderr=slave,
                               cwd=ROOT, env=env, start_new_session=True)
    os.close(slave)
    transcript = bytearray()
    ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")

    def receive(marker, start=0):
        deadline = time.monotonic() + 30
        while marker not in ansi.sub(b"", bytes(transcript[start:])):
            assert time.monotonic() < deadline, (marker, bytes(transcript), process.poll())
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    else:
                        raise
                assert data, (marker, bytes(transcript), process.poll())
                transcript.extend(data)
        return len(transcript)

    try:
        receive(b"sjs > ")
        assert not (termios.tcgetattr(terminal_observer)[3] & termios.ICANON), "REPL did not enter raw mode"
        at = len(transcript)
        os.write(master, b"21*2\r")
        receive(b"42", at)
        receive(b"sjs > ", at)
        at = len(transcript)
        os.write(master, b"function f(x) {\r")
        receive(b"...", at)
        os.write(master, b"return x+1; }\r")
        receive(b"sjs > ", at)
        at = len(transcript)
        os.write(master, b"f(41)\r")
        receive(b"42", at)
        receive(b"sjs > ", at)
        at = len(transcript)
        os.write(master, b"\x1b[A\r")
        receive(b"42", at)
        receive(b"sjs > ", at)
        at = len(transcript)
        os.write(master, b"\\h\r")
        receive(b"toggle timing display", at)
        os.write(master, b"\\q\r")
        assert process.wait(timeout=30) == 0, bytes(transcript)
        restored_terminal = termios.tcgetattr(terminal_observer)
        # Darwin sets PENDIN when tcsetattr restores cooked processing. This is
        # kernel pending-input state, not a retained raw-mode setting (C oracle too).
        pending_input = getattr(termios, "PENDIN", 0)
        original_terminal[3] &= ~pending_input
        restored_terminal[3] &= ~pending_input
        assert restored_terminal == original_terminal, ("REPL exit did not restore terminal", original_terminal, restored_terminal)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(terminal_observer)
    return bytes(transcript)


def stack_scenarios(qjs, env):
    """Exercise physical parser/VM guards through the real native CLI."""
    count = 0

    def js(arguments, **kwargs):
        nonlocal count
        result = invoke([qjs, *arguments], env=env, **kwargs)
        count += 1
        return result

    nested = "(function(){" * 32
    js(["-e", nested + "})" * 32 + ";print('parsed')"],
       stdout=b"parsed\n", stderr=b"")
    js(["-e", nested + "print('executed')" + "})()" * 32],
       stdout=b"executed\n", stderr=b"")
    limited = js(["--stack-size", "64K", "-e", nested + "})" * 32], expected=1)
    assert b"InternalError: stack overflow" in limited.stderr
    deep = js(["-e", "(function(){" * 256 + "})" * 256], expected=1)
    assert b"InternalError: stack overflow" in deep.stderr

    recursion = (
        "var depth=0;function f(){++depth;f()}"
        "try{f()}catch(e){"
        "if(!(e instanceof InternalError)||e.message!=='stack overflow')throw e;"
        "print(depth)}"
    )
    normal = js(["-e", recursion], stderr=b"")
    small = js(["--stack-size", "64K", "-e", recursion], stderr=b"")
    assert 0 < int(small.stdout) < int(normal.stdout), (small.stdout, normal.stdout)
    # Empty precedence levels may be iterative, but operator precedence,
    # left associativity, short circuiting and evaluation order are unchanged.
    js(["-e",
        "let a=[];function n(x){a.push(x);return x}"
        "print(n(20)-n(6)/n(2)-n(3)*n(4),a.join(','));"
        "print(1+2<<2,8>>1+1,1|2^3&1,3<4==true,2**3**2);"
        "let k=0;print(false&&(++k),true||(++k),null??7,k);"
        "class C{#x;has(o){return #x in o && 2+3*4===14}}"
        "let c=new C;print(c.has(c),c.has({}));"
        "let o={x:9,f(){return this.x}};print(o?.f?.(),o.missing?.());"
        "function tag(s,x){return s[0]+x+s[1]}"
        "print(tag`a${2}b`,/a+/.test('aa'),new Date(0).getTime());"],
       stdout=b"5 20,6,2,3,4\n12 2 3 true 512\nfalse true 7 0\ntrue false\n9 undefined\na2b true 0\n",
       stderr=b"")
    unary = js(["-e", "-2**2"], expected=1)
    assert b"SyntaxError:" in unary.stderr
    return count


COMPILER_STAGES = ("dynamic", "experimental", "worker", "features", "module-loader", "stack", "native-module")


def suite(qjs, qjsc, reference, compiler, stdlib, env, output, bjson_plugin=None, compiler_start=None):
    count = 0
    stages = COMPILER_STAGES[COMPILER_STAGES.index(compiler_start):] if compiler_start else COMPILER_STAGES

    def js(arguments, **kwargs):
        nonlocal count
        result = invoke([qjs, *arguments], env=env, **kwargs)
        count += 1
        return result

    if compiler_start is None:
        js(["-e", "print(21*2)"], stdout=b"42\n", stderr=b"")
        js(["-eprint('attached')"], stdout=b"attached\n")
        js(["--eval", "print(JSON.stringify(scriptArgs))", "a", "--not-an-option"],
           stdout=b'["a","--not-an-option"]\n')
        js(["-e"], expected=2, stderr=b"qjs: missing expression for -e\n")
        js(["-I"], expected=1, stderr=b"expecting filename")
        js(["--memory-limit"], expected=1, stderr=b"expecting memory limit")
        js(["--stack-size"], expected=1, stderr=b"expecting stack size")
        js(["--memory-limit", "1z", "-q"], expected=1, stderr=b"qjs: invalid suffix: z\n")
        js(["--memory-limit", "1.9K", "-q"], expected=2, stderr=b"qjs: cannot allocate JS context\n")
        js(["--stack-size", "2MB", "-q"], stdout=b"", stderr=b"")
        assert b"usage: qjs" in js(["--help"], expected=1).stdout
        unknown = js(["--unknown"], expected=1)
        assert b"unknown option '--unknown'" in unknown.stderr and b"usage:" in unknown.stdout
        js(["-q", "-e", "throw 1"], stdout=b"", stderr=b"")
        js(["--strict", "-e", "undeclared_cli_variable=1"], expected=1)
        js(["-m", "-e", "await Promise.resolve();print(import.meta.main)"], stdout=b"undefined\n")
        js(["-e", "print((function(x){return eval('x+1')})(41))"], stdout=b"42\n")
        js(["-e", "print(function f(){return 42}.toString().includes('return 42'))"], stdout=b"true\n")
        js(["--strip-source", "-e", "print(function f(){return 42}.toString().includes('return 42'))"], stdout=b"false\n")
        js(["-s", "-e", "print(function f(){return 42}.toString().includes('return 42'))"], stdout=b"false\n")
        js(["--std", "-e", "print(typeof std.open,typeof os.setTimeout)"], stdout=b"function function\n")
        js(["--experimental", "-e", "print(new Intl.NumberFormat('en').format(1234));print(Temporal.PlainDate.from('2024-02-29').add({years:1}).toString())"],
           stdout=b"1,234\n2025-02-28\n")
        js(["-e", "print(typeof Intl,typeof Temporal)"], stdout=b"undefined undefined\n")
        js(["--no-unhandled-rejection", "-e", "Promise.reject('cli-rejection')"], stderr=b"")
        rejection = js(["-e", "Promise.reject('cli-rejection')"], expected=1)
        assert b"cli-rejection" in rejection.stderr
        trace = js(["-Tq"])
        allocations = Counter(re.findall(rb"^A [0-9]+ -> (H[+-][0-9]+\.[0-9]+)$", trace.stdout, re.M))
        frees = Counter(re.findall(rb"^F (H[+-][0-9]+\.[0-9]+)$", trace.stdout, re.M))
        assert allocations and allocations == frees, (allocations - frees, frees - allocations)
        stats = js(["-dq"])
        assert b"memory usage" in stats.stdout and b"Instantiation times (ms):" in stats.stdout
        objects = int(re.search(rb"^objects\s+(\d+)", stats.stdout, re.M).group(1))
        class_rows = stats.stdout.split(b"JSObject classes\n", 1)[1].split(b"\nNAME ", 1)[0]
        class_counts = [int(match.group(1)) for line in class_rows.splitlines()
                        if (match := re.match(rb"\s+(\d+)\s+\d+\s+", line))]
        assert objects > 0 and objects == sum(class_counts), (objects, class_counts)
        allocated_bytes = int(re.search(rb"^memory allocated\s+\d+\s+(\d+)", stats.stdout, re.M).group(1))
        used_bytes = int(re.search(rb"^memory used\s+\d+\s+(\d+)", stats.stdout, re.M).group(1))
        assert 0 < used_bytes <= allocated_bytes, (used_bytes, allocated_bytes)
        js(["--memory-limit", "1", "-q"], expected=2)
        count += stack_scenarios(qjs, env)
        assert b"usage: qjsc" in invoke([qjsc, "--help"], expected=1, env=env).stdout
        invoke([qjsc, "-o"], expected=1, stderr=b"qjsc: expecting parameter for -o\n", env=env)
        invoke([qjsc, "-fno-unknown"], expected=1, stderr=b"unsupported feature: no-unknown\n", env=env)
        count += 3

    with tempfile.TemporaryDirectory(prefix="silkjs-frontends-") as directory:
        work = Path(directory).resolve()
        if compiler_start is None:
            (work / "include.js").write_text("globalThis.includeOrder=(globalThis.includeOrder||'')+'I';\n")
            (work / "script.js").write_text("print(includeOrder);print(JSON.stringify(scriptArgs));\n")
            js(["-I", work / "include.js", "-I", work / "include.js", work / "script.js", "--x"],
               stdout=("II\n" + '["' + str(work / "script.js") + '","--x"]\n').encode())
            js(sum((["-I", str(work / "include.js")] for _ in range(33)), []) + ["-q"],
               expected=1, stderr=b"too many included files")
            (work / "auto.js").write_text("export const value=42; print(value);\n")
            js([work / "auto.js"], stdout=b"42\n")
            js(["--script", work / "auto.js"], expected=1)
            (work / "-dash.js").write_text("print('dash');\n")
            js(["--", "-dash.js"], cwd=work, stdout=b"dash\n")
            (work / "link.js").symlink_to(work / "auto.js")
            js([work / "link.js"], stdout=b"42\n")
        (work / "nested").mkdir()
        (work / "nested/dep.mjs").write_text("export const n=21;\n")
        (work / "a.mjs").write_text("import {b} from './b.mjs';export function a(){return 20}export const answer=b()+2;\n")
        (work / "b.mjs").write_text("import {a} from './a.mjs';export function b(){return a()*2}\n")
        (work / "data.json").write_text('{"answer":42}')
        (work / "entry.mjs").write_text("import {n} from './nested/dep.mjs';import {answer} from './a.mjs';import data from './data.json' with {type:'json'};await Promise.resolve();print(n*2,answer,data.answer,import.meta.main);\n")
        if compiler_start is None:
            js([work / "entry.mjs"], stdout=b"42 42 42 true\n")
        (work / "entry.js").write_text("print('native',JSON.stringify(scriptArgs.slice(1)));\n")
        package = work / "silk-package"
        (package / "src").mkdir(parents=True)
        (package / "silk.toml").write_text(
            '[package]\nname = "frontend_fixture"\nversion = "0.1.0"\n'
            '[dependencies]\nsilkjs = {path = ' + json.dumps(str(ROOT)) + '}\n'
        )
        generated = package / "src/main.silk"
        executable = work / "native"
        try:
            if compiler_start is None:
                invoke([qjsc, "-e", "-o", generated, work / "entry.mjs"], env=env)
                text = generated.read_text()
                assert "JS_NewRuntime" not in text and "quickjs-libc.h" not in text
                binary = work / "generated"
                build(compiler, stdlib, generated, binary, env)
                sources = [work / name for name in ["entry.mjs", "a.mjs", "b.mjs", "nested/dep.mjs", "data.json"]]
                for source in sources:
                    source.rename(source.with_name(source.name + ".hidden"))
                try:
                    invoke([binary], cwd=work, stdout=b"42 42 42 true\n", env=env)
                finally:
                    for source in sources:
                        source.with_name(source.name + ".hidden").rename(source)
                count += 2
                invoke([qjsc, "-c", "-N", "custom_bundle", "-p", "native_", "-o", work / "data.silk", work / "entry.mjs"], env=env)
                data = (work / "data.silk").read_text()
                assert "custom_bundle" in data and "fn main" not in data
                count += 1
                installation = work / "read-only-install"
                shutil.copytree(ROOT / "src", installation / "src")
                shutil.copy2(ROOT / "silk.toml", installation / "silk.toml")
                installed_paths = list(installation.rglob("*")) + [installation]
                for installed in installed_paths:
                    installed.chmod(0o555 if installed.is_dir() else 0o444)
                try:
                    readonly_env = dict(env, SILKJS_SOURCE_DIR=str(installation / "src"))
                    invoke([qjsc, "-o", executable, work / "entry.js"], env=readonly_env, timeout=1800)
                finally:
                    for installed in installed_paths:
                        installed.chmod(0o755 if installed.is_dir() else 0o644)
                invoke([executable, "hello", "--value"], stdout=b'native ["hello","--value"]\n', env=env)
                count += 1
                (work / "source.js").write_text("print(function kept(){return 42}.toString().includes('return 42'));\n")
                invoke([qjsc, "-x", "-s", "--keep-source", "-o", executable, work / "source.js"], env=env, timeout=1800)
                invoke([executable], stdout=b"true\n", env=env)
                count += 1
            if "dynamic" in stages:
                (work / "dynamic.mjs").write_text("export const answer=42;\n")
                (work / "dynamic-entry.mjs").write_text("const m=await import('./dynamic.mjs');print(m.answer);\n")
                invoke([qjsc, "-D", work / "dynamic.mjs", "-o", executable, work / "dynamic-entry.mjs"], env=env, timeout=1800)
                (work / "dynamic.mjs").unlink()
                (work / "dynamic-entry.mjs").unlink()
                invoke([executable], stdout=b"42\n", env=env)
                count += 1
            if "experimental" in stages:
                (work / "experimental.js").write_text("print(new Intl.NumberFormat('en').format(1234));print(Temporal.PlainDate.from('2024-02-29').add({years:1}).toString());\n")
                invoke([qjsc, "--experimental", "-o", executable, work / "experimental.js"], env=env, timeout=1800)
                invoke([executable], stdout=b"1,234\n2025-02-28\n", env=env)
                count += 1
            if "worker" in stages:
                (work / "compiled_worker.mjs").write_text(
                    "import * as os from 'os';"
                    "os.Worker.parent.onmessage=e=>{Atomics.store(e.data,0,42);"
                    "os.Worker.parent.postMessage(new Intl.NumberFormat('en').format(1234)+':'+Temporal.PlainDate.from('2024-02-29').toString());"
                    "os.Worker.parent.onmessage=null;};\n"
                )
                (work / "worker_main.mjs").write_text(
                    "import * as os from 'os';const worker=new os.Worker('./compiled_worker.mjs');"
                    "const data=new Int32Array(new SharedArrayBuffer(4));"
                    "worker.onmessage=e=>{print(data[0],e.data);worker.onmessage=null;};worker.postMessage(data);\n"
                )
                invoke([qjsc, "--experimental", "-D", work / "compiled_worker.mjs", "-o", executable, work / "worker_main.mjs"],
                       env=env, timeout=1800)
                (work / "compiled_worker.mjs").unlink()
                (work / "worker_main.mjs").unlink()
                invoke([executable], stdout=b"42 1,234:2024-02-29\n", env=env)
                count += 1
            if "features" in stages:
                (work / "suppressed.js").write_text(
                    "print(typeof Date,typeof JSON,typeof Proxy,typeof Map,typeof Uint8Array,typeof Promise,typeof WeakRef,typeof RegExp,typeof ''.normalize);"
                    "let rejected=false;try{eval('1')}catch(e){rejected=true}print(typeof eval,rejected);\n"
                )
                invoke([qjsc, "-fno-date", "-fno-json", "-fno-proxy", "-fno-map", "-fno-typedarray", "-fno-promise",
                        "-fno-weakref", "-fno-regexp", "-fno-string-normalize", "-fno-eval",
                        "-o", executable, work / "suppressed.js"], env=env, timeout=1800)
                invoke([executable], stdout=b"undefined undefined undefined undefined undefined undefined undefined undefined undefined\nfunction true\n", env=env)
                count += 1
            if "module-loader" in stages:
                (work / "not-bundled.mjs").write_text("export const answer=42;\n")
                (work / "loader.js").write_text("import('./not-bundled.mjs').then(()=>print('loaded'),()=>print('disabled'));\n")
                invoke([qjsc, "-fno-module-loader", "-o", executable, work / "loader.js"], env=env, timeout=1800)
                invoke([executable], stdout=b"disabled\n", env=env)
                count += 1
            if "stack" in stages:
                (work / "stack.js").write_text("function recurse(){recurse()}recurse();\n")
                verbose = invoke([qjsc, "-v", "-flto", "-S", "64K", "-o", executable, work / "stack.js"],
                                 env=env, timeout=1800)
                assert b"--optimization speed" in verbose.stdout
                limited = invoke([executable], expected=1, stdout=b"", env=env)
                assert b"stack overflow" in limited.stderr
                count += 1
            if "native-module" in stages:
                (work / "plugin.mjs").write_text(
                    "import {add,identity,version} from 'fixture';"
                    "const object={n:42};print(add(20,22),identity(object)===object,version);\n"
                )
                invoke([qjsc, "-M", "fixture,js_libc_plugins_fixture", "-o", executable, work / "plugin.mjs"],
                       env=env, timeout=1800)
                invoke([executable], stdout=b"42 true 1\n", env=env)
                count += 1
        finally:
            generated.unlink(missing_ok=True)

    if compiler_start is None:
        with tempfile.TemporaryDirectory(prefix="silkjs-upstream-") as upstream_work:
            for name in ["test_language.js", "test_closure.js", "test_loop.js", "test_builtin.js", "test_bigint.js",
                         "test_cyclic_import.js", "test_std.js", "test_worker.js", "test_rw_handler.js"]:
                # The pinned Makefile supplies --std specifically for test_builtin.
                options = ["--std"] if name == "test_builtin.js" else []
                js([*options, reference / "tests" / name], cwd=upstream_work, timeout=180)
            js(["--experimental", reference / "tests/test_intl.js"], cwd=upstream_work, timeout=180)
            upstream_path = Path(upstream_work).resolve()
            if bjson_plugin is None:
                build_bjson_plugin(upstream_path, compiler, stdlib, env["SILK_CLANG"], env)
            else:
                shutil.copyfile(bjson_plugin, upstream_path / "bjson.so")
            copied = upstream_path / "test_bjson.js"
            shutil.copyfile(reference / "tests/test_bjson.js", copied)
            js([copied], cwd=upstream_path, timeout=180)
        transcript = terminal(qjs, env)
        (output / "repl-transcript.bin").write_bytes(transcript)
        count += 1
    scope = "frontend" if compiler_start is None else f"compiler ({compiler_start} onward)"
    print(f"native {scope} process scenarios: {count} passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "build/native-frontends")
    parser.add_argument("--reference", type=Path, default=Path("/private/tmp/silkjs-quickjs-reference-20261023"))
    parser.add_argument("--compiler", type=Path, default=toolchain.compiler_path())
    parser.add_argument("--stdlib", type=Path, default=toolchain.stdlib_path())
    parser.add_argument("--bjson-plugin", type=Path, help="Reuse an already compiled native bjson plugin")
    parser.add_argument("--compiler-start", choices=COMPILER_STAGES,
                        help="Run compiler scenarios from this stage only; do not repeat interpreter/upstream/PTY checks")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(toolchain.host_environment(), SILK_VERIFY_MIR="1",
               SILKJS_SOURCE_DIR=str(ROOT / "src"), SILKJS_COMPILER=str(args.compiler.resolve()), SILKJS_STDLIB=str(args.stdlib.resolve()))
    qjs, qjsc = output / "qjs", output / "qjsc"
    if args.build:
        build(args.compiler, args.stdlib, ROOT / "src/main.silk", qjs, env)
        build(args.compiler, args.stdlib, ROOT / "src/qjsc_main.silk", qjsc, env)
    suite(qjs, qjsc, args.reference.resolve(), args.compiler, args.stdlib, env, output, args.bjson_plugin, args.compiler_start)


if __name__ == "__main__":
    main()
