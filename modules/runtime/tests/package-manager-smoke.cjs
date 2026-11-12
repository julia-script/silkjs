'use strict';
// The package manager commands of the executable, against a registry served from this process:
// add resolves, downloads and links; the installed package loads; remove takes it out again.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

function tarball(files) {
  const entries = Object.entries(files).map(([name, text]) => tarEntry('package/' + name, Buffer.from(text)));
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const packages = {
  greeter: {
    version: '1.0.0',
    dependencies: { worder: '^2.0.0' },
    files: {
      'package.json': '{"name":"greeter","version":"1.0.0","main":"index.js","dependencies":{"worder":"^2.0.0"}}',
      'index.js': 'module.exports = () => "hello " + require("worder");\n',
    },
  },
  worder: {
    version: '2.1.0',
    dependencies: {},
    files: {
      'package.json': '{"name":"worder","version":"2.1.0","main":"index.js"}',
      'index.js': 'module.exports = "world";\n',
    },
  },
  builder: {
    version: '1.0.0',
    dependencies: {},
    hasInstallScript: true,
    files: {
      'package.json': JSON.stringify({
        name: 'builder',
        version: '1.0.0',
        scripts: { postinstall: 'printf \'%s %s\' "$npm_lifecycle_event" "$npm_package_name" > made.txt' },
      }),
    },
  },
};

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  const name = request.url.split('/')[1];
  const found = packages[name];
  if (!found) {
    response.writeHead(404).end('{}');
    return;
  }
  const archive = tarball(found.files);
  if (request.url.endsWith('.tgz')) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length }).end(archive);
    return;
  }
  const body = JSON.stringify({
    name,
    'dist-tags': { latest: found.version },
    versions: {
      [found.version]: {
        name,
        version: found.version,
        dependencies: found.dependencies,
        hasInstallScript: found.hasInstallScript,
        dist: {
          tarball: `${base}/${name}/-/${name}-${found.version}.tgz`,
          integrity: 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64'),
        },
      },
    },
  });
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
});

