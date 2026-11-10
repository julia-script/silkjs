'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const { TextDecoder } = require('internal/web/encoding');
const utf8 = new TextDecoder();
const align = value => Math.ceil(value / 8) * 8;
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function isSea() { return host.seaNative(0); }
function requireSea() {
  if (!isSea()) throw error('ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION', 'Operation cannot be invoked when not in a single-executable application');
}
let loaded;
function metadata() {
  requireSea();
  if (loaded) return loaded;
  const json = host.seaNative(1), data = JSON.parse(json);
  const base = align(16 + Buffer.byteLength(json)), length = host.seaNative(4);
  const invalid = () => { throw error('ERR_INVALID_SEA_BLOB', 'Invalid Silk SEA payload directory'); };
  if (data.version !== 1 || data.format !== 'commonjs' || !Array.isArray(data.assets) ||
      !Array.isArray(data.execArgv) || data.execArgv.some(value => typeof value !== 'string') ||
      !['none', 'env', 'cli'].includes(data.execArgvExtension) || typeof data.main !== 'string') invalid();
  function entry(record) {
    if (!record || !Number.isSafeInteger(record.offset) || !Number.isSafeInteger(record.length) ||
        record.offset < 0 || record.length < 0 || record.offset % 8 ||
        record.offset > length - base || record.length > length - base - record.offset) invalid();
    return Object.freeze({ offset: base + record.offset, length: record.length });
  }
  const assets = new Map();
  for (const item of data.assets) {
    if (!item || typeof item.key !== 'string' || assets.has(item.key)) invalid();
    assets.set(item.key, entry(item));
  }
  loaded = { data, assets, source: entry(data.source), cache: data.cache === null ? null : entry(data.cache) };
  return loaded;
}
function raw(entry) { return host.seaNative(2, entry.offset, entry.length); }
function asset(key) {
  const item = metadata().assets.get(key);
  if (!item) throw error('ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND', `Cannot find asset ${key} for the single executable application`);
  // A fresh wrapper shares immutable mapping bytes; detaching one wrapper cannot
  // invalidate another. The native finalizer owns a mapping reference per call.
  return raw(item);
}
function keys() { return [...metadata().assets.keys()]; }
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw error('ERR_INVALID_ARG_TYPE', `${name} must be an object`, TypeError);
  return value;
}
function string(value, name) {
  if (typeof value !== 'string') throw error('ERR_INVALID_ARG_TYPE', `${name} must be a string`, TypeError);
  return value;
}
function boolean(config, key) {
  if (config[key] !== undefined && typeof config[key] !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', `${key} must be a boolean`, TypeError);
  return config[key] === true;
}
function wrapper(source) {
  return '(function(exports,require,module,__filename,__dirname){\n' + source.replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '') + '\n})';
}
function prepare(configPath) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const config = object(JSON.parse(fs.readFileSync(string(configPath, 'configPath'), 'utf8')), 'SEA configuration');
  const main = string(config.main, 'main'), output = string(config.output, 'output');
  if (!main || !output) throw error('ERR_INVALID_ARG_VALUE', 'main and output must not be empty', TypeError);
  const useSnapshot = boolean(config, 'useSnapshot'), useCodeCache = boolean(config, 'useCodeCache');
  const disableExperimentalSEAWarning = boolean(config, 'disableExperimentalSEAWarning');
  if (useSnapshot) throw error('ERR_NOT_SUPPORTED', 'SEA useSnapshot requires SilkJS runtime-image serialization; source replay is not a startup snapshot');
  if (config.mainFormat !== undefined && config.mainFormat !== 'commonjs') throw error('ERR_NOT_SUPPORTED', 'Node 24 SEA main scripts use the CommonJS module system; bundle the main script as CommonJS');
  const execArgv = config.execArgv === undefined ? [] : config.execArgv;
  if (!Array.isArray(execArgv)) throw error('ERR_INVALID_ARG_TYPE', 'execArgv must be an array', TypeError);
  for (const arg of execArgv) string(arg, 'execArgv entry');
  const execArgvExtension = config.execArgvExtension === undefined ? 'env' : config.execArgvExtension;
  if (!['none', 'env', 'cli'].includes(execArgvExtension)) throw error('ERR_INVALID_ARG_VALUE', 'execArgvExtension must be none, env, or cli', TypeError);
  const sources = config.assets === undefined ? {} : object(config.assets, 'assets');
  const chunks = []; let size = 0;
  function add(bytes) {
    const padding = align(size) - size;
    if (padding) chunks.push(Buffer.alloc(padding));
    size += padding;
    const record = { offset: size, length: bytes.byteLength };
    chunks.push(bytes); size += bytes.byteLength;
    return record;
  }
  const sourceText = fs.readFileSync(main, 'utf8');
  const source = add(Buffer.from(sourceText));
  let cache = null;
  if (useCodeCache) {
    const handle = host.vmCompile(wrapper(sourceText), path.resolve(main));
    cache = add(Buffer.from(host.vmWriteCache(handle)));
  }
  const assets = [];
  for (const key of Object.keys(sources)) assets.push({ key, ...add(fs.readFileSync(string(sources[key], `assets.${key}`))) });
  // Bind preparation to the exact runtime binary, including its engine build.
  // The injector checks this before touching Mach-O metadata or signatures.
  const runtimeHash = crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ version: 1, format: 'commonjs', main: path.resolve(main), runtimeHash,
    source, cache, assets, execArgv, execArgvExtension, disableExperimentalSEAWarning }));
  if (manifest.length > 0xffffffff) throw error('ERR_OUT_OF_RANGE', 'SEA manifest exceeds the v1 format limit', RangeError);
  const header = Buffer.alloc(16); header.write('SILKSEA1'); header.writeUInt32LE(manifest.length, 8);
  fs.writeFileSync(output, Buffer.concat([header, manifest, Buffer.alloc(align(16 + manifest.length) - 16 - manifest.length), ...chunks]));
}
const { parseEnvironment: environmentArgs, validateEnvironment } = require('internal/options');
const reportOptions = require('internal/process_report');
function runMain(args, runtimeFlag, installRuntimeOptions, runPreloads, loadRuntimeEnvironment) {
  const { data, source, cache } = metadata();
  const flags = data.execArgv.slice();
  let appArgs = args.slice();
  loadRuntimeEnvironment(data.execArgvExtension === 'cli' ? flags.concat(args) : flags);
  if (data.execArgvExtension === 'env') {
    const environment = environmentArgs(process.env.NODE_OPTIONS || '');
    environment.length = validateEnvironment(environment);
    flags.push(...environment);
  }
  if (data.execArgvExtension === 'cli') {
    let index = 0;
    while (index < args.length && args[index].startsWith('-') && args[index] !== '-') {
      if (args[index] === '--') { index++; break; }
      const flag = args[index++];
      flags.push(flag);
      if ((['-r', '--require', '--import', '-C', '--conditions', '--localstorage-file', '--trace-event-categories',
        '--trace-event-file-pattern', '--env-file', '--env-file-if-exists'].includes(flag) || reportOptions.isValueOption(flag)) && index < args.length) flags.push(args[index++]);
    }
    appArgs = args.slice(index);
  }
  for (let index = 0; index < flags.length; index++) {
    let flag = flags[index];
    if (['-r', '--require', '--import', '-C', '--conditions', '--localstorage-file', '--trace-event-categories',
      '--trace-event-file-pattern', '--env-file', '--env-file-if-exists'].includes(flag) || reportOptions.isValueOption(flag)) {
      const value = flags[++index];
      if (value === undefined || value === '' || value.startsWith('-'))
        throw error('ERR_INVALID_ARG_VALUE', flag + ' requires an argument');
      flag = (flag === '-r' ? '--require' : flag === '-C' ? '--conditions' : flag) + '=' + value;
    }
    if (['--require=', '--import=', '--conditions=', '--localstorage-file=', '--env-file=', '--env-file-if-exists='].includes(flag) ||
        (flag.endsWith('=') && reportOptions.isValueOption(flag.slice(0, -1))))
      throw error('ERR_INVALID_ARG_VALUE', flag + ' requires an argument');
    if (flag.startsWith('--env-file=') || flag.startsWith('--env-file-if-exists=')) continue;
    if (!runtimeFlag(flag)) throw error('ERR_NOT_SUPPORTED', `Unsupported SEA runtime option: ${flag}`);
  }
  process.execArgv = flags;
  installRuntimeOptions(flags);
  process.argv = [process.execPath, process.execPath, ...appArgs];
  return runPreloads(() => {
  if (!data.disableExperimentalSEAWarning) process.emitWarning('Single executable application is an experimental feature and might change at any time', 'ExperimentalWarning');
  const Module = require('module'), path = require('path');
  const module = new Module('.', null);
  module.filename = process.execPath;
  module.paths = [];
  function builtinRequire(id) {
    string(id, 'id');
    if (!Module.isBuiltin(id)) throw error('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${id}`);
    return require(id);
  }
  builtinRequire.main = module;
  module.require = builtinRequire;
  process.mainModule = module;
  const fn = cache ? host.seaNative(3, cache.offset, cache.length) : host.compileFunction(wrapper(utf8.decode(raw(source))), data.main);
  Reflect.apply(fn, module.exports, [module.exports, builtinRequire, module, process.execPath, path.dirname(process.execPath)]);
  module.loaded = true;
  return module.exports;
  });
}
module.exports = { isSea, asset, keys, prepare, runMain };
