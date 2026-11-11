'use strict';

const host = require('internal/host');

// Each realm owns its CallSite prototype. Shared ephemeron brands allow borrowed
// CallSite methods and recaptured targets without retaining abandoned realms.
function install(global) {
  const Error = global.Error;
  const Object = global.Object;
  const TypeError = global.TypeError;
  const WeakMap = global.WeakMap;
  const state = host.errorStackState || (host.errorStackState = {
    records: new WeakMap(), captured: new WeakMap(), rootError: Error, formatting: false,
    // Node's overrideStackTrace: a one-shot formatter for one error, ahead of Error.prepareStackTrace.
    overrides: new WeakMap(),
    // internal/errors: NodeErrors answer true to kIsNodeError (Node's symbol of the same name).
    kIsNodeError: Symbol('kIsNodeError'),
  });
  const { records, captured, rootError, kIsNodeError } = state;
  const define = Object.defineProperty;
  function record(site) {
    const value = records.get(site);
    if (!value) throw new TypeError('CallSite method called on incompatible receiver');
    return value;
  }
  function CallSite() { throw new TypeError('CallSite is not a constructor'); }
  function methodName(frame) { return frame.methodName || null; }
  function typeName(frame) { return frame.typeName || null; }
  function scriptMetadata(frame) { return frame.scriptMetadata; }
  function evalOrigin(origin) {
    if (!origin) return undefined;
    let location = origin.evalOrigin ? evalOrigin(origin.evalOrigin) : origin.scriptName || '<anonymous>';
    if (!origin.evalOrigin && origin.lineNumber > 0) location += ':' + origin.lineNumber;
    if (!origin.evalOrigin && origin.columnNumber > 0) location += ':' + origin.columnNumber;
    return 'eval at ' + (origin.functionName || '<anonymous>') + ' (' + location + ')';
  }
  function position(frame) {
    if (frame.scriptId === '0') return 0;
    const metadata = scriptMetadata(frame);
    if (!metadata || typeof metadata.source !== 'string') return null;
    const sourceLine = !metadata.sourceURL && typeof metadata.lineOffset === 'number'
      ? frame.lineNumber - metadata.lineOffset : frame.sourceLineNumber;
    const sourceColumn = !metadata.sourceURL && typeof metadata.columnOffset === 'number'
      ? frame.columnNumber - (sourceLine === 1 ? metadata.columnOffset : 0) : frame.sourceColumnNumber;
    if (sourceLine < 1) return null;
    let offset = 0;
    let line = 1;
    const source = metadata.source;
    while (line < sourceLine && offset < source.length) {
      const character = source.charCodeAt(offset++);
      if (character === 13) {
        if (source.charCodeAt(offset) === 10) offset++;
        line++;
      } else if (character === 10 || character === 0x2028 || character === 0x2029) line++;
    }
    return line === sourceLine ? offset + sourceColumn - 1 : null;
  }
  function location(frame) {
    if (frame.isNative) return 'native';
    let filename = frame.scriptName || '<anonymous>';
    if (frame.isEval && !frame.scriptName) {
      const origin = evalOrigin(scriptMetadata(frame)?.evalOrigin);
      if (origin) filename = origin + ', ' + filename;
    }
    if (frame.lineNumber > 0) {
      filename += ':' + frame.lineNumber;
      if (frame.columnNumber > 0) filename += ':' + frame.columnNumber;
    }
    return filename;
  }
  function stringify(frame) {
    const name = frame.functionName;
    const place = location(frame);
    if (frame.isConstructor) return 'new ' + (name || '<anonymous>') + ' (' + place + ')';
    if (!name) {
      // V8's AppendMethodCall for an unnamed function called on an object.
      if (frame.isToplevel !== false || frame.receiver === global) return place;
      const type = typeName(frame);
      const method = methodName(frame);
      return (type ? type + '.' : '') + (method || '<anonymous>') + ' (' + place + ')';
    }
    if (name.startsWith('get ') || name.startsWith('set ')) return name + ' (' + place + ')';
    const type = typeName(frame);
    const method = methodName(frame);
    let display = name;
    if (type && !display.startsWith(type + '.') && frame.receiver !== global) display = type + '.' + display;
    if (method && method !== name && !name.endsWith('.' + method)) display += ' [as ' + method + ']';
    return display + ' (' + place + ')';
  }
  function coordinate(value) { return value > 0 ? value : null; }
  const methods = {
    getColumnNumber() { return coordinate(record(this).columnNumber); },
    getEnclosingColumnNumber() { return coordinate(record(this).enclosingColumnNumber); },
    getEnclosingLineNumber() { return coordinate(record(this).enclosingLineNumber); },
    getEvalOrigin() {
      const frame = record(this);
      return frame.isEval ? scriptMetadata(frame)?.sourceURL || evalOrigin(scriptMetadata(frame)?.evalOrigin) : undefined;
    },
    getFileName() { const frame = record(this); return frame.isEval ? undefined : frame.fileName || null; },
    getFunction() { return record(this).function; },
    getFunctionName() { return record(this).functionName || null; },
    getLineNumber() { return coordinate(record(this).lineNumber); },
    getMethodName() { return methodName(record(this)); },
    getPosition() { return position(record(this)); },
    // Synchronous capture does not invent V8 asynchronous continuation frames.
    getPromiseIndex() { record(this); return null; },
    getScriptNameOrSourceURL() { const frame = record(this); return frame.scriptName || (frame.isEval ? undefined : null); },
    getScriptHash() {
      const frame = record(this);
      const metadata = scriptMetadata(frame);
      if (!metadata || typeof metadata.source !== 'string') return '';
      return require('crypto').createHash('sha256').update(metadata.source).digest('hex');
    },
    getThis() { return record(this).receiver; },
    getTypeName() { return typeName(record(this)); },
    isAsync() { record(this); return false; },
    isConstructor() { return record(this).isConstructor; },
    isEval() { return record(this).isEval; },
    isNative() { return record(this).isNative; },
    isPromiseAll() { record(this); return false; },
    isToplevel() { return record(this).isToplevel; },
    toString() { return stringify(record(this)); },
  };
  for (const name of Object.keys(methods)) define(CallSite.prototype, name, {
    value: methods[name], writable: true, configurable: true,
  });
  function fromNative(raw) {
    return {
      functionName: raw[10] ? raw[8] ? 'eval' : '' : raw[0],
      fileName: raw[1], scriptName: raw[16]?.sourceURL || (raw[8] ? '' : raw[1]), scriptId: raw[2],
      lineNumber: raw[3], columnNumber: raw[4], function: raw[5],
      receiver: raw[6] == null ? raw[6] : Object(raw[6]),
      isConstructor: raw[7], isEval: raw[8], isNative: raw[9] && !raw[17], isScript: raw[10],
      enclosingLineNumber: raw[16]?.enclosingLineNumber ?? raw[11],
      enclosingColumnNumber: raw[16]?.enclosingColumnNumber ?? raw[12],
      typeName: raw[13], methodName: raw[14], isToplevel: raw[15],
      scriptMetadata: raw[16],
      sourceLineNumber: raw[18], sourceColumnNumber: raw[19],
    };
  }
  function defaultFormat(error, frames, sites) {
    let result;
    if (kIsNodeError in error) {
      result = `${error.name} [${error.code}]: ${error.message}`;
    } else {
      const rawName = error.name;
      const name = rawName === undefined ? 'Error' : `${rawName}`;
      const rawMessage = error.message;
      const message = rawMessage === undefined ? '' : `${rawMessage}`;
      result = name ? message ? name + ': ' + message : name : message;
    }
    const sources = host.builtinLoaded('internal/source_maps') ? require('internal/source_maps') : null;
    const mapped = sources !== null && sources.getSourceMapsSupport().enabled;
    for (let index = 0; index < frames.length; index++) {
      if (!frames[index] && sites) {
        result += '\n    at ' + sites[index];
        continue;
      }
      const frame = mapped ? sources.mapPosition(frames[index], { kind: 'stack', caller: frames[index + 1] }) : frames[index];
      result += '\n    at ' + stringify(frame);
    }
    return result;
  }
  function ErrorPrepareStackTrace(error, sites) {
    const frames = [];
    for (let index = 0; index < sites.length; index++) frames[index] = records.get(sites[index]);
    return defaultFormat(error, frames, sites);
  }
  function callSites(frames) {
    const sites = [];
    for (let index = 0; index < frames.length; index++) {
      const site = Object.create(CallSite.prototype);
      records.set(site, frames[index]);
      sites[index] = site;
    }
    return sites;
  }
  function format(error, raw) {
    if (raw === undefined) return undefined;
    const frames = [];
    for (let index = 0; index < raw.length; index++) frames[index] = fromNative(raw[index]);
    if (state.formatting) return defaultFormat(error, frames);
    state.formatting = true;
    try {
      const override = state.overrides.get(error);
      if (override !== undefined) state.overrides.delete(error);
      let owner = Error;
      let prepare = override ?? owner.prepareStackTrace;
      if (override === undefined && typeof prepare !== 'function' && rootError !== Error) {
        owner = rootError;
        prepare = owner.prepareStackTrace;
      }
      if (override === undefined && (typeof prepare !== 'function' || prepare === state.defaultPrepare)) return defaultFormat(error, frames);
      return Reflect.apply(prepare, override === undefined ? owner : undefined, [error, callSites(frames)]);
    } finally { state.formatting = false; }
  }
  function getStack() {
    const state = captured.get(this);
    if (!state) return undefined;
    if (!state.ready) {
      const value = state.format(this, state.raw);
      state.value = value;
      state.ready = true;
      state.raw = undefined;
    }
    return state.value;
  }
  function setStack(value) {
    const state = captured.get(this);
    if (!state) return;
    state.value = value;
    state.ready = true;
    state.raw = undefined;
  }
  function captureStackTrace(target, constructorOpt) {
    if ((typeof target !== 'object' || target === null) && typeof target !== 'function') {
      throw new TypeError('invalid_argument');
    }
    const raw = host.captureCallSites(-1, Error,
      typeof constructorOpt === 'function' ? constructorOpt : captureStackTrace);
    if (host.captureCallSites(-3, target, raw)) return;
    define(target, 'stack', { configurable: true, get: getStack, set: setStack });
    captured.set(target, { raw, ready: false, value: undefined,
      format: host.captureCallSites(-2, target) || format });
  }
  define(getStack, 'name', { value: '', configurable: true });
  define(setStack, 'name', { value: '', configurable: true });
  define(Error, 'stackTraceLimit', { value: 10, writable: true, configurable: true, enumerable: true });
  define(Error, 'captureStackTrace', { value: captureStackTrace, writable: true, configurable: true });
  if (rootError === Error) {
    define(Error, 'prepareStackTrace', { value: ErrorPrepareStackTrace, writable: true, configurable: true });
    state.defaultPrepare = ErrorPrepareStackTrace;
  }
  host.captureCallSites(0, Error, format);
}

module.exports = {
  install,
  get overrideStackTrace() { return host.errorStackState.overrides; },
  get ErrorPrepareStackTrace() { return host.errorStackState.defaultPrepare; },
};
