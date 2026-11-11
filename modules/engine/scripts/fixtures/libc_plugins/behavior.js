// Prefix this body with `import * as p from '<plugin>';`.
// The same assertions run against the native Silk plugin and a separate C oracle.
function assert(ok, label) { if (!ok) throw Error(label); }
assert(p.version === 1, 'evaluated native value export');
assert(p.add.length === 2 && p.add.name === 'add', 'native function descriptors');
assert(p.add(19, 23) === 42, 'native arithmetic');
assert(Object.is(p.add(-0, -0), -0), 'negative zero');
assert(Number.isNaN(p.add(NaN, 1)), 'NaN');
let order = '';
assert(p.add({ valueOf() { order += 'a'; return 20; } },
             { valueOf() { order += 'b'; return 22; } }) === 42 && order === 'ab', 'coercion order');
const object = {}, symbol = Symbol('native'), bigint = 2n ** 100n;
for (const value of [object, symbol, bigint, null, undefined, -0, NaN])
    assert(Object.is(p.identity(value), value), 'identity-preserving handles');
const receiver = { answer: 42 };
const proxy = new Proxy(receiver, { get(target, key, self) {
    assert(self === proxy, 'get receiver'); return target[key];
} });
assert(p.get(proxy, 'answer') === 42, 'native get');
const slot = {};
assert(p.set(slot, symbol, object) === true && slot[symbol] === object, 'symbol set');
let setterReceiver;
Object.defineProperty(slot, 'x', { set(value) { setterReceiver = this; assert(value === 42, 'setter value'); } });
p.set(slot, 'x', 42);
assert(setterReceiver === slot, 'setter receiver');
let frozen = false;
try { p.set(Object.freeze({}), 'x', 1); } catch (error) { frozen = error instanceof TypeError; }
assert(frozen, 'strict set failure');
const marker = {};
try { p.get({ get x() { throw marker; } }, 'x'); throw Error('missing getter exception'); }
catch (error) { assert(error === marker, 'getter exception identity'); }
assert(p.invoke(function (value) { assert(this === receiver, 'call receiver'); return value; }, receiver, object) === object,
       'native call identity');
assert(p.invoke(x => p.add(x, 1), null, 41) === 42, 'synchronous native reentry');
try { p.throwValue(marker); throw Error('missing native throw'); }
catch (error) { assert(error === marker, 'native throw identity'); }
assert(p.evaluate('({ answer: 42 })').answer === 42, 'native eval');
assert(p.invoke(p.evaluate('(x => x * 2)'), undefined, 21) === 42, 'eval returns callable');
let syntax = false;
try { p.evaluate('let ='); } catch (error) { syntax = error instanceof SyntaxError; }
assert(syntax, 'eval exception');
assert(p.text({ toString() { return 'silk\0native'; } }) === 'silk\0native', 'UTF8 with embedded NUL');
assert(p.utf16('\ud800A\udfff') === '\ud800A\udfff', 'lossless lone surrogates');
print('plugin behavior ok');
