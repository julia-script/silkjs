'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { Readable } = require('stream');
const assert = require('assert');
const { MockTracker } = require('internal/test_runner/mock');
const host = require('internal/host');
const context = new AsyncLocalStorage();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetImmediate = globalThis.setImmediate;
const now = Date.now.bind(Date);
const assertions = new Map();
let defaultHarness;
let nextId = 1;
function failure(message, failureType = 'testCodeFailure', cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: 'ERR_TEST_FAILURE', failureType });
}
function invalid(message) { return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_VALUE' }); }
function unsupported(name) { throw Object.assign(new Error(`${name} is not supported by the Silk test runner`), { code: 'ERR_NOT_SUPPORTED' }); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function parse(args) {
  let [name, options, fn] = args;
  if (typeof name === 'function') { fn = name; name = fn.name; options = {}; }
  else if (name && typeof name === 'object') { fn = options; options = name; name = fn?.name; }
  else if (typeof options === 'function') { fn = options; options = {}; }
  options ??= {};
  if (name === undefined) name = fn?.name || '<anonymous>';
  if (typeof name !== 'string') throw invalid('name must be a string');
  if (!options || typeof options !== 'object') throw invalid('options must be an object');
  if (fn !== undefined && typeof fn !== 'function') throw invalid('fn must be a function');
  if (options.timeout !== undefined && (typeof options.timeout !== 'number' || options.timeout < 0 || Number.isNaN(options.timeout))) throw invalid('timeout must be a non-negative number');
  if (options.concurrency !== undefined && typeof options.concurrency !== 'boolean' && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) throw invalid('concurrency must be a positive integer or boolean');
  if (options.signal !== undefined && typeof options.signal?.addEventListener !== 'function') throw invalid('signal must be an AbortSignal');
  for (const key of ['only', 'skip', 'todo']) if (options[key] !== undefined && typeof options[key] !== 'boolean' && (key === 'only' || typeof options[key] !== 'string')) throw invalid(`${key} has an invalid type`);
  for (const key of ['tags', 'expectFailure']) if (options[key] !== undefined) unsupported(`test option ${key}`);
  return { name, options, fn: fn || function() {} };
}
function pattern(value) { return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => item instanceof RegExp ? item : new RegExp(item)); }
function matches(patterns, name) { return patterns.some(re => { re.lastIndex = 0; return re.test(name); }); }
function testMatches(patterns, node) {
  for (let current = node; current?.parent; current = current.parent) {
    if (matches(patterns, current.name) || matches(patterns, current.filterName)) return true;
  }
  return false;
}
function visibleChildren(node) { return node.children.filter(child => !child.filtered && (!child.nameFiltered || child.error)); }
class TestsStream extends Readable {
  constructor() { super({ objectMode: true, read() {} }); }
  publish(type, data) { this.emit(type, data); this.push({ type, data }); }
}
class AssertionPlan {
  constructor(count, options) {
    if (typeof count !== 'number') throw Object.assign(new TypeError('count must be a number'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (!Number.isInteger(count) || count < 0 || count > 4294967295)
      throw Object.assign(new RangeError('count must be an unsigned 32-bit integer'), { code: 'ERR_OUT_OF_RANGE' });
    if (options === null || typeof options !== 'object' || Array.isArray(options))
      throw Object.assign(new TypeError('options must be an object'), { code: 'ERR_INVALID_ARG_TYPE' });
    const wait = options.wait;
    if (wait !== undefined && typeof wait !== 'boolean' && typeof wait !== 'number')
      throw Object.assign(new TypeError('options.wait must be a boolean or number'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (typeof wait === 'number' && (!Number.isFinite(wait) || wait < 0 || wait > 2147483647))
      throw Object.assign(new RangeError('options.wait must be between 0 and 2147483647'), { code: 'ERR_OUT_OF_RANGE' });
    this.expected = count; this.actual = 0; this.wait = wait;
  }
  count() {
    this.actual++;
    if (this.actual === this.expected && this.pending) {
      if (this.timer !== undefined) { nativeClearTimeout(this.timer); this.timer = undefined; }
      this.pending.resolve(); this.pending = undefined;
    }
  }
  check(node) {
    if (this.actual === this.expected) return;
    if (this.wait === undefined || this.wait === false)
      throw failure(`plan expected ${this.expected} assertions but received ${this.actual}`);
    this.pending = deferred();
    if (this.wait !== true) this.timer = nativeSetTimeout(() => {
      node.cancel(failure(`plan timed out after ${this.wait}ms with ${this.actual} assertions when expecting ${this.expected}`, 'testTimeoutFailure'));
    }, this.wait);
    return Promise.race([this.pending.promise, node.cancelled.promise.then(() => { throw node.error; })]).finally(() => {
      if (this.timer !== undefined) nativeClearTimeout(this.timer);
      this.timer = undefined; this.pending = undefined;
    });
  }
}
class TestContext {
  constructor(node) { this._node = node; this._assert = undefined; }
  get name() { return this._node.name; }
  get fullName() { return this._node.fullName; }
  get filePath() { return this._node.file; }
  get signal() { return this._node.controller.signal; }
  get mock() { return this._node.mock ||= new MockTracker(); }
  get assert() {
    if (!this._assert) {
      const plan = this._node.plan;
      this._assert = {};
      for (const key of Object.keys(assert)) if (typeof assert[key] === 'function') this._assert[key] = (...args) => { plan?.count(); return Reflect.apply(assert[key], assert, args); };
      for (const [key, fn] of assertions) this._assert[key] = (...args) => { plan?.count(); return Reflect.apply(fn, this, args); };
      if (!assertions.has('snapshot')) this._assert.snapshot = (...args) => {
        plan?.count(); return this._node.harness.snapshotManager().snapshot(this, ...args);
      };
      if (!assertions.has('fileSnapshot')) this._assert.fileSnapshot = (...args) => {
        plan?.count(); return this._node.harness.snapshotManager().fileSnapshot(...args);
      };
    }
    return this._assert;
  }
  _count() { this._node.plan?.count(); }
  test(...args) {
    this._count();
    const node = this._node.harness.add('test', parse(args), this._node);
    return this._node.type === 'suite' ? Promise.resolve() : node.done.promise;
  }
  before(fn, options) { this._hook('before', fn, options); }
  after(fn, options) { this._hook('after', fn, options); }
  beforeEach(fn, options) { this._hook('beforeEach', fn, options); }
  afterEach(fn, options) { this._hook('afterEach', fn, options); }
  _hook(type, fn, options = {}) {
    if (typeof fn !== 'function') throw invalid('hook must be a function');
    this._node.hooks[type].push({ fn, options });
    if (type === 'before' && this._node.state === 'running') this._node.harness.hooks(this._node, type).catch(error => this._node.cancel(error));
  }
  diagnostic(message) { (this._node.diagnostics ||= []).push(String(message)); }
  skip(message) { this._node.skip = message === undefined ? true : String(message) || true; }
  todo(message) { this._node.todo = message === undefined ? true : String(message) || true; }
  runOnly(value) { if (typeof value !== 'boolean') throw invalid('runOnly requires a boolean'); this._node.runOnly = value; }
  plan(count, options = {}) {
    if (this._node.plan !== undefined) throw failure('cannot set plan more than once');
    this._node.plan = new AssertionPlan(count, options);
  }
  waitFor(condition, options = {}) {
    if (typeof condition !== 'function') throw invalid('condition must be a function');
    const interval = options.interval ?? 50;
    const timeout = options.timeout ?? 1000;
    if (!Number.isFinite(interval) || interval < 0 || !Number.isFinite(timeout) || timeout < 0) throw invalid('Invalid waitFor timing');
    return new Promise((resolve, reject) => {
      let poller;
      let cause;
      let finished = false;
      const timer = nativeSetTimeout(() => { finished = true; nativeClearTimeout(poller); reject(new Error('waitFor() timed out', { cause })); }, timeout);
      const poll = async () => {
        try {
          const result = await condition();
          if (!finished) { finished = true; nativeClearTimeout(timer); resolve(result); }
        } catch (error) {
          cause = error;
          if (!finished) poller = nativeSetTimeout(poll, interval);
        }
      };
      poll();
    });
  }
}
class TestNode {
  constructor(harness, type, spec, parent) {
    this.harness = harness; this.type = type; this.name = spec.name; this.options = spec.options; this.fn = spec.fn; this.parent = parent;
    this.id = nextId++; this.children = []; this.hooks = { before: [], after: [], beforeEach: [], afterEach: [] };
    this.controller = new AbortController(); this.done = deferred(); this.cancelled = deferred(); this.state = 'pending';
    this.skip = spec.options.skip === '' ? true : spec.options.skip;
    this.todo = spec.options.todo === '' ? true : spec.options.todo; this.only = !!spec.options.only;
    this.runOnly = parent?.runOnly ?? !!harness.options.only;
    this.nesting = parent ? parent.nesting + 1 : -1;
    this.fullName = parent?.parent ? `${parent.fullName} > ${this.name}` : this.name;
    this.filterName = parent?.parent ? `${parent.filterName} ${this.name}` : this.name;
    this.file = parent && parent.type !== 'root' ? parent.file : harness.file; this.ctx = new TestContext(this); this.active = 0;
  }
  cancel(error) {
    if (this.state === 'done') return;
    this.error ||= error;
    this.controller.abort(error); this.cancelled.resolve();
    for (const child of this.children) child.cancel(error);
  }
}
class Harness {
  constructor(options = {}) {
    this.options = options; this.stream = new TestsStream(); this.file = options.file;
    this.names = pattern(options.testNamePatterns); this.skips = pattern(options.testSkipPatterns);
    this.root = new TestNode(this, 'root', { name: '', options, fn() {} }, null);
    this.root.state = 'collecting'; this.started = false; this.finished = false;
    this.counts = { tests: 0, suites: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0 };
    this.success = true;
    this.completion = deferred();
    if (options.waitForIdle) this.collection = deferred();
  }
  snapshotManager() {
    return this.snapshots ||= new (require('internal/test_runner/snapshot').SnapshotManager)(!!host.testUpdateSnapshots);
  }
  deferCompletion() {
    if (this.collection) throw invalid('Test collection has already been deferred');
    this.collection = deferred();
    return this.collection.resolve;
  }
  emit(type, node, extra = {}) {
    if (this.finished) return;
    this.stream.publish(type, { name: node.name, nesting: node.nesting, file: node.file,
      testId: node.id, parentId: node.parent?.id, ...extra });
  }
  enqueue(node) {
    if (!node.parent || node.enqueued || node.nameFiltered) return;
    this.enqueue(node.parent);
    node.enqueued = true;
    this.emit('test:enqueue', node, { type: node.type });
  }
  add(type, spec, parent = this.root) {
    const node = new TestNode(this, type, spec, parent);
    parent.children.push(node);
    node.nameFiltered = (this.names.length > 0 && !testMatches(this.names, node)) || testMatches(this.skips, node);
    if (!node.nameFiltered) {
      for (let ancestor = parent; ancestor.parent; ancestor = ancestor.parent) ancestor.nameFiltered = false;
      this.enqueue(node);
    }
    if (this.finished || parent.state === 'done') {
      node.error = failure('test could not be started because its parent has already finished', 'parentAlreadyFinished');
      this.finish(node, now());
      if (this.options.setExitCode !== false) process.exitCode = 1;
      return node;
    }
    if (type === 'suite' && !node.skip && !parent.skip) {
      node.state = 'collecting';
      try {
        const result = context.run(node, () => Reflect.apply(node.fn, node.ctx, [node.ctx]));
        node.build = Promise.resolve(result).catch(error => { node.error = failure(String(error?.message ?? error), 'testCodeFailure', error); });
      } catch (error) { node.error = failure(String(error?.message ?? error), 'testCodeFailure', error); node.build = Promise.resolve(); }
    }
    if (parent.state === 'running') this.pump(parent);
    return node;
  }
  pump(parent) {
    let owner = parent;
    while (owner.parent && owner.options.concurrency === undefined) owner = owner.parent;
    const configured = owner.options.concurrency ?? this.options.concurrency ?? 1;
    const limit = configured === true ? Infinity : configured === false ? 1 : configured;
    for (const child of parent.children) {
      if (parent.active >= limit) break;
      if (child.scheduled) continue;
      child.scheduled = true; parent.active++;
      this.execute(child).catch(error => { child.error ||= failure(String(error?.message ?? error), 'testCodeFailure', error); if (child.state !== 'done') this.finish(child, now()); }).finally(() => { parent.active--; if (parent.state === 'running') this.pump(parent); });
      this.flush(this.root);
    }
  }
  async invoke(fn, node, options = {}) {
    let timer;
    const timeout = options.timeout;
    let result;
    try {
      const task = context.run(node, () => {
        if (fn.length < 2) return Promise.resolve(Reflect.apply(fn, node.ctx, [node.ctx]));
        return new Promise((resolve, reject) => {
          let calls = 0;
          const done = error => {
            if (++calls > 1) {
              const error = failure('callback invoked multiple times', 'multipleCallbackInvocations');
              if (node.state === 'done') throw error;
              node.error ||= error;
              return;
            }
            if (error) reject(error); else resolve();
          };
          const value = Reflect.apply(fn, node.ctx, [node.ctx, done]);
          if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); reject(failure('A callback was supplied and a Promise was returned', 'callbackAndPromisePresent')); }
        });
      });
      const racers = [task, node.cancelled.promise.then(() => { throw node.error; })];
      if (Number.isFinite(timeout)) racers.push(new Promise((_, reject) => { timer = nativeSetTimeout(() => reject(failure(`test timed out after ${timeout}ms`, 'testTimeoutFailure')), timeout); }));
      result = await Promise.race(racers);
    } finally { if (timer !== undefined) nativeClearTimeout(timer); }
    return result;
  }
  async hooks(node, type, target = node, cleanup = false) {
    for (const hook of node.hooks[type]) {
      try {
        const once = type === 'before' || type === 'after';
        if (!once || !hook.promise) {
          const run = async () => {
            if (cleanup && target.controller.signal.aborted) {
              const scope = Object.create(target); scope.cancelled = deferred(); scope.error = undefined;
              const onIdle = () => { scope.error = failure('cleanup is pending after the event loop resolved', 'testUnfinished'); scope.cancelled.resolve(); };
              process.on('beforeExit', onIdle);
              try { await this.invoke(hook.fn, scope, { timeout: target.options.timeout ?? this.options.timeout, ...hook.options }); }
              finally { process.removeListener('beforeExit', onIdle); }
            } else await this.invoke(hook.fn, target, hook.options);
          };
          if (once) hook.promise = run();
          else { await run(); continue; }
        }
        await hook.promise;
      } catch (error) { target.error ||= failure(`${type} hook failed`, 'hookFailed', error); if (!cleanup) throw target.error; }
    }
  }
  async collect(node) {
    await node.build;
    await Promise.all(node.children.filter(child => child.type === 'suite').map(child => this.collect(child)));
  }
  async execute(node) {
    const start = now();
    node.state = 'building';
    const ancestors = [];
    for (let p = node.parent; p; p = p.parent) ancestors.unshift(p);
    if (node.parent?.controller.signal.aborted) node.cancel(node.parent.error || failure('cancelled by parent', 'cancelledByParent'));
    if (node.parent?.skip) node.skip ||= node.parent.skip;
    if (node.parent?.todo) node.todo ||= node.parent.todo;
    const selectedAncestor = ancestors.some(p => p.only);
    if (node.runOnly && !node.only && !selectedAncestor && node.type !== 'suite') node.skip ||= "'only' option not set";
    let timeout;
    const timeoutMs = node.options.timeout ?? this.options.timeout;
    const signal = node.options.signal;
    const onAbort = () => node.cancel(failure('test aborted', 'testAborted', signal.reason));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && !node.skip) timeout = nativeSetTimeout(() => node.cancel(failure(`test timed out after ${timeoutMs}ms`, 'testTimeoutFailure')), timeoutMs);
    try {
      if (node.build && !node.skip && !node.error) await Promise.race([this.collect(node), node.cancelled.promise]);
      if (node.type === 'suite' && !node.skip && !node.error) {
        const descendantsMatch = predicate => {
          const visit = parent => parent.children.some(child => predicate(child) || visit(child));
          return visit(node);
        };
        if (node.runOnly && !node.only && !selectedAncestor && !descendantsMatch(child => child.only)) node.skip = "'only' option not set";
      }
      node.filtered = !!node.nameFiltered && !node.error;
      if (!node.filtered) {
        node.nameFiltered = false;
        this.enqueue(node);
        this.emit('test:dequeue', node, { type: node.type });
      }
      node.state = 'running';
      if (!node.skip && !node.error && !node.filtered) {
        if (node.options.plan !== undefined) node.ctx.plan(node.options.plan);
        await this.hooks(node.parent, 'before');
        if (node.type !== 'suite') for (const ancestor of ancestors) await this.hooks(ancestor, 'beforeEach', node);
        await this.hooks(node, 'before');
        if (node.type === 'suite') {
          this.pump(node);
          await Promise.race([Promise.all(node.children.map(child => child.done.promise)), node.cancelled.promise]);
        } else {
          await this.invoke(node.fn, node);
          await this.hooks(node, 'before');
          // Unawaited subtests cannot outlive their parent test.
          for (const child of node.children) if (child.state !== 'done') child.cancel(failure('test did not finish before its parent', 'cancelledByParent'));
          this.pump(node);
          await Promise.all(node.children.map(child => child.done.promise));
        }
        const planWait = node.plan?.check(node);
        if (planWait) await planWait;
      }
    } catch (error) { node.error ||= error?.code === 'ERR_TEST_FAILURE' ? error : failure(String(error?.message ?? error), 'testCodeFailure', error); }
    finally {
      if (timeout !== undefined) nativeClearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (!node.skip && !node.filtered) {
        await this.hooks(node, 'after', node, true);
        if (node.type !== 'suite') for (let i = ancestors.length - 1; i >= 0; i--) await this.hooks(ancestors[i], 'afterEach', node, true);
      }
      for (const child of node.children) if (child.state !== 'done') {
        if (node.filtered) { child.nameFiltered = true; child.filtered = true; }
        else if (node.skip) child.skip ||= node.skip;
        else child.cancel(node.error || failure('cancelled by parent', 'cancelledByParent'));
      }
      this.pump(node);
      await Promise.all(node.children.map(child => child.done.promise));
      const failed = node.children.filter(child => !child.filtered && child.error && !child.todo && !child.skip).length;
      if (failed && !node.skip) node.error ||= failure(`${failed} subtest${failed === 1 ? '' : 's'} failed`, 'subtestsFailed');
      try { node.mock?.reset(); } catch (error) { node.error ||= failure('mock cleanup failed', 'testCodeFailure', error); }
      this.finish(node, start);
    }
  }
  finish(node, start) {
    node.state = 'done';
    node.controller.abort();
    if (node.filtered) { this.flush(this.root); node.done.resolve(); return; }
    const counts = this.counts;
    if (node.type === 'suite') counts.suites++; else counts.tests++;
    if (node.nesting === 0) counts.topLevel++;
    if (node.type !== 'suite') {
      if (node.skip) counts.skipped++;
      else if (node.todo) counts.todo++;
      else if (node.error) { if (['cancelledByParent', 'testTimeoutFailure', 'testAborted', 'testUnfinished'].includes(node.error.failureType)) counts.cancelled++; else counts.failed++; }
      else counts.passed++;
    }
    if (node.error && !node.todo && !node.skip) this.success = false;
    if (node.error && !node.todo && !node.skip && this.options.setExitCode !== false) process.exitCode = 1;
    node.reportData = { testNumber: visibleChildren(node.parent).indexOf(node) + 1,
      details: { duration_ms: now() - start, type: node.type, ...(node.error ? { error: node.error } : {}) },
      ...(node.skip ? { skip: node.skip } : {}), ...(node.todo ? { todo: node.todo } : {}) };
    this.emit('test:complete', node, { ...node.reportData, details: { ...node.reportData.details, passed: !node.error || !!node.skip } });
    this.flush(this.root);
    node.done.resolve();
  }
  flush(parent) {
    parent.reportIndex ??= 0;
    while (parent.reportIndex < parent.children.length) {
      const node = parent.children[parent.reportIndex];
      if (node.filtered) {
        if (node.state !== 'done') return;
        parent.reportIndex++; continue;
      }
      if (!node.scheduled) return;
      if (!node.reportStarted) {
        let ready = node;
        while (ready.state !== 'done') {
          ready = ready.children[ready.reportIndex || 0];
          if (!ready?.scheduled) return;
        }
        node.reportStarted = true;
        this.emit('test:start', node);
      }
      this.flush(node);
      if (node.state !== 'done') return;
      const count = visibleChildren(node).length;
      if (count) this.emit('test:plan', node, { nesting: node.nesting + 1, count });
      this.emit(node.error && !node.skip ? 'test:fail' : 'test:pass', node, node.reportData);
      for (const message of node.diagnostics || []) this.emit('test:diagnostic', node, { message, level: 'info' });
      parent.reportIndex++;
    }
  }
  async start() {
    if (this.started) return this.completion.promise;
    this.started = true;
    const start = now();
    this.root.state = 'running';
    const onIdle = () => {
      if (this.options.waitForIdle && this.waitingForIdle && this.root.children.every(child => child.state === 'done')) this.collection.resolve();
      else this.root.cancel(failure('Promise resolution is still pending but the event loop has already resolved', 'testUnfinished'));
    };
    const onError = error => {
      const node = context.getStore();
      if (node?.harness === this && node.state !== 'done') node.cancel(failure(String(error?.message ?? error), 'uncaughtException', error));
      else { this.root.error ||= failure(String(error?.message ?? error), 'uncaughtException', error); this.emit('test:diagnostic', this.root, { nesting: 0, message: String(error?.stack ?? error), level: 'error' }); if (this.options.setExitCode !== false) process.exitCode = 1; }
    };
    process.on('beforeExit', onIdle);
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
    const signal = this.options.signal;
    const onAbort = () => this.root.cancel(failure('test run aborted', 'testAborted', signal.reason));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.hooks(this.root, 'before');
      this.pump(this.root);
      // Definitions may append root tests while asynchronous suites are collecting.
      let length;
      do {
        length = this.root.children.length;
        await Promise.all(this.root.children.map(child => child.done.promise));
        if (this.collection) {
          this.waitingForIdle = true;
          await Promise.race([this.collection.promise, this.root.cancelled.promise]);
          this.waitingForIdle = false;
        }
      } while (length !== this.root.children.length);
    } catch (error) {
      this.root.cancel(error); this.pump(this.root);
      await Promise.all(this.root.children.map(child => child.done.promise));
    } finally {
      await this.hooks(this.root, 'after', this.root, true);
      try { this.snapshots?.writeFiles(); }
      catch (error) {
        this.root.error ||= failure(String(error?.message ?? error), 'testCodeFailure', error);
        this.emit('test:diagnostic', this.root, { nesting: 0, message: String(error?.stack ?? error), level: 'error' });
      }
      this.stream.publish('test:plan', { nesting: 0, count: visibleChildren(this.root).length });
      for (const message of this.root.diagnostics || []) this.emit('test:diagnostic', this.root, { nesting: 0, message, level: 'info' });
      if (this.options.collectCoverage) {
        try {
          const coverage = require('internal/test_runner/coverage');
          if (!coverage.publish(this.stream, coverage.take(this.options.collectCoverage, process.cwd()))) this.success = false;
        } catch (error) {
          this.root.error ||= failure('coverage collection failed', 'testCodeFailure', error);
          this.emit('test:diagnostic', this.root, { nesting: 0, level: 'error', message: String(error?.stack ?? error) });
        } finally { host.testCoverageStop(); host.testCoveragePrestarted = false; }
      }
      this.root.state = 'done'; this.finished = true;
      process.removeListener('beforeExit', onIdle); process.removeListener('uncaughtException', onError); process.removeListener('unhandledRejection', onError);
      signal?.removeEventListener('abort', onAbort);
      const success = !this.root.error && this.success;
      if (!success && this.options.setExitCode !== false) process.exitCode = 1;
      const summary = { nesting: 0, file: this.file, success, counts: { ...this.counts }, duration_ms: now() - start };
      this.stream.publish('test:summary', summary);
      this.stream.push(null); this.completion.resolve(summary);
    }
    return this.completion.promise;
  }
}
function createHarness(options) { return new Harness(options); }
function getHarness() {
  const current = context.getStore();
  if (current) return current.harness;
  if (!defaultHarness) {
    const collectCoverage = host.testCoverageOptions?.coverage ? host.testCoverageOptions : undefined;
    if (collectCoverage && !host.testCoveragePrestarted) {
      host.testCoverageStart(); host.testCoveragePrestarted = true;
    }
    defaultHarness = createHarness({ waitForIdle: true, file: process.argv[1], collectCoverage });
    const { tap } = require('test/reporters');
    Readable.from(tap(defaultHarness.stream)).pipe(process.stdout, { end: false });
    nativeSetImmediate(() => { defaultHarness.start(); });
  }
  return defaultHarness;
}
function configure(options = {}) {
  if (defaultHarness) throw Object.assign(new Error('The default test harness is already initialized'), { code: 'ERR_INVALID_STATE' });
  defaultHarness = createHarness(options);
  return defaultHarness;
}
function define(type, args) {
  const harness = getHarness();
  const parent = context.getStore() || harness.root;
  const node = harness.add(type, parse(args), parent);
  return parent.type === 'suite' ? Promise.resolve() : node.done.promise;
}
function test(...args) { return define('test', args); }
function suite(...args) { return define('suite', args); }
for (const fn of [test, suite]) for (const modifier of ['skip', 'todo', 'only']) fn[modifier] = (...args) => {
  const spec = parse(args); spec.options = { ...spec.options, [modifier]: true };
  return define(fn === test ? 'test' : 'suite', [spec.name, spec.options, spec.fn]);
};
const exportsObject = { test, suite, createHarness, configure, getTestContext: () => context.getStore()?.ctx,
  withHarness: (harness, fn) => context.run(harness.root, fn), failure, unsupported, TestsStream,
  registerAssertion(name, fn) { if (typeof name !== 'string' || typeof fn !== 'function') throw invalid('assert.register requires a name and function'); assertions.set(name, fn); } };
for (const type of ['before', 'after', 'beforeEach', 'afterEach']) exportsObject[type] = (fn, options) => {
  const harness = getHarness(); (context.getStore() || harness.root).ctx._hook(type, fn, options);
};
module.exports = exportsObject;
