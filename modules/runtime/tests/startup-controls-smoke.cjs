'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

function child(source, flags = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_REDIRECT_WARNINGS', 'NODE_PENDING_DEPRECATION']) delete env[key];
  const result = spawnSync(process.execPath, [...flags, '-e', source], {
    encoding: 'utf8', timeout: 20000, env: { ...env, ...extraEnv },
  });
  if (result.error) throw result.error;
  return result;
}
function lines(result) { return result.stdout.trim() ? result.stdout.trim().split('\n').map(line => JSON.parse(line)) : []; }
function success(result) { assert.equal(result.status, 0, result.stderr); return result; }
const warnings = `process.on('warning', w => console.log(JSON.stringify([w.name, w.code, w.message])));
process.emitWarning('ordinary', { code: 'W_FIRST', detail: 'details' });
process.emitWarning('deprecated', 'DeprecationWarning', 'DEP_TEST');`;

async function inheritedChild() {
  const observed = [];
  process.on('warning', warning => observed.push(warning.name));
  process.emitWarning('inherited warning');
  Promise.reject('inherited rejection');
  setTimeout(() => {
    const message = { warnings: observed, trace: !!process.traceProcessWarnings };
    if (isMainThread) { process.send(message); process.disconnect(); }
    else parentPort.postMessage(message);
  }, 25);
}
async function inheritedParent() {
  const worker = new Worker(__filename, { argv: ['--inheritance-child'] });
  const subprocess = fork(__filename, ['--inheritance-child'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const observe = value => new Promise((resolve, reject) => {
    let message, stderr = '';
    value.on('message', data => { message = data; });
    value.on('error', reject);
    value.stderr?.on('data', data => { stderr += data; });
    value.on('exit', code => resolve({ code, message, stderr }));
  });
  console.log(JSON.stringify(await Promise.all([observe(worker), observe(subprocess)])));
}
async function main() {
  const flags = process.allowedNodeEnvironmentFlags;
  assert.equal(flags instanceof Set, true);
  assert.equal(Object.isFrozen(flags), true);
  for (const name of ['--warnings', '--no-warnings', '--trace-warnings', '--no-trace-warnings',
    '--deprecation', '--no-deprecation', '--throw-deprecation', '--no-throw-deprecation',
    '--trace-deprecation', '--no-trace-deprecation', '--pending-deprecation', '--no-pending-deprecation',
    '--disable-warning', '--redirect-warnings', '--unhandled-rejections']) assert.equal(flags.has(name), true, name);
  for (const name of ['--eval', '--print', '--test', '--env-file', '--experimental-test-module-mocks',
    '--no-experimental-test-module-mocks', '--no-expose-gc']) assert.equal(flags.has(name), false, name);
  for (const name of ['trace_warnings', '--trace_warnings=anything', 'trace-warnings', 'r', '-r']) assert.equal(flags.has(name), true, name);
  for (const name of ['trace-warnings=anything', '-trace-warnings', '--unknown', 1, null, {}]) assert.equal(flags.has(name), false);
  const before = [...flags];
  const beforeSize = flags.size;
  assert.deepEqual([...flags.keys()], before);
  assert.deepEqual([...flags.entries()], before.map(value => [value, value]));
  const receiver = {}, seen = [];
  flags.forEach(function(value, key, set) { assert.equal(this, receiver); assert.equal(key, value); assert.equal(set, flags); seen.push(value); }, receiver);
  assert.deepEqual([...new Set(seen)], before);
  assert.equal(flags.add('--made-up'), flags);
  assert.equal(flags.delete('--trace-warnings'), false);
  assert.equal(flags.clear(), undefined);
  Set.prototype.add.call(flags, '--made-up');
  assert.equal(flags.has('--made-up'), false);
  assert.deepEqual([...flags], before);
  assert.equal(flags.size, beforeSize);
  assert.throws(() => flags.forEach(null), TypeError);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'allowedNodeEnvironmentFlags');
  assert.equal(descriptor.writable, true);
  process.allowedNodeEnvironmentFlags = 'replacement';
  assert.equal(process.allowedNodeEnvironmentFlags, 'replacement');
  process.allowedNodeEnvironmentFlags = flags;

  const normal = success(child(warnings));
  assert.equal(lines(normal).length, 2);
  assert.match(normal.stderr, /\[W_FIRST\] Warning: ordinary\ndetails/);
  assert.match(normal.stderr, /\[DEP_TEST\] DeprecationWarning: deprecated/);
  assert.equal((normal.stderr.match(/show where the warning was created/g) || []).length, 1);
  for (const [args, env] of [[['--no-warnings'], {}], [[], { NODE_NO_WARNINGS: '1' }], [['--warnings'], { NODE_NO_WARNINGS: '1' }]]) {
    const result = success(child(warnings, args, env));
    assert.equal(result.stderr, '');
    assert.equal(lines(result).length, 2);
  }
  for (const env of [{ NODE_NO_WARNINGS: '0' }, { NODE_NO_WARNINGS: 'yes' }]) assert.match(success(child(warnings, [], env)).stderr, /ordinary/);
  assert.equal(lines(success(child(warnings, ['--no-deprecation']))).length, 1);
  assert.equal(lines(success(child(warnings, ['--deprecation'], { NODE_OPTIONS: '--no-deprecation' }))).length, 2);
  assert.match(success(child(warnings, ['--warnings'], { NODE_OPTIONS: '--no-warnings' })).stderr, /ordinary/);
  assert.equal(success(child(warnings, ['--no-warnings'], { NODE_OPTIONS: '--warnings' })).stderr, '');
  const suppressed = success(child(warnings, ['--disable-warning=W_FIRST', '--disable-warning', 'DeprecationWarning']));
  assert.equal(lines(suppressed).length, 2);
  assert.equal(suppressed.stderr, '');
  assert.match(success(child(warnings, ['--disable-warning=W_FIRST,DEP_TEST'])).stderr, /ordinary/);
  const stacked = success(child(`function caller(){process.emitWarning('stacked')};caller()`, ['--trace-warnings']));
  assert.match(stacked.stderr, /at caller/);
  assert.doesNotMatch(stacked.stderr, /show where the warning was created/);
  assert.doesNotMatch(success(child(`process.emitWarning('plain')`, ['--no-trace-warnings'], { NODE_OPTIONS: '--trace-warnings' })).stderr, /\n\s+at /);
  assert.match(success(child(`function deprecated(){process.emitWarning('old','DeprecationWarning')};deprecated()`, ['--trace-deprecation'])).stderr, /at deprecated/);
  assert.doesNotMatch(success(child(`process.emitWarning('old','DeprecationWarning')`, ['--no-trace-deprecation'], { NODE_OPTIONS: '--trace-deprecation' })).stderr, /\n\s+at /);
  assert.equal(success(child(`console.log(JSON.stringify(process.execArgv[0]));process.emitWarning('hidden')`, ['--no_warnings'])).stdout.trim(), '"--no_warnings"');
  const excluded = success(child(`process.on('warning',w=>console.log(JSON.stringify(w.stack)));function wrapper(){process.emitWarning('stack',{ctor:wrapper})};function caller(){wrapper()};caller()`, ['--no-warnings']));
  assert.match(lines(excluded)[0], /at caller/);
  assert.doesNotMatch(lines(excluded)[0], /at wrapper|at emitWarning/);
  assert.equal(success(child(`process.removeAllListeners('warning');process.emitWarning('hidden')`)).stderr, '');
  for (const args of [['--unhandled-rejections=invalid'], ['--unhandled-rejections='], ['--unhandled-rejections'],
    ['--disable-warning='], ['--redirect-warnings='], ['--expose-gc=false'], ['--no-no-warnings']]) assert.equal(child('', args).status, 9, args.join(' '));
  assert.equal(child('', [], { NODE_OPTIONS: '--unhandled-rejections=invalid' }).status, 9);
  for (const flag of ['--experimental-test-module-mocks', '--no-experimental-test-module-mocks']) assert.equal(child('', [], { NODE_OPTIONS: flag }).status, 9);
  assert.equal(lines(success(child(`console.log(JSON.stringify(process.traceProcessWarnings))`, ['--trace-warnings=false'])))[0], true);
  assert.equal(lines(success(child(`console.log(JSON.stringify(!!process.traceProcessWarnings))`, [], { NODE_OPTIONS: '--no-trace-warnings=false' })))[0], false);

  const thrown = success(child(`process.on('warning',()=>console.log(JSON.stringify('warning')));
    process.on('uncaughtExceptionMonitor',(e,o)=>console.log(JSON.stringify(['monitor',e.name,o])));
    process.setUncaughtExceptionCaptureCallback(e=>console.log(JSON.stringify(['capture',e.code])));
    process.on('uncaughtException',()=>console.log(JSON.stringify('uncaught')));
    process.emitWarning('deprecated','DeprecationWarning','DEP_THROW');`, ['--throw-deprecation', '--no-warnings']));
  assert.deepEqual(lines(thrown), [['monitor', 'DeprecationWarning', 'uncaughtException'], ['capture', 'DEP_THROW']]);
  assert.equal(child(`process.emitWarning('fatal','DeprecationWarning')`, ['--throw-deprecation']).status, 1);
  assert.equal(lines(success(child(warnings, ['--no-throw-deprecation'], { NODE_OPTIONS: '--throw-deprecation' }))).length, 2);
  assert.equal(lines(success(child(warnings, ['--throw-deprecation', '--no-deprecation']))).length, 1);
  success(child(`const assert=require('assert/strict');assert.equal(process.hasUncaughtExceptionCaptureCallback(),false);
    process.setUncaughtExceptionCaptureCallback(()=>{});assert.equal(process.hasUncaughtExceptionCaptureCallback(),true);
    assert.throws(()=>process.setUncaughtExceptionCaptureCallback(()=>{}),{code:'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET'});
    assert.throws(()=>require('domain'),{code:'ERR_DOMAIN_CALLBACK_NOT_AVAILABLE'});
    process.setUncaughtExceptionCaptureCallback(null);assert.equal(process.hasUncaughtExceptionCaptureCallback(),false);
    assert.throws(()=>process.setUncaughtExceptionCaptureCallback(1),{code:'ERR_INVALID_ARG_TYPE'});`));

  for (const mode of ['throw', 'strict', 'warn', 'warn-with-error-code', 'none']) {
    for (const reason of ['"primitive"', 'new Error("failure")']) {
      const result = child(`process.on('warning',w=>console.log(JSON.stringify(w.name)));Promise.reject(${reason});`, ['--no-warnings', '--unhandled-rejections=' + mode]);
      assert.equal(result.status, ['throw', 'strict', 'warn-with-error-code'].includes(mode) ? 1 : 0, mode);
      assert.equal(lines(result).length, ['warn', 'warn-with-error-code'].includes(mode) ? 2 : 0, mode);
      if (mode === 'throw' || mode === 'strict') assert.match(result.stderr, reason[0] === '"' ? /ERR_UNHANDLED_REJECTION|UnhandledPromiseRejection/ : /failure/);
    }
    const handled = child(`process.on('unhandledRejection',(r)=>console.log(JSON.stringify(['event',r])));
      process.on('warning',w=>console.log(JSON.stringify(w.name)));Promise.reject('reason');`, ['--no-warnings', '--unhandled-rejections=' + mode]);
    assert.equal(handled.status, mode === 'strict' ? 1 : 0, mode);
    assert.equal(lines(handled).length, mode === 'strict' ? 0 : mode === 'warn' ? 3 : 1, mode);
    const captured = success(child(`process.on('uncaughtExceptionMonitor',(e,o)=>console.log(JSON.stringify(['monitor',e.name,o])));
      process.setUncaughtExceptionCaptureCallback(e=>console.log(JSON.stringify(['capture',e.code])));
      process.on('unhandledRejection',()=>console.log(JSON.stringify('event')));
      process.on('warning',w=>console.log(JSON.stringify(w.name)));Promise.reject('reason');`, ['--no-warnings', '--unhandled-rejections=' + mode]));
    if (mode === 'strict') assert.deepEqual(lines(captured), [['monitor', 'UnhandledPromiseRejection', 'unhandledRejection'], ['capture', 'ERR_UNHANDLED_REJECTION'], 'event']);
    else assert.deepEqual(lines(captured), mode === 'warn' ? ['event', 'UnhandledPromiseRejectionWarning', 'UnhandledPromiseRejectionWarning'] : ['event']);
    const late = success(child(`process.on('uncaughtException',()=>{});process.on('unhandledRejection',()=>{});
      process.on('warning',w=>console.log(JSON.stringify([w.name,w.id])));
      const p=Promise.reject('late');setImmediate(()=>p.catch(()=>{}));`, ['--no-warnings', '--unhandled-rejections=' + mode]));
    assert.deepEqual(lines(late).at(-1), ['PromiseRejectionHandledWarning', 1]);
    const lateEvent = success(child(`process.on('uncaughtException',()=>{});process.on('unhandledRejection',()=>{});
      process.on('warning',w=>console.log(JSON.stringify(w.name)));process.on('rejectionHandled',()=>console.log(JSON.stringify('handled')));
      const p=Promise.reject('late');setImmediate(()=>p.catch(()=>{}));`, ['--no-warnings', '--unhandled-rejections=' + mode]));
    assert.equal(lines(lateEvent).includes('PromiseRejectionHandledWarning'), false);
    assert.equal(lines(lateEvent).at(-1), 'handled');
  }
  const strictUncaught = success(child(`process.on('uncaughtException',(e,o)=>console.log(JSON.stringify([e.name,o])));
    process.on('warning',w=>console.log(JSON.stringify(w.name)));Promise.reject({});`, ['--no-warnings', '--unhandled-rejections=strict']));
  assert.deepEqual(lines(strictUncaught), [['UnhandledPromiseRejection', 'unhandledRejection'], 'UnhandledPromiseRejectionWarning', 'UnhandledPromiseRejectionWarning']);
  for (const mode of ['warn', 'strict', 'throw']) {
    const failedListener = success(child(`process.on('uncaughtException',(e,o)=>console.log(JSON.stringify([e.message,o])));
      process.on('unhandledRejection',()=>{throw new Error('listener')});process.on('warning',()=>console.log(JSON.stringify('warning')));
      Promise.reject(new Error('reason'));`, ['--no-warnings', '--unhandled-rejections=' + mode]));
    assert.deepEqual(lines(failedListener), mode === 'strict' ? [['reason', 'unhandledRejection'], ['listener', 'uncaughtException']] : [['listener', 'uncaughtException']]);
  }
  const domainResult = success(child(`const d=require('domain').create();d.on('error',e=>console.log(JSON.stringify(['domain',e])));
    process.on('unhandledRejection',()=>console.log(JSON.stringify('event')));d.run(()=>Promise.reject('domain reason'));`, ['--unhandled-rejections=throw']));
  assert.deepEqual(lines(domainResult), [['domain', 'domain reason']]);
  const strictDomain = success(child(`const d=require('domain').create();d.on('error',e=>console.log(JSON.stringify(['domain',e])));
    process.on('uncaughtException',(e,o)=>console.log(JSON.stringify(['uncaught',o])));d.run(()=>Promise.reject('domain reason'));`, ['--unhandled-rejections=strict']));
  assert.deepEqual(lines(strictDomain), [['uncaught', 'unhandledRejection'], ['domain', 'domain reason']]);
  success(child(`Promise.reject('handled on time').catch(()=>{});const p=Promise.reject('tick');process.nextTick(()=>p.catch(()=>{}));`));
  assert.equal(success(child(`Promise.reject('none')`, ['--unhandled-rejections=none'], { NODE_OPTIONS: '--unhandled-rejections=strict' })).stderr, '');
  const workerInvalid = success(child(`const assert=require('assert/strict');const{Worker}=require('worker_threads');
    assert.throws(()=>new Worker('',{eval:true,execArgv:['--unhandled-rejections=bad']}),{code:'ERR_WORKER_INVALID_EXEC_ARGV'});`));
  assert.equal(workerInvalid.stderr, '');
  const explicitWorker = success(child(`const {Worker}=require('worker_threads');let stderr='', warnings=[];
    const w=new Worker("process.on('warning',w=>require('worker_threads').parentPort.postMessage(w.name));process.emitWarning('explicit');Promise.reject('ignored')",
      {eval:true,stderr:true,execArgv:['--warnings','--unhandled-rejections=none']});
    w.stderr.on('data',data=>stderr+=data);w.on('message',value=>warnings.push(value));
    w.on('exit',code=>console.log(JSON.stringify([code,stderr.includes('explicit'),warnings])));`,
    ['--no-warnings', '--unhandled-rejections=warn-with-error-code']));
  assert.deepEqual(lines(explicitWorker), [[0, true, ['Warning']]]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-controls-'));
  try {
    const redirected = path.join(root, 'warnings.log');
    const envRedirected = path.join(root, 'env.log');
    const redirectedResult = success(child(warnings, ['--redirect-warnings', redirected], { NODE_REDIRECT_WARNINGS: envRedirected }));
    assert.equal(redirectedResult.stderr, '');
    assert.equal(lines(redirectedResult).length, 2);
    assert.match(fs.readFileSync(redirected, 'utf8'), /ordinary/);
    assert.equal(fs.existsSync(envRedirected), false);
    success(child(`process.emitWarning('appended')`, [], { NODE_REDIRECT_WARNINGS: redirected }));
    assert.match(fs.readFileSync(redirected, 'utf8'), /ordinary[\s\S]*appended/);
    assert.match(success(child(`process.emitWarning('fallback')`, ['--redirect-warnings=' + path.join(root, 'missing', 'warning.log')])).stderr, /fallback/);
    const dependency = path.join(root, 'node_modules', 'pending');
    fs.mkdirSync(dependency, { recursive: true });
    const entry = path.join(dependency, 'index.js');
    fs.writeFileSync(entry, 'module.exports=()=>new Buffer(2);');
    const pending = `process.on('warning',w=>console.log(JSON.stringify(w.code)));require(${JSON.stringify(entry)})();require('crypto').pseudoRandomBytes(1);
      const {PassThrough}=require('stream');const repl=require('repl').start({input:new PassThrough(),output:new PassThrough(),terminal:false,prompt:''});
      void repl.inputStream;repl.close();`;
    assert.deepEqual(lines(success(child(pending, ['--no-warnings']))), []);
    for (const [args, env] of [[['--pending-deprecation'], {}], [[], { NODE_PENDING_DEPRECATION: '1' }]]) {
      assert.deepEqual(lines(success(child(pending, ['--no-warnings', ...args], env))), ['DEP0005', 'DEP0115', 'DEP0141']);
    }
    assert.deepEqual(lines(success(child(pending, ['--no-warnings', '--no-pending-deprecation'], { NODE_PENDING_DEPRECATION: '1' }))), []);
    assert.deepEqual(lines(success(child(pending, ['--no-warnings', '--pending-deprecation', '--no-deprecation']))), []);
    const inherit = spawnSync(process.execPath, ['--no-warnings', '--trace-warnings', '--unhandled-rejections=warn-with-error-code', __filename, '--inheritance-parent'], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (inherit.error) throw inherit.error;
    success(inherit);
    const inherited = JSON.parse(inherit.stdout);
    for (const result of inherited) {
      assert.equal(result.code, 1);
      assert.equal(result.stderr, '');
      assert.equal(result.message.trace, true);
      assert.deepEqual(result.message.warnings, ['Warning', 'UnhandledPromiseRejectionWarning', 'UnhandledPromiseRejectionWarning']);
    }
    assert.equal(inherit.stderr, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Startup warnings, rejection policy, allowed environment flags and worker/fork inheritance smoke passed');
}
const mode = process.argv[2];
(mode === '--inheritance-child' ? inheritedChild() : mode === '--inheritance-parent' ? inheritedParent() : main()).catch(error => {
  console.error(error); process.exitCode = 1;
});
