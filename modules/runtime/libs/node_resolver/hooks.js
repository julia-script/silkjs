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
    if (result.importAttributes !== undefined) contextObject(result.importAttributes, 'importAttributes');
  }
  if (result.format !== undefined && result.format !== null && typeof result.format !== 'string') throw badProperty('a string', hook, 'format', result.format);
  if (kind === 'load') {
    if (typeof result.format !== 'string') throw badProperty('a string', hook, 'format', result.format);
    const source = result.source;
    if (source != null && typeof source !== 'string' && !(source instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer) && !ArrayBuffer.isView(source)) {
      throw fail('ERR_INVALID_RETURN_PROPERTY_VALUE', 'Expected a string, ArrayBuffer or typed array for "source" from the load hook');
    }
  }
  return result;
}
function chain(records, kind, input, context, terminal, asynchronous) {
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
    const result = hooks[index][kind](value, current, next);
    return asynchronous ? Promise.resolve(result).then(value => validate(kind, value, advanced, true, hooks[index].url)) : validate(kind, result, advanced, false);
  }
  return dispatch(hooks.length - 1, input, context);
}
function createHooks(defaultResolve, defaultLoad, getThreads, awaitHook, workerStatus, getWorkerExecArgv) {
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
    if (!remote) remote = require('./hooks_transport').create(getThreads(), workerStatus, getWorkerExecArgv());
    remote.call('register', { specifier, parentURL, data: options.data }, options.transferList);
  }
  return { registerHooks, register, run, asyncRun,
    active: (allowAsync = true) => synchronous.length !== 0 || (allowAsync && (remote !== undefined || (local && asynchronous.length !== 0))),
    hasAsync: () => remote !== undefined || (local && asynchronous.length !== 0),
    inWorker: () => local,
    enterWorker() { local = true; },
    async addAsync(namespace, data, url) {
      for (const name of ['resolve', 'load', 'initialize']) if (namespace[name] !== undefined && typeof namespace[name] !== 'function') throw fail('ERR_INVALID_ARG_TYPE', `The hook export "${name}" must be a function`);
      if (namespace.initialize) await namespace.initialize(data);
      asynchronous.push({ resolve: namespace.resolve, load: namespace.load, url });
    },
  };
}
module.exports = { createHooks };
