'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-module-hooks-')));
function file(name, source) { fs.writeFileSync(path.join(root, name), source); }
function run(name, status = 0, output = 'ok', flags = []) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(executable, [...flags, name], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, status, JSON.stringify({ name, ...result }));
  assert.equal(result.stdout.trim(), output);
}
try {
  file('sync.cjs', `
    const assert=require('node:assert/strict');
    const {registerHooks,createRequire}=require('node:module');
    const {pathToFileURL}=require('node:url');
    const fs=require('node:fs');
    const ownRequire=createRequire(__filename);
    const events=[];
    const base=registerHooks({
      resolve(s,c,next){
        if(s.startsWith('fixture:')){
          events.push('base-resolve');
          assert.ok(c.conditions.includes('node'));
          assert.equal(typeof c.parentURL,'string');
          return {url:s,format:s.includes('cjs')?'commonjs':'module',shortCircuit:true};
        }
        return next(s,c);
      },
      load(u,c,next){
        if(u.startsWith('fixture:')){
          events.push('base-load');
          if(u==='fixture:attributes') assert.equal(c.importAttributes.custom,'yes');
          return {format:c.format,source:c.format==='commonjs'?'exports.value="base"':'export const value="base"',shortCircuit:true};
        }
        return next(u,c);
      }
    });
    const middle=registerHooks({load(u,c,next){const out=next(u,c);if(u.startsWith('fixture:')){events.push('middle');return {...out,source:String(out.source).replace('base','base-middle')}}return out;}});
    const outer=registerHooks({
      resolve(s,c,next){if(s.startsWith('fixture:'))events.push('outer-resolve');return next(s,c)},
      load(u,c,next){const out=next(u,c);if(u.startsWith('fixture:')){events.push('outer');return {...out,source:new TextEncoder().encode(String(out.source).replace('base-middle','base-middle-outer'))}}return out;}
    });
    assert.equal(require('fixture:cjs').value,'base-middle-outer');
    assert.deepEqual(events,['outer-resolve','base-resolve','base-load','middle','outer']);
    assert.equal(ownRequire('fixture:cjs-create').value,'base-middle-outer');
    assert.equal(require.resolve('fixture:cjs'),'fixture:cjs');
    assert.equal(require('node:fs'),fs);
    require.cache.fs={exports:{cached:true}};
    assert.equal(require('fs').cached,true);
    const redirect=registerHooks({resolve(s,c,next){return next(s==='fs'?'fixture:cjs-cache':s,c)}});
    assert.equal(require('fs').value,'base-middle-outer');
    assert.equal(require('node:fs'),fs);
    redirect.deregister();delete require.cache.fs;
    middle.deregister();middle.deregister();
    assert.equal(ownRequire('fixture:cjs-after').value,'base');
    assert.equal(require('fixture:cjs').value,'base-middle-outer');
    (async()=>{
      assert.equal((await import('fixture:esm')).value,'base');
      assert.equal((await import('fixture:attributes',{with:{custom:'yes'}})).value,'base');
      outer.deregister();base.deregister();
      assert.throws(()=>require('fixture:new'),{code:'MODULE_NOT_FOUND'});
      const invalid=registerHooks({resolve(){return {url:'fixture:broken',format:'module'}}});
      assert.throws(()=>require('fixture:broken'),{code:'ERR_INVALID_RETURN_PROPERTY_VALUE'});
      invalid.deregister();
      const nextType=registerHooks({resolve(s,c,next){return next(123,c)}});
      assert.throws(()=>require('anything'),{code:'ERR_INVALID_ARG_TYPE'});nextType.deregister();
      const badSource=registerHooks({resolve(){return {url:'fixture:bad-source',format:'module',shortCircuit:true}},load(){return {format:'module',source:17,shortCircuit:true}}});
      await assert.rejects(import('fixture:bad-source'),{code:'ERR_INVALID_RETURN_PROPERTY_VALUE'});badSource.deregister();
      console.log('ok');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `);
  run('sync.cjs');

  file('payload.txt', 'from-io');
  file('async-child.cjs', 'exports.value="disk-child";');
  file('hook-dependency.cjs', 'exports.suffix=require("./hook-leaf.cjs").suffix;');
  file('hook-leaf.cjs', 'exports.suffix="-disk";');
  file('async-hooks.mjs', `
    import {readFile} from 'node:fs/promises';
    import {isMainThread,isInternalThread} from 'node:worker_threads';
    let seed;
    export async function initialize({port,buffer}) {
      if(isMainThread || !isInternalThread) throw Error('hooks are not isolated');
      globalThis.hookOnly=true;
      seed=(await readFile(new URL('./payload.txt',import.meta.url),'utf8'))+'-'+new Uint8Array(buffer)[0];
      port.postMessage(seed);port.close();
    }
    export async function resolve(s,c,next) {
      if(s==='late-hooks')return {url:'fixture:late-hooks',format:'module',shortCircuit:true};
      if(s==='hook-dependency')return next(new URL('./hook-dependency.cjs',import.meta.url).href,c);
      if(s.startsWith('fixture:'))return {url:s,format:s.includes('cjs')?'commonjs':'module',shortCircuit:true};
      return next(s,c);
    }
    export async function load(u,c,next) {
      if(u==='fixture:late-hooks')return {format:'module',shortCircuit:true,source:
        'import {suffix} from "hook-dependency"; export async function load(u,c,next){const out=await next(u,c);if(u==="fixture:async")return {...out,source:String(out.source).replace("from-io", "from-io"+suffix)};return out}'};
      if(u.endsWith('/hook-leaf.cjs'))return {format:'commonjs',source:'exports.suffix="-later"',shortCircuit:true};
      if(u.endsWith('/async-child.cjs'))return {format:'commonjs',source:'exports.value="hook-child"',shortCircuit:true};
      if(u==='fixture:reject'){const error=new Error('hook failure');error.code='HOOK_FAILURE';throw error;}
      if(u==='fixture:incomplete')return {format:'module',source:'export default 0'};
      if(u==='fixture:cjs-parent')return {format:'commonjs',source:'exports.value=require('+JSON.stringify(new URL('./async-child.cjs',import.meta.url).pathname)+').value',shortCircuit:true};
      if(u==='fixture:cjs-child')return {format:'commonjs',source:'exports.value="child"',shortCircuit:true};
      if(u==='fixture:async') {
        await readFile(new URL('./payload.txt',import.meta.url));
        return {format:'module',source:'export default '+JSON.stringify(seed),shortCircuit:true};
      }
      return next(u,c);
    }
  `);
  file('async.cjs', `
    const assert=require('node:assert/strict');
    const {register,registerHooks,createRequire}=require('node:module');
    const {MessageChannel,receiveMessageOnPort}=require('node:worker_threads');
    const {pathToFileURL}=require('node:url');
    const {port1,port2}=new MessageChannel();
    const buffer=new ArrayBuffer(1);new Uint8Array(buffer)[0]=7;
    assert.equal(register('./async-hooks.mjs',pathToFileURL(__filename),{data:{port:port2,buffer},transferList:[port2,buffer]}),undefined);
    assert.equal(buffer.byteLength,0);
    assert.equal(receiveMessageOnPort(port1).message,'from-io-7');port1.close();
    assert.equal(globalThis.hookOnly,undefined);
    assert.throws(()=>require('fixture:cjs-child'),{code:'MODULE_NOT_FOUND'});
    assert.throws(()=>createRequire(__filename)('fixture:cjs-child'),{code:'MODULE_NOT_FOUND'});
    register('late-hooks',pathToFileURL(__filename));
    const sync=registerHooks({load(u,c,next){const out=next(u,c);if(u==='fixture:async')return {...out,source:String(out.source).replace('from-io','sync-from-io')};return out;}});
    (async()=>{
      assert.equal((await import('fixture:async')).default,'sync-from-io-disk-7');
      assert.equal((await import('fixture:cjs-parent')).default.value,'hook-child');
      assert.equal((await import('fixture:cjs-child')).default.value,'child');
      await assert.rejects(import('fixture:reject'),{code:'HOOK_FAILURE',message:'hook failure'});
      await assert.rejects(import('fixture:incomplete'),{code:'ERR_LOADER_CHAIN_INCOMPLETE'});
      sync.deregister();
      assert.throws(()=>register('data:text/javascript,export function initialize(){throw Object.assign(new Error("init failure"),{code:"INIT_FAILURE"})}'),{code:'INIT_FAILURE',message:'init failure'});
      console.log('ok');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `);
  run('async.cjs');
  file('exit.cjs', `
    try {
      require('node:module').register('data:text/javascript,export function initialize(){process.exit(7)}');
    } catch { process.exitCode = 99; }
    console.log('returned after hook worker exit');
  `);
  run('exit.cjs', 7, '');
  file('typed-hooks.mts', `
    enum Answer { Yes = 42 }
    export async function initialize() {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    export async function resolve(specifier, context, next) {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (specifier === 'fixture:typed')
        return { url: specifier, format: 'module', shortCircuit: true };
      return next(specifier, context);
    }
    export async function load(url, context, next) {
      if (url === 'fixture:typed') {
        const { answer } = await import('./typed-value.mjs');
        return { format: 'module', source: 'export default ' + (answer === Answer.Yes ? answer : 0), shortCircuit: true };
      }
      return next(url, context);
    }
  `);
  file('typed-value.mjs', 'export const answer = 42;');
  file('typed-register.mjs', `
    import { register } from 'node:module';
    register(new URL('./typed-hooks.mts', import.meta.url));
  `);
  file('typed-main.mjs', `
    import assert from 'node:assert/strict';
    import answer from 'fixture:typed';
    assert.equal(answer, 42);
    console.log('ok');
  `);
  // Inherit runtime flags, but never recursively replay this preload in the
  // internal hook worker. The hook also awaits timers and a nested import.
  run('typed-main.mjs', 0, 'ok', ['--experimental-transform-types', '--import', './typed-register.mjs']);
  file('terminate.cjs', `
    const assert = require('node:assert/strict');
    const { Worker, MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    const hook = 'data:text/javascript,export async function initialize(port){port.postMessage("waiting");await new Promise(()=>{})}';
    const worker = new Worker(
      'const {workerData}=require("node:worker_threads");require("node:module").register(workerData.hook,{data:workerData.port,transferList:[workerData.port]})',
      { eval: true, workerData: { hook, port: port2 }, transferList: [port2] });
    worker.on('error', error => { throw error; });
    port1.once('message', async value => {
      assert.equal(value, 'waiting');
      port1.close();
      assert.equal(await worker.terminate(), 1);
      console.log('ok');
    });
  `);
  run('terminate.cjs');
  console.log('module hooks smoke passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
