#!/usr/bin/env python3
"""Real permission consumers. Usage: python3 tests/permission-matrix.py RUNTIME.

The same consumer matrix runs against Silk and the Node 24 oracle. No runtime
fallback or source assertions; documented permission-model limitations are
tested as compatibility behavior rather than silently strengthened.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

runtime = str(pathlib.Path(sys.argv[1]).resolve())

with tempfile.TemporaryDirectory(prefix='silk-permission-') as directory:
    # Permissions compare lexical absolute paths; getcwd resolves parent-directory
    # symlinks (notably macOS /var). Keep ordinary relative-path cases physical,
    # then exercise alias-vs-physical permission identity explicitly below.
    root = pathlib.Path(directory).resolve()
    allowed = root / 'allowed'
    denied = root / 'denied'
    allowed.mkdir()
    denied.mkdir()
    (allowed / 'input').write_text('allowed')
    (denied / 'secret').write_text('secret')
    (allowed / 'escape').symlink_to(denied, target_is_directory=True)
    (allowed / 'dangling').symlink_to(denied / 'created')
    (root / 'alias').symlink_to(allowed, target_is_directory=True)
    common = """
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.env.PERMISSION_ROOT;
const allowed = path.join(root, 'allowed'), denied = path.join(root, 'denied');
function rejects(fn, permission) {
  assert.throws(fn, error => error.code === 'ERR_ACCESS_DENIED' && error.permission === permission);
}
"""
    import os
    environment = dict(os.environ, PERMISSION_ROOT=str(root))
    environment.pop('NODE_OPTIONS', None)
    cases = []

    def case(name, flags, source, entry=None, exit_ok=True, stderr_contains=None, exit_code=None):
        command = [runtime, *flags]
        if entry is None:
            command += ['-e', common + '\n' + source]
        else:
            command += [str(entry)]
        result = subprocess.run(command, env=environment, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30, cwd=root)
        if ((result.returncode == 0) != exit_ok
                or (exit_code is not None and result.returncode != exit_code)
                or (stderr_contains is not None and stderr_contains not in result.stderr)):
            raise AssertionError(f'{name}: exit={result.returncode}\n{result.stdout}\n{result.stderr}')
        cases.append(name)

    grant_read = '--allow-fs-read=' + str(allowed)
    grant_write = '--allow-fs-write=' + str(allowed)
    case('disabled', [], "assert.equal(process.permission, undefined)")
    case('negation', ['--permission', '--no-permission'], "assert.equal(process.permission, undefined)")
    case('unsupported-experimental-permission', ['--experimental-permission'], '',
         exit_ok=False, exit_code=9, stderr_contains='bad option: --experimental-permission')
    case('path-aliases-and-scopes', ['--permission', grant_read], """
assert.equal(process.permission.has('fs.read', allowed + '/input'), true);
assert.equal(process.permission.has('fs.read', Buffer.from(allowed + '/input')), true);
assert.equal(process.permission.has('fs.read'), false);
for (const scope of ['net', 'child', 'worker', 'addon', 'wasi', 'inspector', 'unknown'])
  assert.equal(process.permission.has(scope), false, scope);
rejects(() => fs.readFileSync(denied + '/secret'), 'FileSystemRead');
rejects(() => fs.readFileSync(Buffer.from(denied + '/secret')), 'FileSystemRead');
rejects(() => fs.readFileSync(pathToFileURL(denied + '/secret')), 'FileSystemRead');
assert.equal(fs.readFileSync(allowed + '/input', 'utf8'), 'allowed');
""")
    case('read-write-flags', ['--permission', grant_read], """
rejects(() => fs.openSync(allowed + '/input', 'r+'), 'FileSystemWrite');
rejects(() => fs.openSync(allowed + '/new', fs.constants.O_RDONLY | fs.constants.O_CREAT), 'FileSystemWrite');
rejects(() => fs.writeFileSync(allowed + '/new', 'data'), 'FileSystemWrite');
rejects(() => fs.renameSync(allowed + '/input', denied + '/moved'), 'FileSystemWrite');
""")
    case('actual-writes-copy-and-normalization', ['--permission', grant_read, grant_write], """
