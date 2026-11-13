'use strict';
// internalBinding('signal_wrap'): signal_wrap.cc's Signal handle over the
// runtime's signal watchers (process_native signalStart and signalStop). Like a
// HandleWrap it keeps the loop alive while started and referenced.
const host = require('internal/host');
const { AsyncResource } = require('async_hooks');

const handles = new WeakMap();
// V8's signature check on a FunctionTemplate method.
function handle(receiver) {
  const state = handles.get(receiver);
  if (state === undefined) throw new TypeError('Illegal invocation');
  return state;
}
function stopWatching(state) {
  if (state.id < 0) return;
  host.processNative('signalStop', [state.id]);
  state.id = -1;
}

class Signal {
  constructor() {
    handles.set(this, { id: -1, referenced: true, closed: false, resource: new AsyncResource('SIGNALWRAP') });
  }
  // uv_signal_start: 0, or the negative error code.
  start(signum) {
    const state = handle(this);
    if (state.closed) return 0;
    signum |= 0;
    // SignalWrap::Start: the inspector's profiler owns SIGPROF while it listens.
    if (signum === require('os').constants.signals.SIGPROF && process.platform !== 'win32' &&
        process.features.inspector && require('internal/inspector').url() !== undefined) {
      process.emitWarning('process.on(SIGPROF) is reserved while debugging');
      return undefined;
    }
    stopWatching(state);
    const self = this;
    const id = host.processNative('signalStart', [signum, function onSignal() {
      if (typeof self.onsignal === 'function') host.invokeResource(state.resource, self.onsignal, self, [signum], false);
      host.checkpoint();
    }]);
    if (id < 0) return id;
    state.id = id;
    if (state.referenced) host.processNative('ref', [id]);
    return 0;
  }
  stop() {
    stopWatching(handle(this));
    return 0;
  }
  close(callback) {
    const state = handle(this);
    if (state.closed) return;
    state.closed = true;
    stopWatching(state);
    state.resource.emitDestroy();
    if (typeof callback === 'function') process.nextTick(() => Reflect.apply(callback, this, []));
  }
  ref() {
    const state = handle(this);
    state.referenced = true;
    if (state.id >= 0) host.processNative('ref', [state.id]);
  }
  unref() {
    const state = handle(this);
    state.referenced = false;
    if (state.id >= 0) host.processNative('unref', [state.id]);
  }
  hasRef() {
    const state = handle(this);
    return state.referenced && state.id >= 0;
  }
  getAsyncId() { return handle(this).resource.asyncId(); }
}

module.exports = { Signal };
