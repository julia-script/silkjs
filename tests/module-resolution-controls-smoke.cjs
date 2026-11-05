'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2] || process.execPath);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-module-controls-')));
function file(name, source) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
}
function json(name, value) { file(name, JSON.stringify(value)); }
function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'NODE_OPTIONS')) delete env.NODE_OPTIONS;
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, JSON.stringify({ args, ...result }));
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
try {
  json('package.json', { name: 'self-package', exports: './missing-export.js', imports: { '#choice': { custom: './custom.cjs', default: './default.cjs' } } });
  file('custom.cjs', 'module.exports="custom";');
  file('default.cjs', 'module.exports="default";');
  json('nested/package.json', { type: 'module' });
  file('nested/value.xyz', 'not JavaScript');
  file('plain/value.js', '');
  file('bad/package.json', 'invalid json');
  file('bad/value.js', '');
  json('node_modules/exports-package/package.json', { exports: './missing.js' });
  file('node_modules/no-config/value.js', '');
  file('node_modules/invalid-package/package.json', 'invalid json');
  file('node_modules/@scope/no-config/value.js', '');
  file('lookup.cjs', `
    const assert=require('node:assert/strict'), path=require('node:path');
    const {findPackageJSON:f}=require('node:module'), {pathToFileURL}=require('node:url');
    const root=process.cwd(), base=path.join(root,'lookup.cjs');
    const pkg=name=>path.join(root,name,'package.json');
    assert.equal(f('./plain/value.js',base),pkg(''));
    assert.equal(f('./nested/value.xyz',pathToFileURL(base)),pkg('nested'));
    assert.equal(f(pathToFileURL(path.join(root,'nested/value.xyz'))),pkg('nested'));
    assert.equal(f('./nested/value.xyz?query#fragment',base),pkg('nested'));
    assert.equal(f('./nested',base),pkg(''));
    assert.equal(f('./nested/',base),pkg('nested'));
    assert.equal(f('self-package/private',base),pkg(''));
    assert.equal(f('self-package',pathToFileURL(root+'/')),pkg(''));
    assert.equal(f('exports-package/private',base),pkg('node_modules/exports-package'));
    assert.equal(f('no-config',base),pkg('node_modules/no-config'));
    assert.equal(f('@scope/no-config/private',base),pkg('node_modules/@scope/no-config'));
    assert.equal(f('invalid-package',base),pkg('node_modules/invalid-package'));
    assert.equal(f('./node_modules/no-config/value.js',base),path.join(root,'node_modules/no-config/value.js'));
    assert.equal(f({toString:()=> './plain/value.js'},base),pkg(''));
    for(const [args,code] of [
      [[], 'ERR_MISSING_ARGS'], [[Symbol('x'),base],'ERR_INVALID_ARG_TYPE'],
      [['./plain/value.js',{}],'ERR_INVALID_ARG_TYPE'], [['./plain/value.js','relative.js'],'ERR_INVALID_URL'],
      [['./plain/value.js'],'ERR_UNSUPPORTED_RESOLVE_REQUEST'], [['fs'],'ERR_INVALID_URL'],
      [['node:fs',base],'ERR_INVALID_URL_SCHEME'], [['https://example.com/a',base],'ERR_INVALID_URL_SCHEME'],
      [['file:///tmp/%2F',base],'ERR_INVALID_MODULE_SPECIFIER'], [['missing-package',base],'ERR_MODULE_NOT_FOUND'],
      [['./missing.js',base],'ERR_MODULE_NOT_FOUND'], [['./bad/value.js',base],'ERR_INVALID_PACKAGE_CONFIG'],
      [['no-config',path.join(root,'bad/entry.js')],'ERR_INVALID_PACKAGE_CONFIG']
    ]) assert.throws(()=>f(...args),{code});
    console.log(JSON.stringify('lookup'));
  `);
  assert.deepEqual(run(['lookup.cjs']), ['lookup']);

  json('node_modules/choice/package.json', { exports: { custom: './custom.cjs', require: './require.cjs', import: './import.cjs' } });
  for (const name of ['custom', 'require', 'import']) file(`node_modules/choice/${name}.cjs`, `module.exports=${JSON.stringify(name)};`);
  json('node_modules/ordered/package.json', { exports: { default: './default.cjs', custom: './custom.cjs' } });
  file('node_modules/ordered/default.cjs', 'module.exports="default-first";');
  file('node_modules/ordered/custom.cjs', 'module.exports="incorrect";');
  file('conditions.cjs', `(async()=>{console.log(JSON.stringify([require('choice'),(await import('choice')).default,require('#choice'),(await import('#choice')).default,require('ordered')]))})().catch(e=>{throw e});`);
  assert.deepEqual(run(['conditions.cjs']), [['require', 'import', 'default', 'default', 'default-first']]);
  const custom = [['custom', 'custom', 'custom', 'custom', 'default-first']];
  assert.deepEqual(run(['-C', 'custom', 'conditions.cjs']), custom);
  assert.deepEqual(run(['--conditions=unused', '--conditions=custom', 'conditions.cjs']), custom);
  assert.deepEqual(run(['conditions.cjs'], { NODE_OPTIONS: '--conditions=custom' }), custom);

  for (const name of ['global-one', 'global-two', 'injected', 'home/.node_modules', 'home/.node_libraries']) {
    file(`${name}/global-only.cjs`, `module.exports=${JSON.stringify(name)};`);
  }
  file('node_modules/local-choice.cjs', 'module.exports="local";');
  file('global-one/local-choice.cjs', 'module.exports="global";');
  file('paths.cjs', `
    const assert=require('node:assert/strict'), path=require('node:path'), M=require('node:module');
    const root=process.cwd(), one=path.join(root,'global-one'), two=path.join(root,'global-two');
    const prefix=process.platform==='win32'?path.resolve(process.execPath,'..'):path.resolve(process.execPath,'..','..');
    const expected=[one,two,path.join(root,'home/.node_modules'),path.join(root,'home/.node_libraries'),path.join(prefix,'lib/node')];
    assert.deepEqual(M.globalPaths,expected);
    assert.deepEqual(require.resolve.paths('global-only.cjs'),[...module.paths,...expected]);
    assert.deepEqual(require.resolve.paths('./global-only.cjs'),[root]);
    assert.equal(require.resolve.paths('node:fs'),null);
    assert.equal(require('local-choice.cjs'),'local');
    assert.equal(require('global-only.cjs'),'global-one');
    M.globalPaths.unshift(path.join(root,'injected'));
    assert.equal(require.resolve.paths('global-only.cjs').includes(path.join(root,'injected')),false);
    process.env.NODE_PATH=two;
    assert.equal(require.resolve('global-only.cjs'),path.join(one,'global-only.cjs'));
    M._initPaths();
    assert.equal(require.resolve('global-only.cjs'),path.join(two,'global-only.cjs'));
    assert.equal(require.resolve('global-only.cjs',{paths:[root]}),path.join(two,'global-only.cjs'));
    assert.throws(()=>require.resolve('global-only.cjs',{paths:[]}),{code:'MODULE_NOT_FOUND'});
    const previous=module.paths; module.paths=[path.join(root,'injected')];
    assert.equal(require.resolve('global-only.cjs'),path.join(root,'injected/global-only.cjs'));
    module.paths=previous;
    delete process.env.NODE_PATH; M._initPaths();
    assert.equal(require.resolve('global-only.cjs'),path.join(root,'home/.node_modules/global-only.cjs'));
    import('global-only.cjs').then(()=>{throw Error('ESM searched NODE_PATH')},e=>{assert.equal(e.code,'ERR_MODULE_NOT_FOUND');console.log(JSON.stringify('paths'))});
  `);
  assert.deepEqual(run(['paths.cjs'], { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), NODE_PATH: [path.join(root, 'global-one'), '', path.join(root, 'global-two')].join(path.delimiter) }), ['paths']);
  file('import-global.mjs', `import assert from 'node:assert/strict';await assert.rejects(import('global-only.cjs'),{code:'ERR_MODULE_NOT_FOUND'});console.log(JSON.stringify('no-global-import'));`);
  assert.deepEqual(run(['import-global.mjs'], { NODE_PATH: path.join(root, 'global-one') }), ['no-global-import']);

  file('real/dep.cjs', 'module.exports={};');
  file('real/dep.mjs', 'export const main=import.meta.main;export default {};');
  file('real/entry.cjs', `console.log(JSON.stringify([__filename,require('./dep.cjs')===require('./alias.cjs'),require.resolve('./alias.cjs'),require.main===module]));`);
  file('real/entry.mjs', `import a,{main as dependencyMain} from './dep.mjs';import b from './alias.mjs';console.log(JSON.stringify([import.meta.filename,a===b,import.meta.resolve('./alias.mjs'),import.meta.main,dependencyMain]));`);
  fs.symlinkSync('dep.cjs', path.join(root, 'real/alias.cjs'));
  fs.symlinkSync('dep.mjs', path.join(root, 'real/alias.mjs'));
  fs.symlinkSync('real', path.join(root, 'linked'), 'dir');
  fs.symlinkSync('../real', path.join(root, 'node_modules/linked-one'), 'dir');
  fs.symlinkSync('../real', path.join(root, 'node_modules/linked-two'), 'dir');
  json('real/package.json', { main: 'dep.cjs' });
  file('identity.cjs', `console.log(JSON.stringify(require('linked-one')===require('linked-two')));`);
  assert.deepEqual(run(['identity.cjs']), [true]);
  file('lookup-links.cjs', `const {findPackageJSON}=require('node:module');console.log(JSON.stringify([findPackageJSON('./linked/dep.cjs',__filename),findPackageJSON('linked-one',__filename)]));`);
  assert.deepEqual(run(['lookup-links.cjs']), [[path.join(root, 'real/package.json'), path.join(root, 'node_modules/linked-one/package.json')]]);
  assert.deepEqual(run(['--preserve-symlinks-main', 'lookup-links.cjs']), [[path.join(root, 'real/package.json'), path.join(root, 'node_modules/linked-one/package.json')]]);
  assert.deepEqual(run(['--preserve-symlinks', 'lookup-links.cjs']), [[path.join(root, 'linked/package.json'), path.join(root, 'node_modules/linked-one/package.json')]]);
  assert.deepEqual(run(['--preserve-symlinks', 'identity.cjs']), [false]);
  const { pathToFileURL } = require('node:url');
  for (const preserve of [false, true]) for (const preserveMain of [false, true]) {
    const flags = [...(preserve ? ['--preserve-symlinks'] : []), ...(preserveMain ? ['--preserve-symlinks-main'] : [])];
    const directory = preserveMain ? 'linked' : 'real';
    const dependencyDirectory = preserve ? directory : 'real';
    const dependency = preserve ? 'alias' : 'dep';
    assert.deepEqual(run([...flags, 'linked/entry.cjs']), [[path.join(root, directory, 'entry.cjs'), !preserve, path.join(root, dependencyDirectory, `${dependency}.cjs`), true]]);
    assert.deepEqual(run([...flags, 'linked/entry.mjs']), [[path.join(root, directory, 'entry.mjs'), !preserve, pathToFileURL(path.join(root, dependencyDirectory, `${dependency}.mjs`)).href, true, false]]);
  }
  file('import-main.mjs', `await import('./linked/entry.mjs');`);
  assert.deepEqual(run(['--preserve-symlinks-main', 'import-main.mjs']), [[path.join(root, 'real/entry.mjs'), true, pathToFileURL(path.join(root, 'real/dep.mjs')).href, false, false]]);
  assert.deepEqual(run(['--preserve-symlinks', '--preserve-symlinks-main', 'import-main.mjs']), [[path.join(root, 'linked/entry.mjs'), false, pathToFileURL(path.join(root, 'linked/alias.mjs')).href, false, false]]);
  assert.deepEqual(run(['--preserve-symlinks', '--no-preserve-symlinks', 'identity.cjs']), [true]);
  assert.deepEqual(run(['--preserve-symlinks-main', '--no-preserve-symlinks-main', 'linked/entry.cjs']), [[path.join(root, 'real/entry.cjs'), true, path.join(root, 'real/dep.cjs'), true]]);
  console.log('module resolution controls smoke: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
