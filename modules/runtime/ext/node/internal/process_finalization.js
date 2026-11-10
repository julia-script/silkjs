'use strict';
const WeakReference = WeakRef;
const Registry = FinalizationRegistry;
const SetConstructor = Set;
function createFinalization(process) {
  const refs = { exit: new SetConstructor(), beforeExit: new SetConstructor() };
  const listeners = { exit: () => invoke('exit'), beforeExit: () => invoke('beforeExit') };
  const warned = new SetConstructor();
  let registered = false;
  function warn(name) {
    if (warned.has(name)) return;
    warned.add(name);
    process.emitWarning(`process.finalization.${name} is an experimental feature and might change at any time`, 'ExperimentalWarning');
  }
  function uninstall(event) {
    if (refs[event].size === 0) process.removeListener(event, listeners[event]);
    if (refs.exit.size === 0 && refs.beforeExit.size === 0) registered = false;
  }
  const registry = new Registry(ref => {
    for (const event of ['exit', 'beforeExit']) {
      if (refs[event].delete(ref)) uninstall(event);
    }
  });
  function invoke(event) {
    // Set iteration intentionally observes registrations/unregistrations made by callbacks.
    for (const ref of refs[event]) {
      const obj = ref.deref();
      const fn = ref.fn;
      if (obj !== undefined) fn(obj, event);
    }
    for (const ref of refs[event]) registry.unregister(ref);
    refs[event].clear();
  }
  function add(event, obj, fn) {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function') || Array.isArray(obj)) {
      throw Object.assign(new TypeError('The "obj" argument must be of type object.'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    if (refs[event].size === 0) process.on(event, listeners[event]);
    const ref = new WeakReference(obj);
    ref.fn = fn;
    // Neither the held value nor the unregister token owns the target.
    registry.register(obj, ref, ref);
    registered = true;
    refs[event].add(ref);
  }
  return {
    register(obj, fn) { warn('register'); add('exit', obj, fn); },
    registerBeforeExit(obj, fn) { warn('registerBeforeExit'); add('beforeExit', obj, fn); },
    unregister(obj) {
      warn('unregister');
      if (!registered) return;
      if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function' && typeof obj !== 'symbol') ||
          (typeof obj === 'symbol' && Symbol.keyFor(obj) !== undefined)) {
        throw new TypeError('Invalid unregisterToken');
      }
      for (const event of ['exit', 'beforeExit']) {
        for (const ref of refs[event]) {
          const target = ref.deref();
          if (target === undefined || target === obj) {
            refs[event].delete(ref);
            registry.unregister(ref);
          }
        }
        uninstall(event);
      }
    },
  };
}
module.exports = { createFinalization };
