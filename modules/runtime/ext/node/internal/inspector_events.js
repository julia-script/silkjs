'use strict';

// The checks Node's protocol event conversion makes (src/inspector/
// network_agent.cc and dom_storage_agent.cc) before an event from
// inspector.Network or inspector.DOMStorage reaches a frontend.
const { isUint8Array } = require('util').types;

const S = 'string', N = 'number', O = 'object', B = 'boolean', H = 'headers', D = 'data', ID = 'storageId';
const shapes = {
  'Network.requestWillBeSent': [['requestId', S], ['timestamp', N], ['wallTime', N], ['request', O, [['url', S], ['method', S], ['headers', H]]]],
  'Network.responseReceived': [['requestId', S], ['timestamp', N], ['type', S], ['response', O, [['url', S], ['status', N], ['statusText', S], ['headers', H]]]],
  'Network.loadingFailed': [['requestId', S], ['timestamp', N], ['type', S], ['errorText', S]],
  'Network.loadingFinished': [['requestId', S], ['timestamp', N]],
  'Network.webSocketCreated': [['requestId', S], ['url', S]],
  'Network.webSocketClosed': [['requestId', S], ['timestamp', N]],
  'Network.webSocketHandshakeResponseReceived': [['requestId', S], ['timestamp', N], ['response', O, [['status', N], ['statusText', S], ['headers', H]]]],
  'Network.dataReceived': [['requestId', S], ['timestamp', N], ['dataLength', N], ['encodedDataLength', N], ['data', D]],
  'DOMStorage.domStorageItemAdded': [['storageId', ID], ['key', S], ['newValue', S]],
  'DOMStorage.domStorageItemRemoved': [['storageId', ID], ['key', S]],
  'DOMStorage.domStorageItemUpdated': [['storageId', ID], ['key', S], ['oldValue', S], ['newValue', S]],
  'DOMStorage.domStorageItemsCleared': [['storageId', ID]],
  'DOMStorage.registerStorage': [['isLocalStorage', B], ['storageMap', O]],
};
const storageIdShape = [['securityOrigin', S], ['isLocalStorage', B], ['storageKey', S]];

function fail(message) { throw new Error(message); }
function check(value, fields, prefix, where) {
  for (const [name, type, nested] of fields) {
    const field = value[name];
    const label = prefix + name;
    if (type === D) {
      if (field === undefined) fail(`Missing ${label} in ${where}`);
      if (!isUint8Array(field)) fail(`Expected ${label} to be Uint8Array in ${where}`);
      continue;
    }
    if (type === ID) {
      if (field === null || typeof field !== 'object') fail(`Missing ${label} in ${where}`);
      check(field, storageIdShape, '', 'storageId');
      continue;
    }
    if (type === H) {
      if (field === null || typeof field !== 'object') fail(`Missing ${label} in ${where}`);
      for (const key of Object.keys(field)) if (typeof field[key] !== 'string') fail(`Invalid header value in ${where}`);
      continue;
    }
    if (typeof field !== type || field === null) fail(`Missing ${label} in ${where}`);
    if (nested) check(field, nested, label + '.', where);
  }
}

// Returns the event's storage items for registerStorage.
function validate(method, params) {
  if (method === 'Network.dataSent') {
    if (typeof params.requestId !== 'string') fail('Missing requestId in event');
    if (params.finished === true) return;
    check(params, [['timestamp', N], ['dataLength', N], ['data', D]], '', 'event');
    return;
  }
  const shape = shapes[method];
  if (shape) check(params, shape, '', 'event');
  if (method !== 'DOMStorage.registerStorage') return;
  const map = params.storageMap;
  let keys;
  try { keys = Object.keys(map); }
  catch { fail('Failed to get property names from storageMap'); }
  const entries = [];
  for (const key of keys) {
    let value;
    try { value = map[key]; } catch { fail('Failed to get value from storageMap'); }
    entries.push([key, `${value}`]);
  }
  return entries;
}

module.exports = { validate };
