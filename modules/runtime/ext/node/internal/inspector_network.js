'use strict';

const host = require('internal/host');
const { Buffer } = require('buffer');
const { protocolError, unsupported } = require('internal/inspector_values');
const resources = new Map();
let nextStream = 1;
function put(url, data) {
  if (!host.experimentalInspectorNetworkResource) {
    process.emitWarning('The --experimental-inspector-network-resource option is not enabled. Please enable it to use the putNetworkResource function');
    return;
  }
  for (const [name, value] of [['url', url], ['data', data]]) if (typeof value !== 'string') {
    const error = new TypeError(`The "${name}" argument must be of type string`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  resources.set(url, Buffer.from(data));
}
function dispatch(session, method, params) {
  switch (method) {
    case 'Network.enable': session.networkEnabled = true; return {};
    case 'Network.disable': session.networkEnabled = false; return {};
    case 'Network.loadNetworkResource': {
      if (!host.experimentalInspectorNetworkResource) throw protocolError(-32000, 'Network resource loading is not enabled. This feature is experimental and requires --experimental-inspector-network-resource flag to be set.');
      if (typeof params.url !== 'string') throw protocolError(-32602, 'Invalid parameters: url');
      const data = resources.get(params.url);
      if (!data) return { resource: { success: false, netError: -6, netErrorName: 'ERR_FILE_NOT_FOUND', httpStatusCode: 404 } };
      if (!session.resourceStreams) session.resourceStreams = new Map();
      const stream = `silk:resource:${nextStream++}`;
      session.resourceStreams.set(stream, { data, offset: 0 });
      return { resource: { success: true, httpStatusCode: 200, stream, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(data.length) } } };
    }
    case 'IO.read': {
      const stream = session.resourceStreams && session.resourceStreams.get(params.handle);
      if (!stream) throw protocolError(-32000, 'Invalid stream handle');
      const offset = params.offset === undefined ? stream.offset : params.offset;
      const size = params.size === undefined ? 65536 : params.size;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0) throw protocolError(-32602, 'Invalid parameters');
      const end = Math.min(stream.data.length, offset + size);
      const data = stream.data.subarray(Math.min(offset, stream.data.length), end).toString('base64');
      stream.offset = end;
      return { data, base64Encoded: true, eof: end >= stream.data.length };
    }
    case 'IO.close':
      if (!session.resourceStreams || !session.resourceStreams.delete(params.handle)) throw protocolError(-32000, 'Invalid stream handle');
      return {};
    default: unsupported(method);
  }
}
function close(session) { if (session.resourceStreams) session.resourceStreams.clear(); }
module.exports = { put, dispatch, close };
