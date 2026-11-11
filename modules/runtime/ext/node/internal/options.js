'use strict';

const host = require('internal/host');
const reportOptions = require('internal/process_report');
const startupControls = require('internal/startup_controls');
const permission = require('internal/permission');
const tlsOptions = require('internal/tls/options');

// Inspector enable flags accept an optional address only with "="; unlike
// ordinary booleans that suffix must survive normalization.
const inspectorEnableOptions = new Set(['--inspect', '--inspect-brk', '--inspect-wait']);
function isInspectorValueOption(name) {
  return name === '--inspect-port' || name === '--debug-port';
}
function inspectorAddress(value) {
  let hostname = '', portText;
  if (value.startsWith('[') && value.endsWith(']')) return { host: value.slice(1, -1), port: 9229 };
  const colon = value.lastIndexOf(':');
  if (colon < 0) {
    if (!/^[0-9]*$/.test(value)) return { host: value, port: 9229 };
    portText = value;
  } else {
    hostname = value.slice(0, colon);
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    portText = value.slice(colon + 1);
  }
  // Node's from_chars accepts a decimal prefix and leaves an invalid prefix
  // at zero. Do not impose stricter URL/port validation here.
  const digits = /^[0-9]+/.exec(portText);
  const port = digits ? Number(digits[0]) : 0;
  if (port > 65535 || (port !== 0 && port < 1024)) throw new Error('must be 0 or in range 1024 to 65535.');
  return { host: hostname, port };
}
function applyInspectorOption(arg) {
  const separator = arg.indexOf('=');
  const name = separator < 0 ? arg : arg.slice(0, separator);
  const positive = name.replace(/^--no-/, '--');
  if (!inspectorEnableOptions.has(positive) && !isInspectorValueOption(name)) return false;
  if (isInspectorValueOption(name) && separator < 0) return false;
  const options = host.inspectorOptions ||= { enabled: false, host: '127.0.0.1', port: 9229, wait: false, breakFirst: false };
  if (separator >= 0) {
    const address = inspectorAddress(arg.slice(separator + 1));
    if (address.host) options.host = address.host;
    options.port = address.port;
  }
  if (inspectorEnableOptions.has(positive)) {
    const enabled = name === positive;
    if (positive === '--inspect') options.enabled = enabled;
    else {
      options[positive === '--inspect-brk' ? 'breakFirst' : 'wait'] = enabled;
      if (enabled) options.enabled = true;
    }
  }
  return true;
}

// Values describe whether a supported environment option consumes an argument.
const environmentOptions = new Map([
  ...reportOptions.optionEntries,
  ...startupControls.optionEntries,
  ...require('internal/heap_prof').optionEntries,
  ...permission.optionEntries,
  ...tlsOptions.optionEntries,
  ...[...inspectorEnableOptions, '--no-inspect', '--no-inspect-brk', '--no-inspect-wait',
    '--experimental-inspector-network-resource', '--no-experimental-inspector-network-resource'].map(name => [name, false]),
  ['--inspect-port', true], ['--debug-port', true], ['--max-http-header-size', true],
  ...['--watch', '--no-watch', '--watch-preserve-output', '--no-watch-preserve-output'].map(name => [name, false]),
  ...['--watch-path', '--watch-kill-signal'].map(name => [name, true]),
  ...['--experimental-test-coverage', '--no-experimental-test-coverage'].map(name => [name, false]),
  ...['--test-coverage-include', '--test-coverage-exclude', '--test-coverage-lines',
    '--test-coverage-branches', '--test-coverage-functions'].map(name => [name, true]),
  ...['--insecure-http-parser', '--no-insecure-http-parser', '--async-context-frame',
    '--no-async-context-frame', '--expose-gc', '--no-expose-gc', '--disable-sigusr1',
    '--trace-events-enabled', '--test-only', '--experimental-eventsource',
    '--no-experimental-eventsource', '--experimental-webstorage',
    '--no-experimental-webstorage', '--experimental-stream-iter',
    '--no-experimental-stream-iter', '--preserve-symlinks', '--no-preserve-symlinks',
    '--preserve-symlinks-main', '--no-preserve-symlinks-main',
    '--experimental-vm-modules', '--no-experimental-vm-modules',
    '--experimental-require-module', '--no-experimental-require-module',
    '--experimental-import-meta-resolve', '--experimental-print-required-tla',
    '--enable-source-maps', '--no-enable-source-maps',
    '--trace-sigint', '--no-trace-sigint',
    '--strip-types', '--no-strip-types', '--experimental-strip-types', '--no-experimental-strip-types',
    '--experimental-transform-types', '--no-experimental-transform-types'].map(name => [name, false]),
  ...['--trace-event-categories', '--trace-event-file-pattern', '--input-type',
    '--test-isolation', '--test-name-pattern', '--test-skip-pattern', '--test-shard',
    '--test-reporter', '--test-reporter-destination', '--localstorage-file',
    '-r', '--require', '--import', '-C', '--conditions', '--experimental-loader', '--loader'].map(name => [name, true]),
]);

