'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync, spawn } = require('node:child_process');
const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-module-cache-')));
const cache = path.join(root, 'cache');
const env = { ...process.env, NODE_COMPILE_CACHE: cache };
delete env.NODE_DISABLE_COMPILE_CACHE; delete env.NODE_OPTIONS; delete env.NODE_COMPILE_CACHE_PORTABLE;
const file = (name, source) => fs.writeFileSync(path.join(root, name), source);
function run(args, extra = {}) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, ...extra });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, JSON.stringify({ args, ...result }));
  return result.stdout.trim();
}
function entries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name));
}
// Cache files use Node's layout: five little-endian words (magic, code size,
// cache size, code hash, cache hash; crc32) and then the cache bytes.
const kHeader = 20;
const isCacheFile = bytes => bytes.length >= kHeader && bytes.readUInt32LE(0) === 0x8adfdbb2;
const rehash = bytes => bytes.writeUInt32LE(zlib.crc32(bytes.subarray(kHeader)), 16);
// A semantic witness, not timing or telemetry: change one valid serialized string
// constant, leaving source and identity intact. Warm execution MUST use that value.
// Only Silk's bytecode is changed; Node still exercises the public contract below.
function witness(directory, from, to) {
  assert.equal(from.length, to.length);
  let count = 0;
  for (const filename of entries(directory)) {
    const bytes = fs.readFileSync(filename);
    if (!isCacheFile(bytes)) continue;
    const payload = bytes.subarray(kHeader);
    const wireLength = Number(payload.readBigUInt64LE(payload.length - 24));
    const wire = payload.subarray(0, wireLength);
    const at = wire.indexOf(from);
    if (at < 0) continue;
    Buffer.from(to).copy(wire, at);
    rehash(bytes);
    fs.writeFileSync(filename, bytes); count++;
  }
  return count;
}
async function main() {
  const disabledEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: '' };
  assert.equal(run(['-e', `const m=require('module');console.log(JSON.stringify([m.getCompileCacheDir(),m.enableCompileCache()]));`], { env: disabledEnv }), '[null,{"status":3,"message":"Disabled by NODE_DISABLE_COMPILE_CACHE"}]');
  const apiEnv = { ...env }; delete apiEnv.NODE_COMPILE_CACHE;
  const api = JSON.parse(run(['-e', `const m=require('module'),p=require('path');const errors=[];for(const x of [null,3,true,{directory:3}])try{m.enableCompileCache(x)}catch(e){errors.push([e.name,e.code,e.message])};for(const x of [null,3])try{m.flushCompileCache(x)}catch(e){errors.push([e.name,e.code,e.message])};const failed=m.enableCompileCache('/dev/null/cache');const first=m.enableCompileCache({directory:${JSON.stringify(cache)},portable:7});const dir=m.getCompileCacheDir();const second=m.enableCompileCache('ignored');console.log(JSON.stringify({errors,failed,first,second,dir,constants:m.constants,frozen:Object.isFrozen(m.constants)&&Object.isFrozen(m.constants.compileCacheStatus),nullProto:Object.getPrototypeOf(m.constants)===null,flush:m.flushCompileCache(true)===undefined}));`], { env: apiEnv }));
  assert.equal(api.errors.length, 6);
  assert.deepEqual(api.errors[0], ['TypeError', 'ERR_INVALID_ARG_TYPE', 'cacheDir should be a string']);
  assert.deepEqual(api.errors[4], ['TypeError', 'ERR_INVALID_ARG_TYPE', 'keepDeserializedCache should be a boolean']);
  assert.deepEqual(api.failed, { status: 0, message: 'Cannot create cache directory: not a directory' });
  assert.deepEqual(api.first, { status: 1, directory: cache });
  assert.deepEqual(api.second, { status: 2, directory: api.dir });
  assert.deepEqual(api.constants.compileCacheStatus, { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 });
  assert.ok(api.frozen && api.nullProto && api.flush);
  file('dep.cjs', `module.exports={value:'CJS_COLD_MARKER',filename:__filename,closure:()=>41};`);
  file('dep.mjs', `import leaf from './leaf.mjs';export const value='ESM_COLD_MARKER';export const url=import.meta.url;export const lazy=()=>import('./lazy.mjs');export const closure=()=>leaf;`);
  file('leaf.mjs', `export default 42;`);
  file('lazy.mjs', `export default 43;`);
  file('main.cjs', `const c=require('./dep.cjs');import('./dep.mjs').then(async e=>{console.log(JSON.stringify([c.value,e.value,c.filename,e.url,c.closure(),e.closure(),(await e.lazy()).default]));});`);
  const cold = JSON.parse(run(['main.cjs']));
  assert.deepEqual(cold.slice(0, 2), ['CJS_COLD_MARKER', 'ESM_COLD_MARKER']);
  assert.deepEqual(JSON.parse(run(['main.cjs'])), cold);
  file('entry.mjs', `import * as dep from './dep.mjs';await Promise.resolve();console.log(JSON.stringify([import.meta.main,dep.closure(),(await dep.lazy()).default]));`);
  assert.deepEqual(JSON.parse(run(['entry.mjs'])), [true, 42, 43]);
  assert.deepEqual(JSON.parse(run(['entry.mjs'])), [true, 42, 43]);
  const directory = run(['-e', `console.log(require('module').getCompileCacheDir())`]);
  assert.ok(entries(directory).length >= 4);
  const cjsWitness = witness(directory, 'CJS_COLD_MARKER', 'CJS_WARM_MARKER');
  const esmWitness = witness(directory, 'ESM_COLD_MARKER', 'ESM_WARM_MARKER');
  const silk = run(['-p', "'silkjsruntime' in process.versions"]) === 'true';
  if (silk) {
    assert.ok(cjsWitness && esmWitness, 'both bytecode kinds must be persisted');
    const warm = JSON.parse(run(['main.cjs']));
    assert.deepEqual(warm, ['CJS_WARM_MARKER', 'ESM_WARM_MARKER', ...cold.slice(2)], 'must execute deserialized code, not recompile source');
    // Like Node, the key is the file name and code type, not the CLI options.
    assert.deepEqual(JSON.parse(run(['--no-warnings', 'main.cjs'])).slice(0, 2), ['CJS_WARM_MARKER', 'ESM_WARM_MARKER']);
    // Recompute outer integrity after damaging native metadata: this reaches
    // decoder/restore rollback, including the ESM context-list ownership edge.
    for (const filename of entries(directory)) {
      const bytes = fs.readFileSync(filename);
      if (!isCacheFile(bytes)) continue;
      const payload = bytes.subarray(kHeader);
      payload[Number(payload.readBigUInt64LE(payload.length - 24))] = 255;
      rehash(bytes);
      fs.writeFileSync(filename, bytes);
    }
    assert.deepEqual(JSON.parse(run(['main.cjs'])), cold);
    // A header that no longer matches falls back to the real source compiler.
    for (const filename of entries(directory)) {
      const bytes = fs.readFileSync(filename); if (isCacheFile(bytes)) { bytes[16] ^= 1; fs.writeFileSync(filename, bytes); }
    }
    assert.deepEqual(JSON.parse(run(['main.cjs'])), cold);
    for (const filename of entries(directory)) fs.writeFileSync(filename, Buffer.from('truncated'));
    assert.deepEqual(JSON.parse(run(['main.cjs'])), cold);
  }
  file('dep.cjs', `module.exports={value:'CJS_EDIT_MARKER',filename:__filename,closure:()=>41};`);
  assert.equal(JSON.parse(run(['main.cjs']))[0], 'CJS_EDIT_MARKER');
  file('policy.cjs', `const m=require('module'),fs=require('fs'),vm=require('vm');const dir=m.getCompileCacheDir();m.flushCompileCache();const count=()=>fs.readdirSync(dir).filter(x=>!x.startsWith('.')).length;const before=count();require('http');new vm.Script('11+12',{filename:'/tmp/module-cache-vm.js'}).runInThisContext();m.flushCompileCache();const vmCount=count();const virtual=new m.Module('/virtual/cache.cjs');virtual._compile('module.exports=3','/virtual/cache.cjs');import('data:text/javascript,export default 4').then(()=>{m.flushCompileCache();console.log(JSON.stringify([before===vmCount,count()>vmCount]));});`);
  assert.deepEqual(JSON.parse(run(['policy.cjs'])), [true, true]);
  // Warm script IDs belong to this compilation, not the cache producer. Source
  // maps/source text remain attached to the new tree rather than a live closure.
  file('mapped.cjs', `module.exports=()=>new Error('mapped');\n//# sourceMappingURL=data:application/json;base64,` +
    Buffer.from(JSON.stringify({ version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' })).toString('base64'));
  file('metadata.cjs', `const m=require('module'),u=require('util'),vm=require('vm');if(process.argv.includes('pad'))for(let i=0;i<40;i++)new vm.Script('0',{filename:'metadata-padding-'+i}).runInThisContext();const source='module.exports=()=>require("util").getCallSites(1,{sourceMap:false})[0]';const name=require('path').resolve('virtual.cjs');const a=new m.Module(name);a.paths=m._nodeModulePaths(process.cwd());a._compile(source,name);const x=a.exports();const mapped=require('./mapped.cjs')();console.log(JSON.stringify([x.scriptId,x.scriptName===name,x.lineNumber===1,/original.ts:1:1/.test(mapped.stack)]));`);
  const originalMetadata = JSON.parse(run(['--enable-source-maps', 'metadata.cjs']));
  const warmMetadata = JSON.parse(run(['--enable-source-maps', 'metadata.cjs', 'pad']));
  assert.deepEqual(originalMetadata.slice(1), [true, true, true]);
  assert.deepEqual(warmMetadata.slice(1), [true, true, true]);
  assert.notEqual(warmMetadata[0], originalMetadata[0]);
  // All isolates race for the same final files. No final name may be partial.
  file('worker.cjs', `require('./dep.cjs');import('./dep.mjs');`);
  file('workers.cjs', `const {Worker}=require('worker_threads');for(let i=0;i<4;i++){const w=new Worker(require('path').resolve('worker.cjs'));w.on('error',e=>{throw e});w.on('exit',c=>{if(c)process.exitCode=c});}`);
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(executable, ['workers.cjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(JSON.parse(run(['main.cjs']))[0], 'CJS_EDIT_MARKER');
  assert.equal(fs.readdirSync(directory).some(name => /\.[A-Za-z0-9]{6}$/.test(name)), false);
  // Portable keys and debug/module identities must relocate together.
  const portable = { ...env, NODE_COMPILE_CACHE_PORTABLE: '1' };
  run(['main.cjs'], { env: portable });
  if (silk) { witness(directory, 'CJS_EDIT_MARKER', 'CJS_MOVE_MARKER'); witness(directory, 'ESM_COLD_MARKER', 'ESM_MOVE_MARKER'); }
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  try {
    const relocated = JSON.parse(run(['main.cjs'], { cwd: moved, env: { ...portable, NODE_COMPILE_CACHE: path.join(moved, 'cache') } }));
    assert.equal(relocated[0], silk ? 'CJS_MOVE_MARKER' : 'CJS_EDIT_MARKER');
    assert.equal(relocated[1], silk ? 'ESM_MOVE_MARKER' : 'ESM_COLD_MARKER');
    assert.equal(relocated[2], path.join(moved, 'dep.cjs'));
    assert.ok(relocated[3].endsWith('/' + path.basename(moved) + '/dep.mjs'));
    assert.equal(relocated[6], 43);
  } finally { fs.renameSync(moved, root); }
  // Unwritable cache initialization must not prevent source execution.
  assert.equal(JSON.parse(run(['main.cjs'], { env: { ...env, NODE_COMPILE_CACHE: '/dev/null/cache' } }))[0], 'CJS_EDIT_MARKER');
  file('io-failure.cjs', `const fs=require('fs'),m=require('module');fs.rmSync(m.getCompileCacheDir(),{recursive:true,force:true});require('./dep.cjs');m.flushCompileCache();console.log('survived');`);
  assert.equal(run(['io-failure.cjs']), 'survived');
  console.log('module compile cache smoke: passed' + (silk ? ' (CJS/ESM deserialization witnessed)' : ' (Node oracle public contracts)'));
}
main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
