'use strict';

// V8's command line API (src/inspector/v8-console.cc installCommandLineAPI) with
// Node's require (lib/internal/util/inspector.js installConsoleExtensions).
// While an evaluation asks for it, V8's CommandLineAPIScope defines each name the
// global object lacks as an accessor there and removes it afterwards; assigning
// one replaces the accessor with a plain property (accessorSetterCallback).

function commandLineAPI(session, contextId, consoleBridge) {
  const inspectRequested = (object, hints) => {
    session.emit('Runtime.inspectRequested', { object: session.values.remote(object, undefined), hints, executionContextId: contextId });
  };
  const api = {
    __proto__: null,
    dir(...args) { consoleBridge.emitConsole('dir', args); },
    dirxml(...args) { consoleBridge.emitConsole('dirxml', args); },
    table(...args) { consoleBridge.emitConsole('table', args); },
    clear() { consoleBridge.emitConsole('clear', []); },
    profile(title) { return consoleBridge.console.profile(title); },
    profileEnd(title) { return consoleBridge.console.profileEnd(title); },
    // V8 keysCallback/valuesCallback: own enumerable string keys of an object.
    keys(object) { return object !== null && (typeof object === 'object' || typeof object === 'function') ? Object.keys(object) : []; },
    values(object) {
      if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return [];
      return Object.keys(object).map(key => object[key]);
    },
    inspect(object) { if (arguments.length) inspectRequested(object, {}); },
    copy(object) { if (arguments.length) inspectRequested(object, { copyToClipboard: true }); },
    queryObjects(object) {
      if (!arguments.length) return;
      if (typeof object === 'function') {
        const prototype = object.prototype;
        if (prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function')) object = prototype;
      }
      inspectRequested(object, { queryObjects: true });
    },
    debug(fn, condition) { require('internal/inspector_debugger').debugFunction(session, fn, condition); },
    undebug(fn) { require('internal/inspector_debugger').undebugFunction(session, fn); },
    get $_() { return session.lastEvaluationResult; },
    // Node never adds inspected objects (addInspectedObject).
    $0: undefined, $1: undefined, $2: undefined, $3: undefined, $4: undefined,
  };
  let required;
  Object.defineProperty(api, 'require', {
    __proto__: null,
    enumerable: true,
    get() {
      if (required) return required;
      const { createRequire } = require('module');
      const path = require('path');
      let cwd;
      try { cwd = process.cwd(); } catch { cwd = path.sep; }
      return (required = createRequire(path.join(cwd, '<inspector console>')));
    },
  });
  return api;
}

function install(global, api) {
  const installed = [];
  for (const name of Object.keys(api)) {
    if (name in global) continue;
    const descriptor = {
      __proto__: null,
      configurable: true,
      enumerable: false,
      get() { return api[name]; },
      set(value) {
        delete global[name];
        Object.defineProperty(global, name, { __proto__: null, value, writable: true, configurable: true, enumerable: true });
      },
    };
    Object.defineProperty(global, name, descriptor);
    installed.push([name, descriptor.get]);
  }
  return () => {
    for (const [name, getter] of installed) {
      const current = Object.getOwnPropertyDescriptor(global, name);
      if (current && current.get === getter) delete global[name];
    }
  };
}

module.exports = { commandLineAPI, install };
