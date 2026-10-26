#!/usr/bin/env python3
"""One-time mechanical rename of the Copy `Value` type to `ValueBits`.

Rewrites every `Value` that is not a member access (`PropertySlot.Value`) in src/*.silk and
in the Silk sources embedded in scripts/*.py, then restores the two union variants that are
themselves named `Value`. Idempotent: rerun it on a branch that still says `Value`.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r'(?<![.\w])Value\b(?!Bits)')
VARIANT = re.compile(r'^(\s*)ValueBits \{ pub value: ValueBits \},', re.M)

for path in sorted(list((ROOT / 'src').glob('*.silk')) + list((ROOT / 'scripts').glob('*.py'))):
    if path.name == Path(__file__).name:
        continue
    text = path.read_text()
    renamed = VARIANT.sub(r'\1Value { pub value: ValueBits },', WORD.sub('ValueBits', text))
    if renamed != text:
        path.write_text(renamed)
