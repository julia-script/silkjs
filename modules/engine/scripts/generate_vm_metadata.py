#!/usr/bin/env python3
"""Generate native Silk atoms and opcode metadata from the pinned QuickJS headers.

Usage: python3 scripts/generate_vm_metadata.py /path/to/quickjs
Short opcodes and parser-only temporary opcodes intentionally share numbers.
"""
import argparse
import ast
import hashlib
from pathlib import Path
import re
import struct
import tomllib

ROOT = Path(__file__).resolve().parents[1]

# silkjs's own final opcodes, numbered after QuickJS's: (name, size, pops, pushes, format).
EXTENSIONS = [
    ('get_loc_field8', 6, 0, 1, 'atom_u8'),  # get_loc8 index, then get_field atom
    ('get_arg_field8', 6, 0, 1, 'atom_u8'),  # get_arg index, then get_field atom
    ('get_loc_length8', 2, 0, 1, 'loc8'),  # get_loc8 index, then get_length
    ('get_arg_length8', 2, 0, 1, 'loc8'),  # get_arg index, then get_length
    ('get_loc_el8', 3, 0, 1, 'u16'),  # get_loc8 array, get_loc8 index, then get_array_el
    ('get_arg_el8', 3, 0, 1, 'u16'),  # get_arg array, get_loc8 index, then get_array_el
]

# Final get_field, get_loc_field8, get_arg_field8, put_field, put_loc_field_loc8 and
# put_loc_field_arg8 keep an inline field-cache key after their atom
# (js_vm_property_ops.fieldKeyAt).
FIELD_KEY_BYTES = 8
FIELD_KEYED = ['get_field', 'get_loc_field8', 'get_arg_field8', 'put_field', 'put_loc_field_loc8', 'put_loc_field_arg8']

