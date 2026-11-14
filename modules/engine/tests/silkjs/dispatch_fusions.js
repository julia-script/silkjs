// Fusions picked from HTTP and Express dispatch pairs, and the cold opcodes
// that moved behind OP_extended to make room for them: every shape must keep
// the unfused semantics, including values that need releasing.
const r = [];
function check(label, got, want) { if (!Object.is(got, want)) r.push(label + ': ' + got + ' !== ' + want); }

// Keep branches: `x || y`, `x && y`, `x ?? y` as values and as statements.
const values = [0, 1, -0, NaN, '', 'a', null, undefined, false, true, 0n, 1n, {}, [], Symbol.iterator];
function or(x, y) { return x || y; }
function and(x, y) { return x && y; }
function nullish(x, y) { return x ?? y; }
let side = 0;
function touch() { side++; return 'y'; }
for (const v of values) {
  check('or ' + String(v), or(v, 'y'), v ? v : 'y');
  check('and ' + String(v), and(v, 'y'), v ? 'y' : v);
  check('nullish ' + String(v), nullish(v, 'y'), v === null || v === undefined ? 'y' : v);
  side = 0; v || touch(); check('or effect ' + String(v), side, v ? 0 : 1);
  side = 0; v && touch(); check('and effect ' + String(v), side, v ? 1 : 0);
  side = 0; v ?? touch(); check('nullish effect ' + String(v), side, v === null || v === undefined ? 1 : 0);
}
// Fresh strings and objects on both edges (the dropped value must be released).
let text = '';
for (let i = 0; i < 2000; i++) {
  const s = (i & 1 ? 'x' : '') + i;
  text = (s || 'none') + (s && '.') + ((i & 3 ? null : s) ?? '-');
}
check('strings', text, 'x1999.-');
const chain = { a: { b: null } };
check('chains', (chain.a && chain.a.b) ?? (chain.c || 'dflt'), 'dflt');
check('nested', (0 || (null ?? (false && 1))), false);
// A label right after the branch (the drop is a jump target) leaves it unfused.
function labelled(x) { let out = 0; for (let i = 0; i < 3; i++) { if (x || i) { out++; } } return out; }
check('labelled', labelled(0) + labelled(1), 5);

// typeof x === 'name' for every name, negated and branching.
const typed = [1, 1.5, 'a', true, null, undefined, {}, [], () => 1, Symbol('s'), 10n, class {}];
for (const v of typed) {
  const t = typeof v;
  check('string ' + t, typeof v === 'string', t === 'string');
  check('number ' + t, typeof v == 'number', t === 'number');
  check('object ' + t, typeof v === 'object', t === 'object');
  check('boolean ' + t, typeof v !== 'boolean', t !== 'boolean');
  check('symbol ' + t, typeof v === 'symbol', t === 'symbol');
  check('bigint ' + t, typeof v != 'bigint', t !== 'bigint');
  let branch = 'n'; if (typeof v !== 'string') { branch = 'y'; }
  check('branch ' + t, branch, t !== 'string' ? 'y' : 'n');
  let count = 0; if (typeof v === 'object') { count++; }
  check('if ' + t, count, t === 'object' ? 1 : 0);
}
check('typeof html-less object', typeof Object(1n) === 'object', true);