function normalizeOption(arg) {
  const separator = arg.indexOf('=');
  const name = (separator < 0 ? arg : arg.slice(0, separator)).replace(/_/g, '-');
  // Node-owned booleans ignore an attached value. V8-style GC flags reject it.
  if (separator < 0 || (name.startsWith('--') && workerOptions.get(name) === false &&
      !inspectorEnableOptions.has(name) && !/^--(?:no-)?expose-gc$/.test(name))) return name;
  return name + arg.slice(separator);
}

function report(error, errors) {
  if (errors) errors.push(error);
  else throw error;
}

function parseEnvironment(value, errors) {
  const result = []; let quoted = false, start = true;
  for (let index = 0; index < value.length; index++) {
    let char = value[index];
    if (char === '\\' && quoted) {
      if (++index === value.length) {
        report(new Error('invalid value for NODE_OPTIONS (invalid escape)\n'), errors);
        break;
      }
      char = value[index];
    } else if (char === ' ' && !quoted) {
      start = true;
      continue;
    } else if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (start) { result.push(char); start = false; }
    else result[result.length - 1] += char;
  }
  if (quoted) report(new Error('invalid value for NODE_OPTIONS (unterminated string)\n'), errors);
  return result;
}

function validateEnvironment(args, errors) {
  if (errors?.length) return 0;
  for (let index = 0; index < args.length; index++) {
    const start = index;
    const arg = normalizeOption(args[index]), separator = arg.indexOf('=');
    if (arg.length <= 1 || arg[0] !== '-') return start;
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (!environmentOptions.has(name) || (separator >= 0 && name[1] !== '-')) {
      report(new Error((name[1] !== '-' ? arg : args[index].includes('=') ? name + '=' : name) + ' is not allowed in NODE_OPTIONS'), errors);
      return start;
    }
    if (inspectorEnableOptions.has(name)) {
      if (separator >= 0) {
        try { inspectorAddress(arg.slice(separator + 1)); }
        catch (error) { report(error, errors); return start; }
      }
      continue;
    }
    if (!environmentOptions.get(name)) {
      if (separator >= 0) {
        report(new Error('invalid value for ' + name), errors);
        return start;
      }
    } else {
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || ((['--localstorage-file', '-r', '--require', '--import', '-C', '--conditions', '--watch-path', '--watch-kill-signal'].includes(name) || reportOptions.isValueOption(name) || permission.isValueOption(name)) && value === '') || (separator < 0 && value.startsWith('-'))) {
        report(new Error(name + ' requires an argument'), errors);
        return start;
      } else if (name === '--input-type' && !['commonjs', 'module', 'commonjs-typescript', 'module-typescript'].includes(value)) {
        report(new Error('--input-type must be "module", "commonjs", "module-typescript" or "commonjs-typescript"'), errors);
        return start;
      }
      if (isInspectorValueOption(name)) {
        try { inspectorAddress(value); }
        catch (error) { report(error, errors); return start; }
      }
      const error = startupControls.valueError(name, value);
      if (error) { report(new Error(error), errors); return start; }
    }
  }
  return args.length;
}

