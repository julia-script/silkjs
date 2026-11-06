#!/usr/bin/env python3
"""Checks the interpreter's opcode match in src/js_vm.silk against js_opcode_data.

Silk match patterns must be integer literals, so each arm of execute() names its
opcode in a trailing `// OP_name` comment. This verifies every literal equals that
opcode's value, that no opcode appears twice, and lists final opcodes that fall
through to the generic arm. extendedStep's arms, the opcodes final bytecode writes
behind OP_extended, are checked the same way and must cover op.isExtended exactly.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
data = (ROOT / 'src/js_opcode_data.silk').read_text()
values = {}
for name, value in re.findall(r'pub const (OP_\w+): u8 = (\d+)', data):
    if name.startswith('OP_FMT_'):
        continue
    values.setdefault(name, int(value))  # temporary opcodes reuse final numbers; keep the first
count = int(re.search(r'pub const OP_COUNT: usize = (\d+)', data).group(1))
final = {v: n for n, v in values.items() if v < count}

table = re.search(r'pub fn isExtended\(opcode: u8\) -> bool \{\n  return b"((?:\\x[0-9a-f]{2})*)"', data).group(1)
extended = {i for i, byte in enumerate(bytes.fromhex(table.replace('\\x', ''))) if byte}
final = {v: n for v, n in final.items() if v not in extended}
for name in re.findall(r'pub const (OP_\w+): u8 = \d+  // final bytecode only', data):
    final[values[name]] = name

source = (ROOT / 'src/js_vm.silk').read_text()


def function_body(name):
    body = source[source.index(f'unsafe effect fn {name}<'):]
    return body[:body.index('\n}\n')]


errors = []
seen = {}
for line in function_body('extendedStep').splitlines():
    match = re.match(r'\s*(\d+) =>.*?//\s*(OP_\w+)(?::.*)?\s*$', line)
    if not match:
        continue
    number, name = int(match.group(1)), match.group(2)
    if values.get(name) != number:
        errors.append(f'{name} is {values.get(name)}, but its extended arm matches {number}')
    seen[number] = name
if set(seen) != extended:
    errors.append(f'extendedStep arms {sorted(set(seen) ^ extended)} disagree with op.isExtended')
seen = {}
for line in function_body('execute').splitlines():
    match = re.match(r'\s*(\d+) =>.*?//\s*(OP_\w+)(?::.*)?\s*$', line)
    if not match:
        if re.match(r'\s*\d+ =>', line):
            errors.append(f'arm without an opcode comment: {line.strip()}')
        continue
    number, name = int(match.group(1)), match.group(2)
    if values.get(name) != number:
        errors.append(f'{name} is {values.get(name)}, but its arm matches {number}')
    if number in seen:
        errors.append(f'opcode {number} has two arms ({seen[number]} and {name})')
    seen[number] = name
for message in errors:
    print('error:', message)
missing = sorted(set(final) - set(seen))
if missing:
    print('generic arm handles:', ', '.join(final[n] for n in missing))
sys.exit(1 if errors else 0)
