#!/usr/bin/env python3
"""Translate all pinned intl/locale-data.c initializers into native readonly Silk.

Usage: python3 scripts/generate_intl_locale_data.py /path/to/quickjs/intl/locale-data.c
No C compiler, host locale database, or runtime allocation is used. Numeric record
storage is explicitly little-endian, independent of the C ABI's bitfield layout.
String payloads retain embedded NULs; raw accessors include the C terminator.
"""
import argparse
import hashlib
import re
from pathlib import Path

REVISION = '7d1c13c5d8f8c6b32893786ed35cdcebd88194d2'
SOURCE_SHA256 = '61b0bdf2df6347be0d7573c85ec07e373bccad41caa8cc7238f81ad9a52fc812'
HEADER_SHA256 = 'd2ce6d65a8c00cdc0c56ef95d51139b031836aa568bce7ca934fa98f28ffd144'
TOKEN = re.compile(r'\s+|/\*.*?\*/|//[^\n]*|"(?:[^"\\]|\\.)*"|0[xX][0-9a-fA-F]+|[0-9]+|[A-Za-z_]\w*|.', re.S)


def tokens(text):
    return [m[0] for m in TOKEN.finditer(text)
            if not m[0].isspace() and not m[0].startswith(('/*', '//'))]


def c_string(token):
    """Decode C escapes as bytes, not Unicode codepoints or Python escapes."""
    out = bytearray()
    i = 1
    while i < len(token) - 1:
        ch = token[i]
        i += 1
        if ch != '\\':
            out.extend(ch.encode('utf-8'))
            continue
        ch = token[i]
        i += 1
        if ch in '01234567':
            digits = ch
            while len(digits) < 3 and i < len(token) - 1 and token[i] in '01234567':
                digits += token[i]
                i += 1
            out.append(int(digits, 8))
        elif ch == 'x':
            start = i
            while i < len(token) - 1 and token[i] in '0123456789abcdefABCDEF':
                i += 1
            if start == i:
                raise ValueError('Empty C hex escape')
            out.append(int(token[start:i], 16))
        elif ch in "'\"?\\abfnrtv":
            out.append(dict(zip("'\"?\\abfnrtv", [39, 34, 63, 92, 7, 8, 12, 10, 13, 9, 11]))[ch])
        elif ch != '\n':
            raise ValueError(f'Unsupported C escape: {ch}')
    return bytes(out)


class Initializer:
    def __init__(self, items):
        self.items = items
        self.at = 0

    def take(self, expected=None):
        token = self.items[self.at]
        self.at += 1
        if expected is not None and token != expected:
            raise ValueError(f'Expected {expected}, got {token}')
        return token

    def value(self):
        token = self.take()
        if token == '{':
            result = []
            while self.items[self.at] != '}':
                result.append(self.value())
                if self.items[self.at] != '}':
                    self.take(',')
            self.take('}')
            return result
        if token.startswith('"'):
            result = c_string(token)
            while self.at < len(self.items) and self.items[self.at].startswith('"'):
                result += c_string(self.take())
            return result
        if token == '-':
            return -int(self.take(), 0)
        if token[0].isdigit():
            return int(token, 0)
        if token == 'NULL':
            return None
        if re.fullmatch(r'\w+', token):
            return token
        raise ValueError(f'Unsupported initializer: {token}')


def parse_source(source):
    text = source.decode('utf-8')
    defines = re.findall(r'^#define (\w+) (\d+)\s*$', text, re.M)
    text = re.sub(r'^#(?:include|define)[^\n]*', '', text, flags=re.M)
    stream = tokens(text)
    declarations = []
    counts = []
    at = 0
    while at < len(stream):
        end = stream.index(';', at)
        declaration = stream[at:end]
        at = end + 1
        eq = declaration.index('=')
        lhs, rhs = declaration[:eq], declaration[eq + 1:]
        if lhs[-2:] == ['[', ']']:
            name = lhs[-3]
            ctype = ' '.join(t for t in lhs[:-3] if t not in ('static', 'const'))
            parser = Initializer(rhs)
            value = parser.value()
            if parser.at != len(rhs):
                raise ValueError(f'Unconsumed initializer in {name}')
            declarations.append((ctype, name, value))
        elif lhs[:2] == ['const', 'int']:
            name = lhs[2]
            expression = ''.join(rhs)
            match = re.fullmatch(r'sizeof\((\w+)\)/sizeof\(\1\[0\]\)', expression)
            if not match:
                raise ValueError(f'Unsupported count: {name}')
            counts.append((name, match[1]))
        else:
            raise ValueError(f'Unhandled declaration: {lhs}')
    return declarations, counts, defines


