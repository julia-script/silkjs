'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const originalPrepare = Error.prepareStackTrace;
const originalLimit = Error.stackTraceLimit;

async function main() {
  try {
    assert.equal(Error.captureStackTrace.length, 2);
    assert.equal(Error.stackTraceLimit, 10);
    assert.equal(Object.getOwnPropertyDescriptor(Error, 'captureStackTrace').enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace').enumerable, false);
    Error.prepareStackTrace = (_error, sites) => sites;
    function constructed() { return new TypeError('constructed'); }
    const constructedError = constructed();
    assert.equal(constructedError.stack[0].getFunctionName(), 'constructed');
    assert.equal(constructedError.stack[0].isNative(), false);
    assert.equal(constructedError.stack[0].getFileName(), __filename);
    assert.ok(constructedError.stack[0].getLineNumber() > 0);
    assert.ok(constructedError.stack[0].getColumnNumber() > 0);
    function nativeFailure() { return null.missing; }
    let nativeError;
    try { nativeFailure(); } catch (error) { nativeError = error; }
    assert.equal(nativeError.stack[0].getFunctionName(), 'nativeFailure');
    assert.equal(nativeError.stack[0].getFileName(), __filename);

    for (const [limit, expected] of [[0, 0], [-2, 0], [NaN, 0], [1.9, 1], [2, 2]]) {
      Error.stackTraceLimit = limit;
      const error = new Error();
      Error.stackTraceLimit = 50;
      assert.equal(error.stack.length, expected);
    }
    for (const limit of [undefined, '3', null]) {
      Error.stackTraceLimit = limit;
      const error = new Error();
      assert.equal(typeof Object.getOwnPropertyDescriptor(error, 'stack').get, 'function');
      Error.stackTraceLimit = 10;
      assert.equal(error.stack, undefined);
    }
    let limitReads = 0;
    Object.defineProperty(Error, 'stackTraceLimit', { configurable: true, get() { limitReads++; return 3; } });
    const accessorLimit = new Error();
    assert.equal(accessorLimit.stack, undefined);
    assert.equal(limitReads, 0);
    Object.defineProperty(Error, 'stackTraceLimit', { value: 10, configurable: true, writable: true, enumerable: true });

    function captureBoundary() {
      const target = {};
      Error.captureStackTrace(target, captureBoundary);
      return target;
    }
    function captureCaller() { return captureBoundary(); }
    assert.equal(captureCaller().stack[0].getFunctionName(), 'captureCaller');
    const absent = {};
    Error.captureStackTrace(absent, function notOnTheStack() {});
    assert.deepEqual(absent.stack, []);
    for (const value of [null, 0, 'skip']) {
      const target = {};
      Error.captureStackTrace(target, value);
      assert.equal(target.stack[0].getFunctionName(), 'main');
    }
    assert.throws(() => Error.captureStackTrace(null), TypeError);
    assert.throws(() => Error.captureStackTrace(Object.freeze({})), TypeError);

    // Function-generated sloppy code is outside this strict CommonJS wrapper.
    const sloppy = Function('const receiver = { method: function visible() { return [this, new Error()]; } }; return receiver.method();');
    const [receiver, sloppyError] = sloppy();
    const sloppySite = sloppyError.stack[0];
    assert.equal(sloppySite.getThis(), receiver);
    assert.equal(sloppySite.getFunction(), receiver.method);
    assert.equal(sloppySite.getMethodName(), 'method');
    assert.equal(sloppySite.getTypeName(), 'Object');
    assert.equal(sloppySite.isToplevel(), false);
    const strictReceiver = { method() { return new Error(); } };
    const strictSites = strictReceiver.method().stack;
    assert.equal(strictSites[0].getThis(), undefined);
    assert.equal(strictSites[0].getFunction(), undefined);
    assert.equal(strictSites[0].getTypeName(), 'Object');
    assert.equal(strictSites[0].getMethodName(), 'method');
    assert.equal(strictSites[0].isToplevel(), false);
    assert.equal(strictSites[1].getFunction(), undefined);
    assert.throws(() => sloppySite.getFileName.call({}), TypeError);
    function Constructor() { this.error = new Error(); }
    assert.equal(new Constructor().error.stack[0].isConstructor(), true);
    const builtinSite = [1].map(function builtinCaller() { return new Error().stack; })[0][1];
    assert.equal(builtinSite.getFunctionName(), 'map');
    assert.equal(builtinSite.getThis(), undefined);
    assert.equal(builtinSite.getFunction(), undefined);
    assert.equal(builtinSite.isNative(), false);
    assert.equal(builtinSite.getPosition(), 0);
    assert.equal(builtinSite.getScriptHash(), '');
    assert.equal(builtinSite.toString(), 'Array.map (<anonymous>)');
    const recapturedError = new Error();
    const previousGetter = Object.getOwnPropertyDescriptor(recapturedError, 'stack').get;
    Error.captureStackTrace(recapturedError);
    assert.equal(previousGetter.call(recapturedError), recapturedError.stack);

    let calls = 0;
    const result = { arbitrary: true };
    Error.prepareStackTrace = function (error, sites) {
      assert.equal(this, Error);
      assert.ok(Array.isArray(sites));
      calls++;
      return result;
    };
    const lazy = new Error('lazy');
    assert.equal(calls, 0);
    assert.equal(lazy.stack, result);
    assert.equal(lazy.stack, result);
    assert.equal(calls, 1);
    const overridden = new Error();
    overridden.stack = 42;
    assert.equal(overridden.stack, 42);
    assert.equal(calls, 1);
    const captured = {};
    Error.captureStackTrace(captured);
    const accessors = Object.getOwnPropertyDescriptor(captured, 'stack');
    assert.equal(accessors.enumerable, false);
    assert.equal(accessors.get.call({}), undefined);
    accessors.set.call({}, 123);
    captured.stack = false;
    assert.equal(captured.stack, false);
    assert.equal(calls, 1);
    const failure = {};
    let failures = 0;
    Error.prepareStackTrace = () => { failures++; throw failure; };
    const retry = new Error();
    assert.throws(() => retry.stack, error => error === failure);
    assert.throws(() => retry.stack, error => error === failure);
    assert.equal(failures, 2);
    Error.prepareStackTrace = () => undefined;
    assert.equal(retry.stack, undefined);
    Error.prepareStackTrace = () => 'must stay cached';
    assert.equal(retry.stack, undefined);
    Error.prepareStackTrace = () => new Error('nested').stack;
    assert.match(new Error().stack, /^Error: nested\n/);

    Error.prepareStackTrace = originalPrepare;
    const header = new Error('before');
    header.name = 'Changed';
    header.message = 'after';
    assert.match(header.stack, /^Changed: after\n/);
    header.message = 'later';
    assert.match(header.stack, /^Changed: after\n/);

    // Metadata stays with the compiled script and survives eval's activation.
    Error.prepareStackTrace = (_error, sites) => sites;
    const evaluated = eval('(function evaluatedFunction() { return new Error(); })');
    const evalSite = evaluated().stack[0];
    assert.equal(evalSite.isEval(), true);
    assert.equal(evalSite.getFileName(), undefined);
    assert.match(evalSite.getEvalOrigin(), /^eval at main /);
    const evalWithURL = eval('new Error()\n//# sourceURL=error-stack-eval.js').stack[0];
    assert.equal(evalWithURL.getScriptNameOrSourceURL(), 'error-stack-eval.js');
    assert.equal(evalWithURL.getEvalOrigin(), 'error-stack-eval.js');
    const source = 'function positioned() { return new Error(); } positioned();';
    const scriptError = vm.runInThisContext(source, { filename: 'error-stack-position.js' });
    const site = scriptError.stack[0];
    assert.equal(site.getPosition(), source.indexOf('new Error'));
    assert.equal(site.getEnclosingLineNumber(), 1);
    assert.equal(site.getEnclosingColumnNumber(), 1);
    assert.equal(site.getScriptHash(), require('node:crypto').createHash('sha256').update(source).digest('hex'));
    const body = 'return new Error()';
    const bodySite = vm.compileFunction(body, [], { lineOffset: 5, columnOffset: 7 })().stack[0];
    assert.equal(bodySite.getPosition(), 7);
    assert.equal(bodySite.getLineNumber(), 6);
    assert.equal(bodySite.getColumnNumber(), 15);
    assert.equal(bodySite.getEnclosingLineNumber(), 6);
    assert.equal(bodySite.getEnclosingColumnNumber(), 8);
    assert.equal(bodySite.getScriptHash(), require('node:crypto').createHash('sha256').update(body).digest('hex'));
    const cachedSource = '/* Ω𐐀 */ new Error()\n//# sourceURL=error-stack-cached.js';
    const cachedData = new vm.Script(cachedSource).createCachedData();
    const consumer = new vm.Script(cachedSource, { cachedData, filename: 'cache-consumer.js', lineOffset: 7, columnOffset: 3 });
    assert.equal(consumer.cachedDataRejected, false);
    const cachedSite = consumer.runInThisContext().stack[0];
    assert.equal(cachedSite.getPosition(), cachedSource.indexOf('new Error'));
    assert.equal(cachedSite.getScriptNameOrSourceURL(), 'error-stack-cached.js');
    assert.equal(cachedSite.getFileName(), 'cache-consumer.js');
    assert.equal(cachedSite.getLineNumber(), 1);
    assert.equal(cachedSite.getColumnNumber(), cachedSource.indexOf('new Error') + 1);
    assert.equal(cachedSite.getEnclosingLineNumber(), 8);
    assert.equal(cachedSite.getEnclosingColumnNumber(), 4);
    assert.equal(cachedSite.getScriptHash(), require('node:crypto').createHash('sha256').update(cachedSource).digest('hex'));

    Error.prepareStackTrace = () => 'root formatter';
    const context = vm.createContext({});
    assert.equal(vm.runInContext('typeof Error.prepareStackTrace', context), 'undefined');
    assert.equal(vm.runInContext('new Error()', context).stack, 'root formatter');
    vm.runInContext('Error.prepareStackTrace = (error, sites) => ({ realm: sites instanceof Array, message: error.message, length: sites.length }); Error.stackTraceLimit = 1;', context);
    const realmResult = vm.runInContext('new Error("realm")', context).stack;
    assert.equal(realmResult.realm, true);
    assert.equal(realmResult.message, 'realm');
    assert.equal(realmResult.length, 1);
    assert.equal(Error.stackTraceLimit, 10);
    Error.prepareStackTrace = (_error, sites) => ({ owner: 'root', length: sites.length });
    const rootTarget = Object.create(null);
    vm.runInContext('Error.captureStackTrace', context)(rootTarget);
    assert.deepEqual(rootTarget.stack, { owner: 'root', length: 1 });
    const foreignTarget = vm.runInContext('Object.create(null)', context);
    Object.setPrototypeOf(foreignTarget, Object.prototype);
    Error.captureStackTrace(foreignTarget);
    assert.equal(foreignTarget.stack.realm, true);
    assert.ok(foreignTarget.stack.length > 1);
    let transient = vm.createContext({});
    const retainedSite = vm.runInContext(
      'Error.prepareStackTrace = (error, sites) => sites; function retained() { return new Error().stack[0]; } retained();',
      transient, { filename: 'retained-context.js' });
    transient = null;
    if (global.gc) global.gc();
    assert.equal(retainedSite.getFileName(), 'retained-context.js');
    assert.equal(typeof retainedSite.getFunction(), 'function');
    assert.equal(sloppySite.getFunctionName.call(retainedSite), 'retained');

    const workerResult = await new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        Error.stackTraceLimit = 1;
        Error.prepareStackTrace = (error, sites) => ({ message: error.message, count: sites.length, file: sites[0].getFileName() });
        function inWorker() { return new Error('worker').stack; }
        parentPort.postMessage(inWorker());
      `, { eval: true });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.equal(workerResult.message, 'worker');
    assert.equal(workerResult.count, 1);
    assert.equal(typeof workerResult.file, 'string');
    const fs = require('node:fs');
    const path = require('node:path');
    const moduleAPI = require('node:module');
    const support = moduleAPI.getSourceMapsSupport();
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'silk-error-stack-')));
    const generated = path.join(directory, 'generated.cjs');
    try {
      moduleAPI.setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
      const map = { version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' };
      fs.writeFileSync(generated, 'module.exports = function mapped() { return new Error("mapped"); };\n' +
        '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
      const mapped = require(generated);
      Error.prepareStackTrace = originalPrepare;
      assert.match(mapped().stack, /original\.ts:1:1/);
      Error.prepareStackTrace = (_error, sites) => sites;
      assert.equal(mapped().stack[0].getFileName(), generated);
    } finally {
      moduleAPI.setSourceMapsSupport(support.enabled, support);
      delete require.cache[generated];
      fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log('error stack smoke: ok');
  } finally {
    Error.prepareStackTrace = originalPrepare;
    Object.defineProperty(Error, 'stackTraceLimit', { value: originalLimit, writable: true, configurable: true, enumerable: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
