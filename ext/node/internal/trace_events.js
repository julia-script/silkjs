'use strict';

const host = require('internal/host');
const counts = new Map();
const resources = new Map();
let patterns = [];
let filePattern = 'node_trace.${rotation}.log';
let opened = false;
let writing = false;
let hook;
let asyncEnabled = false;
let initialized = false;
let nextId = 1;
const stringify = JSON.stringify;
function native(operation, value, timestamp) {
  const errno = host.traceNative(operation, value, timestamp);
  if (errno) throw Object.assign(new Error(`Trace file ${operation} failed (errno ${errno})`), { code: 'ERR_TRACE_EVENTS_WRITE', errno: -errno });
}
function available() { return typeof host.traceNative === 'function'; }
function enabled(group) {
  if (patterns.length === 0) return false;
  return group.split(',').some(category => patterns.some(pattern => pattern.test(category)));
}
function ensureOpen() {
  if (opened) return;
  const path = filePattern.replace(/\$\{(pid|rotation)\}/g, (_, key) => key === 'pid' ? String(process.pid) : '1');
  native('open', path);
  opened = true;
}
function emit(category, name, phase, args = {}, id, timestamp, duration) {
  if (writing || !enabled(category)) return;
  writing = true;
  try {
    const event = { cat: category, name, ph: phase, args };
    if (id !== undefined) event.id = `0x${id.toString(16)}`;
    if (phase === 'i') event.s = 't';
    if (duration !== undefined) event.dur = duration;
    const json = stringify(event);
    native('record', json.slice(0, -1), timestamp);
  } finally { writing = false; }
}
function sync() {
  patterns = [...counts.keys()].map(category => new RegExp(`^${category.split('*').map(part => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')).join('.*')}$`));
  const track = enabled('node,node.async_hooks');
  native('gc', enabled('v8,gc'));
  if (track && !asyncEnabled) {
    if (!hook) {
      const async = require('async_hooks');
      hook = async.createHook({
        init(id, type, triggerAsyncId) {
          resources.set(id, type);
          emit('node,node.async_hooks', type, 'b', { triggerAsyncId, executionAsyncId: async.executionAsyncId() }, id);
        },
        before(id) { const type = resources.get(id); if (type !== undefined) emit('node,node.async_hooks', `${type}_CALLBACK`, 'b', {}, id); },
        after(id) { const type = resources.get(id); if (type !== undefined) emit('node,node.async_hooks', `${type}_CALLBACK`, 'e', {}, id); },
        destroy(id) {
          const type = resources.get(id);
          if (type !== undefined) { resources.delete(id); emit('node,node.async_hooks', type, 'e', {}, id); }
        },
      });
    }
    asyncEnabled = true;
    hook.enable();
  } else if (!track && asyncEnabled) {
    asyncEnabled = false;
    hook.disable();
    resources.clear();
  }
}
function add(categories) {
  ensureOpen();
  for (const category of categories) counts.set(category, (counts.get(category) || 0) + 1);
  sync();
}
function remove(categories) {
  for (const category of categories) {
    const count = counts.get(category);
    if (count === 1) counts.delete(category);
    else if (count !== undefined) counts.set(category, count - 1);
  }
  sync();
  native('flush');
}
function getEnabledCategories() { return [...counts.keys()].sort().join(',') || undefined; }
function initialize(options = {}) {
  if (initialized) return;
  initialized = true;
  if (options.filePattern !== undefined) filePattern = options.filePattern;
  if (options.enabled || options.categories !== undefined) {
    const categories = options.categories === undefined ? ['v8', 'node', 'node.async_hooks'] :
      Array.isArray(options.categories) ? options.categories : options.categories.split(',');
    add(new Set(categories));
  }
}
function begin(category, name, args) {
  if (!enabled(category)) return;
  const id = nextId++;
  emit(category, name, 'b', args, id);
  return id;
}
function end(category, name, id, args) { if (id !== undefined) emit(category, name, 'e', args, id); }
function performanceEntry(entry, origin) {
  const category = entry.entryType === 'mark' || entry.entryType === 'measure' ? 'node,node.perf,node.perf.usertiming' :
    entry.entryType === 'function' ? 'node,node.perf,node.perf.timerify' : 'node,node.perf';
  if (!enabled(category)) return;
  const timestamp = (origin + entry.startTime) * 1000;
  emit(category, entry.name, entry.entryType === 'mark' ? 'i' : 'X', { entryType: entry.entryType }, undefined, timestamp, entry.entryType === 'mark' ? undefined : entry.duration * 1000);
}
function diagnostic(name) {
  if (enabled('node.diagnostics_channel')) emit('node.diagnostics_channel', String(name), 'i');
}
function flush() { if (opened) native('flush'); }
module.exports = { available, enabled, add, remove, getEnabledCategories, initialize, emit, begin, end, performanceEntry, diagnostic, flush };
