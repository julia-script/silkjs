'use strict';

const host = require('internal/host');
const { AbortController, isAbortSignal, createAbortSignal, closeTransferredSignal, abortSignal, kResistStopPropagation } = require('internal/path_events/event_target');
const { codes: { ERR_INVALID_ARG_TYPE } } = require('internal/path_events/support');
const transferable = new WeakSet();
const abortWaitCleanup = new FinalizationRegistry(disposeWait);
const senderCleanup = new FinalizationRegistry(disposeSender);
const receiverCleanup = new FinalizationRegistry(port => port.close());

function transferableAbortSignal(signal) {
  if (!isAbortSignal(signal)) throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  transferable.add(signal);
  return signal;
}
function transferableAbortController() {
  const controller = new AbortController();
  transferableAbortSignal(controller.signal);
  return controller;
}
function disposeWait(link) {
  abortWaitCleanup.unregister(link);
  link.signal.deref()?.removeEventListener('abort', link.listener);
}
function waitListener(link, resolve) {
  return event => {
    // Collection and finalizer delivery are distinct: never resolve for an
    // already collected resource even if its finalizer has not run yet.
    const resource = link.resource.deref();
    disposeWait(link);
    if (resource !== undefined) resolve(event);
  };
}
async function aborted(signal, resource) {
  if (!isAbortSignal(signal)) throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function'))
    throw new ERR_INVALID_ARG_TYPE('resource', 'Object', resource);
  if (signal.aborted) return;
  const link = { signal: new WeakRef(signal), resource: new WeakRef(resource), listener: undefined };
  const promise = new Promise(resolve => { link.listener = waitListener(link, resolve); });
  abortWaitCleanup.register(resource, link, link);
  signal.addEventListener('abort', link.listener, { once: true, [kResistStopPropagation]: true });
  return promise;
}

function disposeSender(link) {
  if (link.closed) return;
  link.closed = true;
  senderCleanup.unregister(link);
  link.signal.deref()?.removeEventListener('abort', link.listener);
  link.port.close();
}
function sendAbort(link) {
  if (link.closed) return;
  const signal = link.signal.deref();
  if (!signal) { disposeSender(link); return; }
  try { link.port.postMessage(signal.reason); }
  finally { disposeSender(link); }
}
function senderListener(link) { return () => sendAbort(link); }
function senderClosed(link) { return () => disposeSender(link); }
function prepareTransfer(signal) {
  if (signal.aborted) return {};
  const { MessageChannel } = require('internal/worker/ports');
  const { port1, port2 } = new MessageChannel();
  const link = { signal: new WeakRef(signal), port: port1, listener: undefined, closed: false };
  link.listener = senderListener(link);
  port1.once('close', senderClosed(link));
  return { port: port2, link };
}
function rollbackTransfer(record) {
  if (!record.link) return;
  disposeSender(record.link);
  record.port.close();
}
function commitTransfer(record) {
  const link = record.link;
  if (!link || link.closed) return;
  if (record.snapshotAborted) { disposeSender(link); return; }
  const signal = link.signal.deref();
  if (!signal) { disposeSender(link); return; }
  senderCleanup.register(signal, link, link);
  // Getters evaluated by the serializer may have aborted the source after its
  // snapshot. Deliver through the same asynchronous port path in that case.
  if (signal.aborted) host.nextTick(() => sendAbort(link));
  else signal.addEventListener('abort', link.listener, { once: true });
}
function createTransferredSignal() { return transferableAbortSignal(createAbortSignal()); }
function receiverListener(reference, port, token) {
  return ({ data }) => {
    receiverCleanup.unregister(token);
    try {
      const signal = reference.deref();
      if (signal) abortSignal(signal, data);
    } finally { port.onmessage = null; port.close(); }
  };
}
function receiverClosed(reference, port, token) {
  return () => {
    receiverCleanup.unregister(token);
    port.onmessage = null;
    const signal = reference.deref();
    if (signal) closeTransferredSignal(signal);
  };
}
function receiveTransfer(signal, aborted, value) {
  if (aborted) { abortSignal(signal, value); return; }
  const port = value;
  const token = {};
  receiverCleanup.register(signal, port, token);
  const reference = new WeakRef(signal);
  port.once('close', receiverClosed(reference, port, token));
  port.onmessage = receiverListener(reference, port, token);
  port.unref();
}

module.exports = {
  util: { transferableAbortController, transferableAbortSignal, aborted },
  isTransferable: value => transferable.has(value),
  prepareTransfer, rollbackTransfer, commitTransfer, createTransferredSignal, receiveTransfer,
};
