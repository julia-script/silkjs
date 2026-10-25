#!/usr/bin/env python3
"""Focused native scoped-wait cancellation regression and standalone smoke.

The module-local regression waits for actual enqueued native waiters before
cancelling; it has no public production test hooks. The separate executable
covers cancellation-before-enqueue, enqueue races, JS uncatchable interruption,
allocation-failure paths, and owner teardown. No QuickJS C is linked or needed.
"""
import argparse
from pathlib import Path
import shutil
import tempfile
import tomllib

from verify_bytecode import executable_path, process

ROOT = Path(__file__).resolve().parents[1]
TEST = "scopedCancellationUnlinksBlockedWaitersWithoutPoisoningSharedQueue"
EXPECTED = b"PASS scoped cancellation: 66 native thread joins; uncatchable JS interruption including OOM; zero ledgers\n"
MAIN = r'''
import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.native_thread { SpawnError }
import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import js_atomics_native { SynchronizationError }
import js_atomics_cancellation_fixture as fixture
import js_exceptions { JsException }
import js_string_types { StringLengthError }
pub effect fn main() -> i32 ! OutOfMemoryError | SynchronizationError | SpawnError | StringLengthError | JsException | WriterError {
  let completed = run fixture.runCancellation()
  if completed != 66 { return 1 }
  run fixture.scopeAllocationFailure()
  run fixture.runInterrupted(false)
  run fixture.runInterrupted(true)
  let mut writer = StdoutWriter.make()
  run Writer.writeAll(b"PASS scoped cancellation: 66 native thread joins; uncatchable JS interruption including OOM; zero ledgers\n") |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--silk", default="silk")
    parser.add_argument("--stdlib", type=Path)
    args = parser.parse_args()
    silk = executable_path(args.silk)
    options = ["--stdlib", str(args.stdlib.resolve())] if args.stdlib else []
    with tempfile.TemporaryDirectory(prefix="silkjs-wait-cancellation-") as directory:
        temp = Path(directory)
        shutil.copytree(ROOT / "src", temp / "src")
        version = tomllib.loads((ROOT / "silk.toml").read_text())["package"]["silk-version"]
        (temp / "silk.toml").write_text(f'[package]\nname="wait-cancellation"\nversion="0.0.0"\nsilk-version="{version}"\n')
        (temp / "src/main.silk").write_text(MAIN)
        regression = process([silk, "test", "--file", "src/js_atomics_native.silk", "--filter", TEST,
                              "--timeout", "30", *options], 1200,
                             owner="scoped cancellation blocked-wait regression", cwd=temp)
        if TEST.encode() not in regression:
            raise SystemExit(f"focused cancellation regression was not selected: {regression!r}")
        print(regression.decode(), end="")
        result = process([silk, "run", "--quiet", "--release", *options], 1200,
                         owner="scoped cancellation native executable", cwd=temp)
        if result != EXPECTED:
            raise SystemExit(f"unexpected scoped cancellation smoke output: {result!r}")
        print(result.decode(), end="")


if __name__ == "__main__":
    main()
