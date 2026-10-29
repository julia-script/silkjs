#!/usr/bin/env python3
"""Run actual native shared scalar/bulk consumers and independent fault cleanup.

Literal byte expectations live in js_shared_scalar_oracle.silk. Existing pinned-C
buffer/typed oracles remain the source comparison for coercion and ownership;
this runner exercises the canonical shared backing paths they did not cover.
"""
import argparse
from pathlib import Path
import shutil
import struct
import tempfile
import tomllib

from verify_bytecode import executable_path, process
import toolchain

ROOT = Path(__file__).resolve().parents[1]
SOURCE = r'''
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.io.writer { Writer, WriterError }
import silk.io.writer_native { StdoutWriter }
import byte_buffer { ByteBuffer }
import js_string_types { StringLengthError }
import js_shared_scalar_oracle as oracle
pub effect fn main() -> i32 ! OutOfMemoryError | StringLengthError | WriterError {
  let mut system = Allocator.systemAllocatorProvider()
  let mut output = ByteBuffer.make()
  let baseline = run oracle.isolated(false, 0)
  let mut field: usize = 0
  while field < 5 {
    run output.writeU32(baseline[field]) |> Effect.provideMut<Allocator>(&mut system)
    field = field + 1
  }
  let mut cutoff: usize = 0
  while cutoff < CUTOFFS {
    let record = run oracle.isolated(true, cutoff)
    field = 0
    while field < 5 {
      run output.writeU32(record[field]) |> Effect.provideMut<Allocator>(&mut system)
      field = field + 1
    }
    cutoff = cutoff + 1
  }
  let mut writer = StdoutWriter.make()
  run Writer.writeAll(output.asSlice()) |> Effect.provideMut<Writer>(&mut writer)
  return 0
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cutoffs', type=int, default=128)
    args = parser.parse_args()
    if args.cutoffs < 1:
        parser.error('--cutoffs must be positive')
    silk = executable_path(args.silk)
    with tempfile.TemporaryDirectory(prefix='silkjs-shared-scalar-') as directory:
        temp = Path(directory)
        shutil.copytree(ROOT / 'src', temp / 'src')
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(
            f'[package]\nname="shared-scalar-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        (temp / 'src/main.silk').write_text(SOURCE.replace('CUTOFFS', str(args.cutoffs)))
        command = [silk, 'run', '--quiet', '--release']
        if args.stdlib:
            command += ['--stdlib', str(args.stdlib.resolve())]
        data = process(command, 1200, owner='shared scalar consumer', cwd=temp)
    expected_size = (args.cutoffs + 1) * 20
    if len(data) != expected_size:
        raise SystemExit(f'expected {expected_size} record bytes, got {len(data)}')
    rows = list(struct.iter_unpack('<5I', data))
    if rows[0] != (1, 0, 0, 0, 0):
        raise SystemExit(f'shared scalar baseline failed: {rows[0]}')
    clean = failures = 0
    for cutoff, row in enumerate(rows[1:]):
        success, injected, pending, allocations, used_bytes = row
        if allocations or used_bytes:
            raise SystemExit(f'cutoff={cutoff}: retained allocations/bytes={allocations}/{used_bytes}')
        if not success and not pending:
            raise SystemExit(f'cutoff={cutoff}: failure without pending exception')
        if not injected:
            clean += 1
            if row != rows[0]:
                raise SystemExit(f'cutoff={cutoff}: unfaulted result differs from baseline: {row}')
        failures += injected
    if not clean or not failures:
        raise SystemExit(f'incomplete fault sweep: unfaulted={clean}, injected failures={failures}')
    print(f'PASS shared scalar: clone/growth identity, unaligned DataView, typed read/write and raw NaN copy, shared slice, overlap moves and tail fill/copies; {args.cutoffs} fault attempts/{failures} failures; zero residual ledgers')


if __name__ == '__main__':
    main()
