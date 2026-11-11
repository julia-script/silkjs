'use strict';

const native = require('internal/host').inspectorNative;
const { protocolError, unsupported } = require('internal/inspector_values');
const createHash = algorithm => require('crypto').createHash(algorithm);
const contexts = require('internal/inspector_contexts');
const pendingScripts = new Map();
const hashes = new Map();
const scriptURLs = new Map();
const enabled = new Set();
const methods = new Set(['Debugger.getScriptSource', 'Debugger.getPossibleBreakpoints', 'Debugger.setBreakpoint', 'Debugger.setBreakpointByUrl', 'Debugger.removeBreakpoint', 'Debugger.setBreakpointsActive', 'Debugger.setSkipAllPauses', 'Debugger.setPauseOnExceptions', 'Debugger.pause', 'Debugger.resume', 'Debugger.stepInto', 'Debugger.stepOver', 'Debugger.stepOut', 'Debugger.evaluateOnCallFrame', 'Debugger.setAsyncCallStackDepth', 'Debugger.setBlackboxPatterns']);
let nextBreakpoint = 1;
let startupArmed = false;
let activePause;
function state(session) {
  if (!session.debugger) session.debugger = { breakpoints: new Map(), active: true, skip: false, exceptions: 'none', blackbox: [], asyncDepth: 0 };
  return session.debugger;
}
function rebuild() {
  native(25);
  for (const session of enabled) {
    const data = state(session);
    if (data.active) for (const breakpoint of data.breakpoints.values()) for (const location of breakpoint.locations) native(24, location.scriptId, location.pc);
  }
}
function exceptionMode() {
  let all = false, uncaught = false;
  for (const session of enabled) { const mode = state(session).exceptions; all ||= mode === 'all'; uncaught ||= mode === 'uncaught'; }
  native(28, all, all || uncaught);
}
function locationOnly(location) { return { scriptId: location.scriptId, lineNumber: location.lineNumber, columnNumber: location.columnNumber }; }
function locationsOnly(locations) {
  const unique = new Map();
  for (const location of locations) unique.set(`${location.scriptId}:${location.lineNumber}:${location.columnNumber}`, locationOnly(location));
  return [...unique.values()];
}
function metadata(script) {
  scriptURLs.set(script.scriptId, script.url);
  const context = contexts.fromToken(script.contextToken);
  if (!context) {
    const token = String(script.contextToken);
    let pending = pendingScripts.get(token);
    if (!pending) pendingScripts.set(token, pending = []);
    pending.push(script);
    return null;
  }
  let hash = hashes.get(script.scriptId);
  if (hash === undefined) {
    hash = createHash('sha256').update(native(22, script.scriptId)).digest('hex');
    hashes.set(script.scriptId, hash);
  }
  const { contextToken, ...properties } = script;
  return { ...properties, hash, executionContextId: context.id };
}
function matches(breakpoint, script) {
  return breakpoint.scriptId !== undefined ? breakpoint.scriptId === script.scriptId : breakpoint.url !== undefined ? breakpoint.url === script.url : breakpoint.regex ? breakpoint.regex.test(script.url) : breakpoint.scriptHash === (script.hash || metadata(script)?.hash);
}
function resolve(breakpoint, script) {
  const locations = native(23, script.scriptId);
  let best;
  const resolved = [];
  for (const location of locations) {
    if (location.lineNumber < breakpoint.lineNumber || (location.lineNumber === breakpoint.lineNumber && location.columnNumber < breakpoint.columnNumber)) continue;
    // Native locations retain executable PC order, which can move backwards in
    // source columns (for example the store following a call). An exact source
    // request wins; otherwise keep the first executable point on the first eligible line.
    const exact = location.lineNumber === breakpoint.lineNumber && location.columnNumber === breakpoint.columnNumber;
    if (!best || location.lineNumber < best.lineNumber || (exact && best.columnNumber !== breakpoint.columnNumber)) {
      best = location;
      resolved.length = 0;
    }
    if (location.lineNumber === best.lineNumber && location.columnNumber === best.columnNumber) resolved.push(location);
  }
  // A source coordinate can have distinct native PCs in several realm clones,
  // and several executable points inside one function: like V8, break once per
  // function, at its first point for the position.
  const functions = new Set();
  return resolved.filter(location => {
    if (functions.has(location.function)) return false;
    functions.add(location.function);
    return !breakpoint.locations.some(old => old.scriptId === location.scriptId && old.pc === location.pc);
  });
}
function scriptParsed(script) {
  if (enabled.size === 0) return;
  script = metadata(script);
  if (!script) return;
  for (const session of enabled) {
    session.emit('Debugger.scriptParsed', script);
    const data = state(session);
    for (const [id, breakpoint] of data.breakpoints) {
      if (!matches(breakpoint, script)) continue;
      const locations = resolve(breakpoint, script);
      if (!locations.length) continue;
      breakpoint.locations.push(...locations);
      if (data.active) for (const location of locations) native(24, location.scriptId, location.pc);
      session.emit('Debugger.breakpointResolved', { breakpointId: id, location: locationOnly(locations[0]) });
    }
  }
}
function frames(session, source) {
  return source.map(frame => {
    const grouped = new Map();
    const context = contexts.fromToken(frame.contextToken);
    for (const binding of native(30, frame.callFrameId)) {
      if (binding.kind === 0) continue;
      const type = binding.kind === 3 ? 'closure' : binding.isLocal ? 'local' : 'block';
      const key = `${type}:${type === 'block' ? binding.scope : ''}:${binding.depth}`;
      let scope = grouped.get(key);
      if (!scope) {
        scope = { type, scope: [], depth: binding.depth };
        grouped.set(key, scope);
      }
      if (!scope.scope.includes(binding.scope)) scope.scope.push(binding.scope);
    }
    const scopeChain = Array.from(grouped.values(), scope => ({ type: scope.type, object: session.values.scope(frame.callFrameId, scope.scope, scope.depth, context) }));
    scopeChain.push({ type: 'global', object: session.values.remote(frame.global, 'backtrace', false, false, context) });
    return { callFrameId: frame.callFrameId, functionName: frame.functionName, location: locationOnly(frame.location), url: scriptURLs.get(frame.location.scriptId) ?? '', scopeChain, this: session.values.remote(frame.this, 'backtrace', false, false, context) };
  });
}
function paused(payload) {
  const source = payload.frames || [];
  activePause = payload;
  const startup = startupArmed;
  startupArmed = false;
  let delivered = false;
  for (const session of enabled) {
    const data = state(session);
    if (data.skip) continue;
    const hits = [];
    let conditional = false;
    if (source.length && data.active) for (const [id, breakpoint] of data.breakpoints) {
      if (!breakpoint.locations.some(location => location.scriptId === source[0].location.scriptId && location.lineNumber === source[0].location.lineNumber && location.columnNumber === source[0].location.columnNumber)) continue;
      if (breakpoint.condition) {
        conditional = true;
        const result = native(29, source[0].callFrameId, breakpoint.condition, false, 0);
        if (result.status !== 'success' || !result.value) continue;
      }
      hits.push(id);
    }
    if (conditional && hits.length === 0 && payload.reason !== 'exception') continue;
    // Blackboxed scripts are stepped through and their debugger statements ignored;
    // an explicit breakpoint there still stops.
    if (hits.length === 0 && payload.reason !== 'exception' && source.length && data.blackbox.length) {
      const url = scriptURLs.get(source[0].location.scriptId) ?? '';
      if (data.blackbox.some(pattern => pattern.test(url))) continue;
    }
    delivered = true;
    session.emit('Debugger.paused', { callFrames: frames(session, source), reason: payload.reason || 'other', hitBreakpoints: hits });
    if (!native(31)) break;
  }
  if (!delivered && !startup && native(31)) { native(27, 0); activePause = undefined; }
}
function resumed() {
  activePause = undefined;
  for (const session of enabled) { session.values.releaseGroup('backtrace'); session.emit('Debugger.resumed', {}); }
}
function close(session) {
  if (!enabled.delete(session)) return;
  session.values.releaseGroup('backtrace');
  session.debugger = undefined;
  rebuild();
  exceptionMode();
  if (enabled.size === 0 && !startupArmed) {
    if (native(31)) native(27, 0);
    native(20, false);
    hashes.clear();
    scriptURLs.clear();
    pendingScripts.clear();
  }
}
function dispatch(session, method, params) {
  const data = state(session);
  if (method === 'Debugger.enable') {
    enabled.add(session);
    const scripts = native(20, true);
    for (const script of scripts) { const info = metadata(script); if (info) session.emit('Debugger.scriptParsed', info); }
    if (activePause && native(31)) session.emit('Debugger.paused', { callFrames: frames(session, activePause.frames || []), reason: activePause.reason || 'other', hitBreakpoints: [] });
    return { debuggerId: `silk:${native(10)}` };
  }
  if (method === 'Debugger.disable') { close(session); return {}; }
  if (!methods.has(method)) unsupported(method);
  if (!enabled.has(session)) throw protocolError(-32000, 'Debugger agent is not enabled');
  switch (method) {
    case 'Debugger.getScriptSource': return { scriptSource: native(22, params.scriptId) };
    case 'Debugger.getPossibleBreakpoints': {
      const start = params.start;
      if (!start || typeof start.scriptId !== 'string' || !Number.isInteger(start.lineNumber)) throw protocolError(-32602, 'Invalid parameters');
      if (params.restrictToFunction) unsupported(method);
      const end = params.end;
      return { locations: locationsOnly(native(23, start.scriptId).filter(location => (location.lineNumber > start.lineNumber || (location.lineNumber === start.lineNumber && location.columnNumber >= (start.columnNumber || 0))) && (!end || location.lineNumber < end.lineNumber || (location.lineNumber === end.lineNumber && location.columnNumber < (end.columnNumber || 0))))) };
    }
    case 'Debugger.setBreakpoint':
    case 'Debugger.setBreakpointByUrl': {
      const requested = method === 'Debugger.setBreakpoint' ? params.location : params;
      if (!requested || !Number.isInteger(requested.lineNumber) || requested.lineNumber < 0 || (requested.columnNumber !== undefined && (!Number.isInteger(requested.columnNumber) || requested.columnNumber < 0))) throw protocolError(-32602, 'Invalid parameters');
      const breakpoint = { lineNumber: requested.lineNumber, columnNumber: requested.columnNumber || 0, condition: params.condition || '', locations: [] };
      if (method === 'Debugger.setBreakpoint') {
        if (typeof requested.scriptId !== 'string') throw protocolError(-32602, 'Invalid parameters');
        breakpoint.scriptId = requested.scriptId;
      } else {
        if ([params.url, params.urlRegex, params.scriptHash].filter(value => value !== undefined).length !== 1) throw protocolError(-32602, 'Either url or urlRegex or scriptHash must be specified');
        breakpoint.url = params.url;
        breakpoint.scriptHash = params.scriptHash;
        if (params.urlRegex !== undefined) {
          try { breakpoint.regex = new RegExp(params.urlRegex); } catch { throw protocolError(-32602, 'Invalid regular expression'); }
        }
      }
      for (const script of native(21)) if (matches(breakpoint, script)) breakpoint.locations.push(...resolve(breakpoint, script));
      if (method === 'Debugger.setBreakpoint' && !breakpoint.locations.length) throw protocolError(-32000, 'Could not resolve breakpoint');
      const id = `${session.id}:${nextBreakpoint++}`;
      data.breakpoints.set(id, breakpoint);
      if (data.active) for (const location of breakpoint.locations) native(24, location.scriptId, location.pc);
      return method === 'Debugger.setBreakpoint' ? { breakpointId: id, actualLocation: locationOnly(breakpoint.locations[0]) } : { breakpointId: id, locations: locationsOnly(breakpoint.locations) };
    }
    case 'Debugger.removeBreakpoint': data.breakpoints.delete(params.breakpointId); rebuild(); return {};
    case 'Debugger.setBreakpointsActive':
      if (typeof params.active !== 'boolean') throw protocolError(-32602, 'Invalid parameters');
      data.active = params.active; rebuild(); return {};
    case 'Debugger.setSkipAllPauses':
      if (typeof params.skip !== 'boolean') throw protocolError(-32602, 'Invalid parameters');
      data.skip = params.skip; return {};
    case 'Debugger.setPauseOnExceptions':
      if (!['none', 'all', 'uncaught'].includes(params.state)) throw protocolError(-32602, 'Invalid parameters');
      data.exceptions = params.state; exceptionMode(); return {};
    case 'Debugger.pause': native(26); return {};
    case 'Debugger.setAsyncCallStackDepth':
      if (!Number.isInteger(params.maxDepth)) throw protocolError(-32602, 'Invalid parameters: maxDepth');
      // Recorded only: paused frames carry no asyncStackTrace yet.
      data.asyncDepth = Math.max(0, params.maxDepth); return {};
    case 'Debugger.setBlackboxPatterns': {
      if (!Array.isArray(params.patterns) || params.patterns.some(pattern => typeof pattern !== 'string')) throw protocolError(-32602, 'Invalid parameters: patterns');
      try { data.blackbox = params.patterns.map(pattern => new RegExp(pattern)); }
      catch { throw protocolError(-32000, 'Invalid regular expression'); }
      return {};
    }
    case 'Debugger.resume': case 'Debugger.stepInto': case 'Debugger.stepOver': case 'Debugger.stepOut': {
      if (params.breakOnAsyncCall || params.skipList || params.terminateOnResume) unsupported(method);
      const mode = { 'Debugger.resume': 0, 'Debugger.stepInto': 1, 'Debugger.stepOver': 2, 'Debugger.stepOut': 3 }[method];
      if (!native(27, mode)) throw protocolError(-32000, 'Can only perform operation while paused.');
      resumed(); return {};
    }
    case 'Debugger.evaluateOnCallFrame':
      if (typeof params.callFrameId !== 'string' || typeof params.expression !== 'string') throw protocolError(-32602, 'Invalid parameters');
      if (params.timeout !== undefined && (typeof params.timeout !== 'number' || !Number.isFinite(params.timeout) || params.timeout < 0)) throw protocolError(-32602, 'Invalid parameters: timeout');
      if (params.includeCommandLineAPI) unsupported(method);
      return session.evaluation(native(29, params.callFrameId, params.expression, !!params.throwOnSideEffect, params.timeout || 0), params);
    default: unsupported(method);
  }
}
function armStartup() {
  startupArmed = true;
  native(20, true);
  native(15, true);
}
contexts.subscribe(context => {
  const pending = pendingScripts.get(context.token);
  if (!pending) return;
  pendingScripts.delete(context.token);
  for (const script of pending) scriptParsed(script);
});
module.exports = { dispatch, close, paused, scriptParsed, armStartup };
