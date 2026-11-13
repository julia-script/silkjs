'use strict';

const host = require('internal/host');
const clone = require('internal/worker/clone');
const ports = require('internal/worker/ports');
const threadId = host.workerNative('info', []).threadId;
const messages = {
  FAILED: 'Cannot find the destination thread or listener',
  ERRORED: 'The destination thread threw an error while processing the message',
  TIMEOUT: 'Sending a message to another thread timed out',
  SAME_THREAD: 'Cannot sent a message to the same thread',
};
function failure(kind) { return clone.codedError('ERR_WORKER_MESSAGING_' + kind, messages[kind], Error); }

async function postMessageToThread(destination, value, transferList, timeout) {
  if (typeof transferList === 'number' && timeout === undefined) { timeout = transferList; transferList = undefined; }
  if (timeout !== undefined) {
    if (typeof timeout !== 'number') throw clone.codedError('ERR_INVALID_ARG_TYPE', 'The timeout argument must be of type number');
    if (Number.isNaN(timeout) || timeout < 0) throw clone.codedError('ERR_OUT_OF_RANGE', 'The timeout argument must be >= 0', RangeError);
  }
  if (destination === threadId) throw failure('SAME_THREAD');
  host.markWorkerActivity();
  const route = host.workerNative('routeChannel', [destination]);
  if (route === null) {
    // A worker sends through a transport even for an unknown destination; main
    // can reject before cloning, as in Node's main-thread routing fast path.
    if (threadId !== 0) {
      const channel = new ports.MessageChannel();
      try { channel.port1.postMessage(value, transferList); }
      finally { channel.port1.close(); channel.port2.close(); }
    }
    throw failure(timeout === 0 ? 'TIMEOUT' : 'FAILED');
  }
  let channel;
  let timer;
  try {
    channel = new ports.MessageChannel();
    const response = new Promise((resolve, reject) => {
      channel.port1.once('message', status => status === 0 ? resolve() : reject(failure(status === 2 ? 'ERRORED' : 'FAILED')));
      channel.port1.once('close', () => reject(failure('FAILED')));
      channel.port1.unref();
      if (timeout !== undefined && Number.isFinite(timeout)) {
        const deadline = require('perf_hooks').performance.now() + timeout;
        const expire = () => {
          const remaining = deadline - require('perf_hooks').performance.now();
          if (remaining <= 0) { reject(failure('TIMEOUT')); return; }
          timer = setTimeout(expire, Math.min(remaining, 2147483647));
          timer.unref();
        };
        expire();
      }
    });
    // Install a rejection handler even if serialization throws synchronously.
    response.catch(() => {});
    clone.post(route, { value, source: threadId, reply: channel.port2 }, [...clone.transferList(transferList), channel.port2]);
    if (timeout === 0) throw failure('TIMEOUT');
    return await response;
  } finally {
    clearTimeout(timer);
    host.workerNative('routeDetach', [route]);
    channel?.port1.close();
    channel?.port2.close();
  }
}
function dispatch(event) {
  const message = clone.decode(event.envelope);
  let status = 1;
  try { if (process.emit('workerMessage', message.value, message.source)) status = 0; }
  catch { status = 2; }
  finally {
    try { message.reply.postMessage(status); }
    finally { message.reply.close(); }
  }
}
module.exports = { postMessageToThread, dispatch };
