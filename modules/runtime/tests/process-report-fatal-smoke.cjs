'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const addon = path.resolve(process.argv[2] || 'build/diagnostic-fatal.node');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silk-fatal-report-'));
try {
  for (const [enabled, worker] of [[true, false], [true, true], [false, false]]) {
    const filename = enabled ? (worker ? 'worker-fatal.json' : 'fatal.json') : 'disabled.json';
    const failure = `require(${JSON.stringify(addon)}).fail();`;
    const invocation = worker ? `new (require('node:worker_threads').Worker)(${JSON.stringify(failure)}, { eval: true });` : failure;
    const source = `Object.assign(process.report, { directory: ${JSON.stringify(root)}, filename: ${JSON.stringify(filename)}, reportOnFatalError: ${enabled} }); ${invocation}`;
    const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /controlled native engine boundary failure/);
    const output = path.join(root, filename);
    assert.equal(fs.existsSync(output), enabled);
    if (enabled) {
      const report = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.equal(report.header.trigger, 'FatalError');
      assert.ok(report.header.processId > 0);
      assert.equal(report.header.threadId > 0, worker);
      if (report.silkjs) {
        assert.equal(report.silkjs.fatalLocation, 'diagnostic-fatal-consumer');
        assert.match(report.silkjs.fatalMessage, /controlled native/);
        assert.match(report.silkjs.unavailable.javascriptHeap, /cannot safely/);
        assert.equal(Object.hasOwn(report, 'javascriptHeap'), false);
        assert.ok(report.resourceUsage.maxRss > 0);
      }
    }
  }
  console.log('Actual native fatal failure writes enabled report and respects disabled setting');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
