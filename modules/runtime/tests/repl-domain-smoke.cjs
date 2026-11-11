'use strict';
const assert = require('node:assert/strict');
const domain = require('node:domain');
const repl = require('node:repl');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');

const servers = [];
function open(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const server = repl.start({ input, output, terminal: false, prompt: '', preview: false, ...options });
  servers.push(server);
  return server;
}
function evaluate(server, source) {
  return new Promise((resolve, reject) => server.eval(source, server.context, 'REPLdomain',
    (error, value) => error ? reject(error) : resolve(value)));
}
function domainError(server, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { server._domain.removeListener('error', receive); reject(new Error('REPL domain error was not delivered')); }, 2000);
    function receive(error) { clearTimeout(timeout); resolve(error); }
    server._domain.once('error', receive);
    action();
  });
}

async function main() {
  const owner = domain.create();
  const server = open({ domain: owner });
  const seen = [];
  owner.on('error', error => seen.push(error));
  assert.equal(server._domain, owner);
  assert.equal(server.eval.domain, owner);
  server.context.owner = owner;
  assert.equal(await evaluate(server, 'process.domain === owner'), true);
  assert.equal(!!process.domain, false);

  const marker = { tag: 'thrown-value' };
  let callbacks = 0;
  for (const value of [marker, 0, undefined]) {
    server.context.thrown = value;
    server.eval('throw thrown', server.context, 'REPLdomain', () => callbacks++);
    assert.equal(seen.at(-1), value);
    assert.equal(server.context._error, value);
    assert.equal(!!process.domain, false);
  }
  assert.equal(callbacks, 0);
  assert.equal(seen.length, 3);

  const listeners = process.listenerCount('uncaughtException');
  server.eval("process.on('uncaughtException', () => {})", server.context, 'REPLdomain', () => callbacks++);
  assert.equal(server.context._error.code, 'ERR_INVALID_REPL_INPUT');
  assert.equal(process.listenerCount('uncaughtException'), listeners);
  function outsideListener() {}
  process.on('uncaughtException', outsideListener);
  assert.equal(process.listeners('uncaughtException').includes(outsideListener), true);
  process.removeListener('uncaughtException', outsideListener);
  assert.equal(process.listenerCount('uncaughtException'), listeners);

  const asynchronous = new Error('asynchronous REPL failure');
  server.context.asynchronous = asynchronous;
  assert.equal(await domainError(server, () => {
    server.eval('setTimeout(() => { throw asynchronous; }, 0); undefined', server.context, 'REPLdomain', error => assert.ifError(error));
  }), asynchronous);
  assert.equal(server.context._error, asynchronous);
  assert.equal(Object.hasOwn(asynchronous, 'domain'), false);
  assert.equal(Object.hasOwn(asynchronous, 'domainThrown'), false);
  assert.equal(await domainError(server, () => {
    server.eval('Promise.reject(asynchronous); undefined', server.context, 'REPLdomain', error => assert.ifError(error));
  }), asynchronous);
  assert.equal(await domainError(server, () => {
    server.eval('await Promise.reject(asynchronous)', server.context, 'REPLdomain', () => callbacks++);
  }), asynchronous);
  assert.equal(callbacks, 0);
  assert.equal(!!process.domain, false);

  const beforeRecoverable = seen.length;
  server.input.write('function answer() {\n');
  assert.equal(seen.length, beforeRecoverable);
  server.input.write('return 42\n}\nanswer()\n');
  assert.equal(await evaluate(server, 'answer()'), 42);
  server.input.write('const =\n');
  assert.equal(server.context._error.name, 'SyntaxError');
  server.input.write('throw 0\n40 + 2\n');
  assert.equal(server.context._error, 0);
  assert.equal(await evaluate(server, '_'), 42);

  const isolated = open();
  assert.notEqual(isolated._domain, owner);
  isolated.context.asynchronous = asynchronous;
  const beforeIsolation = seen.length;
  assert.equal(await domainError(isolated, () => {
    isolated.eval('setTimeout(() => { throw asynchronous; }, 0); undefined', isolated.context, 'REPLdomain', error => assert.ifError(error));
  }), asynchronous);
  assert.equal(isolated.context._error, asynchronous);
  assert.equal(server.context._error, 0);
  assert.equal(seen.length, beforeIsolation);

  const callbackError = new Error('custom callback failure');
  const synchronous = new Error('custom evaluator failure');
  const receiver = {};
  const rendered = [];
  const custom = open({
    eval(code, context, filename, callback) {
      if (code.trim() === 'callback-error') { callback(callbackError); return; }
      if (code.trim() === 'sync-error') throw synchronous;
      callback(null, this === receiver && process.domain === custom._domain);
    },
    writer(value) { rendered.push(value); return String(value); },
  });
  assert.equal(await new Promise((resolve, reject) => custom.eval.call(receiver, 'receiver', custom.context, 'REPLdomain',
    (error, value) => error ? reject(error) : resolve(value))), true);
  assert.equal(await domainError(custom, () => custom.input.write('callback-error\n')), callbackError);
  assert.equal(await domainError(custom, () => setImmediate(() => custom.input.write('sync-error\n'))), synchronous);
  assert.deepEqual(rendered, [callbackError, synchronous]);
  assert.equal(custom.context._error, synchronous);
  assert.equal(!!process.domain, false);

  const pinned = { retained: true };
  server.context._error = pinned;
  server.input.write('throw 17\n');
  assert.equal(server.context._error, pinned);
  assert.equal(seen.at(-1), 17);
}
main().then(async () => {
  await Promise.all(servers.map(server => {
    const exited = once(server, 'exit');
    server.close();
    return exited;
  }));
  console.log('REPL domain ownership, async errors, isolation, and recovery: PASS');
}, error => {
  for (const server of servers) server.close();
  console.error(error);
  process.exitCode = 1;
});
