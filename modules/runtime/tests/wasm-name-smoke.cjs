'use strict';
const assert = require('node:assert/strict');
const F = require('./wasm-fixtures.cjs');
const W = WebAssembly;

const moduleNames = ['host', 'host\0left', 'host\0right', '\uFEFFhost\0\u{1F642}'];
const fieldNames = ['call', 'call\0left', 'call\0right', '\uFEFFcall\0\u{1F642}'];
const exportNames = ['run', 'run\0left', 'run\0right', '\uFEFFrun\0\u{1F642}'];
const customNames = ['', '\0', 'meta', 'meta\0left', 'meta\0right', '\uFEFFmeta\0\u{1F642}'];
const custom = customNames.flatMap((name, i) => [[name, [i, 0, 255]], [name, [i, 1]]]);
const bytes = F.binary({
  types: [F.signature([], [F.I32])],
  imports: moduleNames.map((name, i) => F.named(name, fieldNames[i], 0, [0])),
  exports: exportNames.map((name, i) => F.exported(name, 0, i)),
  custom,
});
assert.equal(W.validate(bytes), true);
const compiled = new W.Module(bytes);
assert.deepEqual(W.Module.imports(compiled), moduleNames.map((name, i) => ({
  module: name, name: fieldNames[i], kind: 'function',
})));
assert.deepEqual(W.Module.exports(compiled), exportNames.map(name => ({ name, kind: 'function' })));
const accessed = [];
const imports = Object.create(null);
for (let i = 0; i < moduleNames.length; ++i) {
  const fields = Object.create(null);
  Object.defineProperty(fields, fieldNames[i], { get() {
    accessed.push(fieldNames[i]);
    return () => 40 + i;
  } });
  Object.defineProperty(imports, moduleNames[i], { get() {
    accessed.push(moduleNames[i]);
    return fields;
  } });
}
const instance = new W.Instance(compiled, imports);
assert.deepEqual(accessed, moduleNames.flatMap((name, i) => [name, fieldNames[i]]));
assert.deepEqual(Object.getOwnPropertyNames(instance.exports), exportNames);
for (let i = 0; i < exportNames.length; ++i) {
  assert.equal(instance.exports[exportNames[i]](), 40 + i);
}
assert.equal(Object.getPrototypeOf(instance.exports), null);
for (let i = 0; i < customNames.length; ++i) {
  const sections = W.Module.customSections(compiled, customNames[i]);
  assert.deepEqual(sections.map(section => [...new Uint8Array(section)]), [[i, 0, 255], [i, 1]]);
  new Uint8Array(sections[0])[0] = 128;
  assert.equal(new Uint8Array(W.Module.customSections(compiled, customNames[i])[0])[0], i);
}
assert.deepEqual(W.Module.customSections(compiled, 'meta\0missing'), []);

// A supplied prefix is never a substitute for the full import property name.
const required = new W.Module(F.binary({
  types: [F.signature([], [])],
  imports: [F.named('host\0private', 'call\0private', 0, [0])],
}));
assert.throws(() => new W.Instance(required, { host: { call() {} } }), TypeError);
assert.throws(() => new W.Instance(required, { 'host\0private': { call() {} } }), W.LinkError);
new W.Instance(required, { 'host\0private': { 'call\0private'() {} } });

// Mixed-kind import sorting must preserve source indices and resource identity.
const left = new W.Global({ value: 'i32', mutable: true }, 17);
const right = new W.Global({ value: 'i32', mutable: true }, 29);
const memory = new W.Memory({ initial: 1 });
const table = new W.Table({ element: 'anyfunc', initial: 1 });
const resources = new W.Module(F.binary({
  types: [F.signature([], [])],
  imports: [
    F.named('env\0', 'same\0left', 3, [F.I32, 1]),
    F.named('env\0', 'call\0', 0, [0]),
    F.named('env\0', 'memory\0', 2, [0, 1]),
    F.named('env\0', 'same\0right', 3, [F.I32, 1]),
    F.named('env\0', 'table\0', 1, [0x70, 0, 1]),
  ],
  exports: [F.exported('same\0left', 3, 0), F.exported('same\0right', 3, 1),
    F.exported('memory\0', 2, 0), F.exported('table\0', 1, 0)],
}));
assert.deepEqual(W.Module.imports(resources).map(entry => entry.name),
  ['same\0left', 'call\0', 'memory\0', 'same\0right', 'table\0']);
