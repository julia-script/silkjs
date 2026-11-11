import value from './data.json' with { type: 'unrecognized-but-allowed' };
import same from './data.json' with { type: 'json' };
import extended from './extended.data' with { type: 'json5' };
import { answer, metadata } from './cycle-a.mjs';
import { ready } from './await.mjs';
function assert(value, name) { if (!value) throw Error(name); }
assert(value === same, 'JSON module identity');
assert(value.answer === 40 && value.__proto__.safe === true, 'JSON data properties');
assert(Object.getPrototypeOf(value) === Object.prototype, 'JSON prototype');
assert(extended.extra === 2 && Object.is(extended.zero, -0), 'JSON5 values');
assert(answer() === 42 && ready === 7, 'cycles and top-level await');
const descriptor = Object.getOwnPropertyDescriptor(import.meta, 'url');
assert(Object.getPrototypeOf(import.meta) === null, 'import.meta prototype');
assert(descriptor.writable && descriptor.enumerable && descriptor.configurable, 'import.meta attributes');
assert(import.meta.main === true && metadata.main === false, 'import.meta main');
assert(import.meta.url.startsWith('file://') && import.meta.url.endsWith('/main.mjs'), 'import.meta root URL');
assert(metadata.url.startsWith('file://') && metadata.url.endsWith('/cycle-a.mjs'), 'import.meta dependency URL');
const dynamic = await import('./dynamic.mjs', { with: { type: 'javascript' } });
assert(dynamic.value === 19, 'dynamic module');
let rejected = false;
try { await import('./dynamic.mjs', { with: { unsupported: 'json' } }); }
catch (error) { rejected = error instanceof TypeError; }
assert(rejected, 'unsupported attribute key');
print('modules:42:7:19:json5');
