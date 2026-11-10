#!/usr/bin/env python3
"""Inject a Silk-prepared SEA blob into a thin Darwin arm64 runtime and sign it.

Usage: python3 tools/sea.py --runtime build/silkjsruntime --blob app.blob --output app
Preparation runs in Silk: silkjsruntime --experimental-sea-config sea-config.json.
This is not Node/postject's V8 blob format. No JS engine runs in this injector.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile

MAGIC = b'SILKSEA1'
OWNER = b'SILKJS_SEA'.ljust(16, b'\0')
LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D
LC_NOTE = 0x31


def align(value, boundary):
    return (value + boundary - 1) // boundary * boundary


def macho(data):
    if len(data) < 32:
        raise ValueError('Truncated Mach-O executable')
    magic, cpu, subtype, kind, count, command_bytes, flags, reserved = struct.unpack_from('<8I', data)
    if magic != 0xFEEDFACF or cpu != 0x0100000C or kind != 2:
        raise ValueError('SEA injection supports only thin little-endian Darwin arm64 Mach-O executables')
    end = 32 + command_bytes
    if end > len(data):
        raise ValueError('Truncated Mach-O load commands')
    commands = []
    cursor = 32
    first_section = len(data)
    linkedit = None
    for _ in range(count):
        if cursor + 8 > end:
            raise ValueError('Invalid Mach-O command count')
        command, size = struct.unpack_from('<II', data, cursor)
        if size < 8 or size % 8 or cursor + size > end:
            raise ValueError('Invalid Mach-O load command extent')
        commands.append((command, cursor, size))
        if command == LC_NOTE and size >= 40 and data[cursor + 8:cursor + 24] == OWNER:
            raise ValueError('Runtime already contains a Silk SEA payload')
        if command == LC_SEGMENT_64:
            if size < 72:
                raise ValueError('Truncated Mach-O segment')
            name = data[cursor + 8:cursor + 24].rstrip(b'\0')
            vmaddr, vmsize, fileoff, filesize = struct.unpack_from('<4Q', data, cursor + 24)
            sections = struct.unpack_from('<I', data, cursor + 64)[0]
            if 72 + sections * 80 > size:
                raise ValueError('Truncated Mach-O section table')
            if name == b'__LINKEDIT':
                if linkedit is not None:
                    raise ValueError('Duplicate __LINKEDIT segment')
                linkedit = (cursor, vmaddr, vmsize, fileoff, filesize)
            for index in range(sections):
                section = cursor + 72 + index * 80
                offset = struct.unpack_from('<I', data, section + 48)[0]
                section_size = struct.unpack_from('<Q', data, section + 40)[0]
                section_type = struct.unpack_from('<I', data, section + 64)[0] & 0xFF
                if offset and section_size and section_type not in (1, 0xC, 0x12):
                    first_section = min(first_section, offset)
        cursor += size
    if cursor != end or linkedit is None:
        raise ValueError('Invalid load-command table or missing __LINKEDIT segment')
    return commands, end, first_section, linkedit


def blob_metadata(blob):
    if len(blob) < 16 or blob[:8] != MAGIC or blob[12:16] != bytes(4):
        raise ValueError('Not a Silk SEA v1 preparation blob')
    length = struct.unpack_from('<I', blob, 8)[0]
    if length > len(blob) - 16:
        raise ValueError('Truncated SEA manifest')
    metadata = json.loads(blob[16:16 + length])
    if metadata.get('version') != 1 or metadata.get('format') != 'commonjs':
        raise ValueError('Unsupported SEA payload version or main format')
    base = align(16 + length, 8)
    entries = [metadata.get('source')]
    if metadata.get('cache') is not None:
        entries.append(metadata['cache'])
    assets = metadata.get('assets')
    if not isinstance(assets, list):
        raise ValueError('Invalid SEA asset directory')
    keys = set()
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get('key'), str) or asset['key'] in keys:
            raise ValueError('Invalid or duplicate SEA asset key')
        keys.add(asset['key'])
        entries.append(asset)
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('Invalid SEA payload entry')
        offset, size = entry.get('offset'), entry.get('length')
        if type(offset) is not int or type(size) is not int or offset < 0 or size < 0 or offset % 8 or base + offset + size > len(blob):
            raise ValueError('Invalid SEA payload extent')
    return metadata


def inject(runtime, blob_path, output, identity):
    if platform.system() != 'Darwin':
        raise ValueError('Injection and signing require macOS; Linux/Windows executable injection is not supported')
    if runtime.resolve() == output.resolve():
        raise ValueError('Output must not replace the input runtime')
    original = runtime.read_bytes()
    original_commands, _, _, _ = macho(original)
    blob = blob_path.read_bytes()
    metadata = blob_metadata(blob)
    if metadata.get('runtimeHash') != hashlib.sha256(original).hexdigest():
        raise ValueError('Blob was prepared by a different runtime binary; regenerate it with this exact --runtime')
    codesign = shutil.which('codesign')
    if not codesign:
        raise ValueError('macOS codesign is required; unsigned arm64 output is not supported')
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + output.name + '-', dir=output.parent)
    os.close(fd)
    temporary = Path(temporary)
    try:
        shutil.copy2(runtime, temporary)
        if any(command == LC_CODE_SIGNATURE for command, _, _ in original_commands):
            subprocess.run([codesign, '--remove-signature', str(temporary)], check=True)
        data = bytearray(temporary.read_bytes())
        commands, end, first_section, linkedit = macho(data)
        if any(command == LC_CODE_SIGNATURE for command, _, _ in commands):
            raise ValueError('codesign did not remove the old code signature')
        if end + 40 > first_section or any(data[end:end + 40]):
            raise ValueError('Insufficient Mach-O header padding; relink runtime with -Wl,-headerpad,0x1000')
        segment, vmaddr, vmsize, fileoff, filesize = linkedit
        if fileoff + filesize != len(data):
            raise ValueError('__LINKEDIT must end at EOF after removing the signature')
        offset = align(len(data), 8)
        data.extend(bytes(offset - len(data)))
        data.extend(blob)
        struct.pack_into('<II16sQQ', data, end, LC_NOTE, 40, OWNER, offset, len(blob))
        struct.pack_into('<II', data, 16, len(commands) + 1, end - 32 + 40)
        new_size = len(data) - fileoff
        struct.pack_into('<Q', data, segment + 48, new_size)
        struct.pack_into('<Q', data, segment + 32, max(vmsize, align(new_size, 16384)))
        temporary.write_bytes(data)
        temporary.chmod(runtime.stat().st_mode | 0o111)
        # The new LC_NOTE and its data are inside the signed image. Signing runs
        # after injection: blindly appending after an existing signature is invalid.
        subprocess.run([codesign, '--force', '--sign', identity, '--timestamp=none',
                        '--identifier', output.name, str(temporary)], check=True)
        subprocess.run([codesign, '--verify', '--strict', str(temporary)], check=True)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--blob', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sign', default='-', help='codesign identity (default: ad-hoc)')
    args = parser.parse_args()
    try:
        inject(args.runtime, args.blob, args.output, args.sign)
    except (ValueError, OSError, subprocess.CalledProcessError) as failure:
        parser.exit(1, f'SEA injection failed: {failure}\n')
    print(args.output)


if __name__ == '__main__':
    main()