fs.writeFileSync(allowed + '/output', 'written');
assert.equal(fs.readFileSync('./allowed/../allowed/output', 'utf8'), 'written');
assert.equal(fs.readFileSync(allowed + '/../allowed/output', 'utf8'), 'written');
fs.copyFileSync(allowed + '/input', allowed + '/copy');
assert.equal(fs.readFileSync(allowed + '/copy', 'utf8'), 'allowed');
rejects(() => fs.copyFileSync(allowed + '/input', denied + '/copy'), 'FileSystemWrite');
rejects(() => fs.copyFileSync(denied + '/secret', allowed + '/copy'), 'FileSystemRead');
rejects(() => fs.renameSync(allowed + '/copy', denied + '/copy'), 'FileSystemWrite');
rejects(() => fs.mkdirSync(denied + '/new'), 'FileSystemWrite');
const fd = fs.openSync(allowed + '/output', 'r+');
try { rejects(() => fs.fsyncSync(fd), ''); }
finally { fs.closeSync(fd); }
""")
    case('cwd-symlink-alias-is-not-a-grant', ['--permission', '--allow-fs-read=' + str(root / 'alias')], """
const alias = path.join(root, 'alias');
assert.equal(fs.readFileSync(alias + '/input', 'utf8'), 'allowed');
assert.equal(process.permission.has('fs.read', alias + '/input'), true);
assert.equal(process.permission.has('fs.read', allowed + '/input'), false);
process.chdir(alias);
assert.equal(process.cwd(), allowed);
assert.equal(process.permission.has('fs.read', './input'), false);
assert.throws(() => fs.readFileSync('./input'),
  error => error.code === 'ERR_ACCESS_DENIED' && error.permission === 'FileSystemRead' && error.resource === './input');
""")
    case('wildcard-prefix-not-extension-filter', ['--permission', '--allow-fs-read=' + str(allowed) + '/*.js'], """
assert.equal(fs.readFileSync(allowed + '/input', 'utf8'), 'allowed');
assert.equal(process.permission.has('fs.read', denied + '/secret'), false);
""")
    case('async-filesystem', ['--permission', grant_read, grant_write], """
(async () => {
  assert.equal(await fs.promises.readFile(allowed + '/input', 'utf8'), 'allowed');
  await assert.rejects(async () => fs.promises.readFile(denied + '/secret'), { code: 'ERR_ACCESS_DENIED' });
  await fs.promises.writeFile(allowed + '/async', 'async');
  await assert.rejects(async () => fs.promises.copyFile(allowed + '/input', denied + '/copy'), { code: 'ERR_ACCESS_DENIED' });
})().catch(error => { console.error(error); process.exitCode = 1; });
""")
    case('restricted-subsystems', ['--permission'], """