const bound = new W.Instance(resources, { 'env\0': {
  'same\0left': left, 'same\0right': right, 'call\0'() {}, 'memory\0': memory, 'table\0': table,
} }).exports;
assert.equal(bound['same\0left'], left);
assert.equal(bound['same\0right'], right);
assert.equal(bound['memory\0'], memory);
assert.equal(bound['table\0'], table);

// WAMR's legacy spectest resolver must not override private imports, even when
// the module name is exactly its reserved spelling or has a forged suffix.
for (const namespace of ['spectest', 'spectest\0private']) {
  const declared = F.binary({
    imports: [F.named(namespace, 'memory\0', 2, [1, 0, 1]),
      F.named(namespace, 'table\0', 1, [0x70, 1, 0, 1])],
    exports: [F.exported('memory', 2, 0), F.exported('table', 1, 0)],
  });
  assert.equal(W.validate(declared), true);
  const importedMemory = new W.Memory({ initial: 0, maximum: 1 });
  const importedTable = new W.Table({ element: 'anyfunc', initial: 0, maximum: 1 });
  const exported = new W.Instance(new W.Module(declared), {
    [namespace]: { 'memory\0': importedMemory, 'table\0': importedTable },
  }).exports;
  assert.equal(exported.memory, importedMemory);
  assert.equal(exported.table, importedTable);
}

// Exercise both stack and allocated duplicate-name sorting tables.
for (const count of [3, 40]) {
  const names = Array.from({ length: count }, (_, i) => 'shared\0' + i);
  const namedExports = values => F.binary({
    types: [F.signature([], [])], functions: [{ type: 0, body: [] }],
    exports: values.map(name => F.exported(name, 0, 0)),
  });
  assert.equal(W.validate(namedExports(names)), true);
  assert.deepEqual(W.Module.exports(new W.Module(namedExports(names))).map(entry => entry.name), names);
  names[count - 1] = names[0];
  assert.equal(W.validate(namedExports(names)), false);
  assert.throws(() => new W.Module(namedExports(names)), W.CompileError);
}

// A NUL suffix cannot forge WAMR's automatic initialization symbol.
new W.Instance(new W.Module(F.binary({
  types: [F.signature([], [])], functions: [{ type: 0, body: [0x00] }],
  exports: [F.exported('__post_instantiate\0not-a-hook', 0, 0)],
})));

// Name-subsection reflection must return pristine bytes, not interned C strings.
const functionNames = F.vector([[0, ...F.text('debug\0\u{1F642}')]]);
const namePayload = [1, ...F.unsigned(functionNames.length), ...functionNames];
const debugModule = new W.Module(F.binary({
  types: [F.signature([], [])], functions: [{ type: 0, body: [] }],
  exports: [F.exported('debug\0export', 0, 0)], custom: [['name', namePayload]],
}));
assert.deepEqual([...new Uint8Array(W.Module.customSections(debugModule, 'name')[0])], namePayload);
const debugFunction = new W.Instance(debugModule).exports['debug\0export'];
assert.equal(typeof debugFunction, 'function');
assert.equal(debugFunction.name, '0');

// Accept U+0000 but retain strict UTF-8 validation over the entire byte span.
const rawName = value => [...F.unsigned(value.length), ...value];
for (const invalid of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2], [0x80], [0, 0xff]]) {
  const malformed = [
    F.binary({ types: [F.signature([], [])], imports: [[...rawName(invalid), ...F.text('ok'), 0, 0]] }),
    F.binary({ types: [F.signature([], [])], imports: [[...F.text('ok'), ...rawName(invalid), 0, 0]] }),
    F.binary({ types: [F.signature([], [])], functions: [{ type: 0, body: [] }], exports: [[...rawName(invalid), 0, 0]] }),
  ];
  const payload = rawName(invalid);
  malformed.push(new Uint8Array([...F.binary(), 0, ...F.unsigned(payload.length), ...payload]));
  for (const binary of malformed) {
    assert.equal(W.validate(binary), false);
    assert.throws(() => new W.Module(binary), W.CompileError);
  }
}
console.log('wasm name smoke: ok');