// x === k and x !== k for small Int k.
const numbers = [0, -0, 1, -1, 127, -128, 128, 0.5, NaN, Infinity, '0', '1', 0n, 1n, false, true, null, undefined, [0], { valueOf() { return 1; } }];
for (const v of numbers) {
  check('eq0 ' + String(v), v === 0, Object.is(v, 0) || Object.is(v, -0));
  check('neq1 ' + String(v), v !== 1, !(typeof v === 'number' && v == 1));
  check('eqm1 ' + String(v), v === -1, typeof v === 'number' && v == -1);
  check('eq127 ' + String(v), v === 127, typeof v === 'number' && v == 127);
  check('neqm128 ' + String(v), v !== -128, !(typeof v === 'number' && v == -128));
  let hit = 0; if (v === 0) { hit = 1; } else if (v !== 1) { hit = 2; }
  check('branch ' + String(v), hit, typeof v === 'number' && v == 0 ? 1 : typeof v === 'number' && v == 1 ? 0 : 2);
}
let found = 0;
for (let i = -200; i < 200; i++) { if ((i & 7) === 3) found++; if (i % 5 !== 0) found += 2; }
check('loop compares', found, 50 + 640);
check('fresh strings', ['1', 'x'].map((s) => (s + '') === 1).join(), 'false,false');

// this[kState]: a closure variable as an element key.
const kState = Symbol('kState');
const kIndex = 2;
class Holder {
  constructor() { this[kState] = { n: 1 }; this[kIndex] = 'two'; }
  get state() { return this[kState]; }
  get second() { return this[kIndex]; }
  bump() { this[kState].n++; return this[kState].n; }
}
const h = new Holder();
check('symbol key', h.state.n, 1);
check('int key', h.second, 'two');
check('symbol write through', h.bump() + h.bump(), 5);
const proto = { get [kState]() { return 'getter'; } };
check('getter key', Holder.prototype.__lookupGetter__('state').call(Object.create(proto)), 'getter');
check('string receiver', (function () { const k = 1; return () => 'abc'[k]; })()(), 'b');
check('uninitialized key', (() => { try { (() => { const f = () => ({})[late]; f(); })(); } catch (e) { return e.name; } return 'none'; })(), 'ReferenceError');
function dead() { const read = () => ({ x: 1 })[late]; let r1; try { r1 = read(); } catch (e) { r1 = e.name; } let late = 'x'; return r1 + '/' + read(); }
check('dead zone then live', dead(), 'ReferenceError/1');
const arr = [10, 20, 30];
check('array receiver', (() => { const i = 1; return () => arr[i]; })()(), 20);
check('undefined receiver', (() => { const k = 'x'; return () => { try { return undefined[k]; } catch (e) { return e.name; } }; })()(), 'TypeError');

// Opcodes behind OP_extended: super property updates (dup3, perm5, swap2, rot4l,
// rot5l, get/put_super_value), private brands (check_brand), using declarations.
class Base { constructor() { this.v = 1; } get p() { return this.v; } set p(x) { this.v = x; } }
class Derived extends Base {
  bump() { super.p += 2; return super.p; }
  post() { const old = super.p++; return old + ':' + super.p; }
  keyed(k) { super[k] = 7; super[k] *= 3; return super[k]; }
  keyedPost(k) { return super[k]++ + ':' + super[k]; }
  #secret() { return 'private'; }
  reveal() { return this.#secret(); }
  static isDerived(o) { try { return Derived.prototype.reveal.call(o); } catch (e) { return e.name; } }
}
const d = new Derived();
check('super +=', d.bump(), 3);
check('super ++', d.post(), '3:4');
check('super [k]', d.keyed('p'), 21);
check('super [k]++', d.keyedPost('p'), '21:22');
check('brand ok', Derived.isDerived(d), 'private');
check('brand miss', Derived.isDerived({}), 'TypeError');
const log = [];
{
  using a = { [Symbol.dispose]() { log.push('a'); } };
  using b = { [Symbol.dispose]() { log.push('b'); } };
  log.push('body');
}
check('using', log.join(), 'body,b,a');
try {
  using c = { [Symbol.dispose]() { throw new Error('dispose'); } };
  throw new Error('body');
} catch (e) { check('using suppressed', e.constructor.name + ':' + e.error.message + ':' + e.suppressed.message, 'SuppressedError:dispose:body'); }

console.log(r.length ? 'FAIL\n' + r.join('\n') : 'PASS dispatch fusions');
if (r.length) throw new Error('dispatch fusion regressions');
