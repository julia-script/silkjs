#!/usr/bin/env python3
"""Exercise signed SEA source/cache launch after removing every input asset.
Run on macOS arm64: python3 tests/sea-smoke.py /absolute/path/to/silkjsruntime
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MAIN = r'''
'use strict';
const assert = require('node:assert/strict');
const sea = require('node:sea');
assert.equal(sea.isSea(), true);
assert.equal(__filename, process.execPath);
assert.equal(module.filename, process.execPath);
assert.equal(require.main, module);
assert.equal(process.mainModule, module);
assert.equal(__dirname, require('node:path').dirname(process.execPath));
assert.deepEqual(process.argv.slice(2), ['argument with spaces', '--application-flag']);
assert.equal(process.argv[1], process.execPath);
assert.throws(() => require('./deleted-main.cjs'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
assert.deepEqual(sea.getAssetKeys().sort(), ['__proto__', 'binary', 'empty', 'text']);
const keys = sea.getAssetKeys(); keys.length = 0;
assert.equal(sea.getAssetKeys().length, 4);
assert.equal(sea.getAsset('text', 'utf8'), 'embedded π\n');
assert.equal(sea.getAsset('empty').byteLength, 0);
assert.equal(sea.getRawAsset('empty').byteLength, 0);
assert.equal(sea.getAsset('__proto__', 'utf-8'), 'embedded π\n');
const original = [0, 255, 128, 1, 2, 3, 4, 5];
const raw = sea.getRawAsset('binary'), other = sea.getRawAsset('binary');
assert.notEqual(raw, other);
assert.deepEqual(Array.from(new Uint8Array(raw)), original);
const copy = sea.getAsset('binary');
new Uint8Array(copy).fill(42);
assert.deepEqual(Array.from(new Uint8Array(raw)), original);
assert.deepEqual(Array.from(new Uint8Array(sea.getAsset('binary'))), original);
// External raw backing may be transferred only by snapshotting the bytes. A
// detached wrapper must not invalidate another wrapper or the native directory.
const transferred = structuredClone(raw, { transfer: [raw] });
assert.equal(raw.byteLength, 0);
assert.deepEqual(Array.from(new Uint8Array(transferred)), original);
assert.deepEqual(Array.from(new Uint8Array(other)), original);
assert.deepEqual(Array.from(new Uint8Array(sea.getRawAsset('binary'))), original);
assert.throws(() => sea.getRawAsset('missing'), { code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' });
assert.throws(() => sea.getAssetAsBlob('missing'), { code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' });
assert.throws(() => sea.getAsset('text', 'not-an-encoding'), { code: 'ERR_ENCODING_NOT_SUPPORTED' });
assert.throws(() => sea.getAsset('missing', 1), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => sea.getRawAsset(null), { code: 'ERR_INVALID_ARG_TYPE' });
(async () => {
  const blob = sea.getAssetAsBlob('binary', { type: 'APPLICATION/OCTET-STREAM' });
  assert.equal(blob.type, 'application/octet-stream');
  assert.equal(blob.size, original.length);
  const first = await blob.arrayBuffer();
  new Uint8Array(first).fill(9);
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), original);
  assert.equal(await sea.getAssetAsBlob('text').text(), 'embedded π\n');
  console.log('SEA ownership and standalone execution passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
'''


def run(command, cwd):
    result = subprocess.run([str(arg) for arg in command], cwd=cwd,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        result.check_returncode()
    return result


def main():
    runtime = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='silk-sea-') as directory:
        cwd = Path(directory)
        run([runtime, '-e', "const s=require('node:sea'),a=require('node:assert/strict');a.equal(s.isSea(),false);for(const f of [()=>s.getRawAsset('x'),()=>s.getAsset('x'),()=>s.getAssetAsBlob('x'),()=>s.getAssetKeys()])a.throws(f,{code:'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION'});"], cwd)
        for cache in (False, True):
            (cwd / 'main.cjs').write_text(MAIN)
            (cwd / 'text.txt').write_text('embedded π\n')
            (cwd / 'binary.bin').write_bytes(bytes([0, 255, 128, 1, 2, 3, 4, 5]))
            (cwd / 'empty.bin').write_bytes(b'')
            config = {'main': 'main.cjs', 'output': 'app.blob', 'useCodeCache': cache,
                      'disableExperimentalSEAWarning': True, 'execArgvExtension': 'none',
                      'assets': {'text': 'text.txt', 'binary': 'binary.bin',
                                 'empty': 'empty.bin', '__proto__': 'text.txt'}}
            (cwd / 'config.json').write_text(json.dumps(config))
            run([runtime, '--experimental-sea-config', 'config.json'], cwd)
            run([sys.executable, ROOT / 'tools/sea.py', '--runtime', runtime,
                 '--blob', cwd / 'app.blob', '--output', cwd / 'standalone'], cwd)
            for name in ('main.cjs', 'text.txt', 'binary.bin', 'empty.bin', 'config.json', 'app.blob'):
                (cwd / name).unlink()
            result = run([cwd / 'standalone', 'argument with spaces', '--application-flag'], cwd)
            assert result.stdout.strip() == 'SEA ownership and standalone execution passed', result
        # Snapshot requests must fail without evaluating source or writing a blob.
        (cwd / 'main.cjs').write_text("require('node:fs').writeFileSync('ran-main', 'bad')")
        (cwd / 'snapshot.json').write_text(json.dumps({'main': 'main.cjs', 'output': 'snapshot.blob', 'useSnapshot': True}))
        rejected = subprocess.run([str(runtime), '--experimental-sea-config', 'snapshot.json'], cwd=cwd,
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert rejected.returncode != 0 and 'runtime-image serialization' in rejected.stderr, rejected
        assert not (cwd / 'ran-main').exists() and not (cwd / 'snapshot.blob').exists()
    print('SEA source, code cache, assets, ownership, and snapshot rejection passed')


if __name__ == '__main__':
    main()
