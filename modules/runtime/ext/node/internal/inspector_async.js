'use strict';

// The async task half of Node's inspector binding (src/inspector_agent.cc
// registerAsyncHook and asyncTask*, over V8Inspector's async task API): tasks
// that async_hooks report while a session asks for async call stacks, and the
// asyncStackTrace of a pause inside one of them.
const host = require('internal/host');

const tasks = new Map();
const running = [];
let hooks;
let active = false;

// Node's pre_execution registers internal/inspector_async_hook here at start;
// it is loaded on first use instead, unless something registered first.
function registerAsyncHook(enable, disable) {
  if (typeof enable !== 'function' || typeof disable !== 'function') throw new TypeError('enable and disable must be functions');
  hooks = { enable, disable };
}
// The deepest async stack any session wants: V8 records tasks only while it is above 0.
function setDepth(depth) {
  const on = depth > 0;
  if (on === active) return;
  active = on;
  if (!on) { tasks.clear(); running.length = 0; }
  hooks ??= require('internal/inspector_async_hook');
  if (on) hooks.enable(); else hooks.disable();
  require('async_hooks')._setPromiseObserver(on ? promiseEvent : undefined);
}
// V8 schedules a "Promise.then" task where then() derives a promise, and runs
// it around the reaction job; promises keyed apart from async_hooks ids.
function promiseEvent(event, token, derived) {
  const id = `promise:${token}`;
  if (event === 0) { if (derived) tasks.set(id, { description: 'Promise.then', callFrames: stack(promiseEvent), parent: running.at(-1) ?? null, recurring: false }); }
  else if (event === 1) asyncTaskStarted(id);
  else if (event === 2) asyncTaskFinished(id);
  else if (event === 4) tasks.delete(id);
}
function stack(skip) {
  return host.captureCallSites(200, skip).map(frame => ({
    functionName: frame.functionName || '', scriptId: String(frame.scriptId ?? 0), url: frame.scriptName || '',
    lineNumber: Math.max(0, (frame.lineNumber ?? 1) - 1), columnNumber: Math.max(0, (frame.columnNumber ?? 1) - 1),
  }));
}
function asyncTaskScheduled(name, id, recurring) {
  if (!active) return;
  tasks.set(id, { description: `${name}`, callFrames: stack(asyncTaskScheduled), parent: running.at(-1) ?? null, recurring: !!recurring });
}
function asyncTaskStarted(id) {
  if (!active) return;
  running.push(tasks.get(id) ?? null);
}
function asyncTaskFinished(id) {
  if (!active) return;
  running.pop();
  const task = tasks.get(id);
  if (task && !task.recurring) tasks.delete(id);
}
function asyncTaskCanceled(id) { tasks.delete(id); }

// Runtime.StackTrace of the running task and its schedulers, at most depth deep.
function asyncStackTrace(depth) {
  let task = running.at(-1);
  if (!task || depth <= 0) return undefined;
  const head = { description: task.description, callFrames: task.callFrames };
  let tail = head;
  for (let level = 1; level < depth && (task = task.parent); level++) {
    tail.parent = { description: task.description, callFrames: task.callFrames };
    tail = tail.parent;
  }
  return head;
}

module.exports = { registerAsyncHook, asyncTaskScheduled, asyncTaskStarted, asyncTaskFinished, asyncTaskCanceled, setDepth, asyncStackTrace };
