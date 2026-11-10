'use strict';
// Run with Node 24 or silkjsruntime; no assembler or second engine is needed.
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { binary, signature, named, exported, I32, I64, EXTERNREF } = require('./wasm-fixtures.cjs');
const E = [0x64, 0x6f]; // (ref extern), deliberately non-nullable.
const A = [0x63, 0];
const namespace = 'constants\0ascii';
const constant = 'A\0\ud83d\ude00\u2603';
const options = { builtins: ['js-string'], importedStringConstants: namespace };
const definitions = [
  ['cast', [EXTERNREF], [E]], ['test', [EXTERNREF], [I32]],
  ['fromCharCode', [I32], [E]], ['fromCodePoint', [I32], [E]],
  ['charCodeAt', [EXTERNREF, I32], [I32]], ['codePointAt', [EXTERNREF, I32], [I32]],
  ['length', [EXTERNREF], [I32]], ['concat', [EXTERNREF, EXTERNREF], [E]],
  ['substring', [EXTERNREF, I32, I32], [E]], ['equals', [EXTERNREF, EXTERNREF], [I32]],
  ['compare', [EXTERNREF, EXTERNREF], [I32]],
  ['fromCharCodeArray', [A, I32, I32], [E]],
  ['intoCharCodeArray', [EXTERNREF, A, I32], [I32]],
];
function fixture() {
  return binary({
    types: [[0x5e, 0x77, 1], ...definitions.map(([, p, r]) => signature(p, r)),
      signature([EXTERNREF], [E])],
    imports: [named(namespace, constant, 3, [EXTERNREF, 0]),
      ...definitions.map(([name], i) => named('wasm:js-string', name, 0, [i + 1]))],
    functions: [{ type: 14, locals: [[1, ...A]], body: [
      0x41, 4, 0xfb, 0x07, 0, 0x21, 1, // array.new_default, local.set 1
      0x20, 0, 0x20, 1, 0x41, 0, 0x10, 12, 0x1a, // intoCharCodeArray
      0x20, 1, 0x41, 0, 0x41, 4, 0x10, 11, // fromCharCodeArray
    ] }],
    exports: [exported('constant', 3, 0),
      ...definitions.map(([name], i) => exported(name, 0, i)), exported('arrayRoundTrip', 0, 13)],
  });
}
function forbiddenImports() {
  return new Proxy({}, { get() { throw new Error('builtin import property was accessed'); } });
}
function check(module) {
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const x = new WebAssembly.Instance(module, forbiddenImports()).exports;
  assert.equal(x.constant.value, constant);
  assert.equal(x.cast('\ud800'), '\ud800');
  assert.equal(x.test(''), 1);
  for (const value of [null, undefined, 0, false, {}, new String('a')]) {
    assert.equal(x.test(value), 0);
    assert.throws(() => x.cast(value), WebAssembly.RuntimeError);
    assert.throws(() => x.length(value), WebAssembly.RuntimeError);
  }
  assert.equal(x.length('a\ud83d\ude00\ud800'), 4);
  assert.equal(x.fromCharCode(0x1d800), '\ud800');
  assert.equal(x.fromCodePoint(0x1f600), '\ud83d\ude00');
  for (const value of [-1, 0x110000]) assert.throws(() => x.fromCodePoint(value), WebAssembly.RuntimeError);
  assert.equal(x.charCodeAt('a\ud83d\ude00', 1), 0xd83d);
  assert.equal(x.codePointAt('a\ud83d\ude00', 1), 0x1f600);
  for (const method of ['charCodeAt', 'codePointAt']) {
    assert.throws(() => x[method]('a', -1), WebAssembly.RuntimeError);
    assert.throws(() => x[method]('', 0), WebAssembly.RuntimeError);
  }
  assert.equal(x.concat('\ud800', '\udc00'), '\ud800\udc00');
  assert.equal(x.substring('abc', 0, -1), 'abc');
  assert.equal(x.substring('abc', -1, 1), '');
  assert.equal(x.substring('abc', 2, 1), '');
  assert.equal(x.equals(null, null), 1);
  assert.equal(x.equals(null, ''), 0);
  assert.equal(x.equals('abc', 'abc'), 1);
  assert.throws(() => x.equals(undefined, undefined), WebAssembly.RuntimeError);
  assert.equal(x.compare('a', 'b'), -1);
  assert.equal(x.compare('b', 'a'), 1);
  assert.equal(x.compare('a', 'a'), 0);
  assert.equal(x.arrayRoundTrip('A\0\ud800B'), 'A\0\ud800B');
  assert.throws(() => x.arrayRoundTrip('12345'), WebAssembly.RuntimeError);
  return x;
}
async function main() {
  const bytes = fixture();
  assert.equal(WebAssembly.validate(bytes, options), true);
  const module = new WebAssembly.Module(bytes, options);
  check(module);
  check(await WebAssembly.compile(bytes, options));
  const instantiated = await WebAssembly.instantiate(bytes, forbiddenImports(), options);
  assert.equal(instantiated.instance.exports.constant.value, constant);
  check(instantiated.module);
  // Options for the Module overload are ignored, not re-read.
  await WebAssembly.instantiate(module, forbiddenImports(), new Proxy({}, { get() { throw 42; } }));

  const accesses = [];
  const list = new Proxy({ 0: 'js-string', 2: { toString() { throw 42; } }, length: 3 }, {
    get(target, key) { accesses.push('get:' + key); return target[key]; },
    has(target, key) { accesses.push('has:' + key); return key in target; },
  });
  const config = new Proxy({ builtins: list, importedStringConstants: namespace }, {
    get(target, key) { accesses.push('get:' + key); return target[key]; },
    has(target, key) { accesses.push('has:' + key); return key in target; },
  });
  check(new WebAssembly.Module(bytes, config));
  assert.deepEqual(accesses, ['get:builtins', 'get:length', 'has:0', 'get:0', 'has:1',
    'has:2', 'get:2', 'has:importedStringConstants', 'get:importedStringConstants']);
  const throws = { get builtins() { throw new Error('options sentinel'); } };
  assert.equal(WebAssembly.validate(bytes, throws), false);
  assert.throws(() => new WebAssembly.Module(bytes, throws), /options sentinel/);
  assert.equal(WebAssembly.validate(new Uint8Array(), throws), false);
  assert.throws(() => new WebAssembly.Module(new Uint8Array(), throws), WebAssembly.CompileError);
  const copied = bytes.slice();
  check(new WebAssembly.Module(copied, { get builtins() { copied.fill(0); return ['js-string']; }, importedStringConstants: namespace }));
  const notCopied = bytes.slice();
  assert.equal(WebAssembly.validate(notCopied, { get builtins() { notCopied.fill(0); return ['js-string']; } }), false);

  for (const [name, parameters, results] of definitions.slice(0, 11)) {
    const wrong = binary({ types: [signature(parameters, [I64])], imports: [named('wasm:js-string', name, 0, [0])] });
    assert.equal(WebAssembly.validate(wrong), true);
    assert.equal(WebAssembly.validate(wrong, options), false);
    assert.throws(() => new WebAssembly.Module(wrong, options), WebAssembly.CompileError);
    // A nullable string result is not interchangeable with (ref extern).
    if (Array.isArray(results[0])) {
      const nullable = binary({ types: [signature(parameters, [EXTERNREF])], imports: [named('wasm:js-string', name, 0, [0])] });
      assert.equal(WebAssembly.validate(nullable, options), false);
    }
  }
  for (const arrayType of [
    [0x5e, 0x77, 0], // immutable i16
    [0x5e, 0x78, 1], // mutable i8
    [0x50, 0, 0x5e, 0x77, 1], // non-final i16
    [0x4e, 2, 0x5e, 0x77, 1, 0x5e, 0x78, 1], // multi-type recursive group
  ]) {
    const recursive = arrayType[0] === 0x4e;
    for (const [name, parameters, results] of definitions.slice(11)) {
      const invalid = binary({
        types: [arrayType, signature(parameters, results)],
        imports: [named('wasm:js-string', name, 0, [recursive ? 2 : 1])],
      });
      assert.equal(WebAssembly.validate(invalid), true);
      assert.equal(WebAssembly.validate(invalid, options), false);
    }
  }
  const collision = binary({ types: [signature([EXTERNREF], [I32])],
    imports: [named('wasm:js-string', 'length', 0, [0])] });
  assert.equal(WebAssembly.validate(collision, {
    builtins: ['js-string'], importedStringConstants: 'wasm:js-string',
  }), false);
  for (const type of [[I32, 0], [EXTERNREF, 1], [0x72, 0]]) {
    const invalid = binary({ imports: [named(namespace, 'x', 3, type)] });
    assert.equal(WebAssembly.validate(invalid, options), false);
    assert.throws(() => new WebAssembly.Module(invalid, options), WebAssembly.CompileError);
  }
  for (const type of [EXTERNREF, E]) {
    const strings = binary({ imports: [named('', '', 3, [...(Array.isArray(type) ? type : [type]), 0])], exports: [exported('s', 3, 0)] });
    const m = new WebAssembly.Module(strings, { importedStringConstants: '' });
    assert.equal(new WebAssembly.Instance(m).exports.s.value, '');
  }
  // On the signed-char Node 24 reference platform, unsigned wire-name bytes
  // cannot match non-ASCII plain-char UTF8 option bytes. These remain ordinary
  // imports, including lossy surrogate conversion. Constant names/values inside
  // recognized ASCII namespaces still contain NUL and Unicode in this fixture.
  for (const [option, moduleName] of [
    ['constants\0\u2603', 'constants\0\u2603'], ['\u00e9', '\u00e9'],
    ['\ud83d\ude00', '\ud83d\ude00'], ['\ud800', '\ufffd'],
    ['\u00e9123', '\u00e912'], ['\u0100', '\0'],
  ]) {
    const source = binary({
      imports: [named(moduleName, constant, 3, [EXTERNREF, 0])],
      exports: [exported('s', 3, 0)],
    });
    const ordinary = new WebAssembly.Module(source, { importedStringConstants: option });
    assert.deepEqual(WebAssembly.Module.imports(ordinary),
      [{ module: moduleName, name: constant, kind: 'global' }]);
    const reads = [];
    const imported = new Proxy({}, { get(_target, key) {
      reads.push(key);
      return new Proxy({}, { get(_namespace, name) { reads.push(name); return 'provided'; } });
    } });
    assert.equal(new WebAssembly.Instance(ordinary, imported).exports.s.value, 'provided');
    assert.deepEqual(reads, [moduleName, constant]);
  }

  // Unknown names remain ordinary imports; duplicate namespaces are read once
  // per import in binary order, not cached or touched by recognized builtins.
  const order = [];
  const mixed = binary({ types: [signature([EXTERNREF], [I32]), signature([], [])],
    imports: [named('host', 'first', 0, [1]), named('wasm:js-string', 'length', 0, [0]),
      named(namespace, constant, 3, [EXTERNREF, 0]), named('wasm:js-string', 'unknown', 0, [1]),
      named('host', 'last', 0, [1])] });
  const mixedModule = new WebAssembly.Module(mixed, options);
  assert.deepEqual(WebAssembly.Module.imports(mixedModule).map(x => x.name), ['first', 'unknown', 'last']);
  const imports = new Proxy({}, { get(_target, key) {
    order.push(key);
    return new Proxy({}, { get(_object, name) { order.push(name); return () => {}; } });
  } });
  new WebAssembly.Instance(mixedModule, imports);
  assert.deepEqual(order, ['host', 'first', 'wasm:js-string', 'unknown', 'host', 'last']);
  const noCoercion = new WebAssembly.Module(mixed, { builtins: ['unknown', new String('js-string')], importedStringConstants: new String(namespace) });
  assert.equal(WebAssembly.Module.imports(noCoercion).length, 5);

  const worker = new Worker(__filename, { workerData: module });
  await new Promise((resolve, reject) => {
    let received = false;
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('compile-options worker timed out')); }, 15000);
    worker.on('message', cloned => { try { check(cloned); received = true; } catch (error) { reject(error); } });
    worker.on('error', reject);
    worker.on('exit', code => { clearTimeout(timer); code === 0 && received ? resolve() : reject(new Error('compile-options worker failed')); });
  });
  console.log('WebAssembly compile options smoke passed');
}
if (isMainThread) main().catch(error => { console.error(error); process.exitCode = 1; });
else { check(workerData); parentPort.postMessage(workerData); parentPort.close(); }
