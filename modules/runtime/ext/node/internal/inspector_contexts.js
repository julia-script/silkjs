'use strict';

// The vm module registers native handles here; public sandbox objects never
// expose them. Weak references let inspector discovery avoid keeping realms alive.
const native = require('internal/host').inspectorNative;
const owner = native(10);
const bySandbox = new WeakMap();
const contexts = new Map();
const tokens = new Map();
const listeners = new Set();
const contextListeners = new Set();
let nextId = 2;
// Node names the main context after the process title (argv0 at start) and pid, a worker's after its thread id.
function mainName() {
  const { isMainThread, threadId } = require('worker_threads');
  return isMainThread ? `${process.argv0}[${process.pid}]` : `Worker[${threadId}]`;
}
const main = { id: 1, name: 'main', origin: '', uniqueId: `silk:${owner}:main`, handle: undefined, token: String(native(14)) };
let nextDefaultName = 1;
function register(sandbox, handle, options = {}) {
  const existing = bySandbox.get(sandbox);
  if (existing) return existing.id;
  const id = nextId++;
  // As lib/vm.js: unnamed contexts are numbered on their own, from 1.
  const entry = { id, name: options.name === undefined ? `VM Context ${nextDefaultName++}` : options.name, origin: options.origin || '', uniqueId: `silk:${owner}:context:${id}`, handle, token: String(native(14, handle)) };
  bySandbox.set(sandbox, entry);
  contexts.set(id, new WeakRef(sandbox));
  tokens.set(entry.token, new WeakRef(sandbox));
  // Context creation must precede deferred scriptParsed events for this realm.
  for (const listener of contextListeners) listener(entry);
  for (const listener of listeners) listener(entry);
  return id;
}
function get(sandbox) { return sandbox === undefined ? main : bySandbox.get(sandbox); }
function fromToken(token) {
  token = String(token);
  if (token === main.token) return main;
  const reference = tokens.get(token);
  const sandbox = reference && reference.deref();
  if (sandbox) return bySandbox.get(sandbox);
  tokens.delete(token);
}
function list() {
  const result = [main];
  for (const [id, reference] of contexts) {
    const sandbox = reference.deref();
    if (sandbox) result.push(bySandbox.get(sandbox));
    else contexts.delete(id);
  }
  return result;
}
function resolve(id, uniqueId) {
  for (const context of list()) {
    if (uniqueId !== undefined ? context.uniqueId === uniqueId : context.id === (id === undefined ? 1 : id)) return context;
  }
}
function description(context) {
  return { id: context.id, name: context === main ? mainName() : context.name, origin: context.origin, uniqueId: context.uniqueId, auxData: { isDefault: context.id === 1 } };
}
module.exports = { register, get, list, resolve, fromToken, description, subscribe: (listener, first = false) => (first ? contextListeners : listeners).add(listener) };
