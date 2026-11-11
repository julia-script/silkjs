'use strict';

const host = require('internal/host');
const native = host.inspectorNative;
const permission = require('internal/permission');
const contexts = require('internal/inspector_contexts');
const { RemoteValues, inspect, protocolError, unsupported } = require('internal/inspector_values');
const debuggerAgent = require('internal/inspector_debugger');
const profiles = require('internal/inspector_profiles');
const network = require('internal/inspector_network');
const sessions = new Map();
const routed = new Map();
const workers = require('internal/inspector_workers').create(connectRemote);
let nextSession = 1;
let nextException = 1;
let waiting = false;
let workerWaitConsumed = false;
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function invalid(name, expected) { return error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type ${expected}`, TypeError); }
function check() { permission.check('inspector'); }
function protocolParams(params, name, type) {
  if (typeof params[name] !== type) throw protocolError(-32602, `Invalid parameters: ${name}`);
}
function contextFor(params) {
  const context = contexts.resolve(params.contextId === undefined ? params.executionContextId : params.contextId, params.uniqueContextId);
  if (!context) throw protocolError(-32000, 'Cannot find context with specified id');
  return context;
}
function evaluation(session, result, params) {
  if (result.status === 'success') {
    if (params.awaitPromise) return Promise.resolve(result.value).then(value => ({ result: session.values.remote(value, params.objectGroup, !!params.returnByValue, !!params.generatePreview, params._context) }), value => evaluation(session, { status: 'exception', value }, { ...params, awaitPromise: false }));
    return { result: session.values.remote(result.value, params.objectGroup, !!params.returnByValue, !!params.generatePreview, params._context) };
  }
  const exception = result.status === 'sideEffect' ? new EvalError('Possible side-effect in debug-evaluate') : result.status === 'terminated' || result.status === 'timeout' ? new Error('Execution was terminated') : result.value;
  const remote = session.values.remote(exception, params.objectGroup);
  return { result: remote, exceptionDetails: { exceptionId: nextException++, text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception: remote } };
}
function validateEvaluation(params, method) {
  if (params.serializationOptions || params.replMode || params.allowUnsafeEvalBlockedByCSP === false || params.includeCommandLineAPI) unsupported(method);
  if (params.timeout !== undefined && (typeof params.timeout !== 'number' || !Number.isFinite(params.timeout) || params.timeout < 0)) throw protocolError(-32602, 'Invalid parameters: timeout');
}
function runtime(session, method, params) {
  switch (method) {
    case 'Runtime.enable':
      if (!session.runtime) {
        session.runtime = true;
        for (const context of contexts.list()) { session.contexts.set(context.id, context); session.emit('Runtime.executionContextCreated', { context: contexts.description(context) }); }
      }
      return {};
    case 'Runtime.disable': session.runtime = false; session.contexts.clear(); return {};
    case 'Runtime.evaluate': {
      protocolParams(params, 'expression', 'string');
      validateEvaluation(params, method);
      const context = contextFor(params);
      return evaluation(session, native(8, params.expression, context.handle, !!params.throwOnSideEffect, params.timeout || 0), { ...params, _context: context });
    }
    case 'Runtime.callFunctionOn': {
      protocolParams(params, 'functionDeclaration', 'string');
      validateEvaluation(params, method);
      if (params.objectId !== undefined && (params.executionContextId !== undefined || params.uniqueContextId !== undefined)) throw protocolError(-32602, 'ObjectId must not be specified together with executionContextId');
      if (params.arguments !== undefined && !Array.isArray(params.arguments)) throw protocolError(-32602, 'Invalid parameters: arguments');
      const receiverEntry = params.objectId === undefined ? undefined : session.values.entry(params.objectId);
      const context = receiverEntry && receiverEntry.context || contextFor(params);
      const receiver = receiverEntry ? session.values.lookup(params.objectId) : undefined;
      const args = (params.arguments || []).map(argument => {
        if (!argument || typeof argument !== 'object') throw protocolError(-32602, 'Invalid parameters: arguments');
        return session.values.argument(argument);
      });
      const compiled = native(8, `(${params.functionDeclaration}\n)`, context.handle, !!params.throwOnSideEffect, params.timeout || 0);
      if (compiled.status !== 'success') return evaluation(session, compiled, params);
      if (typeof compiled.value !== 'function') throw protocolError(-32000, 'Given expression does not evaluate to a function');
      const options = { ...params, _context: context, objectGroup: params.objectGroup === undefined && receiverEntry ? receiverEntry.group : params.objectGroup };
      return evaluation(session, native(13, compiled.value, receiver, args, context.handle, !!params.throwOnSideEffect, params.timeout || 0), options);
    }
    case 'Runtime.getProperties':
      protocolParams(params, 'objectId', 'string'); return session.values.properties(params.objectId, params);
    case 'Runtime.releaseObject':
      protocolParams(params, 'objectId', 'string'); session.values.release(params.objectId); return {};
    case 'Runtime.releaseObjectGroup':
      protocolParams(params, 'objectGroup', 'string'); session.values.releaseGroup(params.objectGroup); return {};
    case 'Runtime.awaitPromise': {
      protocolParams(params, 'promiseObjectId', 'string');
      const entry = session.values.entry(params.promiseObjectId);
      if (inspect(entry.value).subtype !== 'promise') throw protocolError(-32000, 'Could not find promise with given id');
      return evaluation(session, { status: 'success', value: entry.value }, { ...params, objectGroup: entry.group, awaitPromise: true, _context: entry.context });
    }
    case 'Runtime.queryObjects': {
      protocolParams(params, 'prototypeObjectId', 'string');
      return { objects: session.values.remote(host.queryObjects(session.values.lookup(params.prototypeObjectId)), params.objectGroup) };
    }
    case 'Runtime.globalLexicalScopeNames': return { names: native(11, contextFor(params).handle) };
    case 'Runtime.getIsolateId': return { id: `silk:${native(10)}` };
    case 'Runtime.runIfWaitingForDebugger': waiting = false; return {};
    default: unsupported(method);
  }
}
// Node's own domain (src/inspector/node_protocol.pdl): startup-wait notification.
function nodeRuntime(session, method, params) {
  switch (method) {
    case 'NodeRuntime.enable':
      session.nodeRuntime = true;
      if (waiting) session.emit('NodeRuntime.waitingForDebugger', {});
      return {};
    case 'NodeRuntime.disable': session.nodeRuntime = false; return {};
    case 'NodeRuntime.notifyWhenWaitingForDisconnect':
      if (typeof params.enabled !== 'boolean') throw protocolError(-32602, 'Invalid parameters');
      session.notifyDisconnect = params.enabled;
      return {};
    default: unsupported(method);
  }
}
function announceWaiting() {
  for (const session of sessions.values()) if (session.nodeRuntime) session.emit('NodeRuntime.waitingForDebugger', {});
}
function dispatch(session, method, params) {
  if (method.startsWith('Runtime.')) return runtime(session, method, params);
  if (method.startsWith('Debugger.')) return debuggerAgent.dispatch(session, method, params);
  if (method.startsWith('Profiler.') || method.startsWith('HeapProfiler.')) return profiles.dispatch(session, method, params);
  if (method.startsWith('Network.') || method.startsWith('IO.')) return network.dispatch(session, method, params);
  if (method.startsWith('NodeWorker.')) return workers.dispatch(session, method, params);
  if (method.startsWith('NodeRuntime.')) return nodeRuntime(session, method, params);
  if (method === 'Schema.getDomains') return { domains: ['Runtime', 'Debugger', 'Profiler', 'HeapProfiler', 'Network', 'IO', 'NodeWorker', 'NodeRuntime', 'Schema'].map(name => ({ name, version: '1.3' })) };
  unsupported(method);
}
function createSession(key, send) {
  const session = { id: nextSession++, runtime: false, contexts: new Map(), values: null,
    send(message) { if (sessions.get(key) === session) send(message); },
    emit(method, params) { if (sessions.get(key) === session) send({ method, params }); },
    evaluation(result, params) { return evaluation(session, result, params); } };
  session.values = new RemoteValues(`${native(10)}:${session.id}`);
  sessions.set(key, session);
  native(7, true);
  return session;
}
function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  debuggerAgent.close(session);
  profiles.close(session);
  network.close(session);
  workers.close(session);
  session.contexts.clear();
  session.values.clear();
  if (sessions.size === 0) native(7, false);
  if (exitRetained && ![...sessions.values()].some(other => other.notifyDisconnect)) { exitRetained = false; contextsDestroyed(); }
}
function command(session, message) {
  let request;
  try { request = typeof message === 'string' ? JSON.parse(message) : message; }
  catch { session.send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const id = request && request.id;
  if (!request || typeof request !== 'object' || typeof request.method !== 'string' || !Number.isInteger(id)) {
    session.send({ id: id === undefined ? null : id, error: { code: -32600, message: 'Invalid Request' } }); return;
  }
  const failure = cause => session.send({ id, error: { code: cause.protocolCode === undefined ? -32000 : cause.protocolCode, message: cause.message || 'Internal error' } });
  try {
    const params = request.params === undefined ? {} : request.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw protocolError(-32602, 'Invalid parameters');
    const result = dispatch(session, request.method, params);
    if (result && typeof result.then === 'function') result.then(value => session.send({ id, result: value }), failure);
    else session.send({ id, result });
  } catch (cause) { failure(cause); }
}
function connectRemote(target, onMessage, defer = true, greeting = '') {
  check();
  const id = nextSession++;
  const route = { receive: onMessage, defer, target };
  routed.set(id, route);
  try { if (!native(6, target, id, 1, greeting)) throw error('ERR_INSPECTOR_CLOSED', 'Session was closed'); }
  catch (cause) { routed.delete(id); throw cause; }
  return { dispatch(message) {
    if (!native(6, target, id, 2, message)) throw error('ERR_INSPECTOR_CLOSED', 'Session was closed');
  }, disconnect() { routed.delete(id); native(6, target, id, 3, ''); } };
}
function connect(onMessage, mainThread = false) {
  check();
  if (mainThread) {
    if (native(10) === 0) throw error('ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    return connectRemote(0, onMessage);
  }
  const key = `local:${nextSession}`;
  const session = createSession(key, message => onMessage(JSON.stringify(message)));
  return { dispatch: message => command(session, message), disconnect: () => closeSession(key) };
}
function onNative(kind, connection, payload, source) {
  if (kind === 5) { workers.attached(source); return; }
  if (kind === 6) {
    workers.detached(source);
    for (const key of sessions.keys()) if (key.startsWith(`${source}:`)) closeSession(key);
    return;
  }
  if (kind === 10) { debuggerAgent.paused(payload); return; }
  if (kind === 11) { for (const script of payload) debuggerAgent.scriptParsed(script); return; }
  if (kind === 4) {
    const route = routed.get(connection);
    if (route) {
      if (route.defer) queueMicrotask(() => { if (routed.get(connection) === route) route.receive(payload); });
      else route.receive(payload);
    }
    return;
  }
  const key = `${source}:${connection}`;
  if (kind === 1) {
    check();
    if (sessions.has(key)) closeSession(key);
    createSession(key, message => native(5, connection, JSON.stringify(message), source));
    if (source === -1) host.writeStartupDiagnostic('Debugger attached.\n');
    if (source >= 0 && payload === '{"inspectorWorker":true}') {
      const info = host.workerNative('info', []);
      const metadata = JSON.parse(info.metadata);
      native(5, connection, JSON.stringify({ inspectorWorkerInfo: { title: metadata.name, url: metadata.eval ? '' : metadata.filename }, waitingForDebugger: waiting }), source);
    }
  } else if (kind === 2) {
    const session = sessions.get(key);
    if (session) command(session, payload);
  } else if (kind === 3) closeSession(key);
}
function url() { return native(3); }
// WebSocket sessions of this thread's own server; they keep the process alive at exit.
const remoteSessions = () => { for (const key of sessions.keys()) if (key.startsWith('-1:')) return true; return false; };
// A session that asked for NodeRuntime.waitingForDisconnect keeps the main
// context alive at exit until the last such session leaves.
let exitRetained = false;
function contextsDestroyed() {
  for (const session of [...sessions.values()]) if (session.runtime) for (const context of session.contexts.values())
    session.emit('Runtime.executionContextDestroyed', { executionContextId: context.id, executionContextUniqueId: context.uniqueId });
}
// Node's Agent::WaitForDisconnect, run after the 'exit' event while the inspector is active.
function atExit() {
  if (native(10) !== 0 || (!url() && sessions.size === 0)) return;
  if (remoteSessions()) host.writeStartupDiagnostic('Waiting for the debugger to disconnect...\n');
  for (const session of [...sessions.values()]) if (session.notifyDisconnect) { session.emit('NodeRuntime.waitingForDisconnect', {}); exitRetained = true; }
  if (!exitRetained) contextsDestroyed();
  while (url() && remoteSessions()) native(4, 10);
}
function close() {
  native(2);
  for (const key of sessions.keys()) if (!key.startsWith('local:') && key.startsWith('-1:')) closeSession(key);
  waiting = false;
}
function open(port = 9229, hostname = '127.0.0.1', wait = false) {
  check();
  if (url()) throw error('ERR_INSPECTOR_ALREADY_ACTIVATED', 'Inspector is already activated. Close it with inspector.close() before activating it again.');
  if (Number.isInteger(port) && port >= 0 && port <= 0xffffffff && port > 65535) throw error('ERR_OUT_OF_RANGE', 'The value of "port" is out of range. It must be >= 0 && <= 65535.', RangeError);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) port = 9229;
  if (typeof hostname !== 'string' || !hostname) hostname = '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) process.emitWarning('Binding the inspector to a public IP with an open port is insecure, as it allows external hosts to connect to the inspector and perform a remote code execution attack. Documentation can be found at https://nodejs.org/api/cli.html#--inspecthostport', 'SecurityWarning');
  if (!native(1, hostname, port)) throw error('ERR_INSPECTOR_NOT_AVAILABLE', 'Inspector is not available');
  const endpoint = url();
  process.debugPort = Number(new URL(endpoint).port);
  // Startup can park immediately below; publish without queued stdio work.
  host.writeStartupDiagnostic(`Debugger listening on ${endpoint}\nFor help, see: https://nodejs.org/en/docs/inspector\n`);
  if (wait) waitForDebugger();
  return { __proto__: null, [Symbol.dispose]() { close(); } };
}
function waitForDebugger() {
  if (!url()) throw error('ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
  waiting = true;
  announceWaiting();
  while (waiting && url()) native(4, 10);
}
function waitWorker() {
  workerWaitConsumed = true;
  waiting = true;
  announceWaiting();
  // Publish readiness only after the wait state is set: a queued resume must
  // not be overwritten when bootstrap enters its worker wait.
  native(0, onNative);
  native(7, true);
  while (waiting) native(4, 10);
}
function waitForWorkerStart() {
  if (native(10) === 0 || workerWaitConsumed) return;
  if (native(18)) { check(); waitWorker(); }
  else native(0, onNative);
}
function start(port, hostname, wait, breakFirst) {
  check();
  if (native(10) === 0) {
    try { open(port, hostname, false); }
    catch (cause) {
      if (cause.code !== 'ERR_INSPECTOR_NOT_AVAILABLE') throw cause;
      process.stderr.write(`Starting inspector on ${hostname || '127.0.0.1'}:${port === undefined ? 9229 : port} failed\n`);
      return;
    }
    if (wait || breakFirst) waitForDebugger();
  } else if (wait || breakFirst || native(18)) waitWorker();
}
// process._debugEnd closes the server; SIGUSR1 (what process._debugProcess
// sends) opens it on process.debugPort, as Node does unless --disable-sigusr1.
function installProcess(process, hostname, activateOnSignal) {
  process._debugEnd = () => close();
  process._debugProcess = pid => { process.kill(pid, 'SIGUSR1'); };
  if (!activateOnSignal) return;
  host.processNative('signalStart', [host.platform === 'darwin' ? 30 : 10, () => {
    if (!url()) start(process.debugPort, hostname, false, false);
  }]);
}
function armStartup() {
  // A CLI bind failure (or a listener closed during startup wait) must not
  // leave an unresumable breakpoint in an otherwise normal main-thread launch.
  if (native(10) === 0 && !url()) return;
  debuggerAgent.armStartup();
}
function broadcast(method, params) {
  for (const session of sessions.values()) {
    if (method.startsWith('Network.') && !session.networkEnabled) continue;
    session.emit(method, params);
  }
}
const consoleBridge = require('internal/inspector_console').create((type, args) => {
  for (const session of sessions.values()) if (session.runtime) {
    if (type === 'clear') session.values.releaseGroup('console');
    session.emit('Runtime.consoleAPICalled', { type, args: args.map(value => session.values.remote(value, 'console', false, true)), executionContextId: 1, timestamp: Date.now() });
  }
});
consoleBridge.console.profile = function profile(title) {
  return profiles.consoleProfile(title, profiles.emitConsoleEvent, profile);
};
consoleBridge.console.profileEnd = function profileEnd(title) {
  return profiles.consoleProfileEnd(title, profiles.emitConsoleEvent, profileEnd);
};
contexts.subscribe(context => {
  for (const session of sessions.values()) if (session.runtime) { session.contexts.set(context.id, context); session.emit('Runtime.executionContextCreated', { context: contexts.description(context) }); }
}, true);
// Worker owners are announced before bootstrap has installed permissions and
// startup options. Keep incoming routes queued until _start/_waitForWorker.
if (native(10) === 0) {
  native(0, onNative);
  // Native state does not come with a heap image: a start from one registers again.
  host.onHydrate(() => { native(0, onNative); });
}
module.exports = { connect, open, close, url, waitForDebugger, _start: start, _atExit: atExit, _installProcess: installProcess, _waitForWorker: waitForWorkerStart, _armStartup: armStartup, broadcast, error, invalid, console: consoleBridge.console, emitConsole: consoleBridge.emitConsole, putNetworkResource: network.put };
