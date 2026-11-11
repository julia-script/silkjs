'use strict';

// --heap-prof: the runtime's sampling allocation profiler runs from startup, and its profile
// is written as a .heapprofile when the thread exits, as Node does. Samples are observed
// native allocator requests (see inspector_profiles.samplingProfile), not V8 heap estimates.

const host = require('internal/host');
const valueOptions = new Set(['--heap-prof-name', '--heap-prof-dir', '--heap-prof-interval']);
const optionEntries = [['--heap-prof', false], ['--no-heap-prof', false], ...[...valueOptions].map(name => [name, true])];
const state = { enabled: false, name: undefined, dir: undefined, interval: undefined };
let active = false;
let sequence = 0;

function applyOption(arg) {
  const separator = arg.indexOf('=');
  const name = separator < 0 ? arg : arg.slice(0, separator);
  if (name === '--heap-prof' || name === '--no-heap-prof') {
    if (separator >= 0) return false;
    state.enabled = name === '--heap-prof';
    return true;
  }
  if (!valueOptions.has(name) || separator < 0) return false;
  const value = arg.slice(separator + 1);
  if (value === '') throw new Error(name + ' requires an argument');
  if (name === '--heap-prof-interval') {
    if (!/^[0-9]+$/.test(value) || Number(value) === 0 || !Number.isSafeInteger(Number(value))) throw new Error('invalid value for ' + name);
    state.interval = Number(value);
  } else if (name === '--heap-prof-name') state.name = value;
  else state.dir = value;
  return true;
}
// Returns Node's startup error text when a dependent flag is used without --heap-prof.
function start() {
  if (!state.enabled) {
    for (const [name, key] of [['--heap-prof-name', 'name'], ['--heap-prof-dir', 'dir'], ['--heap-prof-interval', 'interval']]) {
      if (state[key] !== undefined) return name + ' must be used with --heap-prof';
    }
    return;
  }
  if (active) return;
  // Node's default sampling interval is 512 KiB; the recorder keeps at most 16384 events.
  active = host.allocationProfileStart(state.interval ?? 524288, 16384);
  // Node also writes the profile when SIGINT ends the process. With no SIGINT listener the
  // watcher writes it, then stops itself and raises SIGINT again for the default action.
  if (active && require('worker_threads').isMainThread) {
    const signal = require('os').constants.signals.SIGINT;
    const id = host.processNative('signalStart', [signal, () => {
      if (process.listenerCount('SIGINT') !== 0) return;
      finish();
      host.processNative('signalStop', [id]);
      process.kill(process.pid, 'SIGINT');
    }]);
  }
}
function filename() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Heap.${date}.${time}.${process.pid}.${require('worker_threads').threadId}.${String(++sequence).padStart(3, '0')}.heapprofile`;
}
function finish() {
  if (!active) return;
  active = false;
  const recording = host.allocationProfileStop();
  if (recording === null) return;
  const profile = require('internal/inspector_profiles').samplingProfile(JSON.parse(recording), false);
  const fs = require('fs'), path = require('path');
  const directory = path.resolve(state.dir ?? process.cwd());
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, state.name ?? filename()), JSON.stringify(profile));
  } catch (error) {
    try { fs.writeSync(2, `Failed to write heap profile: ${error?.message ?? error}\n`); } catch {}
  }
}

module.exports = {
  optionEntries, applyOption, start, finish,
  isValueOption: name => valueOptions.has(name),
  active: () => active,
};
