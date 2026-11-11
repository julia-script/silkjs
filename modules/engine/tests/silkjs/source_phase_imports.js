// flags: -m
// SilkJS regression test: source phase imports (`import source x from 'y'`,
// `import.source(y)`) parse, and a module with no source object (every module of
// this host) fails them with a SyntaxError before the importer runs. `import
// source from 'y'` stays a default import named source. Also checks V8's text for
// an unbound name, "x is not defined".
import source from './source_phase_default_fixture.mjs';
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
let failed = 0;
const fail = (message) => { failed++; print('FAIL ' + message); };
if (source !== 7) fail('default import named source: ' + source);
try { await import.source('./source_phase_default_fixture.mjs'); fail('import.source resolved'); }
catch (e) { if (!(e instanceof SyntaxError) || !/Source phase import object is not defined for module/.test(e.message)) fail('import.source: ' + e); }
try { await import('./source_phase_static_fixture.mjs'); fail('static source import linked'); }
catch (e) { if (!(e instanceof SyntaxError) || !/Source phase import object is not defined for module/.test(e.message)) fail('static: ' + e); }
if (globalThis.sourcePhaseImporterRan) fail('importer of a missing source ran');
try { unboundName; fail('unbound name read'); }
catch (e) { if (!(e instanceof ReferenceError) || e.message !== 'unboundName is not defined') fail('reference message: ' + e.message); }
print(failed ? failed + ' failed' : 'all passed');
if (failed) throw new Error('source phase import regressions');
