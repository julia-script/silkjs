'use strict';

const { EventEmitter } = require('events');
const backend = require('internal/inspector');
const { validateFunction, validateObject, validateString } = require('internal/validators');
const {
  ERR_INSPECTOR_ALREADY_CONNECTED, ERR_INSPECTOR_CLOSED, ERR_INSPECTOR_COMMAND, ERR_INSPECTOR_NOT_CONNECTED, ERR_INSPECTOR_NOT_WORKER,
} = require('internal/errors').codes;
class Session extends EventEmitter {
  #connection = null;
  #nextId = 1;
  #callbacks = new Map();
  connect() {
    if (this.#connection) throw new ERR_INSPECTOR_ALREADY_CONNECTED('The inspector session');
    this.#connection = backend.connect(message => this.#onMessage(message));
  }
  connectToMainThread() {
    if (require('internal/host').inspectorNative(10) === 0) throw new ERR_INSPECTOR_NOT_WORKER();
    if (this.#connection) throw new ERR_INSPECTOR_ALREADY_CONNECTED('The inspector session');
    this.#connection = backend.connect(message => this.#onMessage(message), true);
  }
  #onMessage(message) {
    const parsed = JSON.parse(message);
    try {
      if (parsed.id !== undefined) {
        const callback = this.#callbacks.get(parsed.id);
        this.#callbacks.delete(parsed.id);
        if (callback) {
          if (parsed.error) callback(new ERR_INSPECTOR_COMMAND(parsed.error.code, parsed.error.message));
          else callback(null, parsed.result);
        }
      } else {
        this.emit(parsed.method, parsed);
        this.emit('inspectorNotification', parsed);
      }
    } catch (cause) { process.emitWarning(cause); }
  }
  post(method, params, callback) {
    validateString(method, 'method');
    if (!callback && typeof params === 'function') { callback = params; params = null; }
    if (params) validateObject(params, 'params');
    if (callback) validateFunction(callback, 'callback');
    if (!this.#connection) throw new ERR_INSPECTOR_NOT_CONNECTED();
    const id = this.#nextId++;
    const message = { id, method };
    if (params) message.params = params;
    // Match Node: serialization is synchronous; no protocol callback is made
    // for a JSON serialization exception in the caller's parameters.
    if (callback) this.#callbacks.set(id, callback);
    this.#connection.dispatch(JSON.stringify(message));
  }
  disconnect() {
    if (!this.#connection) return;
    const connection = this.#connection;
    this.#connection = null;
    connection.disconnect();
    for (const callback of this.#callbacks.values()) process.nextTick(callback, new ERR_INSPECTOR_CLOSED());
    this.#callbacks.clear();
    this.#nextId = 1;
  }
}
function event(method) {
  return (params = {}) => {
    validateObject(params, 'params');
    backend.broadcast(method, params);
  };
}
const Network = {};
for (const name of ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed', 'dataSent', 'dataReceived', 'webSocketCreated', 'webSocketClosed', 'webSocketHandshakeResponseReceived']) Network[name] = event(`Network.${name}`);
const DOMStorage = {};
for (const name of ['domStorageItemAdded', 'domStorageItemRemoved', 'domStorageItemUpdated', 'domStorageItemsCleared', 'registerStorage']) DOMStorage[name] = event(`DOMStorage.${name}`);
module.exports = { open: backend.open, close: backend.close, url: backend.url, waitForDebugger: backend.waitForDebugger, console: backend.console, Session, Network, NetworkResources: { put: backend.putNetworkResource }, DOMStorage };
