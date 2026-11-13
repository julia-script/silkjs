'use strict';

// The calls into the runtime's sync fs native, which stands for Node's C++ fs
// binding. V8 shows no frame for a binding call, so no stack trace shows this
// script's frames (host.hideFrames), as with internal/fs/binding.

const host = require('internal/host');
const trace = require('internal/trace_events');

host.hideFrames();

const kSyncCategory = 'node,node.fs,node.fs.sync';
// Node names a sync trace event after its binding call: copyFile is copyfile, scandir readdir.
const syncNames = { __proto__: null, copyFile: 'copyfile', scandir: 'readdir' };
function traced(operation, call, self, args) {
  const name = `fs.sync.${syncNames[operation] ?? operation}`;
  trace.emit(kSyncCategory, name, 'B');
  try { return Reflect.apply(call, self, args); }
  finally { trace.emit(kSyncCategory, name, 'E'); }
}
// Node's Environment::PrintSyncTrace for --trace-sync-io: host.traceSyncIO is set when
// the event loop starts, and each sync call then prints up to 10 frames of its stack.
function printSyncTrace() {
  const frames = host.captureCallSites(10, native);
  let text = `(node:${process.pid}) WARNING: Detected use of sync API\n`;
  for (let index = 0; index < frames.length; index++) {
    const { functionName, scriptName, lineNumber, columnNumber } = frames[index];
    text += functionName ? `    at ${functionName} (${scriptName}:${lineNumber}:${columnNumber})\n` : `    at ${scriptName}:${lineNumber}:${columnNumber}\n`;
  }
  host.stderr.write(text);
}
// Private native extension: fsSync(name, positionalArgs) returns a Node result
// or throws an Error retaining code, errno, syscall, path, and dest (see internal/fs/utils).
let syncTracing = false;
function setSyncTracing(on) { syncTracing = on; }
function native(operation, args) {
  if (typeof host.fsSync !== 'function') {
    throw require('internal/fs/utils').error('ENOSYS', operation, typeof args[0] === 'string' ? args[0] : undefined);
  }
  if (host.traceSyncIO) printSyncTrace();
  if (!syncTracing) return host.fsSync(operation, args);
  return traced(operation, host.fsSync, host, [operation, args]);
}

module.exports = { native, traced, setSyncTracing };
