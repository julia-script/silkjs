'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-dotenv-')));
function file(name, content) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function run(args, overrides = {}) {
  const env = { ...process.env, SILK_DOTENV_OUTER: 'outer', ...overrides };
  if (!Object.hasOwn(overrides, 'NODE_OPTIONS')) delete env.NODE_OPTIONS;
  for (const key of ['SILK_DOTENV_VALUE', 'SILK_DOTENV_FIRST', 'SILK_DOTENV_SECOND']) delete env[key];
  if (!Object.hasOwn(overrides, 'NODE_PATH')) delete env.NODE_PATH;
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}
function success(args, overrides) {
  const result = run(args, overrides);
  assert.equal(result.status, 0, JSON.stringify({ args, ...result }));
  return JSON.parse(result.stdout);
}
try {
  file('.env', 'SILK_DOTENV_VALUE=default\n');
  file('first.env', 'SILK_DOTENV_VALUE=first\nSILK_DOTENV_OUTER=ignored\nSILK_DOTENV_FIRST=yes\n');
  file('second.env', 'SILK_DOTENV_VALUE="second\nline"\nSILK_DOTENV_SECOND=yes\n');
  const report = `console.log(JSON.stringify([process.env.SILK_DOTENV_VALUE??null,process.env.SILK_DOTENV_OUTER,process.env.SILK_DOTENV_FIRST??null,process.env.SILK_DOTENV_SECOND??null,process.argv.slice(2)]));`;
  file('entry.cjs', report);
  assert.deepEqual(success(['--env-file=first.env', '--env-file', 'second.env', 'entry.cjs']),
    ['second\nline', 'outer', 'yes', 'yes', []]);
  assert.deepEqual(success(['entry.cjs', '--env-file=first.env']), [null, 'outer', null, null, ['--env-file=first.env']]);
  assert.deepEqual(success(['--', 'entry.cjs', '--env-file=first.env']), [null, 'outer', null, null, ['--env-file=first.env']]);
  const missing = run(['--env-file=missing.env', '-v']);
  assert.equal(missing.status, 9); assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /missing\.env/);
  const optional = run(['--env-file-if-exists=missing.env', 'entry.cjs']);
  assert.equal(optional.status, 0); assert.deepEqual(JSON.parse(optional.stdout), [null, 'outer', null, null, []]);
  assert.match(optional.stderr, /missing\.env/);
  const emptyOptional = run(['--env-file-if-exists=', 'entry.cjs']);
  assert.equal(emptyOptional.status, 9);
  assert.match(emptyOptional.stderr, /--env-file-if-exists=/);
  const multipleMissing = run(['--env-file-if-exists=absent-1.env', '--env-file-if-exists=absent-2.env', '--env-file=absent-3.env']);
  assert.equal(multipleMissing.status, 9);
  for (let index = 1; index <= 3; index++) assert.ok(multipleMissing.stderr.includes(`absent-${index}.env`));
  assert.equal(run(['--env-file=first.env', 'entry.cjs'], { NODE_OPTIONS: '--env-file=first.env' }).status, 9);

  file('pre.cjs', 'globalThis.dotenvPreload=process.env.SILK_DOTENV_VALUE;');
  file('modules/from-dotenv/index.js', 'module.exports="global-path";');
  file('node_modules/choice/package.json', JSON.stringify({ exports: { dotenv: './chosen.cjs', default: './default.cjs' } }));
  file('node_modules/choice/chosen.cjs', 'module.exports="condition";');
  file('node_modules/choice/default.cjs', 'module.exports="wrong";');
  file('flags.env', 'NODE_OPTIONS="--require ./pre.cjs --conditions=dotenv"\nNODE_PATH=./modules\n');
  const startup = 'console.log(JSON.stringify([dotenvPreload,require("from-dotenv"),require("choice")]));';
  assert.deepEqual(success(['--env-file=first.env', '--env-file=flags.env', '-e', startup]),
    ['first', 'global-path', 'condition']);

  file('public.cjs', `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
    for(const input of [undefined,null]) { delete process.env.SILK_DOTENV_VALUE;process.loadEnvFile(input);assert.equal(process.env.SILK_DOTENV_VALUE,'default'); }
    for(const input of ['first.env',Buffer.from('first.env'),new Uint8Array(Buffer.from('first.env')),pathToFileURL(path.resolve('first.env'))]) {
      delete process.env.SILK_DOTENV_VALUE;process.loadEnvFile(input);assert.equal(process.env.SILK_DOTENV_VALUE,'first');
      process.loadEnvFile('second.env');assert.equal(process.env.SILK_DOTENV_VALUE,'first');assert.equal(process.env.SILK_DOTENV_OUTER,'outer');
    }
    for(const input of [false,3,{},new URL('https://example.com/a')])assert.throws(()=>process.loadEnvFile(input),{code:input instanceof URL?'ERR_INVALID_URL_SCHEME':'ERR_INVALID_ARG_TYPE'});
    assert.throws(()=>process.loadEnvFile('.'),{code:'ERR_INVALID_ARG_TYPE'});
    assert.throws(()=>process.loadEnvFile('missing.env'),{code:'ENOENT',syscall:'open'});
    for(const name of ['openSync','readFileSync','closeSync'])fs[name]=()=>{throw new Error('public fs override must not intercept dotenv')};
    delete process.env.SILK_DOTENV_VALUE;process.loadEnvFile('first.env');assert.equal(process.env.SILK_DOTENV_VALUE,'first');
    console.log(JSON.stringify('public'));
  `);
  assert.equal(success(['public.cjs']), 'public');
  file('worker.cjs', `const {Worker}=require('node:worker_threads');const w=new Worker('console.log(JSON.stringify(process.env.SILK_DOTENV_VALUE??null))',{eval:true,execArgv:['--env-file=first.env']});w.on('error',e=>{throw e});w.on('exit',code=>{if(code)process.exitCode=code});`);
  assert.equal(success(['worker.cjs']), null);
  assert.equal(success(['--env-file=first.env', 'worker.cjs']), 'first');
  console.log('dotenv startup and public API smoke: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
