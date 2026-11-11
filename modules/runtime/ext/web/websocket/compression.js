'use strict';

const { Buffer } = require('buffer');
const constants = require('internal/compression/constants');
const { failure, MAX_MESSAGE } = require('internal/web/websocket/framing');
const tail = Buffer.from([0, 0, 255, 255]);
const offer = 'permessage-deflate; client_max_window_bits';
function negotiate(value) {
  if (value === undefined) return null;
  // This offer contains exactly one extension; duplicate extensions, unknown
  // parameters and duplicate parameters must never silently change the codec.
  const pieces = value.split(';').map(part => part.trim());
  if (pieces.shift() !== 'permessage-deflate') throw failure('Unrequested WebSocket extension');
  const parameters = new Map();
  for (const piece of pieces) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s*=\s*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"([!#$%&'*+.^_`|~0-9A-Za-z-]+)"))?$/.exec(piece);
    if (!match || parameters.has(match[1])) throw failure('Invalid WebSocket extension parameters');
    const name = match[1], parameter = match[2] ?? match[3];
    if (name === 'server_no_context_takeover' || name === 'client_no_context_takeover') {
      if (parameter !== undefined) throw failure('Invalid context takeover parameter');
    } else if (name === 'server_max_window_bits' || name === 'client_max_window_bits') {
      if (!/^(?:[89]|1[0-5])$/.test(parameter || '')) throw failure('Invalid compression window size');
    } else throw failure('Unknown WebSocket extension parameter');
    parameters.set(name, parameter);
  }
  return { windowBits: Number(parameters.get('server_max_window_bits') || 15), noContext: parameters.has('server_no_context_takeover') };
}
class Inflater {
  constructor(options) {
    this.options = options;
    this.engine = null;
    this.callback = null;
    this.parts = [];
    this.length = 0;
    this.closed = false;
  }
  decode(payload, callback) {
    this.callback = callback;
    this.parts = [];
    this.length = 0;
    try {
      if (!this.engine) {
        const engine = this.engine = require('zlib').createInflateRaw({ windowBits: this.options.windowBits });
        engine.on('data', part => {
          if (!this.callback) return;
          this.length += part.length;
          if (this.length > MAX_MESSAGE) { this.fail(failure('Expanded WebSocket message is too large', 1009)); return; }
          this.parts.push(part);
        });
        engine.on('error', error => this.fail(failure('Invalid compressed WebSocket message: ' + error.message, 1007)));
        engine.on('end', () => this.fail(failure('Unexpected final DEFLATE block in WebSocket message', 1007)));
      }
      const engine = this.engine;
      const expectedBytes = engine.bytesWritten + payload.length + tail.length;
      engine.write(payload);
      engine.write(tail);
      engine.flush(constants.Z_SYNC_FLUSH, () => {
        if (!this.callback || this.closed) return;
        if (engine.bytesWritten !== expectedBytes) {
          this.fail(failure('Trailing or prematurely terminated WebSocket DEFLATE data', 1007));
          return;
        }
        const callback = this.callback;
        const output = Buffer.concat(this.parts, this.length);
        this.callback = null;
        this.parts = [];
        this.length = 0;
        if (this.options.noContext) { this.engine = null; engine.destroy(); }
        callback(null, output);
      });
    } catch (error) { this.fail(failure('WebSocket decompression failed: ' + error.message, 1007)); }
  }
  fail(error) {
    const callback = this.callback;
    this.callback = null;
    this.close();
    if (callback) callback(error);
  }
  close() {
    this.closed = true;
    this.callback = null;
    this.parts = [];
    this.engine?.destroy();
    this.engine = null;
  }
}
module.exports = { offer, negotiate, Inflater };
