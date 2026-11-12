#!/usr/bin/env python3
"""Ports Node.js lib/net.js and the modules it needs to ext/node.

usage: port_node_net.py NODE_SRC [OUT_DIR]

NODE_SRC is a Node.js checkout (v24.22.1). Each file is copied with the
mechanical changes every runtime port of Node's JavaScript needs (primordials,
internalBinding, internal modules the runtime does not have), then with the
listed adaptations. Every adaptation must apply exactly once, so porting a newer
Node fails loudly where the source moved.
"""
import os
import sys

HEADER_NOTE = {
    'lib/net.js': 'Adapted from Node.js v24.22.1 lib/net.js by tools/port_node_net.py.',
    'lib/internal/net.js': 'Adapted from Node.js v24.22.1 lib/internal/net.js by tools/port_node_net.py.',
    'lib/tty.js': 'Adapted from Node.js v24.22.1 lib/tty.js by tools/port_node_net.py.',
    'lib/internal/stream_base_commons.js':
        'Adapted from Node.js v24.22.1 lib/internal/stream_base_commons.js by tools/port_node_net.py.',
}

MIT = """// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
"""

# Changes every file gets.
COMMON = [
    ("} = primordials;", "} = require('internal/per_context/primordials');"),
    ("internalBinding('tcp_wrap')", "require('internal/net/binding').tcp_wrap"),
    ("internalBinding('pipe_wrap')", "require('internal/net/binding').pipe_wrap"),
    ("internalBinding('stream_wrap')", "require('internal/net/binding').stream_wrap"),
    ("internalBinding('tty_wrap')", "require('internal/net/binding').tty_wrap"),
    ("internalBinding('uv')", "require('internal/uv_binding')"),
    ("internalBinding('js_stream')", "require('internal/net/binding').js_stream"),
    ("internalBinding('cares_wrap')", "require('internal/dns/cares_wrap')"),
    ("require('internal/util/debuglog').debuglog", "require('util').debuglog"),
    ("require('internal/events/abort_listener')", "require('events')"),
    ("require('internal/util/types')", "require('util').types"),
    ("const assert = require('internal/assert');", "const assert = require('assert').ok;"),
    ("const { exitCodes: { kNoFailure } } = internalBinding('errors');", "const kNoFailure = 0;"),
]