def parse_contracts(header):
    text = header.decode('utf-8')
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    contracts = {}
    for body, name in re.findall(r'typedef struct\s*\{(.*?)\}\s*(\w+);', text, re.S):
        fields = []
        for declaration in body.split(';'):
            if not declaration.strip():
                continue
            match = re.fullmatch(r'\s*(.*?)\s*(\w+)\s*(?::\s*(\d+))?\s*', declaration)
            ctype, field, bits = match.groups()
            ctype = ' '.join(ctype.split())
            if ctype == 'const char *':
                kind = 'optional_string' if name == 'CompactDecimalPattern' else 'string'
                width = 8
            elif ctype == 'const CompactDecimalPattern *':
                kind, width = 'compact_offset', 4
            elif ctype in contracts:
                kind, width = ctype, sum(f[2] for f in contracts[ctype])
            elif ctype in ('int', 'unsigned', 'uint8_t', 'uint16_t'):
                kind = 'i32' if ctype == 'int' else 'usize'
                width = (int(bits) + 7) // 8 if bits else {'int': 4, 'unsigned': 4, 'uint8_t': 1, 'uint16_t': 2}[ctype]
            else:
                raise ValueError(f'Unsupported field: {name}.{field}: {ctype}')
            fields.append((field, kind, width, int(bits) if bits else None))
        contracts[name] = fields
    return contracts


def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


