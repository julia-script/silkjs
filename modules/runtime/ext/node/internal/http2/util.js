'use strict';
const { Buffer } = require('buffer');
const host = require('internal/host');
const sensitiveHeaders = Symbol('nodejs.http2.sensitiveHeaders');
const settingsIds = { headerTableSize: 1, enablePush: 2, maxConcurrentStreams: 3, initialWindowSize: 4, maxFrameSize: 5, maxHeaderListSize: 6, enableConnectProtocol: 8 };
function error(code, message, Type = Error) { return Object.assign(new Type(message), { code }); }
function bytes(value) { if (value instanceof ArrayBuffer) return value; if (!ArrayBuffer.isView(value)) throw error('ERR_INVALID_ARG_TYPE', 'Expected a buffer', TypeError); return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); }
function native(op, ...args) { return host.http2(op, args.map(v => ArrayBuffer.isView(v) ? bytes(v) : v)); }
function integer(value, name, min = 0, max = 0xffffffff) { if (!Number.isInteger(value) || value < min || value > max) throw error('ERR_OUT_OF_RANGE', name + ' is out of range', RangeError); return value; }
function settingsEntries(settings = {}) {
  const entries = [];
  for (const name of Object.keys(settingsIds)) {
    if (settings[name] === undefined) continue;
    let value = settings[name];
    if (name === 'enablePush' || name === 'enableConnectProtocol') { if (typeof value !== 'boolean') throw error('ERR_INVALID_ARG_TYPE', name + ' must be boolean', TypeError); value = +value; }
    else integer(value, name, name === 'maxFrameSize' ? 16384 : 0, name === 'maxFrameSize' ? 16777215 : name === 'initialWindowSize' ? 2147483647 : 0xffffffff);
    entries.push([settingsIds[name], value]);
  }
  if (settings.maxHeaderSize !== undefined && settings.maxHeaderListSize === undefined) entries.push([6, integer(settings.maxHeaderSize, 'maxHeaderSize')]);
  if (settings.customSettings) for (const key of Object.keys(settings.customSettings)) entries.push([integer(+key, 'setting id', 1, 65535), integer(settings.customSettings[key], key)]);
  return entries;
}
function packSettings(settings, nativeFormat = false) { const entries = settingsEntries(settings); const out = Buffer.alloc(entries.length * (nativeFormat ? 8 : 6)); let i = 0; for (const [id, value] of entries) { if (nativeFormat) { out.writeInt32LE(id, i); out.writeUInt32LE(value, i + 4); i += 8; } else { out.writeUInt16BE(id, i); out.writeUInt32BE(value, i + 2); i += 6; } } return out; }
function unpackSettings(buffer, options = {}) { const b = Buffer.from(buffer); if (b.length % 6) throw error('ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six', RangeError); const out = {}; for (let i = 0; i < b.length; i += 6) { const id = b.readUInt16BE(i), value = b.readUInt32BE(i + 2); const key = Object.keys(settingsIds).find(k => settingsIds[k] === id); if (key) out[key] = key === 'enablePush' || key === 'enableConnectProtocol' ? !!value : value; } if (options.validate) settingsEntries(out); return out; }
function readSettings(id, remote) { const out = {}; for (const name of Object.keys(settingsIds)) { const value = native(remote ? 'remoteSetting' : 'localSetting', id, settingsIds[name]); out[name] = name === 'enablePush' || name === 'enableConnectProtocol' ? !!value : value; } out.maxHeaderSize = out.maxHeaderListSize; return out; }
function packOptions(options, server = false) {
  const names = ['maxDeflateDynamicTableSize', 'maxReservedRemoteStreams', 'maxSendHeaderBlockLength', 'peerMaxConcurrentStreams', 'maxSettings'];
  const packed = Buffer.alloc(60);
  let flags = 0;
  for (let index = 0; index < names.length; index++) {
    const value = options[names[index]];
    if (typeof value !== 'number') continue;
    flags |= 1 << index;
    packed.writeUInt32LE((index === 4 ? Math.max(1, value) : value) >>> 0, 4 + index * 4);
  }
  packed.writeUInt32LE(flags, 0);
  const memory = typeof options.maxSessionMemory === 'number' ? Math.max(1, options.maxSessionMemory) * 1000000 : 10000000;
  packed.writeUInt32LE(memory >>> 0, 24); packed.writeUInt32LE(Math.floor(memory / 4294967296) >>> 0, 56);
  packed.writeUInt32LE(typeof options.maxHeaderListPairs === 'number' ? Math.max(server ? 4 : 1, options.maxHeaderListPairs >>> 0) : 128, 28);
  packed.writeUInt32LE(typeof options.paddingStrategy === 'number' ? options.paddingStrategy >>> 0 : 0, 32);
  packed.writeUInt32LE(options.maxSessionInvalidFrames ?? 1000, 36);
  packed.writeUInt32LE(options.maxSessionRejectedStreams ?? 100, 40);
  if (typeof options.streamResetBurst === 'number' && typeof options.streamResetRate === 'number') {
    packed.writeUInt32LE(Math.max(1, options.streamResetBurst) >>> 0, 44);
    packed.writeUInt32LE(Math.max(1, options.streamResetRate) >>> 0, 48);
    packed.writeUInt32LE(1, 52);
  }
  return packed;
}
function validateOptions(options, session = false) {
  for (const name of ['maxSessionInvalidFrames', 'maxSessionRejectedStreams']) {
    if (options[name] === undefined) continue;
    if (typeof options[name] !== 'number') throw error('ERR_INVALID_ARG_TYPE', 'options.' + name + ' must be a number', TypeError);
    integer(options[name], 'options.' + name);
  }
  if (options.remoteCustomSettings !== undefined) {
    if (!Array.isArray(options.remoteCustomSettings)) throw error('ERR_INVALID_ARG_TYPE', 'options.remoteCustomSettings must be an array', TypeError);
    if (options.remoteCustomSettings.length > 10) throw error('ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS', 'Too many custom settings');
    if (session) for (const id of options.remoteCustomSettings) if (typeof id !== 'number' || !Number.isFinite(id) || id < 0 || id > 65535) throw error('ERR_HTTP2_INVALID_SETTING_VALUE', 'Invalid custom setting identifier');
  }
}
const forbidden = new Set(['connection', 'upgrade', 'keep-alive', 'proxy-connection', 'transfer-encoding']);
function headers(input, kind = 'request') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('ERR_INVALID_ARG_TYPE', 'headers must be an object', TypeError);
  const parts = [], sensitive = input[sensitiveHeaders] || [];
  const names = Object.keys(input).sort((a, b) => (a[0] === ':' ? 0 : 1) - (b[0] === ':' ? 0 : 1));
  for (const original of names) {
    const name = original.toLowerCase();
    if (forbidden.has(name)) throw error('ERR_HTTP2_INVALID_CONNECTION_HEADERS', 'HTTP/1 connection header is forbidden: ' + name);
    if (!/^:?[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw error('ERR_INVALID_HTTP_TOKEN', 'Invalid header name: ' + name, TypeError);
    if (name[0] === ':' && (kind === 'trailers' || !(kind === 'response' ? [':status'] : [':method', ':scheme', ':authority', ':path', ':protocol']).includes(name))) throw error('ERR_HTTP2_INVALID_PSEUDOHEADER', 'Invalid pseudoheader: ' + name, TypeError);
    if (input[original] === undefined) continue;
    const values = Array.isArray(input[original]) ? input[original] : [input[original]];
    if (name[0] === ':' && values.length !== 1) throw error('ERR_HTTP2_HEADER_SINGLE_VALUE', 'Pseudoheader requires one value', TypeError);
    for (const value of values) {
      const text = String(value);
      if (/[\0\r\n]/.test(text)) throw error('ERR_INVALID_CHAR', 'Invalid header value', TypeError);
      if (name === 'te' && text !== 'trailers') throw error('ERR_HTTP2_INVALID_CONNECTION_HEADERS', 'Only te: trailers is allowed');
      const n = Buffer.from(name), v = Buffer.from(text), h = Buffer.alloc(12);
      h.writeUInt32LE(n.length, 0); h.writeUInt32LE(v.length, 4); h.writeUInt32LE(sensitive.includes(name) ? 1 : 0, 8); parts.push(h, n, v);
    }
  }
  return Buffer.concat(parts);
}
function addHeader(target, raw, name, value, sensitive) { raw.push(name, value); if (name === 'set-cookie') (target[name] ||= []).push(value); else if (target[name] === undefined) target[name] = name === ':status' ? +value : value; else target[name] += (name === 'cookie' ? '; ' : ', ') + value; if (sensitive) (target[sensitiveHeaders] ||= []).push(name); }
module.exports = { native, bytes, error, integer, headers, addHeader, packSettings, unpackSettings, readSettings, packOptions, validateOptions, settingsEntries, sensitiveHeaders };
