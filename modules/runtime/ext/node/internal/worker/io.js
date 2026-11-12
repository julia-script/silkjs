'use strict';

// Node.js lib/internal/worker/io.js: the message types of a worker's control
// port, and the MessagePort family. The port modules load on first use, so a
// thread that only needs messageTypes loads nothing else.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const messageTypes = {
  UP_AND_RUNNING: 'upAndRunning',
  COULD_NOT_SERIALIZE_ERROR: 'couldNotSerializeError',
  ERROR_MESSAGE: 'errorMessage',
  STDIO_PAYLOAD: 'stdioPayload',
  STDIO_WANTS_MORE_DATA: 'stdioWantsMoreData',
  LOAD_SCRIPT: 'loadScript',
};

module.exports = { messageTypes };

const ports = () => require('internal/worker/ports');
const broadcast = () => require('internal/worker/broadcast');
for (const [name, load] of [
  ['MessagePort', () => ports().MessagePort],
  ['MessageChannel', () => ports().MessageChannel],
  ['moveMessagePortToContext', () => ports().moveMessagePortToContext],
  ['receiveMessageOnPort', () => port => ports().receiveMessageOnPort(broadcast().portOf(port) || port)],
  ['BroadcastChannel', () => broadcast().BroadcastChannel],
  ['markAsUncloneable', () => require('internal/worker/clone').markAsUncloneable],
]) {
  Object.defineProperty(module.exports, name, {
    enumerable: true, configurable: true,
    get() { const value = load(); Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true }); return value; },
  });
}
