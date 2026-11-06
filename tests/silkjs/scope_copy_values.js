// Scope entry and promotion must preserve every value kind and own heap values.
function check(actual, expected) {
  if (actual !== expected) throw new Error('expected ' + String(expected) + ', got ' + String(actual));
}
function captured(a, b, c, d, e, f, g, h, i) {
  var unset;
  let lexical = 'lexical';
  const saved = () => [a, b, c, d, e, f, g, h, i, unset, lexical];
  return saved;
}
const object = { marker: 42 };
const symbol = Symbol('scope');
const values = [object, 'heap string ' + 123, 9007199254740993n, symbol, null, undefined, -0, NaN, 1.25];
for (let n = 0; n < 500; n++) {
  const read = captured(...values);
  const out = read();
  for (let j = 0; j < values.length; j++) check(Object.is(out[j], values[j]), true);
  check(out[9], undefined);
  check(out[10], 'lexical');
  const missing = captured(object)();
  check(missing[0], object);
  for (let j = 1; j < 10; j++) check(missing[j], undefined);
}
function nested(value) {
  let own = { value };
  return function (offset) {
    let local = { offset };
    return () => own.value + local.offset;
  };
}
const first = nested(10), second = nested(100);
check(first(2)(), 12);
check(second(3)(), 103);
check(first(4)(), 14);
function temporal() {
  const read = () => lexical;
  let threw = false;
  try { read(); } catch (e) { threw = e instanceof ReferenceError; }
  let lexical = 7;
  check(threw, true);
  return read;
}
check(temporal()(), 7);
console.log('PASS scope copy values');