rejects(() => require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']), 'ChildProcess');
rejects(() => new (require('node:worker_threads').Worker)('0', { eval: true }), 'WorkerThreads');
rejects(() => new (require('node:wasi').WASI)({ version: 'preview1' }), 'WASI');
assert.throws(() => process.dlopen({ exports: {} }, '/not-an-addon.node'), { code: 'ERR_DLOPEN_DISABLED' });
rejects(() => process.chdir(denied), 'FileSystemRead');
rejects(() => process.binding('fs'), '');
rejects(() => new (require('node:inspector').Session)().connect(), 'Inspector');
""")
    case('audit-addon-startup-disable', ['--permission-audit'], """
assert.throws(() => process.dlopen({ exports: {} }, '/not-an-addon.node'), { code: 'ERR_DLOPEN_DISABLED' });
""")
    case('audit-real-filesystem-and-child', ['--permission-audit'], """
const reports = [];
const dc = require('node:diagnostics_channel');
dc.subscribe('node:permission-model:fs', value => reports.push(value));
dc.subscribe('node:permission-model:child', value => reports.push(value));
assert.equal(fs.readFileSync(denied + '/secret', 'utf8'), 'secret');
fs.writeFileSync(denied + '/audit', 'audit');
const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write("child")']);
assert.equal(child.status, 0); assert.equal(child.stdout.toString(), 'child');
assert.ok(reports.some(value => value.permission === 'FileSystemRead' && value.resource.endsWith('/secret')));
assert.ok(reports.some(value => value.permission === 'FileSystemWrite' && value.resource.endsWith('/audit')));
assert.ok(reports.some(value => value.permission === 'ChildProcess'));
""")
    case('audit-precedes-enforcement', ['--permission-audit', '--permission'], """
assert.equal(fs.readFileSync(denied + '/secret', 'utf8'), 'secret');
""")
    case('worker-default-inheritance', ['--permission', '--allow-worker', grant_read], """
const { Worker } = require('node:worker_threads');
const script = `const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
let code;
try { fs.readFileSync(workerData.denied); } catch (error) { code = error.code; }
parentPort.postMessage([process.permission.has('fs.read', workerData.allowed), code]);`;
const worker = new Worker(script, { eval: true,
  workerData: { denied: denied + '/secret', allowed: allowed + '/input' } });
worker.once('message', value => assert.deepEqual(value, [true, 'ERR_ACCESS_DENIED']));
worker.once('error', error => { console.error(error); process.exitCode = 1; });
worker.once('exit', code => assert.equal(code, 0));
""")
    case('audit-worker-inheritance', ['--permission-audit', '--allow-worker'], """
const { Worker } = require('node:worker_threads');
const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
let count = 0; require('node:diagnostics_channel').subscribe('node:permission-model:fs', () => count++);
const text = require('node:fs').readFileSync(workerData, 'utf8');
parentPort.postMessage([text, count > 0]);`, { eval: true, workerData: denied + '/secret' });
worker.once('message', value => assert.deepEqual(value, ['secret', true]));
worker.once('error', error => { console.error(error); process.exitCode = 1; });
""")
    case('network-is-unrestricted', ['--permission'], """
assert.equal(process.permission.has('net'), false);
const net = require('node:net');
const server = net.createServer(socket => socket.end('network'));
server.listen(0, '127.0.0.1', () => {
  let data = ''; const client = net.connect(server.address().port, '127.0.0.1');
  client.setEncoding('utf8'); client.on('data', chunk => data += chunk);
  client.on('end', () => { assert.equal(data, 'network'); server.close(); });
  client.on('error', error => { console.error(error); process.exitCode = 1; server.close(); });
});
""")
    entry = root / 'entry.cjs'
    entry.write_text("require('node:assert/strict').equal(process.permission.has('fs.read', __filename), true);")
    case('implicit-entry-grant', ['--permission'], '', entry)
    fork_entry = allowed / 'fork.cjs'
    fork_entry.write_text("process.send({ enabled: !!process.permission, child: process.permission.has('child') });")
    case('fork-option-inheritance', ['--permission', '--allow-child-process', grant_read], """
const child = require('node:child_process').fork(allowed + '/fork.cjs');
child.once('message', value => assert.deepEqual(value, { enabled: true, child: true }));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => assert.equal(code, 0));
""")
    case('worker-explicit-options', ['--permission', '--allow-worker'], """
const { Worker } = require('node:worker_threads');
const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage([process.permission === undefined, require('node:fs').readFileSync(workerData, 'utf8')]);`,
  { eval: true, execArgv: [], workerData: denied + '/secret' });
worker.once('message', value => assert.deepEqual(value, [true, 'secret']));
worker.once('error', error => { console.error(error); process.exitCode = 1; });
worker.once('exit', code => assert.equal(code, 0));
""")
    case('link-target-limitations', ['--permission', grant_read, grant_write], """
assert.equal(fs.readFileSync(allowed + '/escape/secret', 'utf8'), 'secret');
fs.writeFileSync(allowed + '/dangling', 'escaped');
assert.equal(fs.lstatSync(allowed + '/escape').isSymbolicLink(), true);
assert.equal(fs.readlinkSync(allowed + '/escape'), denied);
rejects(() => fs.symlinkSync(allowed + '/input', allowed + '/newlink'), '');
fs.renameSync(allowed + '/dangling', allowed + '/renamed-link');
assert.equal(fs.lstatSync(allowed + '/renamed-link').isSymbolicLink(), true);
fs.unlinkSync(allowed + '/renamed-link');
""")
    case('glob-skips-denied-traversal', ['--permission', grant_read], """
assert.deepEqual(fs.globSync('**/*', { cwd: denied }), []);
rejects(() => fs.readdirSync(denied), 'FileSystemRead');
(async () => {
  const matches = [];
  for await (const match of fs.promises.glob('**/*', { cwd: denied })) matches.push(match);
  assert.deepEqual(matches, []);
  await assert.rejects(fs.promises.readdir(denied), { code: 'ERR_ACCESS_DENIED' });
})().catch(error => { console.error(error); process.exitCode = 1; });
""")
    case('symlink-full-grants', ['--permission', '--allow-fs-read=*', '--allow-fs-write=*'], """
fs.symlinkSync(allowed + '/input', allowed + '/newlink');
assert.equal(fs.readFileSync(allowed + '/newlink', 'utf8'), 'allowed');
fs.unlinkSync(allowed + '/newlink');
""")
    case('access-write-mode-needs-read-only', ['--permission', grant_read], """
