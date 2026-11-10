'use strict';

// Execute with the Node 24 oracle; argv[2] is the Silk-native executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const target = path.resolve(process.argv[2] || process.execPath);
// Node resolves module filenames through realpath; Darwin's /var temporary path
// can otherwise differ from the /private/var path reported by coverage.
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-execution-coverage-')));
const env = { ...process.env }; delete env.NODE_OPTIONS;
function file(name, source) { const filename = path.join(directory, name); fs.writeFileSync(filename, source); return filename; }
let lastExecution;
let nextDriver = 0;
function executionFailure(error, stage) {
  const { binary, args, result } = lastExecution;
  console.error(`${stage}\nexecutable: ${binary}\narguments: ${JSON.stringify(args)}\nstatus: ${result.status}\nsignal: ${result.signal}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`);
  throw error;
}
function execute(binary, source, flags = []) {
  // Process-isolated node:test inherits execArgv; an eval driver would execute
  // recursively in the worker instead of loading the requested test file.
  const driver = file(`driver-${++nextDriver}.cjs`, source);
  const args = [...flags, driver];
  const result = spawnSync(binary, args, { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  lastExecution = { binary, args, result };
  try {
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.trim());
  } catch (error) { executionFailure(error, 'child execution or JSON decoding failed'); }
}
function both(source, inspect, flags) {
  const expected = execute(process.execPath, source, flags);
  try { inspect(expected); } catch (error) { executionFailure(error, 'Node oracle expectations failed before executing the native runtime'); }
  const actual = execute(target, source, flags);
  try {
    inspect(actual);
    assert.deepEqual(actual, expected);
  } catch (error) { executionFailure(error, 'Native runtime expectations or oracle comparison failed'); }
}
try {
  const ordered = file('ordered.cjs', `
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
beforeEach(t => { t.hooked = true; });
afterEach(t => assert.equal(t.hooked, true));
test('slow', async t => { assert.equal(t.hooked, true); await new Promise(r => setTimeout(r, 30)); });
test('fast', t => assert.equal(t.hooked, true));
`);
  for (const isolation of ['none', 'process']) both(`
const rows = [], complete = [], observed = []; let setup = false;
const stream = require('node:test').run({ files: [${JSON.stringify(ordered)}], isolation: ${JSON.stringify(isolation)}, ${isolation === 'none' ? 'concurrency: 2,' : ''}
 setup(s) { setup = true; s.on('test:enqueue', () => { if (!setup) throw Error('setup was late'); }); } });
stream.on('data', ({type,data}) => {
 observed.push({type,data});
 if (!['slow','fast'].includes(data.name)) return;
 if (type === 'test:complete') complete.push(data.name);
 if (type === 'test:pass' || type === 'test:fail') rows.push([data.name,type]);
});
stream.on('error', e => { throw e; });
stream.on('end', () => {
 if (rows.length !== 2 || rows.some(row => row[1] !== 'test:pass')) {
   console.error(JSON.stringify({isolation:${JSON.stringify(isolation)},execPath:process.execPath,execArgv:process.execArgv,events:observed},(_key,value)=>value instanceof Error?{name:value.name,message:value.message,stack:value.stack,code:value.code,failureType:value.failureType,cause:value.cause}:value));
 }
 console.log(JSON.stringify({setup,rows,${isolation === 'none' ? 'complete' : ''}}));
});
`, result => {
    assert.equal(result.setup, true);
    assert.deepEqual(result.rows, [['slow', 'test:pass'], ['fast', 'test:pass']]);
    if (isolation === 'none') assert.deepEqual(result.complete, ['fast', 'slow']);
  });

  const filters = file('filters.cjs', `
const { describe, test } = require('node:test');
describe('selected suite', () => {
 test('chosen', () => {});
 test('excluded', () => { throw Error('skip filter did not run'); });
 test.skip('explicit skip', () => { throw Error('explicit skip did not run'); });
});
test('other', () => { throw Error('name filter did not run'); });
`);
  both(`
const rows=[],events=[];let summary,plan;const s=require('node:test').run({files:[${JSON.stringify(filters)}],isolation:'none',testNamePatterns:['selected'],testSkipPatterns:['^selected suite excluded$']});
s.on('data',({type,data})=>{
 if(data.name)events.push(data.name);
 if((type==='test:pass'||type==='test:fail')&&data.details.type!=='suite')rows.push([data.name,type,!!data.skip,data.testNumber]);
 if(type==='test:summary')summary=data;
 if(type==='test:plan'&&data.nesting===0)plan=data.count;
});
s.on('error',e=>{throw e});s.on('end',()=>console.log(JSON.stringify({rows,filteredEvents:events.filter(name=>name==='excluded'||name==='other'),tests:summary.counts.tests,skipped:summary.counts.skipped,plan})));
`, result => {
    assert.deepEqual(result, { rows: [['chosen', 'test:pass', false, 1], ['explicit skip', 'test:pass', true, 2]], filteredEvents: [], tests: 2, skipped: 1, plan: 1 });
  });
  both(`
const rows=[];const s=require('node:test').run({files:[${JSON.stringify(filters)}],isolation:'none',testNamePatterns:['^chosen$']});
s.on('data',({type,data})=>{if(type==='test:pass'||type==='test:fail')rows.push([data.name,type,!!data.skip]);});
s.on('error',e=>{throw e});s.on('end',()=>console.log(JSON.stringify(rows)));
`, rows => assert.deepEqual(rows, [['chosen', 'test:pass', false], ['selected suite', 'test:pass', false]]));

  const args = file('arguments.cjs', `
const test=require('node:test'),assert=require('node:assert/strict');
test('inheritance',()=>{
 assert.deepEqual(process.argv.slice(2),['--literal','value']);
 assert.equal(process.env.SILK_CONSUMER_ENV,'present');
 assert.ok(process.execArgv.includes('--no-warnings'));
});
`);
  both(`
const rows=[];const s=require('node:test').run({files:[${JSON.stringify(args)}],argv:['--literal','value'],env:{...process.env,SILK_CONSUMER_ENV:'present'}});
s.on('data',({type,data})=>{if(data.name==='inheritance'&&(type==='test:pass'||type==='test:fail'))rows.push(type)});
s.on('error',e=>{throw e});s.on('end',()=>console.log(JSON.stringify(rows)));
`, rows => assert.deepEqual(rows, ['test:pass']), ['--no-warnings']);

  const marker = path.join(directory, 'cancelled');
  const cancelled = file('cancelled.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  for (const binary of [process.execPath, target]) {
    fs.rmSync(marker, { force: true });
    const result = execute(binary, `
const ac=new AbortController();ac.abort();let success;
const s=require('node:test').run({files:[${JSON.stringify(cancelled)}],signal:ac.signal});
s.on('data',e=>{if(e.type==='test:summary')success=e.data.success});s.on('error',e=>{throw e});
s.on('end',()=>console.log(JSON.stringify({success,executed:require('node:fs').existsSync(${JSON.stringify(marker)})})));
`);
    assert.equal(result.executed, false);
    assert.equal(result.success, false);
  }
  const cleanup = path.join(directory, 'cleanup.json');
  const aborting = file('aborting.cjs', `
const test=require('node:test');const ac=new AbortController();
test('abort cleanup',{signal:ac.signal},async t=>{
 t.after(()=>require('node:fs').writeFileSync(${JSON.stringify(cleanup)},JSON.stringify({aborted:t.signal.aborted})));
 setTimeout(()=>ac.abort(),5);
 await new Promise(()=>{});
});
`);
  both(`
let summary;const s=require('node:test').run({files:[${JSON.stringify(aborting)}],isolation:'none'});
s.on('data',e=>{if(e.type==='test:summary')summary=e.data});s.on('error',e=>{throw e});
s.on('end',()=>console.log(JSON.stringify({success:summary.success,cancelled:summary.counts.cancelled,cleanup:JSON.parse(require('node:fs').readFileSync(${JSON.stringify(cleanup)},'utf8'))})));
`, result => assert.deepEqual(result, { success: false, cancelled: 1, cleanup: { aborted: true } }));

  const measured = file('measured.cjs', `
function selected(value) {
  if (value) {
    return 42;
  }
  return 99;
}
function untouched() {
  return -1;
}
module.exports = { selected, untouched };
`);
  const coverTest = file('exercise.cjs', `const test=require('node:test'),assert=require('node:assert/strict');const {selected}=require('./measured.cjs');test('coverage',()=>assert.equal(selected(true),42));`);
  for (const isolation of ['none', 'process']) for (const binary of [process.execPath, target]) {
    const result = execute(binary, `
let coverage,success;const events=[];
const s=require('node:test').run({files:[${JSON.stringify(coverTest)}],isolation:${JSON.stringify(isolation)},coverage:true,coverageIncludeGlobs:['**/measured.cjs'],functionCoverage:100});
s.on('data',e=>{events.push(e);if(e.type==='test:coverage')coverage=e.data.summary;if(e.type==='test:summary')success=e.data.success});
s.on('error',e=>{throw e});s.on('end',()=>{
 const types=events.map(e=>e.type),coverageIndex=types.lastIndexOf('test:coverage'),summaryIndex=types.lastIndexOf('test:summary');
 console.log(JSON.stringify({coverage,success,events,isolation:${JSON.stringify(isolation)},execPath:process.execPath,cwd:process.cwd(),ordered:coverageIndex>=0&&coverageIndex<summaryIndex&&summaryIndex===events.length-1},(_key,value)=>value instanceof Error?{name:value.name,message:value.message,stack:value.stack,code:value.code,failureType:value.failureType,cause:value.cause}:value));
 process.exitCode=0;
});
`);
    try {
    assert.equal(result.ordered, true);
    assert.equal(result.success, false);
    const report = result.coverage.files.find(item => item.path === measured);
    assert.ok(report, 'measured module must be included');
    assert.ok(report.functions.find(fn => fn.name === 'selected').count > 0);
    assert.equal(report.functions.find(fn => fn.name === 'untouched').count, 0);
    assert.ok(report.lines.find(line => line.line === 4).count > 0);
    assert.equal(report.lines.find(line => line.line === 6).count, 0);
    assert.equal(report.lines.find(line => line.line === 9).count, 0);
    assert.ok(report.branches.some(branch => branch.count === 0));
    assert.ok(report.branches.some(branch => branch.count > 0));
    } catch (error) { executionFailure(error, `${binary === process.execPath ? 'Node oracle' : 'Native runtime'} coverage expectations failed (isolation: ${isolation})`); }
  }
  for (const binary of [process.execPath, target]) {
    const result = spawnSync(binary, ['--test', '--experimental-test-coverage', '--test-coverage-include=**/measured.cjs', '--test-coverage-functions=100', '--test-reporter=lcov', coverTest],
      { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /^SF:measured\.cjs$/m);
    assert.match(result.stdout, /^FNDA:0,untouched$/m);
    assert.match(result.stdout, /^DA:4,[1-9]\d*$/m);
    assert.match(result.stdout, /^DA:6,0$/m);
    assert.match(result.stdout, /^BRF:[1-9]\d*$/m);
  }
  console.log('test execution and measured coverage consumers: passed');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
