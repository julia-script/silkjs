// Native ABI resource checks; not claimed as QuickJS C ABI behavior.
function check(ok, label) { if (!ok) throw Error(label); }
check(p.next() === 1 && p.next() === 2, 'persistent descriptor state');
check(p.active() === 1, 'no abandoned invocation');
check(p.invoke(() => p.active(), null, null) === 2, 'nested invocation ownership');
const thrown = {};
let before = p.finished();
try { p.add({ valueOf() { throw thrown; } }, 2); throw Error('missing coercion failure'); }
catch (error) { check(error === thrown, 'coercion failure ownership'); }
check(p.finished() - before === 2, 'finish on coercion exception');
check(p.active() === 1, 'coercion scope reclaimed');
before = p.finished();
try { p.evaluate('function {'); } catch (_) {}
check(p.finished() - before === 2, 'finish on eval exception');
check(p.active() === 1, 'eval scope reclaimed');
const escaped = p.identity(p.add);
globalThis.escapedPluginFunction = escaped;
std.gc();
check(escaped(40, 2) === 42, 'escaped callback remains loaded');
print('plugin lifecycle ok');