fs.accessSync(allowed + '/input', fs.constants.W_OK);
rejects(() => fs.openSync(allowed + '/input', 'r+'), 'FileSystemWrite');
""")
    case('native-sqlite-limitations', ['--permission'], """
const { DatabaseSync } = require('node:sqlite');
const disk = new DatabaseSync(denied + '/database');
try {
  disk.exec('CREATE TABLE data(value); INSERT INTO data VALUES (42); PRAGMA journal_mode=WAL');
  assert.equal(disk.prepare('SELECT value FROM data').get().value, 42);
  disk.prepare('ATTACH ? AS extra').run(denied + '/attached');
  disk.exec('DETACH extra');
} finally { disk.close(); }
assert.throws(() => new DatabaseSync(':memory:', { allowExtension: true }),
  error => error.code === 'ERR_LOAD_SQLITE_EXTENSION');
""")
    case('permission-property-and-private-policy', ['--permission', grant_read], """
const descriptor = Object.getOwnPropertyDescriptor(process, 'permission');
assert.deepEqual([descriptor.enumerable, descriptor.writable, descriptor.configurable], [true, false, false]);
assert.equal(Object.isFrozen(process.permission), false);
assert.equal(Object.isFrozen(path), true);
assert.throws(() => Object.defineProperty(process, 'permission', { value: {} }), TypeError);
process.permission.has = () => true;
const original = String.prototype.startsWith;
String.prototype.startsWith = () => true;
try { rejects(() => fs.openSync(denied + '/secret', 'r'), 'FileSystemRead'); }
finally { String.prototype.startsWith = original; }
""")
    case('drop-directory-and-diagnostics', ['--permission', grant_read, '--allow-fs-read=' + str(allowed / 'input')], """
const reports = [];
require('node:diagnostics_channel').subscribe('node:permission-model:fs', value => reports.push(value));
process.permission.drop('fs.read', allowed);
assert.equal(process.permission.has('fs.read', allowed + '/input'), false);
rejects(() => fs.readFileSync(allowed + '/input'), 'FileSystemRead');
assert.ok(reports.some(value => value.permission === 'FileSystemRead' && value.drop === true && value.resource === allowed));
assert.ok(reports.some(value => value.permission === 'FileSystemRead' && value.drop === undefined));
""")
    case('drop-wildcard-grant', ['--permission', '--allow-fs-read=' + str(allowed) + '/*.js'], """
process.permission.drop('fs.read', allowed + '/*.js');
assert.equal(process.permission.has('fs.read', allowed + '/input'), false);
""")
    case('raw-runtime-modules-private', ['--permission'], """
for (const name of ['std', 'internal/host', 'internal/permission'])
  assert.throws(() => require(name), error => error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_UNKNOWN_BUILTIN_MODULE');
""")
    installed = root / 'installed'
    package = installed / 'node_modules' / 'std'
    package.mkdir(parents=True)
    (package / 'package.json').write_text(json.dumps({'main': './index.cjs'}))
    (package / 'index.cjs').write_text("module.exports = 'ordinary-std-package';")
    resolve_std = "require('node:module').createRequire(path.join(root, 'installed', 'caller.cjs'))"
    case('package-metadata-read-is-checked', ['--permission'], f"""
const localRequire = {resolve_std};
assert.throws(() => localRequire('std'),
  error => error.code === 'ERR_ACCESS_DENIED' && error.permission === 'FileSystemRead' &&
    error.resource === path.join(root, 'installed', 'node_modules', 'std', 'package.json'));
""")
    package_read = '--allow-fs-read=' + str(package / 'package.json')
    case('module-probes-do-not-grant-source-read', ['--permission', package_read], f"""
const localRequire = {resolve_std};
rejects(() => localRequire('std'), 'FileSystemRead');
""")
    case('bare-std-remains-installable', ['--permission', package_read,
         '--allow-fs-read=' + str(package / 'index.cjs')], f"""
const localRequire = {resolve_std};
assert.equal(localRequire('std'), 'ordinary-std-package');
rejects(() => fs.readFileSync(denied + '/secret'), 'FileSystemRead');
""")
    case('missing-permission-option', [grant_read], '', exit_ok=False, stderr_contains='--permission is required')
    case('worker-security-warning', ['--permission', '--allow-worker'], '', stderr_contains='PERM0006')
    case('comma-list-warning', ['--permission', '--allow-fs-read=' + str(allowed) + ',' + str(denied)], '',
         stderr_contains='Passing a comma-separated list of paths is no longer valid')
    print(json.dumps({'passed': len(cases), 'cases': cases}))
