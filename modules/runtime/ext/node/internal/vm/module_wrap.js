'use strict';
// The JS side of Node.js v24's internalBinding('module_wrap') ModuleWrap
// (src/module_wrap.cc) for vm modules. Each wrap owns an engine VM module handle
// (src/ext/vm_native.silk moduleOperation) in the realm of its context, and keeps
// what Node's C++ wrap keeps: the url, the linked requests, the resolve cache that
// coalesces requests by specifier and attributes, and the module source object.
const host = require('internal/host');
const { contextData, error, syntaxDiagnostic, terminationErrors, run } = require('internal/vm');
const { codes: { ERR_MODULE_LINK_MISMATCH,
  ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG } } = require('internal/errors');

// v8::Module::Status, which the engine's status operation reports.
const kUninstantiated = 0;
const kInstantiating = 1;
const kInstantiated = 2;
const kEvaluating = 3;
const kEvaluated = 4;
const kErrored = 5;
// Node's ModulePhase.
const kSourcePhase = 1;
const kEvaluationPhase = 2;

// The engine's VM module operations.
const COMPILE = 0, SYNTHETIC = 1, ADD_EXPORT = 2, REQUEST_COUNT = 3, REQUEST = 4,
  LINK_REQUEST = 5, INSTANTIATE = 6, NAMESPACE = 7, STATUS = 8, ERROR = 9, SET_EXPORT = 10,
  IMPORT_META = 11, TOP_LEVEL_AWAIT = 12, LINK_SOURCE = 13;
const REQUEST_SPECIFIER = 0, REQUEST_ATTRIBUTES = 1, REQUEST_PHASE = 2;

// Node's C++ THROW_ERR_VM_MODULE_LINK_FAILURE: a plain Error with a code, no cause.
function linkFailure(message) { return error('ERR_VM_MODULE_LINK_FAILURE', message, Error); }
function moduleNotInstantiated() { return error('ERR_MODULE_NOT_INSTANTIATED', 'Module is not instantiated', Error); }
function sourcePhaseNotDefined(url) {
  return error('ERR_SOURCE_PHASE_NOT_DEFINED', `Source phase import object is not defined for module '${url}'`, SyntaxError);
}
// ModuleCacheKey: the specifier and the attributes, in their source order.
function cacheKey(request) {
  const names = Object.keys(request.attributes);
  return { id: JSON.stringify([request.specifier, ...names.flatMap(name => [name, request.attributes[name]])]),
    text: `ModuleCacheKey("${request.specifier}"${names.length ? `, {${names.map(name => `${name}: ${request.attributes[name]}`).join(', ')}}` : ''})` };
}

class ModuleWrap {
  #handle;
  #realm;
  #requests = [];
  #resolveCache = new Map();
  #linkedRequests;
  #linked = false;
  #sourceObject;
  #terminated = false;

