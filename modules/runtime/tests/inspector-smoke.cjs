'use strict';
// Run: build/silkjsruntime tests/inspector-smoke.cjs
// All assertions exercise the public API and production native inspector.
const assert = require('node:assert/strict');
const inspector = require('node:inspector');
const { Session: PromiseSession } = require('node:inspector/promises');
const vm = require('node:vm');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const started = Date.now();
const diagnostic = { stage: 'initialization', stageStarted: started, lastCompleted: null, pending: new Map(), workers: {} };
let nextCommand = 0;
function stage(name) {
  diagnostic.stage = name;
  diagnostic.stageStarted = Date.now();
}
function beginCommand(method, params = {}) {
  const id = ++nextCommand;
  diagnostic.pending.set(id, { method, expression: params.expression, sessionId: params.sessionId, started: Date.now() });
  return () => {
    diagnostic.pending.delete(id);
    diagnostic.lastCompleted = { id, method, elapsedMs: Date.now() - started };
  };
}
function request(session, method, params, callback) {
  const finish = beginCommand(method, params);
  try {
    session.post(method, params, function (error, result) {
      finish();
      callback.call(this, error, result);
    });
  } catch (error) { finish(); throw error; }
}
const post = (session, method, params = {}) => new Promise((resolve, reject) => request(session, method, params, (error, result) => error ? reject(error) : resolve(result)));
async function promisePost(session, method, params = {}) {
  const finish = beginCommand(method, params);
  try { return await session.post(method, params); }
  finally { finish(); }
}
function observeWorker(worker, name) {
  const state = diagnostic.workers[name] = { threadId: worker.threadId, createdMs: Date.now() - started, online: false, message: null, exitCode: null };
  worker.once('online', () => { state.online = true; state.onlineMs = Date.now() - started; });
  worker.on('message', message => { state.message = message; state.messageMs = Date.now() - started; });
  worker.once('exit', code => { state.exitCode = code; state.exitMs = Date.now() - started; });
  return worker;
}

