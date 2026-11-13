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
    // node_config.cc GetDefaultLocale: the locale Intl falls back to (ICU's default there).
    getDefaultLocale() { return new Intl.DateTimeFormat().resolvedOptions().locale; },
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
  const builtinIds = Object.keys(natives);
  // BuiltinLoader::GetBuiltinCategories: what a require() of the id may load. The
  // runtime's own entry points, contexts and bundled deps cannot, nor can the modules
  // Node leaves out of the list for needing a flag or warning on load.
  const cannotBeRequired = new Set(), canBeRequired = new Set();
  for (const id of builtinIds) {
    if (id === 'config') continue;
    const internal = /^internal\/(?:bootstrap|main|per_context|deps)\//.test(id) || id === 'internal/test/binding' || id === 'internal/v8_prof_polyfill';
    (internal || kNotRequirable.has(id) ? cannotBeRequired : canBeRequired).add(id);
  }
  return {
    natives, builtinIds, configs: JSON.stringify(process.config),
    builtinCategories: { cannotBeRequired, canBeRequired },
    // BuiltinLoader::GetCacheUsage. No built-in runs from a code cache: each was compiled
    // from its source, into the startup image or when first required.
    getCacheUsage() {
      const compiledWithoutCache = new Set();
      for (const entry of process.moduleLoadList) if (entry.startsWith('NativeModule ')) compiledWithoutCache.add(entry.slice(13));
      return { compiledWithCache: new Set(), compiledWithoutCache, compiledInSnapshot: [] };
    },
  };
}
const kNotRequirable = new Set(['quic', 'sqlite', 'stream/iter', 'sys', 'wasi', 'zlib/iter']);

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
  // inspector_agent.cc: registerAsyncHook, the asyncTask* calls, isEnabled and url.
  inspector: () => require('internal/inspector_binding'),
  timers: () => require('internal/timers_binding'),
  tls_wrap: () => require('internal/tls/binding'),
  uv: () => require('internal/uv_binding'),
  tcp_wrap: () => net().tcp_wrap,
  pipe_wrap: () => net().pipe_wrap,
  tty_wrap: () => net().tty_wrap,
  stream_wrap: () => net().stream_wrap,
  js_stream: () => net().js_stream,
  cares_wrap: () => require('internal/dns/cares_wrap'),
  // node_ipc_serdes.cc: the 'advanced' child_process IPC codec.
  ipc_serdes: () => {
    const { serializeIPC, deserializeIPC } = require('internal/serialization/v8');
    return { serialize: value => serializeIPC(value), deserialize: bytes => deserializeIPC(bytes) };
  },
  // node_process_methods.cc: process.chdir and process.cwd call through these.
  process_methods: () => require('internal/host').processMethods,
  // node_credentials.cc: SafeGetenv reads the process environment, which process.env
  // reads and writes through.
  credentials: () => ({
    safeGetenv: key => process.env[key],
    implementsPosixCredentials: typeof process.getuid === 'function',
  }),
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
  // node_modules.cc: package.json reads and package scopes, as the loader keeps them.
  modules: () => require('internal/modules_binding'),
  // node_options.cc: the option table, by type and by environment setting.
  options: () => {
    const { optionTypes, envVarSettings, getCLIOptionsInfo } = require('internal/options');
    return { types: optionTypes, envSettings: envVarSettings, getCLIOptionsInfo };
  },
  signal_wrap: () => ({ Signal: require('internal/signal_wrap').Signal }),
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
// Filled by index: this module loads on first use, after user code may have
// replaced %Array.prototype%[@@iterator], which new Set(array) would call.
const processBindingAllowList = new Set();
{
  const names = ['buffer', 'cares_wrap', 'config', 'constants', 'contextify', 'fs', 'fs_event_wrap', 'icu', 'inspector',
    'js_stream', 'os', 'pipe_wrap', 'process_wrap', 'spawn_sync', 'stream_wrap', 'tcp_wrap', 'tls_wrap',
    'tty_wrap', 'udp_wrap', 'uv', 'zlib'];
  for (let i = 0; i < names.length; i++) processBindingAllowList.add(names[i]);
}
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
