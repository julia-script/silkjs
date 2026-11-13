'use strict';
const host = require('internal/host');
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
    // A SIGUSR1 listener takes the signal from the inspector's activation, as in Node.
    if (name === 'SIGUSR1') host.processNative('debugSignalPause', [true]);
    // internal/process/signal startListeningIfSignal: an unreferenced Signal handle.
    const { Signal } = require('internal/signal_wrap');
    const wrap = new Signal();
    wrap.unref();
    wrap.onsignal = Function.prototype.bind.call(process.emit, process, name, name);
    const err = wrap.start(signals[name]);
    if (err) {
      wrap.close();
      throw new (require('internal/errors').ErrnoException)(err, 'uv_signal_start');
    }
    watchers.set(name, wrap);
  };
  process.on('newListener', name => { if (process.listenerCount(name) === 0) add(name); });
  process.on('removeListener', name => {
    const wrap = watchers.get(name);
    if (wrap && process.listenerCount(name) === 0) {
      watchers.delete(name);
      wrap.close();
      if (name === 'SIGUSR1') host.processNative('debugSignalPause', [false]);
    }
  });
  for (const name of process.eventNames()) if (process.listenerCount(name)) add(name);
  require('internal/child_process/ipc').installChild(process);
}
module.exports = { install, signalNumber, signalName };
