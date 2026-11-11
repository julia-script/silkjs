'use strict';
// A script that prints nothing and starts no worker must not load the stream
// stack, the formatter, URL parsing or the worker internals at startup.
const loaded = process.moduleLoadList.map(entry => entry.replace('NativeModule ', ''));
const assert = require('assert');
const banned = ['stream', 'util', 'url', 'console', 'crypto', 'os', 'net', 'tty', 'internal/web/url',
  'internal/worker/ports', 'internal/worker/clone', 'internal/compile_cache', 'internal/source_maps',
  'internal/dotenv', 'internal/sea', 'internal/streams/readable', 'internal/web/encoding'];
for (const name of banned) assert(!loaded.includes(name), `${name} loaded at startup`);
assert(loaded.length < 60, `startup loaded ${loaded.length} built-in modules`);

// Everything deferred still works on first use.
const util = require('util');
assert.strictEqual(typeof util.parseArgs, 'function');
assert.strictEqual(util.parseArgs.name, 'parseArgs');
assert.strictEqual(new util.TextDecoder().decode(new util.TextEncoder().encode('ok')), 'ok');
assert.deepStrictEqual(Object.keys(util).slice(0, 3), ['format', 'formatWithOptions', 'inspect']);
const workers = require('worker_threads');
assert.strictEqual(typeof workers.MessageChannel, 'function');
assert.strictEqual(workers.MessageChannel, globalThis.MessageChannel);
assert.strictEqual(typeof workers.locks.request, 'function');
assert.strictEqual(typeof console.log, 'function');
assert.strictEqual(require('console'), console);
assert.strictEqual(process.stdout, process.stdout);
assert.strictEqual(typeof process.stdout.write, 'function');
assert.strictEqual(require('url').pathToFileURL(__filename).href, 'file://' + __filename);
assert.strictEqual(typeof process.loadEnvFile, 'function');
console.log('startup-modules-smoke ok');
