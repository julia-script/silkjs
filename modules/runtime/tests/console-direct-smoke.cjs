'use strict';
// console prints plain text straight to the descriptor while the process
// streams are untouched. Each case runs in a child with stdout and stderr
// redirected to files, then to pipes, and must print what the stream path
// prints, in the same order, and load neither the formatter nor a stream.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-direct-'));
function run(source, pipe) {
  const out = path.join(directory, 'out'), err = path.join(directory, 'err');
  const stdio = pipe ? ['ignore', 'pipe', 'pipe'] : ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')];
  const script = path.join(directory, 'case.cjs');
  fs.writeFileSync(script, source);
  const child = spawnSync(process.execPath, [script], { stdio, encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr || source);
  if (pipe) return { stdout: child.stdout, stderr: child.stderr };
  fs.closeSync(stdio[1]); fs.closeSync(stdio[2]);
  return { stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
}
// A start from a heap image has these loaded already (tools/build.py), so only a
// start without one shows which path console took.
function startsFromImage() {
  const fd = fs.openSync(process.execPath, 'r');
  try {
    const trailer = Buffer.alloc(8);
    fs.readSync(fd, trailer, 0, 8, fs.fstatSync(fd).size - 8);
    return trailer.toString('latin1') === 'SILKIMG1';
  } finally { fs.closeSync(fd); }
}
const loadedAfter = startsFromImage() ? '0' : `process.moduleLoadList.filter(name => /NativeModule (util|fs|internal\\/streams\\/writable)$/.test(name)).length`;

for (const pipe of [false, true]) {
  // Text only: no formatter, no stream, when the descriptor is a file.
  let result = run(`console.log('one'); console.log('two', 'three'); console.error('oops'); console.info('i'); console.warn('w', 'x');
    process.exitCode = ${loadedAfter} === 0 ? 0 : 3;`, pipe);
  assert.strictEqual(result.stdout, 'one\ntwo three\ni\n');
  assert.strictEqual(result.stderr, 'oops\nw x\n');

  // Formatting, grouping and values take the full path and keep their order.
  result = run(`console.log('a %s', 'b'); console.log('plain'); console.group('g'); console.log('in\\nner'); console.groupEnd();
    console.log(1, 'two', { a: 1 }); console.log(''); console.log(); console.log('100%'); console.log('%', 'x');`, pipe);
  assert.strictEqual(result.stdout, 'a b\nplain\ng\n  in\n  ner\n1 two { a: 1 }\n\n\n100%\n% x\n');

  // A stream that was read or replaced is never bypassed afterwards.
  result = run(`console.log('before'); process.stdout.write('stream\\n'); console.log('after');
    const write = process.stdout.write; process.stdout.write = function(text, ...rest) { return write.call(this, '[' + text.trim() + ']\\n', ...rest); };
    console.log('patched');`, pipe);
  assert.strictEqual(result.stdout, 'before\nstream\nafter\n[patched]\n');
  result = run(`Object.defineProperty(process, 'stdout', { configurable: true, value: new (require('stream').Writable)({ write(chunk, encoding, done) { process.stderr.write('mine:' + chunk); done(); } }) });
    console.log('redirected');`, pipe);
  assert.deepStrictEqual(result, { stdout: '', stderr: 'mine:redirected\n' });
  result = run(`console._stdout = new (require('stream').Writable)({ write(chunk, encoding, done) { process.stderr.write('own:' + chunk); done(); } }); console.log('c'); console.error('e');`, pipe);
  assert.deepStrictEqual(result, { stdout: '', stderr: 'own:c\ne\n' });

  // A worker's console goes through its parent, and text keeps its encoding.
  result = run(`const { Worker } = require('worker_threads');
    new Worker("console.log('from worker')", { eval: true }).on('exit', () => console.log('h\\u00e9llo \\u{1f600}'));`, pipe);
  assert.strictEqual(result.stdout, 'from worker\nhéllo \u{1f600}\n');

  // A line longer than a pipe holds: what the pipe takes goes at once, the rest
  // through the stream, before anything printed after it.
  result = run(`const line = 'x'.repeat(1 << 18); console.log(line); console.log('next'); process.stdout.write('end\\n');`, pipe);
  assert.strictEqual(result.stdout, 'x'.repeat(1 << 18) + '\nnext\nend\n');
}

// Output to a pipe whose reader has gone fails with EPIPE, which console ignores
// as Node's does; the process is not killed by SIGPIPE.
{
  const script = path.join(directory, 'case.cjs');
  fs.writeFileSync(script, `for (let i = 0; i < 100000; i++) console.log(i);
    process.on('exit', code => require('fs').writeSync(2, 'exit ' + code));`);
  const child = spawnSync('/bin/sh', ['-c', '"$0" "$1" | head -c 1 > /dev/null', process.execPath, script], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(child.stderr, 'exit 0');
}
fs.rmSync(directory, { recursive: true });
console.log('console-direct-smoke ok');
