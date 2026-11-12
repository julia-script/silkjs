'use strict';

// Node's NodeTracing domain (src/inspector/tracing_agent.cc) over the trace
// events backend: a session collects the events of its categories in memory
// and gets them back as NodeTracing.dataCollected chunks on stop.
const backend = require('internal/trace_events');
const { isMainThread } = require('worker_threads');
const { protocolError, unsupported } = require('internal/inspector_values');

// The category list Node's tracing agent reports (node_trace_events plus v8).
const categories = [
  'node', 'node.async_hooks', 'node.bootstrap', 'node.console', 'node.dns.native',
  'node.environment', 'node.fs.async', 'node.fs.sync', 'node.fs_dir.async', 'node.fs_dir.sync',
  'node.http', 'node.net.native', 'node.perf', 'node.perf.timerify', 'node.perf.usertiming',
  'node.promises.rejections', 'node.threadpoolwork.async', 'node.threadpoolwork.sync',
  'node.vm.script', 'v8',
];
const CHUNK = 1000;
const active = new Map();

function start(session, params) {
  if (!isMainThread) throw protocolError(-32000, 'Tracing properties can only be changed through main thread sessions');
  if (active.has(session)) throw protocolError(-32000, 'Call NodeTracing::end to stop tracing before updating the config');
  const config = params && params.traceConfig;
  const included = config && Array.isArray(config.includedCategories) ? config.includedCategories.filter(item => typeof item === 'string') : [];
  if (!included.length) throw protocolError(-32000, 'At least one category should be enabled');
  const set = new Set(included);
  const sink = backend.collect(set);
  active.set(session, { set, sink });
  return {};
}

function stop(session) {
  const tracing = active.get(session);
  if (!tracing) return {};
  active.delete(session);
  const events = tracing.sink.finish();
  for (let at = 0; at < events.length; at += CHUNK) session.emit('NodeTracing.dataCollected', { value: events.slice(at, at + CHUNK) });
  session.emit('NodeTracing.tracingComplete', {});
  return {};
}

function dispatch(session, method, params) {
  switch (method) {
    case 'NodeTracing.getCategories': return { categories: [...categories] };
    case 'NodeTracing.start': return start(session, params);
    case 'NodeTracing.stop': return stop(session);
    default: unsupported(method);
  }
}

function close(session) {
  const tracing = active.get(session);
  if (tracing) { active.delete(session); tracing.sink.finish(); }
}

module.exports = { dispatch, close };
