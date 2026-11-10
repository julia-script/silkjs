'use strict';

function unpackError(value) {
  if (!value || value.loaderError !== true) return value;
  const Type = { Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError }[value.name] || Error;
  const error = new Type(value.message);
  if (value.stack) error.stack = value.stack;
  if (value.properties) Object.assign(error, value.properties);
  return error;
}
function create(threads, status, execArgv) {
  const { Worker, MessageChannel, receiveMessageOnPort } = threads;
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker('globalThis.__silkModuleBridge.startHookWorker()', {
    eval: true, workerData: { port: port2, signal }, transferList: [port2],
    execArgv, name: 'module customization hooks',
  });
  worker.unref();
  port1.unref();
  let failure;
  const threadId = worker.threadId;
  process.once('exit', () => { port1.close(); worker.terminate(); });
  let sequence = 0;
  worker.on('error', error => { failure = error; port1.close(); });
  function request(method, args, transferList) {
    if (failure) throw failure;
    const id = ++sequence;
    port1.postMessage({ id, method, args }, transferList);
    for (;;) {
      const epoch = Atomics.load(signal, 0);
      const envelope = receiveMessageOnPort(port1);
      if (envelope) {
        const message = envelope.message;
        if (message.id !== id) throw new Error('Loader hook response sequence mismatch');
        if (message.failed) throw unpackError(message.error);
        return message.value;
      }
      if (failure) throw failure;
      let exitCode;
      try { exitCode = status(threadId); }
      catch (error) { failure = error; port1.close(); throw error; }
      if (exitCode !== undefined) {
        port1.close();
        process.exit(exitCode);
      }
      Atomics.wait(signal, 0, epoch, 100);
    }
  }
  function call(method, args, transferList) {
    worker.ref();
    try { return request(method, args, transferList); }
    finally { worker.unref(); }
  }
  return { call };
}
module.exports = { create };