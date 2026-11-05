'use strict';

const { Blob, File } = require('internal/web/blob');
const { Buffer } = require('buffer');
const { TextDecoder } = require('internal/web/encoding');
const { scalar, token } = require('internal/web/fetch/headers');
const states = new WeakMap();
function entries(form) {
  const value = states.get(form);
  if (!value) throw new TypeError('Illegal FormData invocation');
  return value;
}
function entry(name, value, filename, hasFilename) {
  name = scalar(name);
  if (hasFilename && !(value instanceof Blob)) throw new TypeError('FormData value must be a Blob when a filename is supplied');
  if (value instanceof Blob) {
    if (!(value instanceof File) || hasFilename) value = new File([value], hasFilename ? scalar(filename) : 'blob', { type: value.type, lastModified: value instanceof File ? value.lastModified : Date.now() });
  } else value = scalar(value);
  return [name, value];
}
class FormData {
  constructor(form) {
    if (form !== undefined) throw new TypeError('FormData constructor does not accept a form in Node.js');
    states.set(this, []);
  }
  append(name, value, filename) {
    if (arguments.length < 2) throw new TypeError('FormData.append requires two arguments');
    entries(this).push(entry(name, value, filename, filename !== undefined));
  }
  delete(name) {
    if (!arguments.length) throw new TypeError('FormData.delete requires an argument');
    name = scalar(name); states.set(this, entries(this).filter(pair => pair[0] !== name));
  }
  get(name) {
    if (!arguments.length) throw new TypeError('FormData.get requires an argument');
    name = scalar(name); const pair = entries(this).find(pair => pair[0] === name); return pair ? pair[1] : null;
  }
  getAll(name) {
    if (!arguments.length) throw new TypeError('FormData.getAll requires an argument');
    name = scalar(name); return entries(this).filter(pair => pair[0] === name).map(pair => pair[1]);
  }
  has(name) {
    if (!arguments.length) throw new TypeError('FormData.has requires an argument');
    name = scalar(name); return entries(this).some(pair => pair[0] === name);
  }
  set(name, value, filename) {
    if (arguments.length < 2) throw new TypeError('FormData.set requires two arguments');
    const pair = entry(name, value, filename, filename !== undefined);
    const list = entries(this); const index = list.findIndex(item => item[0] === pair[0]);
    if (index < 0) list.push(pair);
    else { list[index] = pair; states.set(this, list.filter((item, i) => i <= index || item[0] !== pair[0])); }
  }
  *entries() { entries(this); for (let i = 0; i < entries(this).length; i++) yield entries(this)[i].slice(); }
  *keys() { for (const [name] of this.entries()) yield name; }
  *values() { for (const [, value] of this.entries()) yield value; }
  forEach(callback, thisArg) {
    entries(this);
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this);
  }
  [Symbol.iterator]() { return this.entries(); }
}
const newlines = value => value.replace(/\r\n|\r|\n/g, '\r\n');
const escape = value => newlines(value).replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
function encodeForm(form) {
  const boundary = '----silk-formdata-' + require('crypto').randomBytes(18).toString('hex');
  const parts = [];
  for (const [name, value] of entries(form)) {
    const prefix = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + escape(name) + '"';
    if (typeof value === 'string') parts.push(prefix + '\r\n\r\n' + newlines(value) + '\r\n');
    else parts.push(prefix + '; filename="' + escape(value.name) + '"\r\nContent-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n', value, '\r\n');
  }
  parts.push('--' + boundary + '--\r\n');
  return new Blob(parts, { type: 'multipart/form-data; boundary=' + boundary });
}
// MIME parameters use quoted-string parsing, not splitting on semicolons: a
// filename and even a boundary may legally contain a semicolon.
function parseMIME(value) {
  if (!value) return null;
  const end = value.indexOf(';');
  const essence = (end < 0 ? value : value.slice(0, end)).trim().toLowerCase();
  const parameters = new Map();
  let i = end < 0 ? value.length : end;
  while (i < value.length) {
    i++;
    while (/[\t ]/.test(value[i] || '') && i < value.length) i++;
    const start = i;
    while (i < value.length && value[i] !== '=' && value[i] !== ';') i++;
    const name = value.slice(start, i).trim().toLowerCase();
    if (value[i] !== '=') continue;
    i++; let content = '';
    if (value[i] === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === '\\' && i + 1 < value.length) i++;
        content += value[i++];
      }
      if (value[i] === '"') i++;
      while (i < value.length && value[i] !== ';') i++;
    } else {
      const first = i;
      while (i < value.length && value[i] !== ';') i++;
      content = value.slice(first, i).replace(/[\t ]+$/, '');
    }
    if (token.test(name) && !parameters.has(name)) parameters.set(name, content);
  }
  return { essence, parameters };
}
function parseForm(bytes, type) {
  const mime = parseMIME(type);
  const result = new FormData();
  if (mime?.essence === 'application/x-www-form-urlencoded') {
    const { URLSearchParams } = require('internal/web/url');
    for (const [name, value] of new URLSearchParams(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes))) result.append(name, value);
    return result;
  }
  if (mime?.essence !== 'multipart/form-data') throw new TypeError('Content-Type was not multipart/form-data or application/x-www-form-urlencoded');
  const boundary = mime.parameters.get('boundary');
  if (!boundary || /[\r\n\0]/.test(boundary)) throw new TypeError('Invalid multipart boundary');
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const delimiter = Buffer.from('--' + boundary);
  const separator = Buffer.from('\r\n--' + boundary);
  const crlf = Buffer.from('\r\n');
  let position = input.indexOf(delimiter);
  const fail = () => { throw new TypeError('Failed to parse multipart form data'); };
  if (position < 0) fail();
  for (;;) {
    position += delimiter.length;
    if (input[position] === 45 && input[position + 1] === 45) return result;
    if (input[position] !== 13 || input[position + 1] !== 10) fail();
    position += 2;
    const headerEnd = input.indexOf(Buffer.from('\r\n\r\n'), position);
    if (headerEnd < 0) fail();
    const headers = new Map();
    while (position < headerEnd) {
      const lineEnd = input.indexOf(crlf, position);
      if (lineEnd < 0 || lineEnd > headerEnd) fail();
      const line = input.subarray(position, lineEnd).toString('utf8');
      const colon = line.indexOf(':');
      if (colon < 1 || !token.test(line.slice(0, colon))) fail();
      const name = line.slice(0, colon).toLowerCase();
      if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
      position = lineEnd + 2;
    }
    position = headerEnd + 4;
    let next = input.indexOf(separator, position);
    while (next >= 0) {
      const after = next + separator.length;
      if ((input[after] === 45 && input[after + 1] === 45) || (input[after] === 13 && input[after + 1] === 10)) break;
      next = input.indexOf(separator, next + 1);
    }
    if (next < 0) fail();
    const disposition = parseMIME(headers.get('content-disposition'));
    if (disposition?.essence !== 'form-data' || !disposition.parameters.has('name')) fail();
    const name = disposition.parameters.get('name');
    let body = input.subarray(position, next);
    if (headers.get('content-transfer-encoding')?.toLowerCase() === 'base64') body = Buffer.from(body.toString('ascii'), 'base64');
    if (disposition.parameters.has('filename')) {
      const filename = disposition.parameters.get('filename').replace(/^.*[\\/]/, '');
      result.append(name, new File([body], filename, { type: headers.get('content-type') || 'text/plain' }));
    } else result.append(name, new TextDecoder('utf-8', { ignoreBOM: true }).decode(body));
    position = next + 2;
  }
}
module.exports = { FormData, encodeForm, parseForm, parseMIME };
