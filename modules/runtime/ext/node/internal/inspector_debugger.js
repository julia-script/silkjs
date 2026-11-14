'use strict';

const native = require('internal/host').inspectorNative;
const { protocolError, unsupported, scopeType } = require('internal/inspector_values');
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
// Node's resourceNameToUrl: a script named by an absolute path is reported as a file URL.
function resourceURL(name) {
  return typeof name === 'string' && name.startsWith('/') ? require('url').pathToFileURL(name).href : name;
}
// V8's magic comment: the last `//# sourceURL=` (or `//@`) line comment's value.
function sourceURLOf(source) {
  if (typeof source !== 'string' || !source.includes('sourceURL')) return undefined;
  let found;
  for (const match of source.matchAll(/\/\/[#@][ \t]sourceURL=[ \t]*([^\s'"]*)[ \t]*$/gm)) found = match[1];
  return found || undefined;
}
function metadata(script) {
  script.url = resourceURL(script.url);
  scriptURLs.set(script.scriptId, script.url);
  const context = contexts.fromToken(script.contextToken);
  if (!context) {
    const token = String(script.contextToken);
    let pending = pendingScripts.get(token);
    if (!pending) pendingScripts.set(token, pending = []);
    pending.push(script);
    return null;
  }
  let cached = hashes.get(script.scriptId);
  if (cached === undefined) {
    const source = native(22, script.scriptId);
    cached = { hash: createHash('sha256').update(source).digest('hex'), sourceURL: sourceURLOf(source) };
    hashes.set(script.scriptId, cached);
  }
  const { contextToken, ...properties } = script;
  // V8 names a script with a sourceURL comment by it, and says so (hasSourceURL).
  if (cached.sourceURL !== undefined) {
    properties.url = cached.sourceURL;
    properties.hasSourceURL = true;
    scriptURLs.set(script.scriptId, cached.sourceURL);
  }
  return { ...properties, hash: cached.hash, executionContextId: context.id };
}
function matches(breakpoint, script) {
  const url = resourceURL(script.url);
  return breakpoint.scriptId !== undefined ? breakpoint.scriptId === script.scriptId : breakpoint.url !== undefined ? breakpoint.url === url : breakpoint.regex ? breakpoint.regex.test(url) : breakpoint.scriptHash === (script.hash || metadata(script)?.hash);
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
      if (breakpoint.debugCommand || !matches(breakpoint, script)) continue;
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
      const type = scopeType(binding);
      if (type === undefined) continue;
      const key = `${type}:${type === 'block' ? binding.scope : ''}:${binding.depth}`;
      let scope = grouped.get(key);
      if (!scope) {
        scope = { type, scope: [], depth: binding.depth };
        grouped.set(key, scope);
      }
      if (!scope.scope.includes(binding.scope)) scope.scope.push(binding.scope);
    }
    const scopeChain = Array.from(grouped.values(), scope => ({ type: scope.type, object: session.values.scope(frame.callFrameId, scope.scope, scope.depth, context, scope.type) }));
    scopeChain.push({ type: 'global', object: session.values.remote(frame.global, 'backtrace', false, false, context) });
    return { callFrameId: frame.callFrameId, functionName: frame.functionName, location: locationOnly(frame.location), url: scriptURLs.get(frame.location.scriptId) ?? '', scopeChain, this: session.values.remote(frame.this, 'backtrace', false, false, context) };
  });
}
// V8 reports a pause that ends a step (and hits no breakpoint) with reason 'step'.
let stepping = false;
function paused(payload) {
  const source = payload.frames || [];
  // Node's built-in modules evaluate natively under V8, so the start pause never
  // lands in one: here it waits for the next statement outside them.
  if (startupArmed && payload.reason !== 'exception' && source.length && (scriptURLs.get(source[0].location.scriptId) ?? source[0].url ?? '').startsWith('node:') && native(31)) {
    native(26);
    native(27, 0);
    return;
  }
  const stepped = stepping;
  stepping = false;
  activePause = payload;
  const startup = startupArmed;
  startupArmed = false;
  let delivered = false;
  for (const session of enabled) {
    const data = state(session);
    if (data.skip) continue;
    const hits = [];
    let conditional = false, debugCommand = false;
    if (source.length && data.active) for (const [id, breakpoint] of data.breakpoints) {
      if (!breakpoint.locations.some(location => location.scriptId === source[0].location.scriptId && location.lineNumber === source[0].location.lineNumber && location.columnNumber === source[0].location.columnNumber)) continue;
      if (breakpoint.condition) {
        conditional = true;
        const result = native(29, source[0].callFrameId, breakpoint.condition, false, undefined);
        if (result.status !== 'success' || !result.value) continue;
      }
      // debug(fn) pauses with its own reason and is not a protocol breakpoint.
      if (breakpoint.debugCommand) debugCommand = true;
      else hits.push(id);
    }
    if (conditional && hits.length === 0 && !debugCommand && payload.reason !== 'exception') continue;
    // Blackboxed scripts are stepped through and their debugger statements ignored;
    // an explicit breakpoint there still stops.
    if (hits.length === 0 && !debugCommand && payload.reason !== 'exception' && source.length && data.blackbox.length) {
      const url = scriptURLs.get(source[0].location.scriptId) ?? '';
      if (data.blackbox.some(pattern => pattern.test(url))) continue;
    }
    delivered = true;
    // The pause --inspect-brk arms (V8's schedulePauseOnNextStatement from Node's
    // agent) reports 'Break on start'.
    const reason = debugCommand && payload.reason !== 'exception' ? 'debugCommand'
      : stepped && hits.length === 0 && payload.reason !== 'exception' ? 'step'
      : startup && hits.length === 0 && (!payload.reason || payload.reason === 'other') ? 'Break on start' : payload.reason || 'other';
    const asyncStackTrace = data.asyncDepth > 0 ? asyncTasks().asyncStackTrace(data.asyncDepth) : undefined;
    session.emit('Debugger.paused', { callFrames: frames(session, source), reason, hitBreakpoints: hits, ...(asyncStackTrace && { asyncStackTrace }) });
    if (!native(31)) break;
  }
  // V8 schedules the start pause only for sessions whose debugger is enabled
  // (V8DebuggerAgentImpl::schedulePauseOnNextStatement): without one it runs on.
  if (!delivered && (!startup || enabled.size === 0) && native(31)) { native(27, 0); activePause = undefined; }
  // Node's runMessageLoopOnPause has no frontend to wait for when only same-thread
  // sessions saw the pause: execution continues once they have been notified.
  else if (delivered && native(31) && [...enabled].every(session => session.local)) { native(27, 0); activePause = undefined; }
}
// V8 records async tasks for the deepest stack any enabled session asked for.
let asyncModule;
function asyncTasks() { return asyncModule ??= require('internal/inspector_async'); }
function asyncDepth() {
  let depth = 0;
  for (const session of enabled) depth = Math.max(depth, state(session).asyncDepth);
  asyncTasks().setDepth(depth);
}
function resumed() {
  activePause = undefined;
  for (const session of enabled) { session.values.releaseGroup('backtrace'); session.emit('Debugger.resumed', {}); }
}
function close(session) {
  if (!enabled.delete(session)) return;
  session.values.releaseGroup('backtrace');
  const recorded = session.debugger.asyncDepth > 0;
  session.debugger = undefined;
  if (recorded) asyncDepth();
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
      // V8 names a URL breakpoint by its target and a script breakpoint by its
      // resolved location; a second one with the same name is refused.
      const exists = () => protocolError(-32000, 'Breakpoint at specified location already exists.');
      if (method === 'Debugger.setBreakpointByUrl') {
        for (const other of data.breakpoints.values()) {
          if (other.scriptId === undefined && other.lineNumber === breakpoint.lineNumber && other.columnNumber === breakpoint.columnNumber &&
            other.url === breakpoint.url && other.scriptHash === breakpoint.scriptHash && other.regex?.source === breakpoint.regex?.source) throw exists();
        }
      }
      for (const script of native(21)) if (matches(breakpoint, script)) breakpoint.locations.push(...resolve(breakpoint, script));
      if (method === 'Debugger.setBreakpoint' && !breakpoint.locations.length) throw protocolError(-32000, 'Could not resolve breakpoint');
      if (method === 'Debugger.setBreakpoint') {
        const [first] = breakpoint.locations;
        for (const other of data.breakpoints.values()) {
          if (other.scriptId !== undefined && !other.debugCommand && other.locations.some(location => location.scriptId === first.scriptId && location.lineNumber === first.lineNumber && location.columnNumber === first.columnNumber)) throw exists();
        }
      }
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
      data.asyncDepth = Math.max(0, params.maxDepth); asyncDepth(); return {};
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
      stepping = mode !== 0;
      resumed(); return {};
    }
    case 'Debugger.evaluateOnCallFrame':
      if (typeof params.callFrameId !== 'string' || typeof params.expression !== 'string') throw protocolError(-32602, 'Invalid parameters');
      if (params.timeout !== undefined && (typeof params.timeout !== 'number' || !Number.isFinite(params.timeout) || params.timeout < 0)) throw protocolError(-32602, 'Invalid parameters: timeout');
      {
        const frame = params.includeCommandLineAPI && activePause ? (activePause.frames || []).find(item => item.callFrameId === params.callFrameId) : undefined;
        const context = frame && contexts.fromToken(frame.contextToken);
        const restore = context ? session.commandLineAPI(context) : undefined;
        let result;
        try { result = native(29, params.callFrameId, params.expression, !!params.throwOnSideEffect, params.timeout); }
        finally { if (restore) restore(); }
        return session.evaluation(result, params);
      }
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
// The command line API's debug(fn, condition) and undebug(fn): a breakpoint at the
// function's entry that pauses with reason 'debugCommand', as V8's
// (V8Debugger::setBreakpointFor with kDebugCommandBreakpointSource).
function debugFunction(session, fn, condition) {
  if (typeof fn !== 'function') return;
  undebugFunction(session, fn);
  const location = native(32, fn);
  if (!location) return;
  const data = state(session);
  data.breakpoints.set(`debugCommand:${nextBreakpoint++}`, { debugCommand: true, target: fn, scriptId: location.scriptId,
    lineNumber: location.lineNumber, columnNumber: location.columnNumber, condition: condition === undefined ? '' : String(condition), locations: [location] });
  if (data.active && enabled.has(session)) native(24, location.scriptId, location.pc);
}
function undebugFunction(session, fn) {
  const data = state(session);
  let removed = false;
  for (const [id, breakpoint] of data.breakpoints) if (breakpoint.debugCommand && breakpoint.target === fn) { data.breakpoints.delete(id); removed = true; }
  if (removed) rebuild();
}

module.exports = { dispatch, close, paused, scriptParsed, armStartup, resourceURL, debugFunction, undebugFunction };
