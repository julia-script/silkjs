'use strict';

// The runtime's JS emulations of Node's internalBinding() modules, only for the
// bindings that have one: any other name throws as Node's internalBinding does
// for an unknown binding. internal/test/binding and process.binding read them.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

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
  // node_process_methods.cc: process.chdir and process.cwd call through these.
  process_methods: () => require('internal/host').processMethods,
  // node_worker.cc: this thread's identity and its control port.
  worker: () => {
    const { isMainThread, isInternalThread, threadId, getEnvMessagePort } = require('internal/worker');
    return { isMainThread, isInternalThread, threadId, getEnvMessagePort };
  },
  udp_wrap: () => {
    const { UDP, UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT } = require('internal/dgram');
    return { UDP, constants: { UV_UDP_IPV6ONLY, UV_UDP_REUSEADDR, UV_UDP_REUSEPORT } };
  },
};

function internalBinding(module) {
  const binding = kBindings[module];
  if (binding === undefined) throw new Error(`No such binding: ${module}`);
  return binding();
}


// lib/internal/bootstrap/realm.js: what process.binding() still gives out.
const processBindingAllowList = new Set([
  'buffer', 'cares_wrap', 'config', 'constants', 'contextify', 'fs', 'fs_event_wrap', 'icu',
  'inspector', 'js_stream', 'os', 'pipe_wrap', 'process_wrap', 'spawn_sync', 'stream_wrap',
  'tcp_wrap', 'tls_wrap', 'tty_wrap', 'udp_wrap', 'uv', 'zlib',
]);
// lib/internal/legacy/processbinding.js.
const legacyTypes = ['isArrayBuffer', 'isArrayBufferView', 'isAsyncFunction', 'isDataView', 'isDate',
  'isExternal', 'isMap', 'isMapIterator', 'isNativeError', 'isPromise', 'isRegExp', 'isSet',
  'isSetIterator', 'isTypedArray', 'isUint8Array', 'isAnyArrayBuffer'];
const legacyWrappers = {
  __proto__: null,
  util() {
    const { types } = require('util');
    return Object.fromEntries(Object.entries(types).filter(({ 0: key }) => legacyTypes.includes(key)));
  },
};

function processBinding(module) {
  module = String(module);
  if (module in legacyWrappers) return legacyWrappers[module]();
  // A name Node allows whose binding this runtime does not emulate is unknown here too.
  if (processBindingAllowList.has(module) && kBindings[module] !== undefined) return kBindings[module]();
  throw new Error(`No such module: ${module}`);
}

module.exports = { internalBinding, processBinding };