ADAPT = {
    'lib/internal/dns/utils.js': [
        ("""const {
  namespace: {
    addSerializeCallback,
    addDeserializeCallback,
    isBuildingSnapshot,
  },
} = require('internal/v8/startup_snapshot');""",
         """// silkjs: the runtime builds no user-land startup snapshot, so nothing is ever serialized.
const isBuildingSnapshot = () => false;
const addSerializeCallback = () => {};
const addDeserializeCallback = () => {};"""),
        ("\nmodule.exports = {",
         "\n// silkjs: Node runs this in pre-execution; dns loads on first use, after the options.\n"
         "initializeDns();\n\nmodule.exports = {"),
    ],
    'lib/internal/cluster/primary.js': [
        ("const { getInspectPort, isUsingInspector } = require('internal/util/inspector');",
         """// silkjs: getInspectPort and isUsingInspector of Node's internal/util/inspector.
const { validatePort } = require('internal/validators');
const kMinPort = 1024;
const kMaxPort = 65535;
const kInspectArgRegex = /--inspect(?:-brk|-port)?|--debug-port/;
const _isUsingInspector = new WeakMap();
function isUsingInspector(execArgv = process.execArgv) {
  if (!_isUsingInspector.has(execArgv)) {
    _isUsingInspector.set(execArgv,
                          execArgv.some((arg) => kInspectArgRegex.exec(arg) !== null) ||
      kInspectArgRegex.exec(process.env.NODE_OPTIONS) !== null);
  }
  return _isUsingInspector.get(execArgv);
}
let debugPortOffset = 1;
function getInspectPort(inspectPort) {
  if (typeof inspectPort === 'function') {
    inspectPort = inspectPort();
  } else if (inspectPort == null) {
    inspectPort = process.debugPort + debugPortOffset;
    if (inspectPort > kMaxPort)
      inspectPort = inspectPort - kMaxPort + kMinPort - 1;
    debugPortOffset++;
  }
  validatePort(inspectPort);

  return inspectPort;
}"""),
    ],
    'lib/tty.js': [
        ("} = require('internal/tty');", "} = require('internal/tty/colors');"),
    ],
    'lib/internal/net.js': [
        ("const { writeBuffer } = internalBinding('fs');\n",
         "const { writeSync } = require('fs');\n"),
        ("""    const ctx = {};
    writeBuffer(fd, chunk, 0, chunk.length, null, undefined, ctx);
    if (ctx.errno !== undefined) {
      const ex = new UVException(ctx);
      ex.errno = ctx.errno;
      return cb(ex);
    }
    cb();""",
         """    // silkjs: fs.writeSync reports the same UVException that Node builds from ctx.
    try {
      writeSync(fd, chunk, 0, chunk.length, null);
    } catch (ex) {
      return cb(ex);
    }
    cb();"""),
        ("const {\n  UVException,\n} = require('internal/errors');\n", ""),
    ],
    'lib/net.js': [
        ("""let autoSelectFamilyDefault = getOptionValue('--network-family-autoselection');
let autoSelectFamilyAttemptTimeoutDefault = getOptionValue('--network-family-autoselection-attempt-timeout');""",
         """// silkjs: read on first use. A heap image holds this module loaded before the
// process's options are parsed.
let autoSelectFamilyDefault;
let autoSelectFamilyAttemptTimeoutDefault;"""),
        ("""function getDefaultAutoSelectFamily() {
  return autoSelectFamilyDefault;""",
         """function getDefaultAutoSelectFamily() {
  autoSelectFamilyDefault ??= getOptionValue('--network-family-autoselection');
  return autoSelectFamilyDefault;"""),
        ("""function getDefaultAutoSelectFamilyAttemptTimeout() {
  return autoSelectFamilyAttemptTimeoutDefault;""",
         """function getDefaultAutoSelectFamilyAttemptTimeout() {
  autoSelectFamilyAttemptTimeoutDefault ??= getOptionValue('--network-family-autoselection-attempt-timeout');
  return autoSelectFamilyAttemptTimeoutDefault;"""),
        ("    autoSelectFamily = autoSelectFamilyDefault;",
         "    autoSelectFamily = getDefaultAutoSelectFamily();"),
        ("    autoSelectFamilyAttemptTimeout = autoSelectFamilyAttemptTimeoutDefault;",
         "    autoSelectFamilyAttemptTimeout = getDefaultAutoSelectFamilyAttemptTimeout();"),
        ("const { convertIpv6StringToBuffer } = require('internal/dns/cares_wrap');\n",
         "// silkjs: cares_wrap's convertIpv6StringToBuffer, over the BlockList parser.\n"
         "const convertIpv6StringToBuffer = (ip) => require('internal/socketaddress').parseAddress(ip, 6);\n"),
        ("const { queueMicrotask } = require('internal/process/task_queues');\n", ""),
        # silkjs: a child that exits leaves _workers (the _setupWorker exit hook); with
        # none left there is no child to ask, so close() and getConnections() go on with
        # the server's own connections (Node waits forever when every child exits first).
        ("""  if (!this._usingWorkers) {
    end(null, this._connections);""",
         """  if (!this._usingWorkers || this._workers.length === 0) {
    end(null, this._connections);"""),
        ("""  if (this._usingWorkers) {
    let left = this._workers.length;""",
         """  if (this._usingWorkers && this._workers.length !== 0) {
    let left = this._workers.length;"""),
        ("""const {
  guessHandleType,
  isWindows,
  kEmptyObject,
  promisify,
} = require('internal/util');""",
         """const { kEmptyObject, promisify } = require('internal/util');
// silkjs: guessHandleType is the handle binding's; internal/util has no isWindows.
const { guessHandleType } = require('internal/net/binding');
const isWindows = process.platform === 'win32';"""),
        ("""const {
  hasObserver,
  startPerf,
  stopPerf,
} = require('internal/perf/observe');""",
         "const { hasObserver, startPerf, stopPerf } = require('internal/perf_observers');"),
        ("module.exports = {\n  _createServerHandle: createServerHandle,",
         """// silkjs: runtime glue for modules that still drive a socket through a transport object
// (internal/net/transport's contract) instead of a handle: tls and tty adopt one with
// _attachTransport; ws, stdio, child_process and the http parser read _transport.
const { JSTransportHandle } = require('internal/net/binding');
Socket.prototype._attachTransport = function(transport) {
  this._handle = new JSTransportHandle(transport);
  // A transport reports its secure or upgraded connect as a connect event. A socket over
  // an accepted or connected carrier is not connecting: like a net.Socket given a handle,
  // it only starts reading.
  this._handle._connectRequest = {
    oncomplete: (...args) => {
      if (this.connecting) afterConnect(...args);
      else if (!this.destroyed && this.readable && !this.isPaused()) this.read(0);
    },
  };
  initSocketHandle(this);
};
ObjectDefineProperty(Socket.prototype, '_transport', {
  __proto__: null,
  configurable: true,
  get() { return this._handle?._transport ?? null; },
});
ObjectDefineProperty(Server.prototype, '_transport', {
  __proto__: null,
  configurable: true,
  get() { return this._handle?._transport ?? null; },
});
ObjectDefineProperty(Socket.prototype, '_connected', {
  __proto__: null,
  configurable: true,
  get() { return !!this._handle && !this.connecting && !this.destroyed; },
});
Socket.prototype._refreshTimeout = function() { this._unrefTimer(); };

module.exports = {
  _createServerHandle: createServerHandle,"""),
    ],
}