# Upstream final opcodes whose numbers silkjs reuses: name -> (name, size, pops, pushes, format).
# set_arg0-3 are emitted as set_arg; the fused branches keep the test's byte
# (is_undefined_or_null or is_null), a padding byte (the old if_*8 opcode), then
# the if_*8 displacement.
REPLACEMENTS = {
    'set_arg0': ('if_nullish8', 3, 1, 0, 'u16'),  # is_undefined_or_null, then if_true8
    'set_arg1': ('if_not_nullish8', 3, 1, 0, 'u16'),  # is_undefined_or_null, then if_false8
    'set_arg2': ('if_null8', 3, 1, 0, 'u16'),  # is_null, then if_true8
    'set_arg3': ('if_not_null8', 3, 1, 0, 'u16'),  # is_null, then if_false8
    # The short var_ref forms are never emitted (get/put/set_var_ref take a u16
    # index); their first six numbers hold the depth-0 scope opcodes, each with
    # a u16 slot of the running frame's scope.
    'get_var_ref0': ('get_scope0', 3, 0, 1, 'u16'),
    'get_var_ref1': ('put_scope0', 3, 1, 0, 'u16'),
    'get_var_ref2': ('set_scope0', 3, 1, 1, 'u16'),
    'get_var_ref3': ('get_scope0_check', 3, 0, 1, 'u16'),
    'put_var_ref0': ('put_scope0_check', 3, 1, 0, 'u16'),
    'put_var_ref1': ('put_scope0_check_init', 3, 1, 0, 'u16'),
    # `local.f = v;` with v a local or an argument: put_field into the local's
    # object, the atom, the object's local, then the value's local or
    # argument, both read in place.
    # Four hold a binary operator with an Int right operand: push_i16 (or a
    # shorter push) of the immediate, then the operator.
    'put_var_ref2': ('add_imm', 3, 1, 1, 'i16'),
    'put_var_ref3': ('sar_imm', 3, 1, 1, 'i16'),
    'set_var_ref0': ('and_imm', 3, 1, 1, 'i16'),
    'set_var_ref1': ('or_imm', 3, 1, 1, 'i16'),
    # push_minus1 is emitted as push_i8; its number holds the fusion prefix. A
    # prefix pushes and pops nothing: the instructions it covers follow it
    # unchanged, and it either answers all of them at once and skips them or
    # does nothing and lets them run. Its four operand bytes depend on what it
    # covers, which the first covered opcode tells:
    # - a local read, add_imm, sar_imm or not, get_array_el
    #   (`heap[(x + k) >> s]`): the shift count, the add_imm constant and the
    #   covered byte count;
    # - dup, push_atom_value, strict_eq and a forward if_true8 or if_false8 (a
    #   `switch` case on a string): the atom (the covered push_atom_value owns
    #   the reference).
    'push_minus1': ('fuse_prefix', 5, 0, 0, 'u32'),
    'set_var_ref2': ('put_loc_field_loc8', 7, 0, 0, 'atom_u16'),
    'set_var_ref3': ('put_loc_field_arg8', 7, 0, 0, 'atom_u16'),
    # push_2 to push_7 are emitted as push_i8; their numbers hold add, sub and
    # mul with local operands read in place: both operands (get_loc8 a,
    # get_loc8 b, then the operator), or the right one alone (get_loc8 b, then
    # the operator on the top value).
    'push_2': ('add_loc_loc8', 3, 0, 1, 'u16'),
    'push_3': ('sub_loc_loc8', 3, 0, 1, 'u16'),
    'push_4': ('mul_loc_loc8', 3, 0, 1, 'u16'),
    'push_5': ('add_top_loc8', 2, 1, 1, 'loc8'),
    'push_6': ('sub_top_loc8', 2, 1, 1, 'loc8'),
    'push_7': ('mul_top_loc8', 2, 1, 1, 'loc8'),
    # set_loc0-3 are emitted as set_loc8 and put_arg0-3 as put_arg. Their
    # numbers hold: `x++`, `++x`, `x--` and `--x` with the value used, on a
    # local or an argument (the slot, then a mode byte: 1 pushes the new value,
    # 2 steps down); shl with an Int right operand; a[i] with a a local or an
    # argument and i an argument, both read in place; add, sub and mul with
    # the right operand an argument read in place.
    'set_loc0': ('step_loc8', 3, 0, 1, 'u16'),
    'set_loc1': ('step_arg8', 3, 0, 1, 'u16'),
    'set_loc2': ('shl_imm', 3, 1, 1, 'i16'),
    'set_loc3': ('get_loc_el_arg8', 3, 0, 1, 'u16'),
    'put_arg0': ('add_top_arg8', 2, 1, 1, 'u8'),
    'put_arg1': ('sub_top_arg8', 2, 1, 1, 'u8'),
    'put_arg2': ('mul_top_arg8', 2, 1, 1, 'u8'),
    'put_arg3': ('get_arg_el_arg8', 3, 0, 1, 'u16'),
    # for await keeps its loop's throw handler (AsyncIteratorClose, which awaits
    # return()): the iterator marker is that catch offset; 0 for yield*, which has none.
    'for_await_of_start': ('for_await_of_start', 5, 1, 3, 'label'),
}

