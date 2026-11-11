'use strict';

const host = require('internal/host');
const reportOptions = require('internal/process_report');
const startupControls = require('internal/startup_controls');
const permission = require('internal/permission');

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
  ...permission.optionEntries,
  ...[...inspectorEnableOptions, '--no-inspect', '--no-inspect-brk', '--no-inspect-wait',
    '--experimental-inspector-network-resource', '--no-experimental-inspector-network-resource'].map(name => [name, false]),
  ['--inspect-port', true], ['--debug-port', true],
  ...['--watch', '--no-watch', '--watch-preserve-output', '--no-watch-preserve-output'].map(name => [name, false]),
  ...['--watch-path', '--watch-kill-signal'].map(name => [name, true]),
  ...['--experimental-test-coverage', '--no-experimental-test-coverage'].map(name => [name, false]),
  ...['--test-coverage-include', '--test-coverage-exclude', '--test-coverage-lines',
    '--test-coverage-branches', '--test-coverage-functions'].map(name => [name, true]),
  ...['--insecure-http-parser', '--no-insecure-http-parser', '--async-context-frame',
    '--no-async-context-frame', '--expose-gc', '--no-expose-gc',
    '--trace-events-enabled', '--test-only', '--experimental-eventsource',
    '--no-experimental-eventsource', '--experimental-webstorage',
    '--no-experimental-webstorage', '--experimental-stream-iter',
    '--no-experimental-stream-iter', '--preserve-symlinks', '--no-preserve-symlinks',
    '--preserve-symlinks-main', '--no-preserve-symlinks-main',
    '--experimental-vm-modules', '--no-experimental-vm-modules',
    '--enable-source-maps', '--no-enable-source-maps',
    '--trace-sigint', '--no-trace-sigint',
    '--strip-types', '--no-strip-types', '--experimental-strip-types', '--no-experimental-strip-types',
    '--experimental-transform-types', '--no-experimental-transform-types'].map(name => [name, false]),
  ...['--trace-event-categories', '--trace-event-file-pattern', '--input-type',
    '--test-isolation', '--test-name-pattern', '--test-skip-pattern', '--test-shard',
    '--test-reporter', '--test-reporter-destination', '--localstorage-file',
    '-r', '--require', '--import', '-C', '--conditions'].map(name => [name, true]),
]);

function normalizeOption(arg) {
  const separator = arg.indexOf('=');
  const name = (separator < 0 ? arg : arg.slice(0, separator)).replace(/_/g, '-');
  // Node-owned booleans ignore an attached value. V8-style GC flags reject it.
  if (separator < 0 || (name.startsWith('--') && workerOptions.get(name) === false &&
      !inspectorEnableOptions.has(name) && !/^--(?:no-)?expose-gc$/.test(name))) return name;
  return name + arg.slice(separator);
}

