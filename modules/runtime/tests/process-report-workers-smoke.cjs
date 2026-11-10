'use strict';
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const live = new Set();
async function worker(body) {
  const shared = new SharedArrayBuffer(4);
  const child = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const gate = new Int32Array(workerData);
    globalThis.backing = new Uint8Array(2 * 1024 * 1024);
    const timer = setInterval(() => {}, 1000);
    const watcher = require('node:fs').watch(process.execPath, () => {});
    parentPort.postMessage('ready');
    ${body}
  `, { eval: true, workerData: shared });
  live.add(child);
  await once(child, 'message');
  return { child, gate: new Int32Array(shared) };
}
function entry(report, id) { return report.workers.find(value => value.header.threadId === id); }
function available(value) {
  assert.ok(value, 'live worker must appear in report');
  if (value.silkjs) assert.equal(value.silkjs.snapshotStatus, 'available', JSON.stringify(value));
  assert.ok(value.javascriptHeap.usedMemory > 0, JSON.stringify(value.javascriptHeap));
  assert.ok(value.javascriptHeap.externalMemory >= 2 * 1024 * 1024, JSON.stringify(value.javascriptHeap));
  // Silk schedules JS timers in its own Map, not as libuv timer handles.
  // fs.watch creates a real native handle even before the first event-loop turn.
  assert.ok(value.libuv.some(handle => handle.is_active && handle.type === 'fs_event'), JSON.stringify(value.libuv));
}
async function main() {
  try {
    const busy = await worker('function busyDiagnosticLoop() { while (Atomics.load(gate, 0) === 0) {} } busyDiagnosticLoop(); clearInterval(timer); watcher.close();');
    const idle = await worker('parentPort.on("message", () => {});');
    const report = process.report.getReport();
    const busyReport = entry(report, busy.child.threadId);
    available(busyReport);
    available(entry(report, idle.child.threadId));
    assert.ok(busyReport.javascriptStack.stack.some(line => line.includes('busyDiagnosticLoop')), JSON.stringify(busyReport.javascriptStack));

    // Atomics.wait is an actual native blocking region, not a simulated timeout.
    const blocked = await worker('Atomics.wait(gate, 0, 0); clearInterval(timer); watcher.close();');
    const blockedReport = entry(process.report.getReport(), blocked.child.threadId);
    assert.ok(blockedReport);
    if (blockedReport.silkjs) {
      assert.equal(blockedReport.silkjs.snapshotStatus, 'unavailable');
      assert.match(blockedReport.silkjs.reason, /safe point/);
      assert.equal(Object.hasOwn(blockedReport, 'javascriptHeap'), false);
    }
    const blockedExit = once(blocked.child, 'exit');
    Atomics.store(blocked.gate, 0, 1); Atomics.notify(blocked.gate, 0);
    await blockedExit; live.delete(blocked.child);

    const id = busy.child.threadId;
    const exited = once(busy.child, 'exit');
    Atomics.store(busy.gate, 0, 1);
    const racing = entry(process.report.getReport(), id);
    if (racing?.silkjs?.snapshotStatus === 'unavailable') assert.match(racing.silkjs.reason, /exited|safe point/);
    await exited; live.delete(busy.child);
    assert.equal(entry(process.report.getReport(), id), undefined);
    console.log('Live busy/idle worker snapshots, native-block timeout and exit race passed');
  } finally {
    await Promise.all([...live].map(child => child.terminate()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