def port(src_root, rel):
    with open(os.path.join(src_root, rel)) as f:
        text = f.read()
    for old, new in COMMON:
        text = text.replace(old, new)
    for old, new in ADAPT.get(rel, []):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f'{rel}: adaptation applies {count} times:\n{old}')
        text = text.replace(old, new)
    if 'internalBinding(' in text:
        line = next(l for l in text.splitlines() if 'internalBinding(' in l)
        raise SystemExit(f'{rel}: unported internalBinding: {line}')
    note = f'// {HEADER_NOTE.get(rel) or f"Adapted from Node.js v24.22.1 {rel} by tools/port_node_net.py."}\n'
    if text.startswith('// Copyright Joyent'):
        return note + text
    return note + MIT + '\n' + text


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'ext', 'node')
    targets = {
        'lib/net.js': 'net.js',
        'lib/internal/net.js': 'internal/net.js',
        'lib/internal/stream_base_commons.js': 'internal/stream_base_commons.js',
        'lib/tty.js': 'tty.js',
        'lib/cluster.js': 'cluster.js',
        'lib/internal/cluster/child.js': 'internal/cluster/child.js',
        'lib/internal/cluster/primary.js': 'internal/cluster/primary.js',
        'lib/internal/cluster/round_robin_handle.js': 'internal/cluster/round_robin_handle.js',
        'lib/internal/cluster/shared_handle.js': 'internal/cluster/shared_handle.js',
        'lib/internal/cluster/utils.js': 'internal/cluster/utils.js',
        'lib/internal/cluster/worker.js': 'internal/cluster/worker.js',
        'lib/internal/linkedlist.js': 'internal/linkedlist.js',
        'lib/internal/js_stream_socket.js': 'internal/js_stream_socket.js',
        'lib/_stream_wrap.js': '_stream_wrap.js',
        'lib/dns.js': 'dns.js',
        'lib/dns/promises.js': 'dns/promises.js',
        'lib/internal/dns/utils.js': 'internal/dns/utils.js',
        'lib/internal/dns/promises.js': 'internal/dns/promises.js',
        'lib/internal/dns/callback_resolver.js': 'internal/dns/callback_resolver.js',
    }
    for rel, dest in targets.items():
        path = os.path.join(out, dest)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(port(src, rel))
        print('wrote', path)


if __name__ == '__main__':
    main()
