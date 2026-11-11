'use strict';

// Node's DOMStorage and Storage domains (--experimental-storage-inspection).
// As DOMStorageAgent in Node, each session has its own copy of the items, made
// of the storage events it saw (and registerStorage, a pseudo-event, replaced).
const host = require('internal/host');
const { protocolError, unsupported } = require('internal/inspector_values');

const DEFAULT_KEY = 'node-inspector://default-dom-storage';

function enabled() { return !!host.experimentalStorageInspection; }
// lib/internal/inspector/webstorage.js getStorageKey.
function storageKey() {
  const file = host.localStorageFile;
  return typeof file === 'string' && file !== '' ? 'file://' + require('path').resolve(file) : DEFAULT_KEY;
}
function storageId(isLocalStorage) { return { securityOrigin: '', isLocalStorage, storageKey: storageKey() }; }

function storages(session) { return session.domStorage ??= { local: new Map(), session: new Map() }; }
function mapFor(session, params) {
  const id = params.storageId;
  const local = id !== null && typeof id === 'object' ? id.isLocalStorage : params.isLocalStorage;
  return local ? storages(session).local : storages(session).session;
}
// Every DOMStorage event updates the session's copy, enabled or not.
function observe(session, method, params, items) {
  switch (method) {
    case 'DOMStorage.registerStorage': {
      const map = mapFor(session, params);
      map.clear();
      for (const [key, value] of items) map.set(key, value);
      break;
    }
    case 'DOMStorage.domStorageItemAdded':
    case 'DOMStorage.domStorageItemUpdated': mapFor(session, params).set(`${params.key}`, `${params.newValue}`); break;
    case 'DOMStorage.domStorageItemRemoved': mapFor(session, params).delete(`${params.key}`); break;
    case 'DOMStorage.domStorageItemsCleared': mapFor(session, params).clear(); break;
  }
}

function items(session, params) {
  const id = params && params.storageId;
  if (id === null || typeof id !== 'object' || typeof id.isLocalStorage !== 'boolean') throw protocolError(-32602, 'Invalid parameters');
  return { entries: [...(id.isLocalStorage ? storages(session).local : storages(session).session)] };
}

function dispatch(session, method, params) {
  if (!enabled()) unsupported(method);
  switch (method) {
    case 'DOMStorage.enable': session.domStorageEnabled = true; return {};
    case 'DOMStorage.disable': session.domStorageEnabled = false; return {};
    case 'DOMStorage.getDOMStorageItems': return items(session, params);
    case 'Storage.getStorageKey': return { storageKey: storageKey() };
    default: unsupported(method);
  }
}

module.exports = { dispatch, observe, storageId };
