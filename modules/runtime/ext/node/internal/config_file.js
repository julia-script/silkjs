'use strict';

// Node's --experimental-config-file reader (src/node_config_file.cc ConfigReader
// and its use in node.cc ProcessGlobalArgsInternal): a JSON object whose
// "nodeOptions" become NODE_OPTIONS text and whose namespaces ("test", "watch",
// "permission") become flags parsed before the command line. Diagnostics go to
// stderr as they are found; the caller reports the returned errors and exits 9.
const host = require('internal/host');
const table = require('internal/options_table');

const kConfigFileFlag = '--experimental-config-file';
const kDefaultConfigFileFlag = '--experimental-default-config-file';
const kDefaultConfigFileName = 'node.config.json';
const kSchemaField = '$schema';

function diagnostic(text) { host.writeText(2, text + '\n'); }

// ConfigReader::GetDataFromArgs: rewrites the bare flags in args to name the
// default file and returns the last file named, or undefined.
function configPath(args) {
  let result, invalidDefault = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === kConfigFileFlag || arg === kDefaultConfigFileFlag) {
      args[index] = kConfigFileFlag + '=' + kDefaultConfigFileName;
      result = kDefaultConfigFileName;
    } else if (arg.startsWith(kConfigFileFlag + '=') && arg.length > kConfigFileFlag.length + 1) {
      result = arg.slice(kConfigFileFlag.length + 1);
    } else if (arg.startsWith(kDefaultConfigFileFlag + '=') && arg.length > kDefaultConfigFileFlag.length + 1) {
      invalidDefault = true;
    }
  }
  return { path: result, invalidDefault };
}

// The members of the JSON object text[start] opens, in order and with repeated
// keys kept (simdjson's on-demand fields): [key, start, end] of each value.
function members(text, start) {
  const result = [];
  let index = skip(text, start + 1);
  if (text[index] === '}') return result;
  for (;;) {
    const keyEnd = valueEnd(text, index);
    const key = JSON.parse(text.slice(index, keyEnd));
    index = skip(text, keyEnd) + 1;
    const valueStart = skip(text, index);
    const end = valueEnd(text, valueStart);
    result.push([key, valueStart, end]);
    index = skip(text, end);
    if (text[index] === '}') return result;
    index = skip(text, index + 1);
  }
}
function skip(text, index) {
  while (index < text.length && ' \t\n\r'.includes(text[index])) index++;
  return index;
}
// The end of the (already validated) JSON value at index.
function valueEnd(text, index) {
  const first = text[index];
  if (first === '"') {
    for (let at = index + 1; ; at++) {
      if (text[at] === '\\') at++;
      else if (text[at] === '"') return at + 1;
    }
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let at = index; ; at++) {
      const char = text[at];
      if (char === '"') { at = valueEnd(text, at) - 1; continue; }
      if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) return at + 1;
    }
  }
  let at = index;
  while (at < text.length && !',}] \t\n\r'.includes(text[at])) at++;
  return at;
}

// ConfigReader::ProcessOptionValue: the flags one option's JSON value stands for.
function optionFlags(name, type, value, raw, output) {
  const invalid = () => { diagnostic(`Invalid value for ${name}`); return false; };
  switch (type) {
    case 'Boolean':
      if (typeof value !== 'boolean') return invalid();
      output.push(value ? name : '--no-' + name.slice(2));
      return true;
    case 'StringList':
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item !== 'string') return invalid();
          output.push(name + '=' + item);
        }
        return true;
      }
      if (typeof value !== 'string') return invalid();
      output.push(name + '=' + value);
      return true;
    case 'String':
      if (typeof value !== 'string') return invalid();
      output.push(name + '=' + value);
      return true;
    case 'Integer':
      // get_int64: an integer literal, without fraction or exponent.
      if (typeof value !== 'number' || !/^-?\d+$/.test(raw)) return invalid();
      output.push(name + '=' + raw);
      return true;
    case 'HostPort':
    case 'UInteger':
      if (typeof value !== 'number' || !/^\d+$/.test(raw)) return invalid();
      output.push(name + '=' + raw);
      return true;
    case 'NoOp':
      diagnostic(`No-op flag ${name} is currently not supported`);
      return false;
    case 'V8Option':
      diagnostic(`V8 flag ${name} is currently not supported`);
      return false;
  }
  return invalid();
}