class Generator:
    def __init__(self, contracts, declarations):
        self.contracts = contracts
        self.values = {name: value for _, name, value in declarations}
        self.pool = bytearray()
        self.strings = {}
        self.compact = []
        self.compact_offsets = {}
        for ctype, name, value in declarations:
            if ctype == 'CompactDecimalPattern':
                self.compact_offsets[name] = len(self.compact)
                self.compact.extend(value)
        self.out = [
            '// Generated by scripts/generate_intl_locale_data.py; do not edit.',
            f'// QuickJS {REVISION}; LICENSE.quickjs.',
            f'// locale-data.c SHA-256: {SOURCE_SHA256}',
            '// Complete source tables. Storage records are little-endian, not C ABI layouts.',
            '// String accessors exclude only the implicit C terminator; _raw includes it.',
            '// All returned slices borrow readonly static storage. Invalid table indices trap.',
            '// LocaleData.compactPatterns is a compact_pattern row offset, not a pointer.',
            'import silk.collections.slice { Slice }', 'import silk.core.option { Option }', 'import silk.num.u8', 'import silk.num.usize', '',
        ]

    def string(self, value):
        if value is None:
            return (0xffffffff).to_bytes(4, 'little') + bytes(4)
        if isinstance(value, str):
            value = self.values[value]
        if not isinstance(value, bytes):
            raise ValueError(f'Not a string: {value}')
        if value not in self.strings:
            self.strings[value] = len(self.pool)
            self.pool.extend(value + b'\0')
        return self.strings[value].to_bytes(4, 'little') + len(value).to_bytes(4, 'little')

    def record(self, kind, value):
        fields = self.contracts[kind]
        if len(fields) != len(value):
            raise ValueError(f'Wrong arity: {kind}: {len(value)} != {len(fields)}')
        out = bytearray()
        for (field, typ, width, bits), item in zip(fields, value):
            if typ in ('string', 'optional_string'):
                if item is None and typ == 'string':
                    raise ValueError(f'Unexpected NULL: {kind}.{field}')
                encoded = self.string(item)
            elif typ in self.contracts:
                encoded = self.record(typ, item)
            else:
                if typ == 'compact_offset':
                    item = self.compact_offsets[item]
                if bits is not None and not 0 <= item < 1 << bits:
                    raise ValueError(f'Bitfield overflow: {kind}.{field}')
                encoded = item.to_bytes(width, 'little', signed=typ == 'i32')
            if len(encoded) != width:
                raise ValueError(f'Width mismatch: {kind}.{field}')
            out.extend(encoded)
        return bytes(out)

    def bytes_fn(self, name, data):
        self.out += [f"pub fn {name}() -> &'static [u8] {{", f'  return {literal(data)}', '}', '']

    def contracts_out(self):
        types = {'string': "&'static [u8]", 'optional_string': "Option<&'static [u8]>", 'compact_offset': 'usize'}
        for name, fields in self.contracts.items():
            self.out.append(f'pub struct {name} {{')
            self.out.extend(f'  pub {field}: {types.get(kind, kind)},' for field, kind, _, _ in fields)
            self.out += ['}', '']
            self.out += [f'fn decode{name}(data: &[u8], at: usize) -> {name} {{', f'  return {name} {{']
            offset = 0
            for field, kind, width, _ in fields:
                pos = f'at + {offset}'
                if kind == 'string':
                    expr = f'readString(data, {pos})'
                elif kind == 'optional_string':
                    expr = f'readOptionalString(data, {pos})'
                elif kind in self.contracts:
                    expr = f'decode{kind}(data, {pos})'
                elif kind == 'i32':
                    expr = f'readSigned32(data, {pos})'
                else:
                    expr = f'read{width * 8}(data, {pos})'
                self.out.append(f'    {field}: {expr},')
                offset += width
            self.out += ['  }', '}', '']

    def table(self, ctype, name, value):
        if ctype == 'char':
            descriptor = self.string(value)
            offset = int.from_bytes(descriptor[:4], 'little')
            self.out += [f'pub const {name}_len: usize = {len(value) + 1}',
                         f"pub fn {name}() -> &'static [u8] {{",
                         f'  return Slice.view<u8>(locale_string_pool(), {offset}, {len(value) + 1})', '}', '']
            return
        self.out.append(f'pub const {name}_len: usize = {len(value)}')
        if ctype == 'uint8_t':
            self.bytes_fn(name, bytes(value))
            self.out += [f'pub fn {name}_at(index: usize) -> u8 {{', f'  return {name}()[index]', '}', '']
        elif ctype == 'char *':
            self.bytes_fn(f'{name}_records', b''.join(self.string(v) for v in value))
            self.out += [f"pub fn {name}(index: usize) -> &'static [u8] {{",
                         f'  if index >= {name}_len {{ return Intrinsic.trap("Invalid locale data index") }}',
                         f'  return readString({name}_records(), index * 8)', '}', '',
                         f"pub fn {name}_raw(index: usize) -> &'static [u8] {{",
                         f'  if index >= {name}_len {{ return Intrinsic.trap("Invalid locale data index") }}',
                         f'  return readStringRaw({name}_records(), index * 8)', '}', '']
        elif ctype in self.contracts:
            width = sum(f[2] for f in self.contracts[ctype])
            if ctype == 'CompactDecimalPattern' and name != 'compact_pattern':
                offset = self.compact_offsets[name]
                self.out += [f'pub fn {name}(index: usize) -> CompactDecimalPattern {{',
                             f'  if index >= {name}_len {{ return Intrinsic.trap("Invalid locale data index") }}',
                             f'  return compact_pattern({offset} + index)', '}', '']
                return
            self.bytes_fn(f'{name}_records', b''.join(self.record(ctype, v) for v in value))
            self.out += [f'pub const {name}_record_size: usize = {width}',
                         f'pub fn {name}(index: usize) -> {ctype} {{',
                         f'  if index >= {name}_len {{ return Intrinsic.trap("Invalid locale data index") }}',
                         f'  return decode{ctype}({name}_records(), index * {width})', '}', '']
            first_field, first_kind, _, _ = self.contracts[ctype][0]
            if first_kind == 'string':
                self.out += [f"pub fn {name}_{first_field}(index: usize) -> &'static [u8] {{",
                             f'  if index >= {name}_len {{ return Intrinsic.trap("Invalid locale data index") }}',
                             f'  return readString({name}_records(), index * {width})', '}', '']
        else:
            raise ValueError(f'Unhandled C table type: {ctype}')

    def helpers(self):
        for width in (1, 2, 4):
            terms = [f'u8.toUsize(data[at + {i}])' + (f' * {256 ** i}' if i else '') for i in range(width)]
            self.out += [f'fn read{width * 8}(data: &[u8], at: usize) -> usize {{',
                         '  return ' + ' + '.join(terms), '}', '']
        self.out += '''fn readSigned32(data: &[u8], at: usize) -> i32 {
  let value = read32(data, at)
  if value >= 2147483648 { return -1 - usize.toI32(4294967295 - value) }
  return usize.toI32(value)
}
fn readString(data: &[u8], at: usize) -> &'static [u8] {
  return Slice.view<u8>(locale_string_pool(), read32(data, at), read32(data, at + 4))
}
fn readStringRaw(data: &[u8], at: usize) -> &'static [u8] {
  return Slice.view<u8>(locale_string_pool(), read32(data, at), read32(data, at + 4) + 1)
}
fn readOptionalString(data: &[u8], at: usize) -> Option<&'static [u8]> {
  if read32(data, at) == 4294967295 { return Option<&'static [u8]>.none() }
  return Option<&'static [u8]>.some(readString(data, at))
}

// As in C, negative n selects the first entry. The result excludes its NUL.
// The final entry may end at the slice boundary (the implicit C terminator).
pub fn strpool_get<'a>(pool: &'a [u8], n: i32) -> &'a [u8] {
  let mut at: usize = 0
  let mut remaining = n
  while remaining > 0 {
    while at < pool.length && pool[at] != 0 { at = at + 1 }
    if at >= pool.length { return Intrinsic.trap("Invalid locale string pool index") }
    at = at + 1
    remaining = remaining - 1
  }
  let start = at
  while at < pool.length && pool[at] != 0 { at = at + 1 }
  return Slice.view<u8>(pool, start, at - start)
}
'''.splitlines()
        symbols = {'DECIMAL': 'decimal', 'GROUP': 'group', 'PLUS': 'plusSign', 'MINUS': 'minusSign',
                   'PERCENT': 'percentSign', 'INFINITY': 'infinity', 'NAN': 'nan'}
        for macro, field in symbols.items():
            self.out += [f"pub fn NS_{macro}(ns: &NumberSymbols) -> &'static [u8] {{",
                         f'  return {field}_tab(ns.{field}_idx)', '}', '']
        for field, _, _, _ in self.contracts['NumberPatterns']:
            self.out += [f"pub fn NP_{field.upper()}(np: &NumberPatterns) -> &'static [u8] {{",
                         f'  return pattern_tab(np.{field})', '}', '']
        for field in ('month_long', 'month_short', 'month_narrow', 'weekday_long', 'weekday_short',
                      'weekday_narrow', 'ampm', 'dayperiod', 'dayperiod_narrow'):
            self.out += [f"pub fn LD_{field.upper()}(ld: &LocaleData, i: i32) -> &'static [u8] {{",
                         f'  return strpool_get({field}_tab(ld.{field}_idx), i)', '}', '']
        self.out += ["pub fn LD_ERA(ld: &LocaleData, style: i32, era: i32) -> &'static [u8] {",
                     '  return strpool_get(era_tab(ld.era_idx), style * 2 + era)', '}', '']


def generate(source, header):
    for data, expected, name in ((source, SOURCE_SHA256, 'locale-data.c'), (header, HEADER_SHA256, 'intl_private.h')):
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'{name} does not match pinned QuickJS revision')
    declarations, counts, defines = parse_source(source)
    generator = Generator(parse_contracts(header), declarations)
    generator.contracts_out()
    generator.helpers()
    generator.table('CompactDecimalPattern', 'compact_pattern', generator.compact)
    for ctype, name, value in declarations:
        generator.table(ctype, name, value)
    for name, table in counts:
        generator.out.append(f'pub const {name}: usize = {len(generator.values[table])}')
    for name, value in defines:
        generator.out.append(f'pub const {name}: usize = {value}')
    generator.out += ['', f'pub const locale_string_pool_len: usize = {len(generator.pool)}']
    generator.bytes_fn('locale_string_pool', generator.pool)
    return '\n'.join(generator.out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--header', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'src/intl_locale_data.silk')
    args = parser.parse_args()
    header = args.header or args.source.with_name('intl_private.h')
    result = generate(args.source.read_bytes(), header.read_bytes())
    args.output.write_text(result)
    print(f'Generated {args.output} from QuickJS {REVISION}')


if __name__ == '__main__':
    main()
