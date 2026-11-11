'use strict';

// Node.js lib/internal/test/binding.js, for --expose-internals tests.
// internalBinding returns the runtime's JS emulations of Node's bindings,
// only for the bindings that have one; any other name throws as Node's
// internalBinding does for an unknown binding.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const primordials = require('internal/per_context/primordials');

process.emitWarning(
  'These APIs are for internal testing only. Do not use them.',
  'internal/test/binding');

const net = () => require('internal/net/binding');
const kBindings = {
  __proto__: null,
  async_wrap: () => require('internal/async_wrap_binding'),
  buffer: () => require('internal/buffer_binding'),
  constants: () => require('internal/constants_binding'),
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

module.exports = { internalBinding, primordials };
