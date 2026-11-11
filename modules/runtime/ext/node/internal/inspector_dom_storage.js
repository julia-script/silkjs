'use strict';

// Node's DOMStorage and Storage domains (--experimental-storage-inspection):
// a session reads the realm's localStorage and sessionStorage, and Node's
// registerStorage pseudo-event supplies the items of a storage the realm has
// not made.
const host = require('internal/host');
const { protocolError, unsupported } = require('internal/inspector_values');

const DEFAULT_KEY = 'node-inspector://default-dom-storage';
const registered = { local: new Map(), session: new Map() };

function enabled() { return !!host.experimentalStorageInspection; }
// lib/internal/inspector/webstorage.js getStorageKey.
function storageKey() {
  const file = host.localStorageFile;
  return typeof file === 'string' && file !== '' ? 'file://' + require('path').resolve(file) : DEFAULT_KEY;
}
function storageId(isLocalStorage) { return { securityOrigin: '', isLocalStorage, storageKey: storageKey() }; }

function register(params) {
  if (params === null || typeof params !== 'object') return;
  const map = params.isLocalStorage ? registered.local : registered.session;
  map.clear();
  const items = params.storageMap;
  if (items !== null && typeof items === 'object') for (const key of Object.keys(items)) map.set(`${key}`, `${items[key]}`);
}

function items(params) {
  const id = params && params.storageId;
  if (id === null || typeof id !== 'object' || typeof id.isLocalStorage !== 'boolean') throw protocolError(-32602, 'Invalid parameters');
  const storage = require('internal/web/storage');
  const made = storage.created[id.isLocalStorage ? 'localStorage' : 'sessionStorage'];
  if (made !== undefined) return { entries: storage.entries(made) };
  return { entries: [...(id.isLocalStorage ? registered.local : registered.session)] };
}

function dispatch(session, method, params) {
  if (!enabled()) unsupported(method);
  switch (method) {
    case 'DOMStorage.enable': session.domStorageEnabled = true; return {};
    case 'DOMStorage.disable': session.domStorageEnabled = false; return {};
    case 'DOMStorage.getDOMStorageItems': return items(params);
    case 'Storage.getStorageKey': return { storageKey: storageKey() };
    default: unsupported(method);
  }
}

module.exports = { dispatch, register, storageId };
