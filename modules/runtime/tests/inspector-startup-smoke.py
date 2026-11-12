#!/usr/bin/env python3
"""Run: python3 tests/inspector-startup-smoke.py build/silkjsruntime

Only the supplied runtime executes guest code. The Python client controls the
production inspector transport and checks startup ordering with a real file.
"""
import importlib.util
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("inspector_transport", Path(__file__).with_name("inspector-transport-smoke.py"))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
runtime = str(Path(sys.argv[1] if len(sys.argv) > 1 else "build/silkjsruntime").resolve())
base_env = {key: value for key, value in os.environ.items() if key != "NODE_OPTIONS"}


def evaluate(args, source, node_options=None):
    env = dict(base_env)
    if node_options is not None:
        env["NODE_OPTIONS"] = node_options
    result = subprocess.run([runtime, *args, "-e", source], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, (args, result.returncode, result.stdout, result.stderr)
    return result


evaluate(["--inspect-port", "0"], "const a=require('node:assert/strict');a.equal(process.features.inspector,true);a.equal(process.debugPort,0);a.equal(require('node:inspector').url(),undefined)")
evaluate(["--no-inspect"], "require('node:assert/strict').equal(require('node:inspector').url(),undefined)", "--inspect=127.0.0.1:0")
opened = evaluate(["--inspect=127.0.0.1:0"], r"require('node:assert/strict').match(require('node:inspector').url(),/^ws:\/\/127\.0\.0\.1:[1-9][0-9]*\//)")
assert re.search(r"Debugger listening on ws://127\.0\.0\.1:[1-9][0-9]*/[^\s]+\n", opened.stderr), opened.stderr
evaluate([], "require('node:assert/strict').match(require('node:inspector').url(),/^ws:/)", "--inspect=127.0.0.1:0")
evaluate(["--inspect=127.0.0.1:0"], """
const assert = require('node:assert/strict');
const {Worker} = require('node:worker_threads');
const source = `const {parentPort}=require('node:worker_threads');parentPort.postMessage({url:require('node:inspector').url(),enabled:process.features.inspector,args:process.execArgv})`;
const inherited = new Worker(source, {eval:true});
inherited.on('error', error => {throw error});
inherited.on('message', value => {assert.equal(value.url,undefined);assert.equal(value.enabled,true);assert.ok(value.args.includes('--inspect=127.0.0.1:0'))});
const explicit = new Worker(source, {eval:true,execArgv:['--inspect-port=0','--inspect']});
explicit.on('error', error => {throw error});
explicit.on('message', value => {assert.equal(value.url,undefined);assert.deepEqual(value.args,['--inspect-port=0','--inspect'])});
const data = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`import {parentPort} from 'node:worker_threads';import {url} from 'node:inspector';parentPort.postMessage({url:url(),enabled:process.features.inspector})`)));
data.on('error', error => {throw error});
data.on('message', value => {assert.equal(value.url,undefined);assert.equal(value.enabled,true)});
""")
evaluate(["--experimental-inspector-network-resource"], """
const assert=require('node:assert/strict'), inspector=require('node:inspector');
inspector.NetworkResources.put('smoke://startup','resource payload');
const session=new inspector.Session();session.connect();
session.post('Network.loadNetworkResource',{url:'smoke://startup',options:{disableCache:false,includeCredentials:false}},(error,result)=>{assert.ifError(error);assert.equal(result.resource.success,true);session.disconnect()});
""")


def startup(mode, directory, source_prefix="", expected_position=None):
    marker = directory / (mode + ".started")
    entry = directory / "entry.cjs"
    entry.write_text(source_prefix + "require('node:fs').writeFileSync(process.argv[2], 'started');\nsetInterval(() => {}, 1000);\n", encoding="utf-8")
    child = subprocess.Popen([runtime, "--" + mode + "=127.0.0.1:0", str(entry), str(marker)], env=base_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    ws = None
    diagnostics = b""
    endpoint_pattern = rb"ws://[^\s]+\r?\n"
    stage = "endpoint publication"
    def status():
        return (f"mode={mode}, stage={stage}, pid={child.pid}, exit={child.poll()!r}, "
                f"user_started={marker.exists()}, command={child.args!r}\n"
                f"stderr={diagnostics.decode(errors='replace')!r}\n"
                f"recent_protocol_events={ws.events[-8:] if ws is not None else []!r}")
    try:
        endpoint_match = None
        deadline = time.monotonic() + 10
        while endpoint_match is None:
            assert child.poll() is None, "guest exited before publishing its endpoint"
            remaining = deadline - time.monotonic()
            assert remaining > 0, "deadline expired before endpoint publication"
            readable, _, _ = select.select([child.stderr], [], [], remaining)
            assert readable, "inspector did not publish its endpoint"
            block = os.read(child.stderr.fileno(), 4096)
            assert block, "stderr closed before endpoint publication"
            diagnostics += block
            endpoint_match = re.search(endpoint_pattern, diagnostics)
        endpoint = endpoint_match.group().decode().strip()
        assert not marker.exists(), "user code ran before a debugger attached"
        stage = "WebSocket attachment"
        ws = transport.WebSocket(urlsplit(endpoint))
        stage = "Runtime.enable"
        ws.result(ws.command("Runtime.enable"))
        stage = "Debugger.enable"
        ws.result(ws.command("Debugger.enable"))
        assert not marker.exists(), "attachment alone released the startup wait"
        stage = "Runtime.runIfWaitingForDebugger"
        ws.result(ws.command("Runtime.runIfWaitingForDebugger"))
        if mode == "inspect-brk":
            stage = "first user pause"
            paused = ws.event("Debugger.paused")
            frame = paused["params"]["callFrames"][0]
            assert frame["url"].endswith("/entry.cjs"), frame
            if expected_position is None:
                first_column = len(source_prefix.rsplit("\n", 1)[-1].encode("utf-16-le")) // 2
                expected_position = (source_prefix.count("\n"), first_column)
            assert frame["location"]["lineNumber"] == expected_position[0], frame
            assert frame["location"]["columnNumber"] == expected_position[1], frame
            assert not marker.exists(), "breakpoint came after the first user statement"
            stage = "Debugger.resume"
            ws.result(ws.command("Debugger.resume"))
        deadline = time.monotonic() + 5
        stage = "user entry marker"
        while not marker.exists():
            assert time.monotonic() < deadline, "user code did not resume"
            assert child.poll() is None, "guest exited before writing the startup marker"
            time.sleep(0.01)
        assert marker.read_text() == "started"
        assert not any(event.get("method") == "Debugger.paused" for event in ws.events), "unexpected startup pause"
    except Exception as error:
        # Endpoint discovery consumed only the initial stderr bytes. Preserve
        # the real startup exception emitted after debugger release as well.
        for _ in range(16):
            readable, _, _ = select.select([child.stderr], [], [], 0)
            if not readable:
                break
            block = os.read(child.stderr.fileno(), 4096)
            if not block:
                break
            diagnostics += block
        raise AssertionError(f"{error}\n{status()}") from error
    finally:
        if ws is not None:
            ws.close()
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stderr.close()


with tempfile.TemporaryDirectory(prefix="silk-inspector-startup-") as directory:
    for mode in ("inspect-wait", "inspect-brk"):
        startup(mode, Path(directory))
    # As V8, a directive prologue has no break location: the first pause is the
    # first statement after it.
    for name, prefix, position in (
        ("unicode", "/* é😀 */", None),
        ("multiline", "/* é😀 */\r\n\n  ", None),
        ("directives", "'use strict';\r\n/* é😀 */\n  ", None),
    ):
        variant = Path(directory) / name
        variant.mkdir()
        startup("inspect-brk", variant, prefix, position)
print("inspector CLI, environment, Worker inheritance, wait and first-user break passed")