if (!isMainThread) {
  globalThis.inspectorOwnerValue = 'worker';
  const session = new PromiseSession();
  parentPort.ref();
  (async () => {
    session.connectToMainThread();
    const result = await promisePost(session, 'Runtime.evaluate', { expression: 'globalThis.inspectorOwnerValue', returnByValue: true });
    assert.equal(result.result.value, 'main');
    session.disconnect();
    parentPort.postMessage('main-thread-session-passed');
  })().catch(error => { session.disconnect(); throw error; }).finally(() => parentPort.unref());
} else {
  const session = new inspector.Session();
  const promised = new PromiseSession();
  const deadline = setTimeout(() => {
    const now = Date.now();
    console.error('inspector smoke deadline', JSON.stringify({
      stage: diagnostic.stage, elapsedMs: now - started, stageElapsedMs: now - diagnostic.stageStarted,
      lastCompleted: diagnostic.lastCompleted,
      pending: Array.from(diagnostic.pending, ([id, command]) => ({ id, ...command, pendingMs: now - command.started })),
      workers: diagnostic.workers,
    }));
    process.exit(1);
  }, 20000);
  async function main() {
    stage('session validation and Runtime.enable');
    assert.throws(() => session.post('Runtime.enable'), { code: 'ERR_INSPECTOR_NOT_CONNECTED' });
    assert.throws(() => session.connectToMainThread(), { code: 'ERR_INSPECTOR_NOT_WORKER' });
    session.connect();
    assert.throws(() => session.connect(), { code: 'ERR_INSPECTOR_ALREADY_CONNECTED' });
    assert.throws(() => session.post(1), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => session.post('Runtime.enable', []), { code: 'ERR_INVALID_ARG_TYPE' });
    const notifications = [], created = [];
    session.on('inspectorNotification', event => notifications.push(event));
    session.on('Runtime.executionContextCreated', event => created.push(event.params.context));
    await post(session, 'Runtime.enable');
    assert.ok(created.some(context => context.auxData.isDefault));
    assert.ok(notifications.some(event => event.method === 'Runtime.executionContextCreated'));
    inspector.console.log('inspector-console-once');
    assert.equal(notifications.filter(event => event.method === 'Runtime.consoleAPICalled' && event.params.args[0]?.value === 'inspector-console-once').length, 1);
    stage('callback and promise evaluation');
    let callbackThis;
    const answer = await new Promise((resolve, reject) => request(session, 'Runtime.evaluate', { expression: '21 * 2' }, function (error, result) {
      callbackThis = this;
      error ? reject(error) : resolve(result);
    }));
    assert.equal(callbackThis, undefined);
    assert.equal(answer.result.value, 42);
    promised.connect();
    assert.equal((await promisePost(promised, 'Runtime.evaluate', { expression: '6 * 7' })).result.value, 42);
    await assert.rejects(post(session, 'Silk.unsupported'), { code: 'ERR_INSPECTOR_COMMAND', message: "Inspector error -32601: 'Silk.unsupported' wasn't found" });
    stage('primitive and exception serialization');
    for (const [expression, expected] of [['NaN', 'NaN'], ['Infinity', 'Infinity'], ['-Infinity', '-Infinity'], ['-0', '-0'], ['123n', '123n']]) {
      const result = await post(session, 'Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(result.result.unserializableValue, expected);
    }
    const thrown = await post(session, 'Runtime.evaluate', { expression: 'throw new Error("inspector thrown value")' });
    assert.ok(thrown.exceptionDetails);
    assert.equal(thrown.result.type, 'object');
    stage('retained object descriptors');
    globalThis.inspectorGetterReads = 0;
    globalThis.inspectorObject = { answer: 42, get dangerous() { globalThis.inspectorGetterReads++; throw new Error('getter executed'); } };
    globalThis.inspectorObject.self = globalThis.inspectorObject;
    const retained = (await post(session, 'Runtime.evaluate', { expression: 'globalThis.inspectorObject', objectGroup: 'smoke', generatePreview: true })).result;
    assert.equal(typeof retained.objectId, 'string');
    assert.equal(globalThis.inspectorGetterReads, 0);
    const properties = (await post(session, 'Runtime.getProperties', { objectId: retained.objectId, ownProperties: true })).result;
    assert.equal(properties.find(property => property.name === 'answer').value.value, 42);
    assert.equal(properties.find(property => property.name === 'dangerous').get.type, 'function');
    assert.equal(properties.find(property => property.name === 'self').value.type, 'object');
    assert.equal(globalThis.inspectorGetterReads, 0);
    stage('function calls and by-value serialization');
    const called = await post(session, 'Runtime.callFunctionOn', { objectId: retained.objectId, functionDeclaration: 'function(addend) { return this.answer + addend; }', arguments: [{ value: 8 }], returnByValue: true });
    assert.equal(called.result.value, 50);
    const specialArgument = await post(session, 'Runtime.callFunctionOn', { functionDeclaration: 'function(value) { return Object.is(value, -0); }', executionContextId: 1, arguments: [{ unserializableValue: '-0' }], returnByValue: true });
    assert.equal(specialArgument.result.value, true);
    const plain = await post(session, 'Runtime.evaluate', { expression: '({ answer: 42, list: [1, 2] })', returnByValue: true });
    assert.deepEqual(plain.result.value, { answer: 42, list: [1, 2] });
    await assert.rejects(post(session, 'Runtime.evaluate', { expression: 'globalThis.inspectorObject', returnByValue: true }), { code: 'ERR_INSPECTOR_COMMAND' });
    assert.equal(globalThis.inspectorGetterReads, 0);
    await assert.rejects(post(session, 'Runtime.evaluate', { expression: '(() => { const value = {}; value.self = value; return value; })()', returnByValue: true }), { code: 'ERR_INSPECTOR_COMMAND' });
    await post(session, 'Runtime.releaseObjectGroup', { objectGroup: 'smoke' });
    await assert.rejects(post(session, 'Runtime.getProperties', { objectId: retained.objectId }), { code: 'ERR_INSPECTOR_COMMAND' });
    stage('restricted evaluation and proxy inspection');
    globalThis.inspectorEffects = 0;
    const rejected = await post(session, 'Runtime.evaluate', { expression: 'globalThis.inspectorEffects++', throwOnSideEffect: true });
    assert.ok(rejected.exceptionDetails);
    assert.equal(globalThis.inspectorEffects, 0);
    globalThis.inspectorProxyReads = 0;
    globalThis.inspectorProxy = new Proxy({}, { get() { globalThis.inspectorProxyReads++; return 1; }, ownKeys() { globalThis.inspectorProxyReads++; return []; } });
    const proxy = await post(session, 'Runtime.evaluate', { expression: 'globalThis.inspectorProxy', generatePreview: true });
    await post(session, 'Runtime.getProperties', { objectId: proxy.result.objectId, ownProperties: true });
    assert.equal(globalThis.inspectorProxyReads, 0);
    stage('VM execution context');
    const context = vm.createContext({ realmLabel: 'vm', answer: 17 }, { name: 'inspector-smoke-realm', origin: 'smoke://realm' });
    const discovered = created.find(item => item.name === 'inspector-smoke-realm');
    assert.ok(discovered);
    assert.notEqual(discovered.id, 1);
    assert.equal(discovered.origin, 'smoke://realm');
    assert.equal((await post(session, 'Runtime.evaluate', { expression: 'answer + 25', contextId: discovered.id })).result.value, 42);
    const inRealm = (await post(session, 'Runtime.evaluate', { expression: '({ answer })', contextId: discovered.id })).result;
    assert.equal((await post(session, 'Runtime.callFunctionOn', { objectId: inRealm.objectId, functionDeclaration: 'function() { return realmLabel + this.answer; }' })).result.value, 'vm17');
    assert.equal(vm.runInContext('answer', context), 17);
    stage('restricted live VM sandbox');
    const pureVM = expression => post(session, 'Runtime.evaluate', { expression, contextId: discovered.id, throwOnSideEffect: true });
    assert.equal((await pureVM('answer + 25')).result.value, 42);
    let sandboxGetterReads = 0;
    context.guarded = { get value() { sandboxGetterReads++; return 7; } };
    const guarded = await pureVM('guarded');
    assert.equal(guarded.exceptionDetails, undefined);
    assert.equal(guarded.result.type, 'object');
    const guardedProperties = await post(session, 'Runtime.getProperties', { objectId: guarded.result.objectId, ownProperties: true });
    assert.equal(guardedProperties.result.find(property => property.name === 'value').get.type, 'function');
    assert.equal(sandboxGetterReads, 0);
    assert.ok((await pureVM('guarded.value')).exceptionDetails);
    assert.equal(sandboxGetterReads, 0);
    context.answer = 19;
    assert.equal((await pureVM('answer')).result.value, 19, 'restricted reads must observe current sandbox data');
    delete context.answer;
    assert.equal((await pureVM('typeof answer')).result.value, 'undefined', 'restricted reads must observe sandbox deletion');
    context.answer = 17;
    const priorSandboxPrototype = Object.getPrototypeOf(context);
    Object.setPrototypeOf(context, { inheritedInspectorValue: 23 });
    assert.equal((await pureVM('inheritedInspectorValue')).result.value, 23);
    Object.setPrototypeOf(context, priorSandboxPrototype);
    Object.defineProperty(context, 'inspectorAccessor', { configurable: true, get() { sandboxGetterReads++; return 1; } });
    assert.ok((await pureVM('inspectorAccessor')).exceptionDetails);
    assert.equal(sandboxGetterReads, 0);
    delete context.inspectorAccessor;
    let pauseCount = 0, bindingPauseCount = 0, pauseFailure;
    session.on('Debugger.paused', event => {
      try {
        stage('debugger paused callback');
        const frame = event.params.callFrames[0];
        if (frame.functionName === 'inspectorBindingBreakpointFrame') {
          bindingPauseCount++;
          assert.ok(frame.url.endsWith('inspector-binding-breakpoints.js'));
          assert.equal(frame.location.lineNumber, 1);
          assert.ok(notifications.some(item => item.method === 'Debugger.scriptParsed' && item.params.scriptId === frame.location.scriptId));
          return;
        }
        pauseCount++;
        assert.equal(frame.functionName, 'inspectorPausedFrame');
        assert.ok(frame.url.endsWith('inspector-live-frame.js'));
        assert.equal(frame.url, notifications.find(event => event.method === 'Debugger.scriptParsed' && event.params.scriptId === frame.location.scriptId).params.url);
        assert.ok(frame.scopeChain.some(scope => scope.type === 'local'));
        let evaluated = false;
        request(session, 'Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'lexical + 1', returnByValue: true }, (error, result) => {
          assert.ifError(error);
          assert.equal(result.result.value, 42);
          evaluated = true;
        });
        assert.equal(evaluated, true, 'nested frame request must complete inside paused callback');
      } catch (error) { pauseFailure = error; }
      finally {
        stage('debugger resume callback');
        request(session, 'Debugger.resume', {}, error => { if (error) pauseFailure = error; });
      }
    });
    const unpublishedScript = new vm.Script('6 * 7', { filename: 'inspector-unbound-before-enable.js' });
    const boundBeforeEnable = new vm.Script('21 * 2', { filename: 'inspector-bound-before-enable.js' });
    assert.equal(boundBeforeEnable.runInContext(context), 42);
    stage('Debugger.enable');
    await post(session, 'Debugger.enable');
    const parsed = filename => notifications.filter(event => event.method === 'Debugger.scriptParsed' && event.params.url.endsWith(filename)).map(event => event.params);
    assert.equal(parsed('inspector-unbound-before-enable.js').length, 0, 'enable must not inventory unbound VM bytecode');
    assert.equal(parsed('inspector-bound-before-enable.js').length, 1);
    assert.equal(parsed('inspector-bound-before-enable.js')[0].executionContextId, discovered.id);
    assert.equal((await post(session, 'Debugger.getScriptSource', { scriptId: parsed('inspector-bound-before-enable.js')[0].scriptId })).scriptSource, '21 * 2');
    assert.equal(unpublishedScript.runInThisContext(), 42);
    assert.equal(parsed('inspector-unbound-before-enable.js').length, 1);
    assert.equal(parsed('inspector-unbound-before-enable.js')[0].executionContextId, 1);
    stage('cached VM script and realm binding publication');
    const cacheSource = '40 + 2';
    const cacheOrigin = new vm.Script(cacheSource, { filename: 'inspector-cache-origin.js', lineOffset: 3, columnOffset: 4 });
    assert.equal(parsed('inspector-cache-origin.js').length, 0, 'Script construction must not publish');
    const restoredScript = new vm.Script(cacheSource, {
      filename: 'inspector-cache-restored.js', lineOffset: 7, columnOffset: 9, cachedData: cacheOrigin.createCachedData(),
    });
    assert.equal(restoredScript.cachedDataRejected, false);
    assert.equal(parsed('inspector-cache-origin.js').length, 0, 'creating cached data must not bind its producer');
    assert.equal(parsed('inspector-cache-restored.js').length, 0, 'cached reconstruction must not publish');
    const assertSource = async (info, source, line, column, contextId) => {
      assert.equal(info.executionContextId, contextId);
      assert.equal(info.startLine, line);
      assert.equal(info.startColumn, column);
      assert.equal(info.endLine, line);
      assert.equal(info.endColumn, column + source.length);
      assert.equal(info.length, source.length);
      assert.equal((await post(session, 'Debugger.getScriptSource', { scriptId: info.scriptId })).scriptSource, source);
    };
    assert.equal(cacheOrigin.runInThisContext(), 42);
    assert.equal(parsed('inspector-cache-origin.js').length, 1);
    await assertSource(parsed('inspector-cache-origin.js')[0], cacheSource, 3, 4, 1);
    const secondContext = vm.createContext({}, { name: 'inspector-second-script-realm' });
    const secondDiscovered = created.find(item => item.name === 'inspector-second-script-realm');
    assert.ok(secondDiscovered);
    const runBindings = [
      [() => restoredScript.runInContext(context), discovered.id],
      [() => restoredScript.runInContext(context), discovered.id],
      [() => restoredScript.runInContext(secondContext), secondDiscovered.id],
      [() => restoredScript.runInContext(context), discovered.id],
      [() => restoredScript.runInThisContext(), 1],
    ];
    let restoredId;
    for (let i = 0; i < runBindings.length; i++) {
      const [run, contextId] = runBindings[i];
      assert.equal(run(), 42);
      const events = parsed('inspector-cache-restored.js');
      assert.equal(events.length, i + 1, 'every execution publishes its binding, including repeated contexts');
      const info = events[i];
      if (restoredId === undefined) restoredId = info.scriptId;
      assert.equal(info.scriptId, restoredId, 'realm clones preserve Script source identity');
      await assertSource(info, cacheSource, 7, 9, contextId);
    }
    stage('fresh and restored function body publication');
    const functionSource = 'return answer + 25;';
    const freshFunction = vm.compileFunction(functionSource, [], {
      filename: 'inspector-function-origin.js', lineOffset: 13, columnOffset: 17, parsingContext: context, produceCachedData: true,
    });
    assert.equal(parsed('inspector-function-origin.js').length, 1, 'compileFunction publishes before its first call');
    const functionEvents = notifications.filter(event => event.method === 'Debugger.scriptParsed' && event.params.url.endsWith('inspector-function-origin.js'));
    assert.equal(functionEvents.length, 1, 'synthetic factories must not publish before the original body is installed');
    assert.equal(functionEvents[0].params.executionContextId, discovered.id);
    assert.equal(functionEvents[0].params.startLine, 13);
    assert.equal(functionEvents[0].params.startColumn, 17);
    assert.equal((await post(session, 'Debugger.getScriptSource', { scriptId: functionEvents[0].params.scriptId })).scriptSource, functionSource);
    assert.equal(functionEvents[0].params.endLine, 13);
    assert.equal(functionEvents[0].params.endColumn, 17 + functionSource.length);
    assert.equal(functionEvents[0].params.length, functionSource.length);
    assert.equal(freshFunction(), 42);
    assert.equal(parsed('inspector-function-origin.js').length, 1);
    const restoredFunction = vm.compileFunction(functionSource, [], {
      filename: 'inspector-function-restored.js', lineOffset: 19, columnOffset: 23, parsingContext: context, cachedData: freshFunction.cachedData,
    });
    assert.equal(restoredFunction.cachedDataRejected, false);
    assert.equal(parsed('inspector-function-restored.js').length, 1, 'cached compileFunction publishes before its first call');
    const restoredFunctionEvents = notifications.filter(event => event.method === 'Debugger.scriptParsed' && event.params.url.endsWith('inspector-function-restored.js'));
    assert.equal(restoredFunctionEvents.length, 1);
    assert.equal(restoredFunctionEvents[0].params.executionContextId, discovered.id);
    assert.equal(restoredFunctionEvents[0].params.startLine, 19);
    assert.equal(restoredFunctionEvents[0].params.startColumn, 23);
    assert.equal((await post(session, 'Debugger.getScriptSource', { scriptId: restoredFunctionEvents[0].params.scriptId })).scriptSource, functionSource);
    assert.equal(restoredFunctionEvents[0].params.endLine, 19);
    assert.equal(restoredFunctionEvents[0].params.endColumn, 23 + functionSource.length);
    assert.equal(restoredFunctionEvents[0].params.length, functionSource.length);
    assert.equal(restoredFunction(), 42);
    assert.equal(parsed('inspector-function-restored.js').length, 1);
    stage('breakpoints across Script realm bindings');
    const bindingBreakpoint = await post(session, 'Debugger.setBreakpointByUrl', {
      urlRegex: 'inspector-binding-breakpoints\\.js$', lineNumber: 1, columnNumber: 2,
    });
    const breakpointScript = new vm.Script('(function inspectorBindingBreakpointFrame() {\n  return 42;\n})();', { filename: 'inspector-binding-breakpoints.js' });
    for (const target of [context, context, secondContext, context, undefined]) {
      const before = bindingPauseCount;
      assert.equal(target ? breakpointScript.runInContext(target) : breakpointScript.runInThisContext(), 42);
      assert.ifError(pauseFailure);
      assert.equal(bindingPauseCount, before + 1, 'breakpoints must cover every cloned function without duplicate registration');
    }
    await post(session, 'Debugger.removeBreakpoint', { breakpointId: bindingBreakpoint.breakpointId });
    stage('named-function debugger fixture');
    assert.equal(vm.runInThisContext('(function inspectorPausedFrame() { const lexical = 41; debugger; return lexical + 1; })();', { filename: 'inspector-live-frame.js' }), 42);
    assert.ifError(pauseFailure);
    assert.equal(pauseCount, 1);
    assert.ok(notifications.some(event => event.method === 'Debugger.scriptParsed' && event.params.url.endsWith('inspector-live-frame.js')));
    assert.ok(notifications.some(event => event.method === 'Debugger.resumed'));
    stage('Debugger.disable');
    await post(session, 'Debugger.disable');
    globalThis.inspectorOwnerValue = 'main';
    stage('worker-to-main Session message');
    const worker = observeWorker(new Worker(__filename), 'main-thread-session');
    try {
      assert.equal(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), 'main-thread-session-passed');
    } finally { stage('worker-to-main termination'); await worker.terminate(); }
    const notification = (method, predicate = () => true) => new Promise(resolve => {
      const listener = event => { if (predicate(event.params)) { session.off(method, listener); resolve(event.params); } };
      session.on(method, listener);
    });
    stage('NodeWorker auto-wait enable');
    await post(session, 'NodeWorker.enable', { waitForDebuggerOnStart: true });
    const attached = notification('NodeWorker.attachedToWorker', params => /^\[worker \d+\] inspector-auto-wait$/.test(params.workerInfo.title));
    const pausedWorker = observeWorker(new Worker('globalThis.workerRan = true; require("node:worker_threads").parentPort.postMessage("worker-released"); setInterval(() => {}, 1000);', { eval: true, name: 'inspector-auto-wait', execArgv: [] }), 'auto-wait');
    const released = new Promise((resolve, reject) => { pausedWorker.once('message', resolve); pausedWorker.once('error', reject); });
    try {
      stage('NodeWorker auto-wait attachment');
      const attachedInfo = await attached;
      assert.equal(attachedInfo.waitingForDebugger, true);
      diagnostic.workers['auto-wait'].attached = attachedInfo.sessionId;
      stage('NodeWorker routed evaluation');
      const evaluationResponse = notification('NodeWorker.receivedMessageFromWorker', params => params.sessionId === attachedInfo.sessionId && JSON.parse(params.message).id === 701);
      await post(session, 'NodeWorker.sendMessageToWorker', { sessionId: attachedInfo.sessionId, message: JSON.stringify({ id: 701, method: 'Runtime.evaluate', params: { expression: 'typeof globalThis.workerRan', returnByValue: true } }) });
      assert.equal(JSON.parse((await evaluationResponse).message).result.result.value, 'undefined');
      stage('NodeWorker startup release');
      await post(session, 'NodeWorker.sendMessageToWorker', { sessionId: attachedInfo.sessionId, message: JSON.stringify({ id: 702, method: 'Runtime.runIfWaitingForDebugger' }) });
      assert.equal(await released, 'worker-released');
      stage('NodeWorker detach');
      const detached = notification('NodeWorker.detachedFromWorker', params => params.sessionId === attachedInfo.sessionId);
      await post(session, 'NodeWorker.detach', { sessionId: attachedInfo.sessionId });
      await detached;
      await assert.rejects(post(session, 'NodeWorker.sendMessageToWorker', { sessionId: attachedInfo.sessionId, message: '{}' }), { code: 'ERR_INSPECTOR_COMMAND' });
    } finally { stage('NodeWorker auto-wait termination'); await pausedWorker.terminate(); await post(session, 'NodeWorker.disable'); }
    stage('worker without auto-wait message');
    const unpausedWorker = observeWorker(new Worker('require("node:worker_threads").parentPort.postMessage("no-auto-wait");', { eval: true, execArgv: [] }), 'without-auto-wait');
    try {
      assert.equal(await new Promise((resolve, reject) => { unpausedWorker.once('message', resolve); unpausedWorker.once('error', reject); }), 'no-auto-wait');
    } finally { stage('worker without auto-wait termination'); await unpausedWorker.terminate(); }
    await post(session, 'NodeWorker.enable', { waitForDebuggerOnStart: false });
    stage('NodeWorker termination attachment');
    const terminateAttach = notification('NodeWorker.attachedToWorker', params => /^\[worker \d+\] inspector-terminate$/.test(params.workerInfo.title));
    const terminatingWorker = observeWorker(new Worker('setInterval(() => {}, 1000);', { eval: true, name: 'inspector-terminate', execArgv: [] }), 'terminate');
    try {
      const info = await terminateAttach;
      assert.equal(info.waitingForDebugger, false);
      diagnostic.workers.terminate.attached = info.sessionId;
      stage('NodeWorker termination and detach notification');
      const terminated = notification('NodeWorker.detachedFromWorker', params => params.sessionId === info.sessionId);
      await terminatingWorker.terminate();
      await terminated;
    } finally { stage('NodeWorker termination cleanup'); await terminatingWorker.terminate(); await post(session, 'NodeWorker.disable'); }
    stage('disconnect pending command');
    const pending = new Promise(resolve => request(session, 'Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, resolve));
    session.disconnect();
    assert.equal((await pending).code, 'ERR_INSPECTOR_CLOSED');
    session.disconnect();
    promised.disconnect();
    stage('global cleanup');
    for (const name of ['inspectorGetterReads', 'inspectorObject', 'inspectorEffects', 'inspectorProxyReads', 'inspectorProxy', 'inspectorOwnerValue']) delete globalThis[name];
    console.log('inspector callbacks, promises, descriptors, VM, debugger and main-thread routing passed');
  }
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { session.disconnect(); promised.disconnect(); clearTimeout(deadline); });
}