# Final-only opcodes over upstream numbers the final code never holds: the
# opcode the parser view keeps there (rare: never run by the HTTP workloads or
# Octane) is written behind OP_extended in final code, and the number holds a
# fusion. number -> (name, size, pops, pushes, format), and the opcode moved out.
FINAL_ONLY = {
    # The prefix of the moved opcodes: extended, then the opcode's own number.
    20: (('extended', 2, 0, 0, 'u8'), 'dup3'),
    # `x || y`, `x && y`, `x ?? y`: dup, the short branch, drop, rewritten in
    # place (js_compiler_label_support.fuseKeepBranches): the old bytes stay as
    # padding and the displacement keeps its place. Taken, the value stays;
    # not taken, it is dropped (pops 1, pushes 0 is the fallthrough's effect;
    # the taken edge keeps the value).
    26: (('if_true_keep8', 4, 1, 0, 'u16'), 'perm5'),  # dup, if_true8 d, drop
    28: (('if_false_keep8', 4, 1, 0, 'u16'), 'swap2'),  # dup, if_false8 d, drop
    31: (('if_not_nullish_keep8', 5, 1, 0, 'u32'), 'rot4l'),  # dup, if_not_nullish8 pad d, drop
    # obj[k] with k a scope variable (`this[kState]`): get_scope0(_check) k, get_array_el.
    32: (('get_scope0_el', 3, 1, 1, 'u16'), 'rot5l'),
    # typeof x === 'string' and friends: the type's index in TYPEOF_NAMES.
    45: (('typeof_is', 2, 1, 1, 'u8'), 'check_brand'),
    # x === k and x !== k for an Int k in -128..127.
    71: (('strict_eq_imm8', 2, 1, 1, 'i8'), 'get_super_value'),
    72: (('strict_neq_imm8', 2, 1, 1, 'i8'), 'put_super_value'),
}
# Moved out without a fusion in their number (yet): free final numbers.
EXTENDED_ONLY = ['using_dispose_init', 'using_dispose_merge', 'using_dispose_end']


def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def prelude(revision, imports):
    return [
        '// Generated by scripts/generate_vm_metadata.py; do not edit.',
        f'// QuickJS {revision}; see LICENSE.quickjs.',
        'import silk.collections.slice { Slice }', *imports, '',
    ]


