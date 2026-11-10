'use strict';

const harness = require('internal/test_runner/harness');
const { MockTracker } = require('internal/test_runner/mock');
const test = harness.test;
Object.assign(test, {
  test, it: test, suite: harness.suite, describe: harness.suite,
  before: harness.before, after: harness.after,
  beforeEach: harness.beforeEach, afterEach: harness.afterEach,
  getTestContext: harness.getTestContext,
  run: require('internal/test_runner/runner').run,
  assert: { register: harness.registerAssertion },
});
let mock, snapshot;
Object.defineProperty(test, 'mock', { configurable: true, enumerable: true, get() { return mock ||= new MockTracker(); } });
Object.defineProperty(test, 'snapshot', { configurable: true, enumerable: true, get() {
  if (!snapshot) {
    const api = require('internal/test_runner/snapshot');
    snapshot = { setDefaultSnapshotSerializers: api.setDefaultSnapshotSerializers, setResolveSnapshotPath: api.setResolveSnapshotPath };
  }
  return snapshot;
} });
module.exports = test;
