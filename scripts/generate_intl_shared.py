#!/usr/bin/env python3
"""Transcribe numbering identities and digit bases from the pinned intl.c."""
import argparse
import hashlib
from pathlib import Path
import re


def generate(reference):
    source = (reference / 'intl/intl.c').read_bytes()
    text = source.decode()
    body = re.search(r'const char \*intl_all_numbering_systems\[\] = \{(.*?)\n\};', text, re.S).group(1)
    names = re.findall(r'"([a-z]+)"', body)
    bases = dict(re.findall(r'\[NS_(\w+)\]\s*=\s*(0x[0-9A-Fa-f]+)', text))
    hanidec = re.search(r'hanidec_cps\[10\] = \{(.*?)\};', text, re.S).group(1)
    points = re.findall(r'0x[0-9A-Fa-f]+', hanidec)
    out = ['// Generated from pinned QuickJS intl.c; LICENSE.quickjs.',
           '// Source SHA-256: ' + hashlib.sha256(source).hexdigest(),
           'pub const NS_UNKNOWN: i32 = -1', f'pub const NS_COUNT: i32 = {len(names)}',
           f'pub const intl_all_numbering_systems_count: i32 = {len(names)}',
           'pub const intl_supported_collations_count: i32 = 3']
    out += [f'pub const NS_{name.upper()}: i32 = {i}' for i, name in enumerate(names)]
    out += ["pub fn intl_all_numbering_systems(index: i32) -> string<'static> {", '  return match index {']
    out += [f'    {i} => "{name}"' for i, name in enumerate(names)]
    out += ['    _ => ""', '  }', '}', "pub fn intl_supported_collations(index: i32) -> string<'static> {",
            '  return match index { 0 => "emoji" 1 => "eor" 2 => "phonebk" _ => "" }', '}',
            'pub fn nf_digit_base(index: i32) -> u32 {', '  return match index {']
    out += [f'    {i} => {bases[name.upper()]}' for i, name in enumerate(names) if name.upper() in bases]
    out += ['    _ => 0', '  }', '}', 'pub fn hanidec_cps(index: i32) -> u32 {', '  return match index {']
    out += [f'    {i} => {point}' for i, point in enumerate(points)]
    out += ['    _ => 0', '  }', '}', '']
    return '\n'.join(out)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    parser.add_argument('--output', type=Path, default=Path('src/intl_numbering_data.silk'))
    args = parser.parse_args()
    args.output.write_text(generate(args.reference))
