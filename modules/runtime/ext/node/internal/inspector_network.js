'use strict';

const host = require('internal/host');
const { Buffer } = require('buffer');
const { protocolError, unsupported } = require('internal/inspector_values');
const { validateString } = require('internal/validators');
const resources = new Map();
let nextStream = 1;
function put(url, data) {
  if (!host.experimentalInspectorNetworkResource) {
    process.emitWarning('The --experimental-inspector-network-resource option is not enabled. Please enable it to use the putNetworkResource function');
    return;
  }
  validateString(url, 'url');
  validateString(data, 'data');
  resources.set(url, Buffer.from(data));
}
// With --experimental-network-inspection, http, http2 and fetch report to the Network domain
// while a session has it enabled (Node's inspector_network_tracking).
const tracking = new Set();
function track(session, enabled) {
  session.networkEnabled = enabled;
  if (!enabled) { session.requests = undefined; session.bufferedBytes = 0; }
  if (!host.experimentalNetworkInspection) return;
  const before = tracking.size;
  if (enabled) tracking.add(session); else tracking.delete(session);
  if (before === 0 && tracking.size === 1) require('internal/inspector_network_tracking').enable();
  else if (before === 1 && tracking.size === 0) require('internal/inspector_network_tracking').disable();
}
// As Node's NetworkAgent, a session keeps the bodies of the requests it saw:
// dataSent and dataReceived are buffered, not sent, until a command asks for
// them, or streamResourceContent turns a response into dataReceived events.
const DEFAULT_TOTAL_BUFFER = 100 * 1024 * 1024;
const DEFAULT_RESOURCE_BUFFER = 10 * 1024 * 1024;
function chunk(data) {
  if (typeof data === 'string') return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}
function textCharset(charset) { return typeof charset === 'string' && charset.toLowerCase().replace('-', '') === 'utf8'; }
function evict(session) {
  for (const [id, request] of session.requests) {
    if (session.bufferedBytes <= session.maxTotalBuffer) return;
    session.bufferedBytes -= request.bytes;
    session.requests.delete(id);
  }
}
function append(session, request, list, data) {
  const bytes = chunk(data);
  if (!bytes || request.bytes + bytes.length > session.maxResourceBuffer) return undefined;
  list.push(bytes);
  request.bytes += bytes.length;
  session.bufferedBytes += bytes.length;
  evict(session);
  return bytes;
}
function observe(session, method, params) {
  const requests = session.requests ??= new Map();
  const request = requests.get(params.requestId);
  switch (method) {
    case 'Network.requestWillBeSent':
      requests.delete(params.requestId);
      requests.set(params.requestId, { requestCharset: params.charset, sent: [], received: [], responseCharset: undefined, streaming: false, bytes: 0 });
      return params;
    case 'Network.responseReceived':
      if (request) request.responseCharset = params.response && params.response.charset;
      return params;
    case 'Network.dataSent':
      if (request && params.data !== undefined) append(session, request, request.sent, params.data);
      return undefined;
    case 'Network.dataReceived': {
      if (!request) return undefined;
      const bytes = append(session, request, request.received, params.data);
      if (!request.streaming) return undefined;
      const { data, ...rest } = params;
      return bytes ? { ...rest, data: bytes.toString('base64') } : rest;
    }
    default: return params;
  }
}
function requestFor(session, params) {
  if (params === null || typeof params !== 'object' || typeof params.requestId !== 'string') throw protocolError(-32602, 'Invalid parameters: requestId');
  const request = session.requests && session.requests.get(params.requestId);
  if (!request) throw protocolError(-32602, 'Request not found');
  return request;
}
function dispatch(session, method, params) {
  switch (method) {
    case 'Network.enable':
      session.maxTotalBuffer = Number.isSafeInteger(params.maxTotalBufferSize) && params.maxTotalBufferSize >= 0 ? params.maxTotalBufferSize : DEFAULT_TOTAL_BUFFER;
      session.maxResourceBuffer = Number.isSafeInteger(params.maxResourceBufferSize) && params.maxResourceBufferSize >= 0 ? params.maxResourceBufferSize : DEFAULT_RESOURCE_BUFFER;
      session.bufferedBytes ??= 0;
      track(session, true);
      return {};
    case 'Network.getRequestPostData': {
      const request = requestFor(session, params);
      if (!textCharset(request.requestCharset)) throw protocolError(-32000, 'Unable to get request post data: only UTF-8 text is supported');
      return { postData: Buffer.concat(request.sent).toString('utf8') };
    }
    case 'Network.getResponseBody': {
      const request = requestFor(session, params);
      const body = Buffer.concat(request.received);
      return textCharset(request.responseCharset) ? { body: body.toString('utf8'), base64Encoded: false } : { body: body.toString('base64'), base64Encoded: true };
    }
    case 'Network.streamResourceContent': {
      const request = requestFor(session, params);
      request.streaming = true;
      return { bufferedData: Buffer.concat(request.received).toString('base64') };
    }
    case 'Network.disable': track(session, false); return {};
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
function close(session) { track(session, false); if (session.resourceStreams) session.resourceStreams.clear(); }
module.exports = { put, dispatch, observe, close };