const workerOptions = new Map([
  ...environmentOptions,
  ...['-i', '--interactive', '--test', '-c', '--check', '--no-print',
    '--test-update-snapshots', '--no-test-update-snapshots',
    '--experimental-test-module-mocks', '--no-experimental-test-module-mocks'].map(name => [name, false]),
  ...['-e', '--eval', '-p', '--print', '--test-concurrency', '--test-timeout',
    '--env-file', '--env-file-if-exists'].map(name => [name, true]),
]);
// Node's options parser types (src/node_options.h OptionType) and the option
// table node inspect walks to find the child script (lib/internal/options.js).
const optionTypes = { kNoOp: 0, kV8Option: 1, kBoolean: 2, kInteger: 3, kUInteger: 4, kString: 5, kHostPort: 6, kStringList: 7 };
function getCLIOptionsInfo() {
  const options = new Map();
  for (const [name, value] of workerOptions) {
    if (!name.startsWith('--') || name.startsWith('--no-')) continue;
    options.set(name, { type: value ? optionTypes.kString : optionTypes.kBoolean });
  }
  const aliases = new Map([
    ['-e', ['--eval']], ['-p', ['--print']], ['-pe', ['--print', '--eval']], ['-r', ['--require']],
    ['-C', ['--conditions']], ['-i', ['--interactive']], ['-c', ['--check']], ['--debug-port', ['--inspect-port']],
  ]);
  return { options, aliases };
}
function processOption(name) {
  return /^--(?:no-)?(?:expose-gc|trace-sigint)$/.test(name) || /^--trace-event(?:s-enabled|-categories|-file-pattern)$/.test(name) || reportOptions.processWideOption(name);
}
function validateWorker(args, explicit) {
  for (let index = 0; index < args.length; index++) {
    const arg = normalizeOption(args[index]), separator = arg.indexOf('=');
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (!workerOptions.has(name) || (separator >= 0 && name[1] !== '-') || (explicit && processOption(name))) {
      if (!explicit) continue;
      throw new Error('Unsupported Worker execArgv option: ' + arg);
    }
    if (inspectorEnableOptions.has(name)) {
      if (separator >= 0) inspectorAddress(arg.slice(separator + 1));
      continue;
    }
    if (!workerOptions.get(name)) {
      if (separator >= 0) throw new Error('invalid value for ' + name);
      continue;
    }
    if ((name === '-p' || name === '--print') && separator < 0 &&
        (args[index + 1] === undefined || args[index + 1].startsWith('-'))) continue;
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (value === undefined || (separator < 0 && isInspectorValueOption(name) && value.startsWith('-')) ||
        ((['--localstorage-file', '-r', '--require', '--import', '-C', '--conditions',
      '--env-file', '--env-file-if-exists', '--watch-path', '--watch-kill-signal'].includes(name) || reportOptions.isValueOption(name) || permission.isValueOption(name)) && value === '')) throw new Error(name + ' requires an argument');
    if (name === '--input-type' && !['commonjs', 'module', 'commonjs-typescript', 'module-typescript'].includes(value))
      throw new Error('--input-type must be "module", "commonjs", "module-typescript" or "commonjs-typescript"');
    if (name === '--test-isolation' && !['process', 'none'].includes(value))
      throw new Error('--test-isolation must be "process" or "none"');
    if (isInspectorValueOption(name)) inspectorAddress(value);
    const error = startupControls.valueError(name, value);
    if (error) throw new Error(error);
  }
}

function environmentFiles(args) {
  const files = [];
  for (let index = 0; index < args.length; index++) {
    const arg = normalizeOption(args[index]);
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) break;
    const separator = arg.indexOf('=');
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (name === '--env-file' || name === '--env-file-if-exists') {
      const path = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (path !== undefined) files.push({ path, optional: name === '--env-file-if-exists' });
    } else if (separator < 0 && (workerOptions.get(name) || name === '-pe' || name === '--experimental-sea-config' || name === '--run')) {
      if ((name === '-p' || name === '--print' || name === '--run') &&
          (args[index + 1] === undefined || args[index + 1].startsWith('-'))) continue;
      index++;
    }
  }
  return files;
}

