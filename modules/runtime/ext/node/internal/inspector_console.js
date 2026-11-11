'use strict';

const host = require('internal/host');
let currentEmitter;
let callDepth = 0;
function call(type, args, receiver, method) {
  const outer = callDepth++ === 0;
  try {
    if (outer && currentEmitter) currentEmitter(type, args);
    return Reflect.apply(method, receiver, args);
  } finally { callDepth--; }
}
function create(publish) {
  const console = Object.create(null);
  const counts = new Map(), timers = new Map();
  let forwarding = 0;
  let emitting = false;
  function emitConsole(type, args) {
    if (forwarding || emitting) return;
    if (type === 'assert') {
      if (args[0]) return;
      args = ['Assertion failed', ...args.slice(1)];
    } else if (type === 'count' || type === 'countReset') {
      const label = args[0] === undefined ? 'default' : String(args[0]);
      if (type === 'countReset') { counts.delete(label); return; }
      const value = (counts.get(label) || 0) + 1;
      counts.set(label, value);
      args = [`${label}: ${value}`];
    } else if (type === 'time' || type === 'timeLog' || type === 'timeEnd') {
      const label = args[0] === undefined ? 'default' : String(args[0]);
      if (type === 'time') { if (!timers.has(label)) timers.set(label, host.now()); return; }
      const start = timers.get(label);
      if (start === undefined) return;
      args = [`${label}: ${(host.now() - start).toFixed(3)}ms`, ...args.slice(1)];
      if (type === 'timeEnd') timers.delete(label);
      else type = 'log';
    }
    const names = { group: 'startGroup', groupCollapsed: 'startGroupCollapsed', groupEnd: 'endGroup', warn: 'warning' };
    emitting = true;
    try { publish(names[type] || type, args); }
    finally { emitting = false; }
  }
  for (const name of ['log', 'debug', 'info', 'warn', 'error', 'dir', 'dirxml', 'table', 'trace', 'clear', 'assert', 'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'group', 'groupCollapsed', 'groupEnd']) {
    console[name] = (...args) => {
      emitConsole(name, args);
      forwarding++;
      // The built-in console, loaded on the first forwarded call.
      const output = require('console');
      try { return Reflect.apply(output[name], output, args); }
      finally { forwarding--; }
    };
  }
  currentEmitter = emitConsole;
  return { console, emitConsole };
}
module.exports = { create, call };
