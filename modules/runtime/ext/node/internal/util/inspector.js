'use strict';

const {
  ArrayPrototypeSome,
  RegExpPrototypeExec,
  SafeWeakMap,
} = require('internal/per_context/primordials');
const { validatePort } = require('internal/validators');

// isUsingInspector, getInspectPort and isInspectorMessage are Node's lib/internal/util/inspector.js.
const kMinPort = 1024;
const kMaxPort = 65535;
const kInspectArgRegex = /--inspect(?:-brk|-port)?|--debug-port/;
const kInspectMsgRegex = /Debugger listening on ws:\/\/\[?(.+?)\]?:(\d+)\/|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector|Debugger attached|Waiting for the debugger to disconnect\.\.\./;

const _isUsingInspector = new SafeWeakMap();
function isUsingInspector(execArgv = process.execArgv) {
  if (!_isUsingInspector.has(execArgv)) {
    _isUsingInspector.set(execArgv,
                          ArrayPrototypeSome(execArgv, (arg) => RegExpPrototypeExec(kInspectArgRegex, arg) !== null) ||
      RegExpPrototypeExec(kInspectArgRegex, process.env.NODE_OPTIONS) !== null);
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
}

// sendInspectorCommand of Node's lib/internal/util/inspector.js: runs cb with a
// connected in-process inspector session, or onError when the permission model
// is on (the inspector is then unavailable, so no REPL previews or completion).
let session;
function sendInspectorCommand(cb, onError) {
  if (require('internal/permission').enabled()) return onError();
  const inspector = require('inspector');
  if (session === undefined) session = new inspector.Session();
  session.connect();
  try {
    return cb(session);
  } finally {
    session.disconnect();
  }
}

function isInspectorMessage(string) {
  return isUsingInspector() && RegExpPrototypeExec(kInspectMsgRegex, string) !== null;
}

module.exports = { getInspectPort, isInspectorMessage, isUsingInspector, sendInspectorCommand };
