'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const ids = new WeakMap();
const finalizers = new FinalizationRegistry(id => host.crypto('release', [id]));
function error(code, message, Type = Error) { const e = new Type(message); e.code = code; return e; }
function invalid(name, type) { return error('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${type}`, TypeError); }
function integer(n, name, min = 0, max = 0x7fffffff) { if (typeof n !== 'number') throw invalid(name, 'a number'); if (!Number.isSafeInteger(n) || n < min || n > max) throw error('ERR_OUT_OF_RANGE', `${name} is out of range`, RangeError); return n; }
function callback(cb) { if (typeof cb !== 'function') throw invalid('callback', 'a function'); return cb; }
function bytes(value, encoding, name = 'data') {
  if (typeof value === 'string') return Buffer.from(value, encoding);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return Buffer.from(value);
  throw invalid(name, 'a string, ArrayBuffer, Buffer, TypedArray, or DataView');
}
function binary(value, name = 'buffer') { if (typeof value === 'string') throw invalid(name, 'an ArrayBuffer or ArrayBufferView'); return bytes(value, undefined, name); }
function packed(value) { const b = bytes(value); return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && !(typeof SharedArrayBuffer !== 'undefined' && b.buffer instanceof SharedArrayBuffer) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function normalize(e) {
  if (!(e instanceof Error)) e = new Error(String(e));
  const match = /^(ERR_[A-Z0-9_]+):\s*/.exec(e.message);
  if (match) { e.code = match[1]; e.message = e.message.slice(match[0].length); }
  else if (!e.code) e.code = 'ERR_OSSL_CRYPTO_OPERATION_FAILED';
  const openssl = /^error:([0-9a-f]+):([^:]*):[^:]*:(.*)$/i.exec(e.message);
  if (openssl) { e.library = openssl[2]; e.reason = openssl[3]; e.opensslErrorStack = [e.message]; const reason = openssl[3].toUpperCase().replace(/[^A-Z0-9]+/g, '_'); if (reason) e.code = `ERR_OSSL_${reason}`; }
  return e;
}
function call(op, args) { try { return host.crypto(op, args); } catch (e) { throw normalize(e); } }
function submit(op, args, cb, convert = x => x) {
  callback(cb);
  const { AsyncResource } = require('async_hooks');
  const resource = new AsyncResource(`${op.toUpperCase()}REQUEST`, { requireManualDestroy: true });
  try {
    host.cryptoAsync(op, args, (err, value) => {
      host.invokeResource(resource, () => {
        if (err != null) { cb(normalize(err)); return; }
        let result; try { result = convert(value); } catch (e) { cb(e); return; }
        cb(null, result);
      }, undefined, []);
      host.checkpoint();
    });
  } catch (e) { resource.emitDestroy(); throw normalize(e); }
}
function output(value, encoding) { const b = Buffer.from(value); return encoding && encoding !== 'buffer' ? b.toString(encoding) : b; }
function attach(object, id) { try { ids.set(object, id); finalizers.register(object, id, object); } catch (e) { call('release', [id]); throw e; } return object; }
function handle(object) { const id = ids.get(object); if (id === undefined) throw error('ERR_CRYPTO_INVALID_STATE', 'Crypto object has been finalized'); return id; }
function release(object) { const id = ids.get(object); if (id !== undefined) { ids.delete(object); finalizers.unregister(object); call('release', [id]); } }
function name(value, field = 'algorithm') { if (typeof value !== 'string') throw invalid(field, 'a string'); if (value.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', `${field} must not contain null bytes`, TypeError); return value; }
module.exports = { Buffer, error, invalid, integer, callback, bytes, binary, packed, normalize, call, submit, output, attach, handle, release, name };