const table = require('internal/options_table');
function impliedBy(name) {
  const implied = [];
  for (const [from, to] of table.implications) if (from === name && to.startsWith('--')) implied.push(to);
  return implied;
}
// Node's OptionsParser::Parse (src/node_options-inl.h) over the option table of
// the reference release. Each entry is { name, type, value, negated, raw }, with
// name canonical (aliases expanded, `_` read as `-`, `--no-` removed), type from
// the table (undefined for an option Node passes to V8 unknown), raw the
// argument as written and implied set for an option another one implies.
// execArgv holds the arguments taken from args as written, without `--`, and
// index is where the script and its arguments start.
function parseArguments(args, inEnvironment) {
  const entries = [], execArgv = [], synthetic = [];
  let index = 0, error;
  const empty = () => synthetic.length === 0 && index >= args.length;
  const first = () => synthetic.length !== 0 ? synthetic[0] : args[index];
  const pop = () => {
    if (synthetic.length !== 0) return synthetic.shift();
    const arg = args[index++];
    if (arg !== '--') execArgv.push(arg);
    return arg;
  };
  while (!empty() && error === undefined) {
    const next = first();
    if (next.length <= 1 || next[0] !== '-') break;
    const arg = pop();
    if (arg === '--') {
      if (inEnvironment) error = '-- is not allowed in NODE_OPTIONS';
      break;
    }
    // Only options with two dashes take --name=value.
    const equals = arg[1] === '-' ? arg.indexOf('=') : -1;
    let name = equals < 0 ? arg : arg.slice(0, equals);
    const originalName = equals < 0 ? name : name + '=';
    name = name.slice(0, 2) + name.slice(2).replace(/_/g, '-');
    let negated = false;
    if (name.startsWith('--no-')) {
      name = '--' + name.slice(5);
      negated = true;
    }
    for (;;) {
      let expansion = table.aliases.get(name);
      if (expansion === undefined && equals >= 0) expansion = table.aliases.get(name + '=');
      if (expansion === undefined && !empty() && first() !== '' && first()[0] !== '-') expansion = table.aliases.get(name + ' <arg>');
      if (expansion === undefined) break;
      const previous = name;
      name = expansion[0];
      synthetic.unshift(...expansion.slice(1));
      if (name === previous) break;
    }
    const info = table.options.get(name);
    if ((info === undefined || !info[1]) && inEnvironment) {
      error = `${originalName} is not allowed in NODE_OPTIONS`;
      break;
    }
    if (!negated) for (const implied of impliedBy(name)) {
      const target = table.options.get(implied);
      if (target) entries.push({ name: implied, type: target[0], value: true, negated: false, raw: implied, implied: true });
    }
    if (info === undefined) {
      entries.push({ name, type: undefined, value: undefined, negated, raw: arg });
      continue;
    }
    const type = info[0];
    // Some V8 options can be negated: V8 validates them.
    if (negated && type !== 'Boolean' && type !== 'V8Option') {
      error = `${arg} is an invalid negation because it is not a boolean option`;
      break;
    }
    let value;
    if (type !== 'Boolean' && type !== 'NoOp' && type !== 'V8Option') {
      // --run alone lists the package scripts: it does not take a later flag.
      const optional = name === '--run';
      value = '';
      if (equals >= 0) {
        value = arg.slice(equals + 1);
        if (value === '' && !optional) { error = `${originalName} requires an argument`; break; }
      } else if (empty() || (optional && first()[0] === '-')) {
        if (!optional) { error = `${originalName} requires an argument`; break; }
      } else {
        value = pop();
        if (value !== '' && value[0] === '-') { error = `${originalName} requires an argument`; break; }
        // \- escapes a leading dash.
        if (value[0] === '\\' && value[1] === '-') value = value.slice(1);
      }
    }
    entries.push({ name, type, value: type === 'Boolean' ? !negated : value, negated, raw: arg });
  }
  return { entries, execArgv, index, error };
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

// NODE_OPTIONS as parsed: the number of leading arguments that are options.
function validateEnvironment(args, errors) {
  if (errors?.length) return 0;
  const parsed = parseArguments(args, true);
  if (parsed.error === undefined) return parsed.index;
  report(new Error(parsed.error), errors);
  return 0;
}

const workerOptions = new Map([
  ...environmentOptions,
  ...['-i', '--interactive', '--test', '-c', '--check', '--no-print',
    '--test-update-snapshots', '--no-test-update-snapshots',
    '--experimental-test-module-mocks', '--no-experimental-test-module-mocks'].map(name => [name, false]),
  ...['-e', '--eval', '-p', '--print', '--test-concurrency', '--test-timeout',
    '--env-file', '--env-file-if-exists'].map(name => [name, true]),
]);
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
    default: return startupControls.getOptionValue(name);
  }
}

// Node's process.allowedNodeEnvironmentFlags (lib/internal/process/per_thread.js).
function buildAllowedFlags() {
  const array = [];
  for (const [name, [type, allowed]] of table.options) {
    // Bracketed names are internal parser targets for aliases, not flags.
    if (!allowed || name[0] === '[') continue;
    array.push(name);
    if (type === 'Boolean') array.push('--no-' + name.slice(2));
  }
  const accepted = to => {
    if (!to.startsWith('-') || to === '--') return true;
    const expansion = table.aliases.get(to);
    if (expansion) return (expansion[0] === to ? expansion.slice(1) : expansion).every(accepted);
    return table.options.get(to)?.[1] === true;
  };
  for (const [from, expansion] of table.aliases) {
    if (!expansion.every(accepted)) continue;
    let canonical = from;
    if (canonical.endsWith('=')) canonical = canonical.slice(0, -1);
    if (canonical.endsWith(' <arg>')) canonical = canonical.slice(0, -6);
    array.push(canonical);
  }
  // has() takes a flag with or without its dashes, `_` for `-` and an =value.
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

module.exports = { parseArguments, normalizeOption, parseEnvironment, validateEnvironment, validateWorker, processOption, getOptionValue, environmentFiles, loaderWorkerArguments, buildAllowedFlags, applyInspectorOption, isInspectorValueOption };
