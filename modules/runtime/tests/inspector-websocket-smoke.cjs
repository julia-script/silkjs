'use strict';
// Run with an oracle Node 24 client, not Silk:
//   node tests/inspector-websocket-smoke.cjs build/silkjsruntime
// The subprocess is always Silk; no oracle executes guest source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'silk-inspector-websocket-')));
const entry = path.join(root, 'debug-target.cjs');
const source = [
  "'use strict';",
  'function inspectorInner(value) {',
  '  const doubled = value * 2;',
  '  return doubled + 1;',
  '}',
  'function inspectorOuter(seed) {',
  '  let local = seed + 1;',
  '  const result = inspectorInner(local);',
  '  return result;',
  '}',
  'globalThis.inspectorTransportTarget = inspectorOuter;',
  "console.log('INSPECTOR_GUEST_READY');",
  'setInterval(() => {}, 1000);',
].join('\n');
fs.writeFileSync(entry, source);
const executable = path.resolve(process.argv[2] || 'build/silkjsruntime');
const child = spawn(executable, ['--inspect-brk=127.0.0.1:0', entry], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exited = false, spawnError;
const started = Date.now(), recentPackets = [];
let stage = 'waiting for endpoint', stageStarted = started, evaluation = { status: 'not requested' };
let pendingRequests = () => [];
function enter(name) { stage = name; stageStarted = Date.now(); }
function record(direction, message) {
  const packet = JSON.stringify(message);
  recentPackets.push({ elapsedMs: Date.now() - started, direction, packet: packet.length > 2048 ? packet.slice(0, 2048) + ' [truncated]' : packet });
  if (recentPackets.length > 24) recentPackets.shift();
}
function failureDetails() {
  const now = Date.now();
  return JSON.stringify({
    stage, elapsedMs: now - started, stageElapsedMs: now - stageStarted,
    child: { exited, exitCode: child.exitCode, signalCode: child.signalCode },
    socketState: socket?.readyState, pendingRequests: pendingRequests(), evaluation, recentPackets,
    output: output.slice(-8192),
  }, null, 2);
}
const outputWaiters = new Set();
const notifyOutput = () => { for (const check of [...outputWaiters]) check(); };
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); notifyOutput(); });
const closed = new Promise(resolve => child.once('close', () => { exited = true; notifyOutput(); resolve(); }));
child.once('error', error => { spawnError = error; notifyOutput(); });
function untilOutput(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { outputWaiters.delete(check); reject(new Error('Child output deadline')); }, 10000);
    function check() {
      const result = predicate(output);
      if (result || exited || spawnError) {
        clearTimeout(timer); outputWaiters.delete(check);
        if (result) resolve(result); else reject(spawnError || new Error('Child exited'));
      }
    }
    outputWaiters.add(check); check();
  });
}
let socket;
async function main() {
  assert.equal(typeof WebSocket, 'function', 'Run this client with Node 24 WebSocket support');
  const endpoint = await untilOutput(text => text.match(/ws:\/\/[^\s]+/)?.[0]);
  const address = new URL(endpoint);
  enter('HTTP target discovery');
  const discovery = await fetch(`http://${address.host}/json/list`).then(response => response.json());
  assert.ok(discovery.some(target => target.webSocketDebuggerUrl === endpoint));
  enter('WebSocket attachment');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const requests = new Map(), events = [], eventWaiters = new Set(), scripts = new Map();
  pendingRequests = () => Array.from(requests, ([id, request]) => ({ id, method: request.method, pendingMs: Date.now() - request.started }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    record('received', message);
    if (message.id !== undefined) {
      const pending = requests.get(message.id);
      assert.ok(pending, 'unexpected response id');
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    } else {
      events.push(message);
      if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params);
      for (const check of [...eventWaiters]) check();
    }
  });
  function post(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('CDP deadline: ' + method)); }, 10000);
      requests.set(id, { resolve, reject, timer, method, started: Date.now() });
      const packet = { id, method, params };
      record('sent', packet);
      socket.send(JSON.stringify(packet));
    });
  }
  function notification(method, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { eventWaiters.delete(check); reject(new Error('Notification deadline: ' + method)); }, 10000);
      function check() {
        const index = events.findIndex(event => event.method === method && predicate(event.params));
        if (index < 0) return;
        const event = events.splice(index, 1)[0];
        clearTimeout(timer); eventWaiters.delete(check); resolve(event.params);
      }
      eventWaiters.add(check); check();
    });
  }
  enter('Runtime.enable and default context');
  await post('Runtime.enable');
  const mainContext = await notification('Runtime.executionContextCreated', params => params.context.auxData.isDefault);
  assert.ok(mainContext.context.id > 0);
  enter('Debugger.enable');
  await post('Debugger.enable');
  enter('startup release and initial pause');
  await post('Runtime.runIfWaitingForDebugger');
  const startup = await notification('Debugger.paused');
  assert.equal(scripts.get(startup.callFrames[0].location.scriptId)?.url, entry, 'inspect-brk must stop in the guest entry, not inspector internals');
  assert.ok(startup.callFrames[0].location.lineNumber >= 0, 'startup must pause inside the original CJS source');
  assert.ok(startup.callFrames[0].location.columnNumber >= 0, 'startup must skip the generated CJS wrapper prefix');
  enter('startup resume and guest ready');
  await post('Debugger.resume');
  await untilOutput(text => text.includes('INSPECTOR_GUEST_READY'));
  const script = [...scripts.values()].find(item => item.url === entry);
  assert.ok(script);
  enter('script source and executable locations');
  assert.equal((await post('Debugger.getScriptSource', { scriptId: script.scriptId })).scriptSource, source);
  assert.match(script.hash, /^[a-f0-9]{64}$/);
  const possible = await post('Debugger.getPossibleBreakpoints', { start: { scriptId: script.scriptId, lineNumber: 7, columnNumber: 0 }, end: { scriptId: script.scriptId, lineNumber: 8, columnNumber: 0 } });
  assert.ok(possible.locations.length > 0);
  enter('resolve exact column breakpoint');
  const callLine = source.split('\n')[7];
  const exactColumn = callLine.indexOf('(');
  assert.ok(possible.locations.some(location => location.columnNumber === exactColumn));
  const exactBreakpoint = await post('Debugger.setBreakpoint', { location: { scriptId: script.scriptId, lineNumber: 7, columnNumber: exactColumn } });
  assert.equal(exactBreakpoint.actualLocation.columnNumber, exactColumn, 'an exact executable column must take precedence over earlier PCs');
  await post('Debugger.removeBreakpoint', { breakpointId: exactBreakpoint.breakpointId });
  enter('install URL breakpoint');
  const breakpoint = await post('Debugger.setBreakpointByUrl', { url: entry, lineNumber: 7, columnNumber: 0 });
  assert.equal(breakpoint.locations[0].lineNumber, 7);
  assert.equal(breakpoint.locations[0].columnNumber, callLine.indexOf('inspectorInner'), 'a line breakpoint must precede the call, not select its later assignment store');
  enter('evaluate target and await URL breakpoint pause');
  evaluation = { status: 'pending' };
  const execution = post('Runtime.evaluate', { expression: 'inspectorTransportTarget(6)', returnByValue: true });
  // Attach a rejection handler while the evaluation is suspended in the guest.
  execution.then(
    result => { evaluation = { status: 'fulfilled', result }; },
    error => { evaluation = { status: 'rejected', code: error.code, message: error.message }; },
  );
  const paused = await notification('Debugger.paused');
  const frame = paused.callFrames[0];
  assert.equal(frame.functionName, 'inspectorOuter');
  assert.equal(frame.location.lineNumber, 7);
  assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId));
  const scope = frame.scopeChain.find(item => item.type === 'local');
  assert.ok(scope);
  enter('paused scope descriptors and lexical mutation');
  const before = (await post('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true })).result;
  assert.equal(before.find(property => property.name === 'local').value.value, 7);
  assert.equal((await post('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'local = 9', returnByValue: true })).result.value, 9);
  const after = (await post('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true })).result;
  assert.equal(after.find(property => property.name === 'local').value.value, 9, 'same scope remote id must read live bindings');
  enter('remove URL breakpoint');
  await post('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
  enter('stepInto and await inspectorInner pause');
  await post('Debugger.stepInto');
  const entered = await notification('Debugger.paused', params => params.callFrames[0].functionName === 'inspectorInner');
  enter('inspect entered function argument');
  assert.equal((await post('Debugger.evaluateOnCallFrame', { callFrameId: entered.callFrames[0].callFrameId, expression: 'value', returnByValue: true })).result.value, 9);
  enter('stepOver and await next pause');
  await post('Debugger.stepOver');
  const stepped = await notification('Debugger.paused');
  assert.equal(stepped.callFrames[0].functionName, 'inspectorInner');
  assert.ok(stepped.callFrames[0].location.lineNumber > entered.callFrames[0].location.lineNumber);
  enter('stepOut and await caller pause');
  await post('Debugger.stepOut');
  const returned = await notification('Debugger.paused');
  assert.equal(returned.callFrames[0].functionName, 'inspectorOuter');
  enter('resume and await target evaluation result');
  await post('Debugger.resume');
  assert.equal((await execution).result.value, 19);
  enter('callFunctionOn target and await URL breakpoint pause');
  const callBreakpoint = await post('Debugger.setBreakpointByUrl', { url: entry, lineNumber: 7, columnNumber: 0 });
  evaluation = { status: 'pending', command: 'Runtime.callFunctionOn' };
  const called = post('Runtime.callFunctionOn', { functionDeclaration: 'function() { return inspectorTransportTarget(2); }', executionContextId: mainContext.context.id, returnByValue: true });
  called.then(
    result => { evaluation = { status: 'fulfilled', command: 'Runtime.callFunctionOn', result }; },
    error => { evaluation = { status: 'rejected', command: 'Runtime.callFunctionOn', code: error.code, message: error.message }; },
  );
  const callPause = await notification('Debugger.paused');
  assert.equal(callPause.callFrames[0].functionName, 'inspectorOuter');
  assert.ok(callPause.hitBreakpoints.includes(callBreakpoint.breakpointId));
  await post('Debugger.removeBreakpoint', { breakpointId: callBreakpoint.breakpointId });
  enter('resume and await callFunctionOn result');
  await post('Debugger.resume');
  assert.equal((await called).result.value, 7);
  enter('same-line statement debugger pause');
  evaluation = { status: 'pending', command: 'same-line Runtime.evaluate' };
  const sameLineExecution = post('Runtime.evaluate', { expression: '(() => { debugger; let value = 1; value++; return value; })()', returnByValue: true });
  sameLineExecution.then(
    result => { evaluation = { status: 'fulfilled', command: 'same-line Runtime.evaluate', result }; },
    error => { evaluation = { status: 'rejected', command: 'same-line Runtime.evaluate', code: error.code, message: error.message }; },
  );
  const sameLineStart = await notification('Debugger.paused');
  enter('same-line declaration step');
  await post('Debugger.stepOver');
  const declaration = (await notification('Debugger.paused')).callFrames[0];
  assert.equal(declaration.location.lineNumber, sameLineStart.callFrames[0].location.lineNumber);
  assert.ok(declaration.location.columnNumber > sameLineStart.callFrames[0].location.columnNumber);
  enter('same-line mutation step');
  await post('Debugger.stepOver');
  const mutation = (await notification('Debugger.paused')).callFrames[0];
  assert.equal(mutation.location.lineNumber, declaration.location.lineNumber);
  assert.ok(mutation.location.columnNumber > declaration.location.columnNumber);
  assert.equal((await post('Debugger.evaluateOnCallFrame', { callFrameId: mutation.callFrameId, expression: 'value', returnByValue: true })).result.value, 1);
  enter('same-line return step');
  await post('Debugger.stepOver');
  const returnStatement = (await notification('Debugger.paused')).callFrames[0];
  assert.equal(returnStatement.location.lineNumber, mutation.location.lineNumber);
  assert.ok(returnStatement.location.columnNumber > mutation.location.columnNumber);
  assert.equal((await post('Debugger.evaluateOnCallFrame', { callFrameId: returnStatement.callFrameId, expression: 'value', returnByValue: true })).result.value, 2);
  enter('same-line execution resume');
  await post('Debugger.resume');
  assert.equal((await sameLineExecution).result.value, 2);
  enter('reject stale frames and unsupported commands');
  await assert.rejects(post('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'local' }));
  await assert.rejects(post('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true }));
  await assert.rejects(post('Debugger.unsupported'), { code: -32601, message: "'Debugger.unsupported' wasn't found" });
  enter('Debugger.disable');
  await post('Debugger.disable');
  console.log('external WebSocket startup, breakpoints, live scopes, step into/over/out and resume passed');
}
main().catch(error => { console.error(error); console.error('Inspector WebSocket failure details:\n' + failureDetails()); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  child.kill('SIGKILL');
  await closed;
  fs.rmSync(root, { recursive: true, force: true });
});