def emit_names(lines, names, function, argument, index_expression):
    offsets = [0]
    data = bytearray()
    for name in names:
        data.extend(name)
        offsets.append(len(data))
    if offsets[-1] > 65535:
        raise SystemExit('Name data exceeds the pinned 16-bit offset representation')
    packed = b''.join(struct.pack('<H', offset) for offset in offsets)
    lines += [f'pub fn {function}({argument}) -> &\'static [u8] {{',
              f'  let index = {index_expression}',
              f'  let offsets = {literal(packed)}',
              f'  let data = {literal(data)}',
              '  let start = u8.toUsize(offsets[index * 2]) + u8.toUsize(offsets[index * 2 + 1]) * 256',
              '  let end = u8.toUsize(offsets[index * 2 + 2]) + u8.toUsize(offsets[index * 2 + 3]) * 256',
              '  return Slice.view<u8>(data, start, end - start)', '}', '']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    args = parser.parse_args()
    pin = tomllib.loads((ROOT / 'upstream.toml').read_text())
    sources = {}
    for filename in ['quickjs-atom.h', 'quickjs-opcode.h']:
        raw = (args.upstream / filename).read_bytes()
        if hashlib.sha256(raw).hexdigest() != pin['source-sha256'][filename]:
            raise SystemExit(f'Wrong upstream source: {filename}')
        sources[filename] = raw.decode()

    atoms = re.findall(r'^DEF\(\s*(\w+),\s*("(?:[^"\\]|\\.)*")\)', sources['quickjs-atom.h'], re.M)
    if not atoms:
        raise SystemExit('No permanent atoms')
    names = [ast.literal_eval(text).encode('utf-8') for name, text in atoms]
    lines = prelude(pin['revision'], ['import silk.num.u8', 'import silk.num.u32'])
    lines += ['pub const JS_ATOM_NULL: u32 = 0']
    lines += [f'pub const JS_ATOM_{name}: u32 = {index}' for index, (name, _) in enumerate(atoms, 1)]
    lines += [f'pub const JS_ATOM_END: u32 = {len(atoms) + 1}',
              'pub const JS_ATOM_LAST_KEYWORD: u32 = JS_ATOM_super',
              'pub const JS_ATOM_LAST_STRICT_KEYWORD: u32 = JS_ATOM_yield', '',
              '// Preconditions: JS_ATOM_NULL < atom < JS_ATOM_END. Bytes exclude NUL.']
    emit_names(lines, names, 'atomName', 'atom: u32', 'u32.toUsize(atom - 1)')
    (ROOT / 'src/js_atom_data.silk').write_text('\n'.join(lines))

    source = sources['quickjs-opcode.h']
    formats = re.findall(r'^FMT\((\w+)\)', source, re.M)
    entries = re.findall(r'^(DEF|def)\(\s*(\w+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\w+)\)', source, re.M)
    entries = [('DEF', *map(str, REPLACEMENTS[entry[1]][:4]), REPLACEMENTS[entry[1]][4])
               if entry[0] == 'DEF' and entry[1] in REPLACEMENTS else entry for entry in entries]
    entries += [('DEF', name, str(size), str(pops), str(pushes), fmt) for name, size, pops, pushes, fmt in EXTENSIONS]
    regular = [entry for entry in entries if entry[0] == 'DEF']
    temporary = [entry for entry in entries if entry[0] == 'def']
    regular_ids = {entry[1]: index for index, entry in enumerate(regular)}
    temporary_start = regular_ids['nop'] + 1
    temporary_end = temporary_start + len(temporary)
    if not formats or len(regular) > 256 or temporary_end > 256:
        raise SystemExit('Invalid opcode metadata')
    if [entry[1] for entry in entries[temporary_start:temporary_end]] != [entry[1] for entry in temporary]:
        raise SystemExit('Temporary opcode block no longer follows nop')
    format_ids = {name: index for index, name in enumerate(formats)}
    lines = prelude(pin['revision'], ['import silk.num.u8'])
    lines += ['import silk.core.ownership { Copy }', '',
              'pub struct OpcodeInfo { pub size: u8, pub pops: u8, pub pushes: u8, pub format: u8 }',
              'impl Copy for OpcodeInfo {}', '']
    lines += [f'pub const OP_FMT_{name}: u8 = {index}' for index, name in enumerate(formats)]
    lines += ['']
    lines += [f'pub const OP_{entry[1]}: u8 = {index}' for index, entry in enumerate(regular)]
    lines += [f'pub const OP_{entry[1]}: u8 = {temporary_start + index}' for index, entry in enumerate(temporary)]
    final_names = {number: entry[0][0] for number, entry in FINAL_ONLY.items()}
    lines += [f'pub const OP_{name}: u8 = {number}' for number, name in sorted(final_names.items())]
    lines += [f'pub const OP_COUNT: usize = {len(regular)}',
              f'pub const OP_TEMP_START: u8 = {temporary_start}',
              f'pub const OP_TEMP_END: u8 = {temporary_end}', '',
              '/// OP_apply magic bit: the operand is the spread iterable itself (`f(...x)`),',
              '/// not the argument array; bit 0 is the construct flag.',
              'pub const APPLY_ITERABLE: u16 = 4', '',
              '// Parser metadata uses temporary opcodes; final bytecode uses short opcodes.',
              'fn metadataIndex(opcode: u8, short: bool) -> usize {',
              '  let mut index = u8.toUsize(opcode)',
              f'  if short && opcode >= OP_TEMP_START {{ index = index + {len(temporary)} }}',
              '  return index', '}', '']
    data = bytes(value for _, _, size, pops, pushes, fmt in entries
                 for value in (int(size), int(pops), int(pushes), format_ids[fmt]))
    keyed = {regular_ids[name] for name in FIELD_KEYED}
    short_data = bytearray()
    for opcode in range(256):
        index = opcode + len(temporary) if opcode >= temporary_start else opcode
        size, pops, pushes, fmt = data[index * 4:index * 4 + 4]
        if opcode in FINAL_ONLY:
            name, size, pops, pushes, fmt_name = FINAL_ONLY[opcode][0]
            fmt = format_ids[fmt_name]
        elif regular_ids.get(entries[opcode][1]) == opcode and entries[opcode][1] in EXTENDED_ONLY:
            size = pops = pushes = fmt = 0
        short_data.extend((size + FIELD_KEY_BYTES if opcode in keyed else size, pops, pushes, fmt))
    lines += ['/// Bytes of the inline field-cache key that final get_field, get_loc_field8,',
              '/// get_arg_field8, put_field, put_loc_field_loc8 and put_loc_field_arg8 carry',
              '/// right after their atom (the parser view has none).',
              f'pub const FIELD_KEY_BYTES: u8 = {FIELD_KEY_BYTES}', '',
              '/// The final opcodes that carry the inline field-cache key.',
              'pub fn fieldKeyed(opcode: u8) -> bool {',
              '  return opcode == OP_get_field || opcode == OP_get_loc_field8 || opcode == OP_get_arg_field8',
              '    || opcode == OP_put_field || opcode == OP_put_loc_field_loc8 || opcode == OP_put_loc_field_arg8',
              '}', '',
              '/// The opcode metadata table: 4 bytes per opcode (size, pops, pushes, format),',
              '/// the parser view for every byte, then the final (short) view of the temporary',
              f'/// opcodes OP_TEMP_START.. at index opcode + {len(temporary)}. opcodeInfo reads the final',
              '/// view from SHORT_OPCODES, which js_opcode_data_tests checks against it.',
              f'const OPCODES: &[u8] = {literal(data)}',
              "/// The final view of every byte, in OPCODES's layout: OPCODES's final entry with",
              '/// the inline field-cache key added to the size of fieldKeyed opcodes.',
              f'const SHORT_OPCODES: &[u8] = {literal(short_data)}', '',
              'pub fn opcodeInfo(opcode: u8, short: bool) -> OpcodeInfo {',
              '  let index = u8.toUsize(opcode) * 4',
              '  let table = if short { SHORT_OPCODES } else { OPCODES }',
              '  return OpcodeInfo { size: table[index], pops: table[index + 1], pushes: table[index + 2], format: table[index + 3] }',
              '}',
              '/// opcodeInfo as metadataIndex and fieldKeyed define it, from OPCODES alone.',
              'pub fn referenceOpcodeInfo(opcode: u8, short: bool) -> OpcodeInfo {',
              '  if short && (finalOnly(opcode) || freedByExtended(opcode)) { return opcodeInfo(opcode, true) }',
              '  let index = metadataIndex(opcode, short) * 4',
              '  let mut size = OPCODES[index]',
              '  if short && fieldKeyed(opcode) { size = size + FIELD_KEY_BYTES }',
              '  return OpcodeInfo { size: size, pops: OPCODES[index + 1], pushes: OPCODES[index + 2], format: OPCODES[index + 3] }',
              '}', '']

    moved = sorted(regular_ids[entry[1]] for entry in FINAL_ONLY.values()) 
    moved = sorted(set(moved + [regular_ids[name] for name in EXTENDED_ONLY]))
    finals = sorted(FINAL_ONLY)
    freed = sorted(regular_ids[name] for name in EXTENDED_ONLY)
    def member(fn, doc, numbers):
        return [doc, f'pub fn {fn}(opcode: u8) -> bool {{',
                '  return ' + ' || '.join(f'opcode == {n}' for n in numbers), '}', '']
    lines += member('movedToExtended', '/// Parser-view opcodes final code writes as OP_extended, then the opcode.', moved)
    lines += member('finalOnly', '/// Final numbers that hold a silkjs fusion, not the parser view\'s opcode.', finals)
    lines += member('freedByExtended', '/// Final numbers no final code holds (their opcode moved behind OP_extended).', freed)
    emit_names(lines, [entry[1].encode() for entry in entries], 'parserOpcodeName', 'opcode: u8, short: bool', 'metadataIndex(opcode, short)')
    lines += ['pub fn opcodeName(opcode: u8, short: bool) -> &\'static [u8] {']
    for number in finals:
        lines += [f'  if short && opcode == {number} {{ return b"{FINAL_ONLY[number][0][0]}" }}']
    lines += ['  return parserOpcodeName(opcode, short)', '}', '']
    (ROOT / 'src/js_opcode_data.silk').write_text('\n'.join(lines))
    print(f'Generated {len(atoms)} atoms, {len(regular)} VM opcodes, {len(temporary)} temporary opcodes, {len(formats)} formats')


if __name__ == '__main__':
    main()
