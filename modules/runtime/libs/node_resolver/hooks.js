'use strict';

function fail(code, message, Type = TypeError) {
  const error = new Type(message);
  error.code = code;
  return error;
}
function contextObject(value, name) {
  if (value === null || typeof value !== 'object') throw fail('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be an object`);
}
// Node's ERR_INVALID_RETURN_PROPERTY_VALUE: "<loader url> '<hook>'" names a module.register() hook.
function badProperty(expected, hook, property, value) {
  const { ERR_INVALID_RETURN_PROPERTY_VALUE } = require('internal/errors').codes;
  return new ERR_INVALID_RETURN_PROPERTY_VALUE(expected, hook, property, value);
}
function validate(kind, result, advanced, asynchronous, url) {
  if (!asynchronous && result == null) throw new TypeError(`The "${kind}" hook must return an object`);
  if (result === null || typeof result !== 'object' || typeof result.then === 'function') {
    throw fail(asynchronous ? 'ERR_INVALID_RETURN_VALUE' : 'ERR_INVALID_RETURN_PROPERTY_VALUE', `Expected an object to be returned from the "${kind}" hook`);
  }
  if (!advanced && result.shortCircuit !== true) throw fail(asynchronous ? 'ERR_LOADER_CHAIN_INCOMPLETE' : 'ERR_INVALID_RETURN_PROPERTY_VALUE', `"${kind}" did not call the next hook in its chain and did not explicitly signal a short circuit`, asynchronous ? Error : TypeError);
  const hook = url === undefined ? kind : `${url} '${kind}'`;
  if (kind === 'resolve' && (typeof result.url !== 'string' || !URL.canParse(result.url))) throw badProperty('a URL string', hook, 'url', result.url);
  if (kind === 'resolve') {
    if (asynchronous && !('importAttributes' in result) && 'importAssertions' in result) {
      importAssertionWarning();
      result.importAttributes = result.importAssertions;
    }
    if (result.importAttributes !== undefined) contextObject(result.importAttributes, 'importAttributes');
  }
  if (result.format !== undefined && result.format !== null && typeof result.format !== 'string') throw badProperty('a string', hook, 'format', result.format);
  if (kind === 'load') {
    if (typeof result.format !== 'string') throw badProperty('a string', hook, 'format', result.format);
    const source = result.source;
    if (source != null && typeof source !== 'string' && !(source instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer) && !ArrayBuffer.isView(source)) {
      throw badProperty('a string, an ArrayBuffer, or a TypedArray', hook, 'source', source);
    }
  }
  return result;
}
// module.register() hooks still accept the old importAssertions name, with one warning
// (Node's defineImportAssertionAlias).
let importAssertionWarned = false;
function importAssertionWarning() {
  if (importAssertionWarned) return;
  importAssertionWarned = true;
  process.emitWarning('Use `importAttributes` instead of `importAssertions`', 'ExperimentalWarning');
}
function importAssertionAlias(context) {
  return Object.defineProperty(context, 'importAssertions', {
    configurable: true,
    get() { importAssertionWarning(); return this.importAttributes; },
    set(value) { importAssertionWarning(); return Reflect.set(this, 'importAttributes', value); },
  });
}
// Node's Hooks#resolve/#load chain for module.register() hooks (internal/modules/esm/hooks.js):
// next<Hook> functions from nextHookFactory, one shared context that each call assigns into,
// the default hook as the chain's first link, and ERR_LOADER_CHAIN_INCOMPLETE when a hook
// neither calls next nor signals a short circuit.
function asyncChain(records, kind, input, context, terminal) {
  const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_INVALID_RETURN_VALUE,
    ERR_LOADER_CHAIN_INCOMPLETE, ERR_INTERNAL_ASSERTION } } = require('internal/errors');
  const { validateString, validateObject } = require('internal/validators');
  const links = [{ fn: terminal, url: kind === 'resolve' ? 'node:internal/modules/esm/resolve' : 'node:internal/modules/esm/load' }];
  for (const record of records) if (typeof record[kind] === 'function') links.push({ fn: record[kind], url: record.url });
  const meta = { chainFinished: null, context: importAssertionAlias({ ...context }), hookErrIdentifier: '', hookUrl: undefined, shortCircuited: false };
  const validateArgs = kind === 'resolve' ? (identifier, specifier, nextContext) => {
    validateString(specifier, `${identifier} specifier`);
    if (nextContext) validateObject(nextContext, `${identifier} context`);
  } : (identifier, url, nextContext) => {
    if (typeof url !== 'string') throw new ERR_INVALID_ARG_TYPE(`${identifier} url`, 'a URL string', url);
    if (!URL.canParse(url)) throw new ERR_INVALID_ARG_VALUE(`${identifier} url`, url, 'should be a URL string');
    if (nextContext) validateObject(nextContext, `${identifier} context`);
  };
  const validateOutput = (identifier, output) => {
    if (typeof output !== 'object' || output === null) throw new ERR_INVALID_RETURN_VALUE('an object', identifier, output);
  };
  const nextHookName = kind === 'resolve' ? 'nextResolve' : 'nextLoad';
  function nextHookFactory(index) {
    const { fn: hook, url } = links[index];
    const nextNextHook = index > 0 ? nextHookFactory(index - 1) : function chainAdvancedTooFar() {
      throw new ERR_INTERNAL_ASSERTION(`ESM custom loader '${kind}' advanced beyond the end of the chain.`);
    };
    return Object.defineProperty(async (arg0 = undefined, nextContext) => {
      meta.hookErrIdentifier = `${url} '${kind}'`;
      meta.hookUrl = url;
      validateArgs(`${meta.hookErrIdentifier} hook's ${nextHookName}()`, arg0, nextContext);
      const outputErrIdentifier = `${url} '${kind}' hook's ${nextHookName}()`;
      if (index === 0) meta.chainFinished = true;
      if (nextContext) Object.assign(meta.context, nextContext);
      const output = await hook(arg0, meta.context, nextNextHook);
      validateOutput(outputErrIdentifier, output);
      if (output?.shortCircuit === true) meta.shortCircuited = true;
      return output;
    }, 'name', { __proto__: null, value: nextHookName });
  }
  return nextHookFactory(links.length - 1)(input, meta.context).then(result => {
    validateOutput(meta.hookErrIdentifier, result);
    if (result?.shortCircuit === true) meta.shortCircuited = true;
    if (!meta.chainFinished && !meta.shortCircuited) throw new ERR_LOADER_CHAIN_INCOMPLETE(meta.hookErrIdentifier);
    return validate(kind, result, true, true, meta.hookUrl);
  });
}
// module.registerHooks() hooks run synchronously in this thread (customization_hooks.js).
function chain(records, kind, input, context, terminal, asynchronous) {
  if (asynchronous) return asyncChain(records, kind, input, context, terminal);
  const hooks = records.filter(record => typeof record[kind] === 'function');
  function dispatch(index, value, current) {
    if (typeof value !== 'string') throw fail('ERR_INVALID_ARG_TYPE', `The "${kind === 'resolve' ? 'specifier' : 'url'}" argument must be a string`);
    contextObject(current, 'context');
    if (index < 0) return terminal(value, current);
    let advanced = false;
    const next = (nextValue, nextContext) => {
      advanced = true;
      return dispatch(index - 1, nextValue, { ...current, ...nextContext });
    };
    const hook = hooks[index][kind];
    const result = hook(value, current, next);
    return validate(kind, result, advanced, false);
  }
  return dispatch(hooks.length - 1, input, context);
}
function createHooks(defaultResolve, defaultLoad, getThreads, awaitHook, workerStatus, getWorkerExecArgv, getDrainWorker) {
  const synchronous = [];
  const asynchronous = [];
  let remote;
  let local = false;
  class ModuleHooks {
    constructor(record) {
      this.resolve = record.resolve;
      this.load = record.load;
      Object.defineProperty(this, 'record', { value: record });
    }
    deregister() {
      const index = synchronous.indexOf(this.record);
      if (index !== -1) synchronous.splice(index, 1);
    }
  }
  function registerHooks(hooks) {
    contextObject(hooks, 'hooks');
    for (const name of ['resolve', 'load']) if (hooks[name] !== undefined && typeof hooks[name] !== 'function') throw fail('ERR_INVALID_ARG_TYPE', `The "hooks.${name}" argument must be a function`);
    const record = { resolve: hooks.resolve, load: hooks.load };
    const handle = new ModuleHooks(record);
    synchronous.push(record);
    return handle;
  }
  async function asyncRun(kind, input, context) {
    return chain(asynchronous, kind, input, context, kind === 'resolve' ? defaultResolve : defaultLoad, true);
  }
  function run(kind, input, context, allowAsync = true) {
    const terminal = (value, current) => {
      if (allowAsync && local && asynchronous.length) {
        if (typeof awaitHook !== 'function') throw fail('ERR_LOADER_ASYNC_BRIDGE', 'The hook isolate requires a native promise-await bridge', Error);
        return awaitHook(asyncRun(kind, value, current));
      }
      if (allowAsync && remote) return remote.call(kind, { input: value, context: current });
      return (kind === 'resolve' ? defaultResolve : defaultLoad)(value, current);
    };
    return chain(synchronous, kind, input, context, terminal, false);
  }
  function register(specifier, parentURL, options) {
    if (parentURL && typeof parentURL === 'object' && !(parentURL instanceof URL)) { options = parentURL; parentURL = options.parentURL; }
    options = options || {};
    contextObject(options, 'options');
    if (specifier instanceof URL) specifier = specifier.href;
    if (typeof specifier !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "specifier" argument must be a string or URL');
    if (parentURL instanceof URL) parentURL = parentURL.href;
    if (parentURL === undefined) parentURL = options.parentURL || 'data:';
    if (typeof parentURL !== 'string') throw fail('ERR_INVALID_ARG_TYPE', 'The "parentURL" argument must be a string or URL');
    if (local) throw fail('ERR_LOADER_HOOK_REENTRANCY', 'module.register() cannot be called from inside a loader hook', Error);
    if (!remote) remote = require('./hooks_transport').create(getThreads(), workerStatus, getWorkerExecArgv(), getDrainWorker());
    remote.call('register', { specifier, parentURL, data: options.data }, options.transferList);
  }
  return { registerHooks, register, run, asyncRun,
    active: (allowAsync = true) => synchronous.length !== 0 || (allowAsync && (remote !== undefined || (local && asynchronous.length !== 0))),
    hasAsync: () => remote !== undefined || (local && asynchronous.length !== 0),
    inWorker: () => local,
    enterWorker() { local = true; },
    async addAsync(namespace, data, url) {
      for (const name of ['resolve', 'load', 'initialize']) if (namespace[name] !== undefined && typeof namespace[name] !== 'function') throw fail('ERR_INVALID_ARG_TYPE', `The hook export "${name}" must be a function`);
      const { initialize } = namespace;
      if (initialize) await initialize(data);
      asynchronous.push({ resolve: namespace.resolve, load: namespace.load, url });
    },
  };
}
module.exports = { createHooks };