function run(directory, args, home = directory) {
  return new Promise((resolve, reject) => {
    const environment = { PATH: process.env.PATH, HOME: home, SILKJS_STORE: path.join(home, 'store') };
    const child = spawn(process.execPath, args, { cwd: directory, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-smoke-'));
  try {
    const manifest = path.join(directory, 'package.json');
    fs.writeFileSync(manifest, '{\n  "name": "app",\n  "private": true\n}\n');
    fs.writeFileSync(path.join(directory, '.npmrc'), `registry=http://127.0.0.1:${server.address().port}/\n`);
    fs.writeFileSync(path.join(directory, 'main.js'), 'console.log(require("greeter")());\n');

    const added = await run(directory, ['add', 'greeter']);
    assert.strictEqual(added.status, 0, added.stderr);
    assert.match(added.stdout, /\+ greeter \^1\.0\.0\n/);
    assert.match(added.stdout, /2 packages: 2 downloaded, 2 linked\n/);
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'),
      '{\n  "name": "app",\n  "private": true,\n  "dependencies": {\n    "greeter": "^1.0.0"\n  }\n}\n');
    assert.ok(fs.existsSync(path.join(directory, 'sjs.lock')));
    assert.ok(fs.lstatSync(path.join(directory, 'node_modules/greeter')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(directory, 'node_modules/worder')), 'only direct dependencies are at the top');

    const ran = await run(directory, ['main.js']);
    assert.strictEqual(ran.status, 0, ran.stderr);
    assert.strictEqual(ran.stdout, 'hello world\n');

    // A frozen install from the lockfile and the store asks the registry nothing.
    fs.rmSync(path.join(directory, 'node_modules'), { recursive: true });
    const before = requests.length;
    const frozen = await run(directory, ['ci']);
    assert.strictEqual(frozen.status, 0, frozen.stderr);
    assert.match(frozen.stdout, /2 packages: 0 downloaded, 2 linked\n/);
    assert.strictEqual(requests.length, before);

    const removed = await run(directory, ['remove', 'greeter']);
    assert.strictEqual(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /- greeter\n/);
    assert.ok(!fs.existsSync(path.join(directory, 'node_modules/greeter')));
    assert.ok(!fs.existsSync(path.join(directory, 'node_modules/.sjs/greeter@1.0.0')));
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), '{\n  "name": "app",\n  "private": true\n}\n');

    const missing = await run(directory, ['add', 'nothing-by-this-name']);
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /^silkjsruntime: /);
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), '{\n  "name": "app",\n  "private": true\n}\n');

    // The install scripts of a package run only when allowBuilds of the project names it.
    const made = path.join(directory, 'node_modules/builder/made.txt');
    const unbuilt = await run(directory, ['add', 'builder']);
    assert.strictEqual(unbuilt.status, 0, unbuilt.stderr);
    assert.match(unbuilt.stdout, /allowBuilds in package\.json does not name the package:\nbuilder@1\.0\.0\n/);
    assert.ok(!fs.existsSync(made));
    const allowing = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    allowing.allowBuilds = { builder: true };
    fs.writeFileSync(manifest, JSON.stringify(allowing, null, 2) + '\n');
    const built = await run(directory, ['install']);
    assert.strictEqual(built.status, 0, built.stderr);
    assert.match(built.stdout, /1 packages: 0 downloaded, 1 linked, 1 built\n/);
    assert.strictEqual(fs.readFileSync(made, 'utf8'), 'postinstall builder');
    const settled = await run(directory, ['install']);
    assert.match(settled.stdout, /1 packages: 0 downloaded, 0 linked\n/);

    // A workspace: one lockfile and one hidden directory at the root, and a package that depends
    // on another gets a link to its directory.
    const repo = path.join(directory, 'repo');
    fs.mkdirSync(path.join(repo, 'packages/app'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages/lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.npmrc'), `registry=http://127.0.0.1:${server.address().port}/\n`);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo","private":true,"workspaces":["packages/*"]}\n');
    fs.writeFileSync(path.join(repo, 'packages/lib/package.json'), '{"name":"@repo/lib","version":"1.0.0","main":"index.js","dependencies":{"worder":"^2.0.0"}}\n');
    fs.writeFileSync(path.join(repo, 'packages/lib/index.js'), 'module.exports = () => "lib says " + require("worder");\n');
    fs.writeFileSync(path.join(repo, 'packages/app/package.json'), '{"name":"app","dependencies":{"@repo/lib":"workspace:*"}}\n');
    fs.writeFileSync(path.join(repo, 'packages/app/main.js'), 'console.log(require("@repo/lib")(), require("greeter")());\n');
    const app = path.join(repo, 'packages/app');
    const shared = await run(app, ['install'], directory);
    assert.strictEqual(shared.status, 0, shared.stderr);
    assert.match(shared.stdout, /1 packages: 0 downloaded, 1 linked\n/);
    assert.ok(fs.existsSync(path.join(repo, 'sjs.lock')));
    assert.ok(!fs.existsSync(path.join(app, 'sjs.lock')));
    assert.strictEqual(fs.readlinkSync(path.join(app, 'node_modules/@repo/lib')), '../../../../packages/lib');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules/.sjs/worder@2.1.0')));
    const filtered = await run(path.join(repo, 'packages/lib'), ['add', '--filter', 'app', 'greeter'], directory);
    assert.strictEqual(filtered.status, 0, filtered.stderr);
    assert.match(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), /"greeter":\s*"\^1\.0\.0"/);
    const together = await run(app, ['main.js'], directory);
    assert.strictEqual(together.status, 0, together.stderr);
    assert.strictEqual(together.stdout, 'lib says world hello world\n');
    console.log('ok');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    server.close();
  }
});