  // new ModuleWrap(url, context, sourceText, lineOffset, columnOffset, cachedData)
  // new ModuleWrap(url, context, exportNames, evaluationSteps)
  constructor(url, context, source, lineOffset, columnOffset, cachedData) {
    const realm = context === undefined ? undefined : contextData(context);
    this.#realm = realm;
    const synthetic = Array.isArray(source);
    if (synthetic) {
      const steps = lineOffset;
      this.#handle = host.vmModule(SYNTHETIC, url, realm && realm.handle, () => Reflect.apply(steps, this, []));
      for (const name of source) host.vmModule(ADD_EXPORT, this.#handle, name);
      this.#linked = true;
    } else {
      try { this.#handle = host.vmModule(COMPILE, source, url, realm && realm.handle, lineOffset, columnOffset); }
      catch (cause) { syntaxDiagnostic(cause, source, url, lineOffset, columnOffset); }
      // The engine has no bytecode cache for modules (createCachedData says so), so
      // no cachedData can match this source: V8 rejects such a cache the same way.
      if (cachedData !== undefined) throw error('ERR_VM_MODULE_CACHED_DATA_REJECTED', 'cachedData buffer was rejected', Error);
      const count = host.vmModule(REQUEST_COUNT, this.#handle);
      for (let i = 0; i < count; i++) {
        const attributes = Object.freeze(Object.assign(Object.create(null), host.vmModule(REQUEST, this.#handle, i, REQUEST_ATTRIBUTES)));
        const request = Object.freeze(Object.assign(Object.create(null), {
          specifier: host.vmModule(REQUEST, this.#handle, i, REQUEST_SPECIFIER), attributes,
          phase: host.vmModule(REQUEST, this.#handle, i, REQUEST_PHASE) ? kSourcePhase : kEvaluationPhase,
        }));
        this.#requests.push(request);
        const key = cacheKey(request).id;
        if (!this.#resolveCache.has(key)) this.#resolveCache.set(key, i);
      }
      this.hasTopLevelAwait = host.vmModule(TOP_LEVEL_AWAIT, this.#handle);
      this.sourceURL = undefined;
      this.sourceMapURL = undefined;
    }
    this.synthetic = synthetic;
    this.url = url;
  }

  getModuleRequests() {
    return this.#requests.map(request => Object.freeze(Object.assign(Object.create(null), request)));
  }

  link(modules) {
    for (let i = 0; i < this.#requests.length; i++) {
      const key = cacheKey(this.#requests[i]);
      const coalesced = this.#resolveCache.get(key.id);
      if (modules[i] !== modules[coalesced]) {
        throw new ERR_MODULE_LINK_MISMATCH(
          `Module request '${key.text}' at index ${i} must be linked to the same module requested at index ${coalesced}`);
      }
    }
    this.#linkedRequests = Array.from(modules);
    this.#linked = true;
  }

  // V8 InstantiateModule resolves every request of each not yet instantiated
  // module of the graph through Node's ResolveModule/ResolveSourceCallback.
  #resolve(visited) {
    if (visited.has(this)) return;
    visited.add(this);
    if (this.getStatus() >= kInstantiated) return;
    for (let i = 0; i < this.#requests.length; i++) {
      const request = this.#requests[i];
      if (!this.#linked) {
        throw linkFailure(`request for '${request.specifier}' can not be resolved on module '${this.url}' that is not linked`);
      }
      const dependency = this.#linkedRequests[i];
      if (request.phase === kSourcePhase) {
        host.vmModule(LINK_SOURCE, this.#handle, i, dependency.getModuleSourceObject());
        continue;
      }
      host.vmModule(LINK_REQUEST, this.#handle, i, dependency.#handle);
      dependency.#resolve(visited);
    }
  }

  instantiate() {
    if (!this.#linked) throw linkFailure('module is not linked');
    this.#resolve(new Set());
    host.vmModule(INSTANTIATE, this.#handle);
  }

  #terminate(visited) {
    if (visited.has(this)) return;
    visited.add(this);
    if (this.getStatus() === kErrored) this.#terminated = true;
    for (const dependency of this.#linkedRequests || []) dependency.#terminate(visited);
  }

  // As in Node, the engine's own evaluation promise: already settled when the module
  // (or a synthetic one's evaluation step) finished synchronously.
  evaluate(timeout, breakOnSigint) {
    if (this.#terminated) throw null;
    let result;
    try {
      result = run(this.#handle, { timeout: timeout === -1 ? 0 : timeout, breakOnSigint },
        this.#realm ? this.#realm.afterEvaluate : false, false);
    } catch (cause) {
      // A timeout or SIGINT ends evaluation without an exception for the module:
      // the errored modules it leaves report null as their error, as in V8.
      if (terminationErrors.has(cause)) this.#terminate(new Set());
      throw cause;
    }
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  getNamespace() {
    if (this.getStatus() < kInstantiated) throw moduleNotInstantiated();
    return host.vmModule(NAMESPACE, this.#handle);
  }

  getStatus() { return host.vmModule(STATUS, this.#handle); }

  getError() { return this.#terminated ? null : host.vmModule(ERROR, this.#handle); }

  setExport(name, value) {
    if (!host.vmModule(SET_EXPORT, this.#handle, name, value)) throw new ReferenceError(`Export '${name}' is not defined in module`);
  }

  get hasAsyncGraph() {
    if (this.getStatus() < kInstantiated) throw moduleNotInstantiated();
    const seen = new Set();
    const pending = [this];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (current.hasTopLevelAwait) return true;
      const requests = current.#requests;
      for (let i = 0; i < requests.length; i++) {
        if (requests[i].phase === kEvaluationPhase && current.#linkedRequests) pending.push(current.#linkedRequests[i]);
      }
    }
    return false;
  }

  setModuleSourceObject(object) { this.#sourceObject = object; }

  getModuleSourceObject() {
    if (this.#sourceObject === undefined) throw sourcePhaseNotDefined(this.url);
    return this.#sourceObject;
  }

  createCachedData() {
    throw error('ERR_NOT_IMPLEMENTED', 'vm module cached data is not supported by this runtime', Error);
  }

  // internal/modules/esm/utils registerModule for a vm module: the host callbacks
  // for its import.meta and its dynamic import().
  static register(wrap, registry) {
    const handle = wrap.#handle;
    if (registry.initializeImportMeta !== undefined) {
      host.vmModule(IMPORT_META, handle, meta => registry.initializeImportMeta(meta, registry.callbackReferrer));
    }
    host.vmSetImportModuleDynamically(handle, async (specifier, attributes, sourcePhase) => {
      if (registry.importModuleDynamically === undefined) throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING();
      if (!host.experimentalVmModules) throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG();
      return registry.importModuleDynamically(specifier, registry.callbackReferrer,
        attributes || Object.create(null), sourcePhase ? kSourcePhase : kEvaluationPhase);
    });
  }
}

function registerModule(wrap, registry) { ModuleWrap.register(wrap, registry); }

module.exports = {
  ModuleWrap, registerModule,
  kUninstantiated, kInstantiating, kInstantiated, kEvaluating, kEvaluated, kErrored,
  kSourcePhase, kEvaluationPhase,
};
