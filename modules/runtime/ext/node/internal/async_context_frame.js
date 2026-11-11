'use strict';
// Node's lib/internal/async_context_frame.js over the runtime's async context.
// The frame is the context's stores map, the one AsyncLocalStorage reads when
// --async-context-frame is on (the default).
const host = require('internal/host');

function activeCurrent() {
  return host.getAsyncContext()?.stores;
}

function activeSet(frame) {
  const context = host.getAsyncContext();
  host.setAsyncContext({ stores: frame, id: context?.id, trigger: context?.trigger, resource: context?.resource });
}

function activeExchange(frame) {
  const prior = activeCurrent();
  activeSet(frame);
  return prior;
}

function activeDisable(store) {
  activeCurrent()?.delete(store);
}

class InactiveAsyncContextFrame extends Map {
  static get enabled() {
    enabled_ ??= checkEnabled();
    return enabled_;
  }

  static current() {}
  static set(frame) {}
  static exchange(frame) {}
  static disable(store) {}
}

class AsyncContextFrame extends InactiveAsyncContextFrame {
  constructor(store, data) {
    super(AsyncContextFrame.current());
    this.set(store, data);
  }

  disable(store) {
    this.delete(store);
  }
}

let enabled_;

function checkEnabled() {
  const enabled = host.asyncContextFrame !== false;
  if (enabled) {
    AsyncContextFrame.current = activeCurrent;
    AsyncContextFrame.set = activeSet;
    AsyncContextFrame.exchange = activeExchange;
    AsyncContextFrame.disable = activeDisable;
  }
  return enabled;
}

module.exports = AsyncContextFrame;
