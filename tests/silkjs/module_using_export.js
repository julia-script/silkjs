// flags: -m
// SilkJS regression test: a module-level `using` binding can be exported and is
// disposed once the module body finishes (test262
// language/statements/using/initializer-disposed-at-end-of-imported-module.js).
// SilkJS used to fail to link: "exported variable 'resource' does not exist".
import { disposed, resource, readResource } from './module_using_export_fixture.mjs';
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
let failed = 0;
if (!disposed) { failed++; print('FAIL resource not disposed'); }
if (resource.name !== 'r' || readResource() !== resource) { failed++; print('FAIL export binding'); }
try { resource = 1; failed++; print('FAIL import assignable'); } catch (e) { if (!(e instanceof TypeError)) { failed++; print('FAIL ' + e); } }
print(failed ? failed + ' failed' : 'all passed');
if (failed) throw new Error('module using export regressions');
