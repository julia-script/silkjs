#!/usr/bin/env python3
"""One-time mechanical rename of the Copy `Value` type to `ValueBits`.

Rewrites every `Value` that is not a member access (`PropertySlot.Value`) in src/*.silk and
in the Silk sources embedded in scripts/*.py, then restores the two union variants that are
themselves named `Value`. Rerun it on a branch that still says `Value`, optionally naming
only the files to rewrite. Files that use the owning `Value` (js_owned_value and its
importers) are skipped, because there `Value` already means the owning handle.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r'(?<![.\w])Value\b(?!Bits)')
VARIANT = re.compile(r'^(\s*)ValueBits \{ pub value: ValueBits \},', re.M)

paths = [Path(arg).resolve() for arg in sys.argv[1:]] or sorted(
    list((ROOT / 'src').glob('*.silk')) + list((ROOT / 'scripts').glob('*.py')))
for path in paths:
    if path.name in (Path(__file__).name, 'js_owned_value.silk'):
        continue
    text = path.read_text()
    if 'import js_owned_value' in text:
        print(f'skipped {path.name}: it uses the owning Value')
        continue
    renamed = VARIANT.sub(r'\1Value { pub value: ValueBits },', WORD.sub('ValueBits', text))
    if renamed != text:
        path.write_text(renamed)