function loaderWorkerArguments(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const arg = normalizeOption(args[index]), separator = arg.indexOf('=');
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const optionalPrint = (name === '-p' || name === '--print') &&
      (args[index + 1] === undefined || args[index + 1].startsWith('-'));
    const value = separator < 0 && workerOptions.get(name) && !optionalPrint ? args[++index] : undefined;
    // The internal worker gets runtime policy, not entry-point execution or
    // preloads that would recursively register another hook worker.
    // Module mocking is CLI-only, but remains runtime policy in hook workers.
    const moduleMocks = name === '--experimental-test-module-mocks' || name === '--no-experimental-test-module-mocks';
    if ((!environmentOptions.has(name) && !moduleMocks) || processOption(name) ||
        inspectorEnableOptions.has(name) || isInspectorValueOption(name) ||
        ['--no-inspect', '--no-inspect-brk', '--no-inspect-wait'].includes(name) ||
        ['-r', '--require', '--import', '--input-type', '--watch', '--no-watch', '--watch-path',
          '--watch-preserve-output', '--no-watch-preserve-output', '--watch-kill-signal',
          '--experimental-test-coverage', '--no-experimental-test-coverage'].includes(name) ||
        name.startsWith('--test-coverage-')) continue;
    result.push(arg);
    if (value !== undefined) result.push(value);
  }
  return result;
}

function getOptionValue(name) {
  switch (name) {
    case '--enable-source-maps': return !!host.enableSourceMaps;
    case '--trace-sigint': return !!host.traceSigint;
    case '--experimental-stream-iter': return !!host.experimentalStreamIter;
    case '--experimental-vm-modules': return !!host.experimentalVmModules;
    case '--experimental-eventsource': return !!host.experimentalEventSource;
    case '--experimental-webstorage': return !!host.experimentalWebStorage;
    case '--experimental-websocket': return host.experimentalWebSocket !== false;
    case '--frozen-intrinsics': return !!host.frozenIntrinsics;
    case '--zero-fill-buffers': return !!host.zeroFillBuffers;
    case '--experimental-inspector-network-resource': return !!host.experimentalInspectorNetworkResource;
    case '--inspect': return !!host.inspectorOptions?.enabled;
    case '--inspect-brk': return !!host.inspectorOptions?.breakFirst;
    case '--inspect-wait': return !!host.inspectorOptions?.wait;
    case '--inspect-port': return { host: host.inspectorOptions?.host ?? '127.0.0.1', port: host.inspectorOptions?.port ?? 9229 };
    case '--localstorage-file': return host.localStorageFile;
    case '--insecure-http-parser': return !!host.insecureHTTPParser;
    case '--max-http-header-size': return host.maxHTTPHeaderSize ?? 16 * 1024;
    case '--experimental-print-required-tla': return !!host.printRequiredTLA;
    default: return startupControls.getOptionValue(name) ?? tlsOptions.getOptionValue(name);
  }
}

function buildAllowedFlags() {
  // V8 accepts --no-expose-gc but only advertises its positive flag.
  const array = [...environmentOptions.keys()].filter(name => name !== '--no-expose-gc');
  const names = new Set(array);
  const undashed = new Set(array.map(name => name.replace(/^-+/, '')));
  // Keep the actual Set storage empty, as Node does: even borrowed intrinsic
  // mutators cannot change the flags exposed by the public read-only view.
  class NodeEnvironmentFlagsSet extends Set {
    add() { return this; }
    delete() { return false; }
    clear() {}
    has(key) {
      if (typeof key !== 'string') return false;
      key = key.replace(/_/g, '-');
      return key.startsWith('-') ? names.has(key.replace(/=.*$/, '')) : undashed.has(key);
    }
    entries() { return names.entries(); }
    values() { return names.values(); }
    forEach(callback, thisArg) {
      array.forEach(value => Reflect.apply(callback, thisArg, [value, value, this]));
    }
    get size() { return array.length; }
  }
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, Symbol.iterator, { value: NodeEnvironmentFlagsSet.prototype.values });
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, 'keys', { value: NodeEnvironmentFlagsSet.prototype.values });
  Object.freeze(NodeEnvironmentFlagsSet);
  Object.freeze(NodeEnvironmentFlagsSet.prototype);
  return Object.freeze(new NodeEnvironmentFlagsSet());
}

module.exports = { optionTypes, getCLIOptionsInfo, normalizeOption, parseEnvironment, validateEnvironment, validateWorker, processOption, getOptionValue, environmentFiles, loaderWorkerArguments, buildAllowedFlags, applyInspectorOption, isInspectorValueOption };
