'use strict';
// Run: build/silkjsruntime tests/inspector-builtin-source-smoke.cjs
// Debugger.enable hashes the source of every script it reports, built-ins included.
// The inventory names each script by the first of its functions found in the heap,
// so it must find the text from whichever function that is.
const assert = require('node:assert/strict');
const inspector = require('node:inspector');
for (const name of ['fs', 'fs/promises', 'url', 'util', 'stream', 'events', 'path', 'os', 'crypto', 'zlib', 'http', 'net', 'child_process', 'worker_threads', 'vm', 'readline', 'string_decoder', 'querystring', 'assert', 'buffer']) require(name);
new URLSearchParams('a=1').get('a');
const session = new inspector.Session();
session.connect();
const scripts = [];
session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params));
session.post('Debugger.enable', error => {
  assert.equal(error, null);
  assert.ok(scripts.length > 20, `only ${scripts.length} scripts`);
  let checked = 0;
  for (const script of scripts) {
    session.post('Debugger.getScriptSource', { scriptId: script.scriptId }, (failure, result) => {
      assert.equal(failure, null, `${script.url}: ${failure && failure.message}`);
      assert.equal(typeof result.scriptSource, 'string');
      if (++checked === scripts.length) { session.disconnect(); console.log('inspector-builtin-source-smoke ok'); }
    });
  }
});
