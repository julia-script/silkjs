'use strict';

// The runtime's JS emulations of Node's internal bindings, by binding name.
// internalBinding (node_binding.cc getInternalBinding) loads each once and
// returns the same object after, so a patch to a binding is seen by the
// modules that use it. process.binding (internal/bootstrap/realm.js) and
// internal/test/binding both go through it.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const host = require('internal/host');

// node_config.cc: what this build was configured with.
function config() {
  return {
    hasIntl: typeof Intl === 'object',
    hasSmallICU: false,
    hasInspector: !!process.features.inspector,
    noBrowserGlobals: false,
    bits: 64,
    hasOpenSSL: !!process.versions.openssl,
    openSSLIsBoringSSL: false,
    fipsMode: false,
    hasNodeOptions: true,
    isDebugBuild: false,
  };
}

// node_builtins.cc: the builtin sources by id, as natives exposes them.
const kWrapperStart = '(function(module, exports, require, process) {\n';
const kWrapperEnd = '\n})';
function builtins() {
  const natives = { __proto__: null };
  for (let index = 0, count = host.builtinCount(); index < count; index++) {
    let source = host.builtinSource(index);
    if (source.startsWith(kWrapperStart) && source.endsWith(kWrapperEnd)) source = source.slice(kWrapperStart.length, -kWrapperEnd.length);
    natives[host.builtinName(index)] = source;
  }
  natives.config = JSON.stringify(process.config);
  return { natives, builtinIds: Object.keys(natives), configs: JSON.stringify(process.config) };
}

const net = () => require('internal/net/binding');
const kBindings = {
  __proto__: null,
  async_wrap: () => require('internal/async_wrap_binding'),
  buffer: () => require('internal/buffer_binding'),
  constants: () => require('internal/constants_binding'),
  errors: () => require('internal/errors_binding'),
  crypto: () => require('internal/crypto/binding'),
  http2: () => require('internal/http2/binding'),
  // node_http_parser.cc: HTTPParser, ConnectionsList, methods, allMethods.
  http_parser: () => require('internal/http/native-parser'),
  performance: () => require('internal/performance_binding'),
  trace_events: () => require('internal/trace_events_binding'),
  util: () => require('internal/util/binding'),
  // inspector_agent.cc: registerAsyncHook and the asyncTask* calls.
  inspector: () => require('internal/inspector_async'),
  timers: () => require('internal/timers_binding'),
  tls_wrap: () => require('internal/tls/binding'),
  uv: () => require('internal/uv_binding'),
  tcp_wrap: () => net().tcp_wrap,
  pipe_wrap: () => net().pipe_wrap,
  tty_wrap: () => net().tty_wrap,
  stream_wrap: () => net().stream_wrap,
  js_stream: () => net().js_stream,
  cares_wrap: () => require('internal/dns/cares_wrap'),
  // node_process_methods.cc: process.chdir and process.cwd call through these.
  process_methods: () => require('internal/host').processMethods,
  // node_worker.cc: this thread's identity and its control port.
  worker: () => {
    const { isMainThread, isInternalThread, threadId, getEnvMessagePort } = require('internal/worker');
    return { isMainThread, isInternalThread, threadId, getEnvMessagePort };
  },
  // The bindings in process.binding's allowlist that had no other user.
  config: () => config(),
  contextify: () => require('internal/contextify_binding'),
  fs: () => require('internal/fs/binding'),
  fs_event_wrap: () => ({ FSEvent: require('internal/fs/fs_event_wrap').FSEvent }),
  icu: () => require('internal/icu_binding'),
  os: () => require('internal/os_binding'),
  spawn_sync: () => require('internal/child_process').spawn_sync,
  zlib: () => require('internal/compression/handle'),
  builtins: () => builtins(),
  udp_wrap: () => {
    const { UDP, UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT } = require('internal/dgram');
    return { UDP, constants: { UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT } };
  },
};

const bindingObj = { __proto__: null };

function internalBinding(module) {
  let mod = bindingObj[module];
  if (typeof mod !== 'object') {
    const binding = kBindings[module];
    // getInternalBinding (node_binding.cc) throws ERR_INVALID_MODULE.
    if (binding === undefined) throw Object.assign(new Error(`No such binding: ${module}`), { code: 'ERR_INVALID_MODULE' });
    mod = bindingObj[module] = binding();
  }
  return mod;
}

// realm.js: the internal bindings process.binding hands out as they are.
const processBindingAllowList = new Set([
  'buffer', 'cares_wrap', 'config', 'constants', 'contextify', 'fs', 'fs_event_wrap', 'icu', 'inspector',
  'js_stream', 'os', 'pipe_wrap', 'process_wrap', 'spawn_sync', 'stream_wrap', 'tcp_wrap', 'tls_wrap',
  'tty_wrap', 'udp_wrap', 'uv', 'zlib',
]);
const legacyWrapperList = new Set(['natives', 'util']);
// lib/internal/legacy/processbinding.js: a new object on each call.
const kUtilTypes = ['isArrayBuffer', 'isArrayBufferView', 'isAsyncFunction', 'isDataView', 'isDate',
  'isExternal', 'isMap', 'isMapIterator', 'isNativeError', 'isPromise', 'isRegExp', 'isSet',
  'isSetIterator', 'isTypedArray', 'isUint8Array', 'isAnyArrayBuffer'];
const legacy = {
  util() {
    const { types } = require('util');
    return Object.fromEntries(Object.entries(types).filter(({ 0: key }) => kUtilTypes.includes(key)));
  },
  natives() {
    const { natives: result, configs } = internalBinding('builtins');
    result.configs = configs;
    return result;
  },
};

// realm.js process.binding. Its runtimeDeprecatedList is empty; the DEP0111
// wrapper for --pending-deprecation is added by bootstrap.
function processBinding(module) {
  module = String(module);
  if (legacyWrapperList.has(module)) return legacy[module]();
  if (processBindingAllowList.has(module)) return internalBinding(module);
  throw new Error(`No such module: ${module}`);
}

module.exports = { internalBinding, processBinding };
