'use strict';

// Binary fixtures need no external assembler and run under either JS runtime.
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c, EXTERNREF = 0x6f;
function unsigned(value) {
  const bytes = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return bytes;
}
function vector(values) { return [...unsigned(values.length), ...values.flat()]; }
function text(value) { const bytes = [...new TextEncoder().encode(value)]; return [...unsigned(bytes.length), ...bytes]; }
function section(id, bytes) { return [id, ...unsigned(bytes.length), ...bytes]; }
function signature(parameters, results) { return [0x60, ...vector(parameters), ...vector(results)]; }
function named(module, name, kind, type) { return [...text(module), ...text(name), kind, ...type]; }
function exported(name, kind, index) { return [...text(name), kind, ...unsigned(index)]; }
function binary({ types = [], imports = [], functions = [], tables = [], memories = [], tags = [], globals = [], exports = [], start, custom = [] } = {}) {
  const sections = [];
  if (types.length) sections.push(section(1, vector(types)));
  if (imports.length) sections.push(section(2, vector(imports)));
  if (functions.length) sections.push(section(3, vector(functions.map(f => unsigned(f.type)))));
  if (tables.length) sections.push(section(4, vector(tables)));
  if (memories.length) sections.push(section(5, vector(memories)));
  if (tags.length) sections.push(section(13, vector(tags)));
  if (globals.length) sections.push(section(6, vector(globals)));
  if (exports.length) sections.push(section(7, vector(exports)));
  if (start !== undefined) sections.push(section(8, unsigned(start)));
  if (functions.length) sections.push(section(10, vector(functions.map(f => {
    const body = [...vector(f.locals || []), ...f.body, 0x0b];
    return [...unsigned(body.length), ...body];
  }))));
  for (const [name, bytes] of custom) sections.push(section(0, [...text(name), ...bytes]));
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
}
function echo(type = I32) {
  return binary({
    types: [signature([type], [type])],
    imports: [named('host', 'call', 0, [0])],
    functions: [{ type: 0, body: [0x20, 0, 0x10, 0] }],
    exports: [exported('run', 0, 1)],
    custom: [['silk-smoke', [1, 3, 5, 7]], ['silk-smoke', [2, 4]]],
  });
}
function growth(shared = false) {
  return binary({
    types: [signature([], []), signature([I32], [I32])],
    imports: [named('host', 'after', 0, [0]), named('host', 'memory', 2, [shared ? 3 : 1, 1, 2])],
    functions: [{ type: 1, body: [0x20, 0, 0x40, 0, 0x10, 0] }],
    exports: [exported('grow', 0, 1), exported('memory', 2, 0)],
  });
}
function concurrent() {
  return binary({
    types: [signature([I32], [I32]), signature([], [I32])],
    imports: [named('host', 'wait', 0, [0]), named('host', 'counter', 3, [I32, 1])],
    functions: [
      { type: 0, body: [0x20, 0, 0x10, 0, 0x23, 0, 0x6a] },
      { type: 1, body: [0x23, 0] },
    ],
    exports: [exported('run', 0, 1), exported('inspect', 0, 2)],
  });
}
function atomic() {
  return binary({
    types: [signature([], [I32])],
    imports: [named('host', 'memory', 2, [3, 1, 2])],
    functions: [{ type: 0, body: [0x41, 0, 0x41, 1, 0xfe, 0x1e, 2, 0] }],
    exports: [exported('bump', 0, 0), exported('memory', 2, 0)],
  });
}
module.exports = { I32, I64, F32, F64, EXTERNREF, unsigned, vector, text, signature, named, exported, binary, echo, growth, concurrent, atomic };