// ConfigReader::ParseConfig: { nodeOptions, namespaceFlags } or a result the
// caller turns into "<path>: invalid content" / "<path>: not found".
function parseConfig(path) {
  let text;
  try { text = host.Buffer.from(host.readFile(path)).toString('utf8'); }
  catch (error) {
    diagnostic(`Cannot read configuration from ${path}: ${require('util').getSystemErrorMessage(error.errno)}`);
    return { status: 'not found' };
  }
  let document;
  try { document = JSON.parse(text); }
  catch {
    diagnostic(`Can't parse ${path}`);
    return { status: 'invalid content' };
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    diagnostic(`Root value unexpected not an object for ${path}\n`);
    return { status: 'invalid content' };
  }
  const namespaces = new Set(['test', 'watch', 'permission', 'nodeOptions']);
  const unique = new Set();
  const nodeOptions = [], namespaceFlags = [];
  for (const [namespace, start, end] of members(text, skip(text, 0))) {
    if (namespace === 'testRunner') {
      diagnostic('the "testRunner" namespace has been removed. Use "test" instead.');
      return { status: 'invalid content' };
    }
    if (namespace === kSchemaField) continue;
    if (!namespaces.has(namespace)) {
      diagnostic(`Unknown namespace ${namespace}`);
      return { status: 'invalid content' };
    }
    if (text[start] !== '{') {
      diagnostic(`"${namespace}" value unexpected for ${path} (should be an object)`);
      return { status: 'invalid content' };
    }
    // nodeOptions take what NODE_OPTIONS may hold; a namespace its own options.
    const output = namespace === 'nodeOptions' ? nodeOptions : namespaceFlags;
    for (const [key, valueStart, valueEnd] of members(text, start)) {
      const name = '--' + key;
      const info = table.options.get(name);
      const known = info !== undefined && (namespace === 'nodeOptions' ? info[1] === true : info[4] === namespace);
      if (!known) {
        diagnostic(`Unknown or not allowed option ${key} for namespace ${namespace}`);
        return { status: 'invalid content' };
      }
      if (unique.has(name)) {
        diagnostic(`Option ${name} is already defined`);
        return { status: 'invalid content' };
      }
      unique.add(name);
      const raw = text.slice(valueStart, valueEnd);
      if (!optionFlags(name, info[0], JSON.parse(raw), raw, output)) return { status: 'invalid content' };
    }
  }
  return { status: 'valid', nodeOptions, namespaceFlags };
}

// node.cc: reads the file args name. errors are the messages node prints after
// the program name; nodeOptions is the NODE_OPTIONS text the file contributes.
function read(args) {
  const { path, invalidDefault } = configPath(args);
  if (invalidDefault) return { errors: ['--experimental-default-config-file does not take an argument'] };
  if (path === undefined) return undefined;
  const errors = [];
  const parsed = parseConfig(path);
  if (parsed.status !== 'valid') errors.push(`${path}: ${parsed.status}`);
  const flags = parsed.nodeOptions ?? [];
  const nodeOptions = flags.map(flag => ' ' + flag).join('');
  // A value with a space would split into more flags than the file named.
  let split;
  try { split = require('internal/options').parseEnvironment(nodeOptions); } catch (error) { errors.push(error.message); split = flags; }
  if (split.length !== flags.length)
    errors.push("The number of NODE_OPTIONS doesn't match the number of flags in the config file");
  return { errors, nodeOptions, namespaceFlags: parsed.namespaceFlags ?? [] };
}

module.exports = { read };
