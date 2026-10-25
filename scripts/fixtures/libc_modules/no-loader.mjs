import data from './data.json';
if (data.answer !== 40) throw Error('bundled static JSON unavailable');
let rejected = false;
try { await import('./external.mjs'); }
catch (error) { rejected = error instanceof ReferenceError; }
if (!rejected) throw Error('disabled filesystem module loader was used');
print('bundle-only:40');
