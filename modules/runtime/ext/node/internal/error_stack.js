'use strict';

const host = require('internal/host');
const { getPrototypeOf: ReflectGetPrototypeOf, getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor } = Reflect;

// Each realm owns its CallSite prototype. Shared ephemeron brands allow borrowed
// CallSite methods and recaptured targets without retaining abandoned realms.
// isolated: a ShadowRealm, which never falls back to the main realm's Error.prepareStackTrace
// as a vm context does.
function install(global, isolated = false) {
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
    // The structured frames of each formatted error: the inspector's exceptionDetails
    // and the fatal report's origin.
    frames: new WeakMap(),
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
    // A Wasm frame's position is its byte offset in the module.
    if (frame.wasmFunction >= 0) return frame.columnNumber - 1;
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
  // Node's internalBinding('errors').getErrorSourcePositions: where the top
  // frame of a capture whose stack is not formatted yet sits in its script's
  // source, as { sourceLine, scriptResourceName, lineNumber, startColumn }
  // with a 0-based column. Undefined when there is no such frame or source.
  function isLineBreak(code) { return code === 10 || code === 13 || code === 0x2028 || code === 0x2029; }
  if (!state.getErrorSourcePositions) state.getErrorSourcePositions = (error) => {
    const entry = captured.get(error);
    if (!entry || entry.ready || !entry.raw || entry.raw.length === 0) return undefined;
    const frame = fromNative(entry.raw[0]);
    if (frame.scriptId === '0') return undefined;
    const offset = position(frame);
    if (offset === null || offset < 0) return undefined;
    const source = scriptMetadata(frame).source;
    let start = offset;
    while (start > 0 && !isLineBreak(source.charCodeAt(start - 1))) start--;
    let end = offset;
    while (end < source.length && !isLineBreak(source.charCodeAt(end))) end++;
    return { sourceLine: source.slice(start, end), scriptResourceName: frame.scriptName,
      lineNumber: frame.lineNumber, startColumn: offset - start };
  };
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
  // V8's SerializeJSStackFrame: an async stack trace frame is "async " then the frame.
  // A combinator waiting in the async stack trace, as V8 writes it.
  const combinatorNames = ['all', 'allSettled', 'any'];
  // V8's SerializeWasmStackFrame: [module.]name (url:wasm-function[index]:0xoffset).
  function stringifyWasm(frame) {
    const name = frame.functionName;
    const module = frame.wasmModule;
    const place = (frame.scriptName || '<anonymous>') + ':wasm-function[' + frame.wasmFunction + ']:0x' +
      (frame.columnNumber - 1).toString(16);
    if (!name && !module) return place;
    return (module ? (name ? module + '.' + name : module) : name) + ' (' + place + ')';
  }
  function stringify(frame) {
    if (frame.wasmFunction >= 0) return stringifyWasm(frame);
    if (frame.promiseCombinator >= 0) return 'async Promise.' + combinatorNames[frame.promiseCombinator] + ' (index ' + frame.promiseIndex + ')';
    return frame.isAsync ? 'async ' + stringifyFrame(frame) : stringifyFrame(frame);
  }
  function stringifyFrame(frame) {
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
  // A frame a source map moved, as Node's serializeJSStackFrame
  // (lib/internal/source_map/prepare_stack_trace.js) writes it from the CallSite.
  function stringifyMapped(frame) {
    const fnName = (frame.functionName || (frame.isEval ? 'eval' : null)) ?? methodName(frame);
    const prefix = frame.isAsync ? 'async ' : frame.isConstructor ? 'new ' : '';
    // V8's GetTypeName is null unless the frame is a method call: not a constructor,
    // not top-level code (a global or nullish receiver).
    const type = frame.isConstructor || frame.isToplevel !== false || frame.receiver === global ? null : typeName(frame);
    const namePrefix = type !== null && type !== 'global' ? type + '.' : '';
    return prefix + namePrefix + (frame.mappedName || fnName || '<anonymous>') +
      ' (' + frame.scriptName + ':' + frame.lineNumber + ':' + frame.columnNumber + ')';
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
    // Promise.all continuations are not walked: no frame is one.
    getPromiseIndex() { const frame = record(this); return frame.promiseCombinator >= 0 ? frame.promiseIndex : null; },
    getScriptNameOrSourceURL() { const frame = record(this); return frame.scriptName || (frame.isEval ? undefined : null); },
    getScriptHash() {
      const frame = record(this);
      const metadata = scriptMetadata(frame);
      if (!metadata || typeof metadata.source !== 'string') return '';
      return require('crypto').createHash('sha256').update(metadata.source).digest('hex');
    },
    getThis() { return record(this).receiver; },
    getTypeName() { return typeName(record(this)); },
    isAsync() { return record(this).isAsync; },
    isConstructor() { return record(this).isConstructor; },
    isEval() { return record(this).isEval; },
    isNative() { return record(this).isNative; },
    isPromiseAll() { return record(this).promiseCombinator === 0; },
    isToplevel() { return record(this).isToplevel; },
    toString() { return stringify(record(this)); },
  };
  for (const name of Object.keys(methods)) define(CallSite.prototype, name, {
    value: methods[name], writable: true, configurable: true,
  });
  // V8 looks the method name up when the stack is formatted, not when it is
  // captured: a property that no longer holds the function (an Immediate's
  // _onImmediate, cleared after its call) names no method.
  let types;
  function currentMethod(name, fn, receiver) {
    if (typeof name !== 'string' || name === '' || name[0] === '[' || typeof fn !== 'function' ||
      receiver === null || (typeof receiver !== 'object' && typeof receiver !== 'function')) return name;
    types ??= require('util/types');
    for (let object = receiver; object !== null; object = ReflectGetPrototypeOf(object)) {
      if (types.isProxy(object)) return name;
      const descriptor = ReflectGetOwnPropertyDescriptor(object, name);
      if (descriptor !== undefined) {
        return descriptor.value === fn || descriptor.get === fn || descriptor.set === fn ? name : null;
      }
    }
    return null;
  }
  function fromNative(raw) {
    return {
      functionName: raw[10] ? raw[8] ? 'eval' : '' : raw[0],
      fileName: raw[1], scriptName: raw[16]?.sourceURL || (raw[8] ? '' : raw[1]), scriptId: raw[2],
      lineNumber: raw[3], columnNumber: raw[4], function: raw[5],
      receiver: raw[6] == null ? raw[6] : Object(raw[6]),
      isConstructor: raw[7], isEval: raw[8], isNative: raw[9] && !raw[17], isScript: raw[10],
      enclosingLineNumber: raw[16]?.enclosingLineNumber ?? raw[11],
      enclosingColumnNumber: raw[16]?.enclosingColumnNumber ?? raw[12],
      typeName: raw[13], methodName: currentMethod(raw[14], raw[22], raw[21]), isToplevel: raw[15],
      scriptMetadata: raw[16],
      sourceLineNumber: raw[18], sourceColumnNumber: raw[19], isAsync: raw[20] === true,
      promiseCombinator: raw[23], promiseIndex: raw[24],
      wasmFunction: raw[25], wasmModule: raw[26],
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
      result += '\n    at ' + (frame.sourceMapped ? stringifyMapped(frame) : stringify(frame));
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
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') state.frames.set(error, frames);
    if (state.formatting) return defaultFormat(error, frames);
    state.formatting = true;
    try {
      const override = state.overrides.get(error);
      if (override !== undefined) state.overrides.delete(error);
      let owner = Error;
      let prepare = override ?? owner.prepareStackTrace;
      if (override === undefined && typeof prepare !== 'function' && rootError !== Error && !isolated) {
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

// The frames an error captured, once its stack has been formatted.
function framesOf(error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  const state = host.errorStackState;
  if (!state) return undefined;
  if (!state.frames.has(error)) {
    try { void error.stack; } catch { return undefined; }
  }
  return state.frames.get(error);
}
// The first frame with a source location of error's formatted stack, where V8
// places the message of an error no throw statement threw.
function origin(error) {
  const frames = (typeof error === 'object' && error !== null) ? host.errorStackState?.frames.get(error) : undefined;
  if (!frames) return undefined;
  for (const frame of frames) if (!frame.isNative && frame.wasmFunction < 0 && frame.lineNumber > 0 && frame.scriptName) return frame;
  return undefined;
}

module.exports = {
  install,
  framesOf,
  origin,
  get overrideStackTrace() { return host.errorStackState.overrides; },
  get ErrorPrepareStackTrace() { return host.errorStackState.defaultPrepare; },
};
