'use strict';
const host = require('internal/host');
const { AsyncResource } = require('async_hooks');
let signalTable;
const signalNumbers = () => signalTable ??= require('os').constants.signals;
function signalNumber(signal = 'SIGTERM') {
  const signals = signalNumbers();
  if (typeof signal === 'string' && signals[signal.toUpperCase()] !== undefined) return signals[signal.toUpperCase()];
  if (Number.isInteger(signal) && signal >= 0 && signal <= 0x7fffffff) return signal;
  throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: 'ERR_UNKNOWN_SIGNAL' });
}
let signalNames;
// The first name of each number, as a search of the table in order finds it.
function signalName(number) {
  if (!number) return null;
  if (!signalNames) {
    const signals = signalNumbers(); signalNames = new Map();
    for (const name of Object.keys(signals)) if (!signalNames.has(signals[name])) signalNames.set(signals[name], name);
  }
  return signalNames.get(number) ?? null;
}
function install(process) {
  const watchers = new Map();
  const add = name => {
    // Every signal name starts with SIG, so other events never load the table.
    if (typeof name !== 'string' || !name.startsWith('SIG')) return;
    const signals = signalNumbers();
    if (signals[name] === undefined || watchers.has(name)) return;
    const resource = new AsyncResource('SIGNALWRAP');
    const id = host.processNative('signalStart', [signals[name], () => {
      host.invokeResource(resource, process.emit, process, [name, name], false);
      host.checkpoint();
    }]);
    if (id < 0) {
      resource.emitDestroy();
      const code = host.processNative('errorName', [id]);
      throw Object.assign(new Error(`uv_signal_start ${code}`), { code, errno: id, syscall: 'uv_signal_start' });
    }
    watchers.set(name, { id, resource });
  };
  process.on('newListener', name => { if (process.listenerCount(name) === 0) add(name); });
  process.on('removeListener', name => {
    const watcher = watchers.get(name);
    if (watcher && process.listenerCount(name) === 0) {
      watchers.delete(name);
      host.processNative('signalStop', [watcher.id]);
      watcher.resource.emitDestroy();
    }
  });
  for (const name of process.eventNames()) if (process.listenerCount(name)) add(name);
  require('internal/child_process/ipc').installChild(process);
}
module.exports = { install, signalNumber, signalName };
