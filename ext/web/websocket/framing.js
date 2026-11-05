'use strict';

const { Buffer } = require('buffer');
const { randomBytes } = require('crypto');
// Bound both compressed wire messages and expanded messages before allocation.
const MAX_MESSAGE = 64 * 1024 * 1024;
function failure(message, closeCode = 1002) {
  const error = new Error(message);
  error.closeCode = closeCode;
  return error;
}
function validCloseCode(code) {
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3000 && code <= 4999;
}
function decodeText(bytes) {
  // RFC 3629: no overlong sequences, surrogates, stray continuations or values
  // beyond U+10FFFF. Validation spans the complete reassembled message.
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first < 0x80) continue;
    let remaining, low = 0x80, high = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) remaining = 1;
    else if (first >= 0xe0 && first <= 0xef) {
      remaining = 2;
      if (first === 0xe0) low = 0xa0;
      if (first === 0xed) high = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      remaining = 3;
      if (first === 0xf0) low = 0x90;
      if (first === 0xf4) high = 0x8f;
    } else throw failure('Invalid UTF-8 in WebSocket message', 1007);
    if (i + remaining > bytes.length || bytes[i] < low || bytes[i] > high) throw failure('Invalid UTF-8 in WebSocket message', 1007);
    i++;
    while (--remaining) {
      if (bytes[i] < 0x80 || bytes[i] > 0xbf) throw failure('Invalid UTF-8 in WebSocket message', 1007);
      i++;
    }
  }
  return bytes.toString('utf8');
}
function frame(opcode, payload) {
  const size = payload.length;
  const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8;
  const output = Buffer.allocUnsafe(6 + extra + size);
  output[0] = 0x80 | opcode;
  output[1] = 0x80 | (extra === 0 ? size : extra === 2 ? 126 : 127);
  if (extra === 2) output.writeUInt16BE(size, 2);
  else if (extra === 8) {
    output.writeUInt32BE(Math.floor(size / 4294967296), 2);
    output.writeUInt32BE(size >>> 0, 6);
  }
  const mask = randomBytes(4);
  output.set(mask, 2 + extra);
  const start = 6 + extra;
  for (let i = 0; i < size; i++) output[start + i] = payload[i] ^ mask[i & 3];
  return output;
}
class Receiver {
  constructor(callbacks, compression) {
    this.callbacks = callbacks;
    this.compression = compression;
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.available = 0;
    this.pending = null;
    this.fragments = [];
    this.messageLength = 0;
    this.opcode = 0;
    this.compressed = false;
    this.paused = false;
    this.stopped = false;
    this.running = false;
  }
  stop() {
    this.stopped = true;
    this.chunks = [];
    this.fragments = [];
    this.available = 0;
    this.pending = null;
    this.compression?.close();
  }
  feed(chunk) {
    if (this.stopped || !chunk.length) return;
    this.chunks.push(chunk);
    this.available += chunk.length;
    if (this.available > MAX_MESSAGE + 14) { this.fail(failure('WebSocket receive buffer exceeded', 1009)); return; }
    this.run();
  }
  byte(index) {
    index += this.offset;
    for (let i = this.head; i < this.chunks.length; i++) {
      if (index < this.chunks[i].length) return this.chunks[i][index];
      index -= this.chunks[i].length;
    }
  }
  take(length) {
    if (!length) return Buffer.alloc(0);
    const first = this.chunks[this.head];
    let result;
    if (length <= first.length - this.offset) {
      result = first.subarray(this.offset, this.offset + length);
      this.offset += length;
      if (this.offset === first.length) { this.chunks[this.head++] = null; this.offset = 0; }
    } else {
      result = Buffer.allocUnsafe(length);
      let written = 0;
      while (written < length) {
        const chunk = this.chunks[this.head];
        const size = Math.min(length - written, chunk.length - this.offset);
        result.set(chunk.subarray(this.offset, this.offset + size), written);
        written += size;
        this.offset += size;
        if (this.offset === chunk.length) { this.chunks[this.head++] = null; this.offset = 0; }
      }
    }
    this.available -= length;
    if (this.head === this.chunks.length) { this.chunks = []; this.head = 0; }
    else if (this.head > 128 && this.head * 2 > this.chunks.length) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
    return result;
  }
  fail(error) {
    this.stop();
    this.callbacks.error(error);
  }
  run() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && !this.paused) {
        if (!this.pending) {
          if (this.available < 2) break;
          const first = this.byte(0), second = this.byte(1);
          const fin = !!(first & 0x80), compressed = !!(first & 0x40), opcode = first & 15;
          const control = opcode >= 8;
          if (first & 0x30 || second & 0x80) throw failure('Reserved bits or server masking in WebSocket frame');
          if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw failure('Invalid WebSocket opcode');
          if (compressed && (control || opcode === 0 || !this.compression)) throw failure('Unexpected compressed WebSocket frame');
          if (control && (!fin || (second & 127) > 125)) throw failure('Invalid WebSocket control frame');
          if (!control && (opcode === 0 ? this.opcode === 0 : this.opcode !== 0)) throw failure('Invalid WebSocket fragmentation sequence');
          let length = second & 127;
          const headerSize = length === 126 ? 4 : length === 127 ? 10 : 2;
          if (this.available < headerSize) break;
          if (length === 126) {
            length = this.byte(2) * 256 + this.byte(3);
            if (length < 126) throw failure('Non-minimal WebSocket frame length');
          } else if (length === 127) {
            if (this.byte(2) & 128) throw failure('Invalid WebSocket 64-bit length');
            let high = 0, low = 0;
            for (let i = 2; i < 6; i++) high = high * 256 + this.byte(i);
            for (let i = 6; i < 10; i++) low = low * 256 + this.byte(i);
            if (high > 0x1fffff) throw failure('WebSocket frame is too large', 1009);
            length = high * 4294967296 + low;
            if (length <= 65535) throw failure('Non-minimal WebSocket frame length');
          }
          if (!control && length + this.messageLength > MAX_MESSAGE) throw failure('WebSocket message is too large', 1009);
          this.take(headerSize);
          this.pending = { fin, compressed, opcode, length, control };
        }
        const header = this.pending;
        if (this.available < header.length) break;
        const payload = this.take(header.length);
        this.pending = null;
        if (header.control) {
          if (header.opcode === 8) {
            if (payload.length === 1) throw failure('Invalid WebSocket close payload');
            const code = payload.length ? payload.readUInt16BE(0) : 1005;
            if (payload.length && !validCloseCode(code)) throw failure('Invalid WebSocket close code');
            const reason = decodeText(payload.subarray(2));
            this.callbacks.close(code, reason, payload);
            this.stop();
          } else if (header.opcode === 9) this.callbacks.ping(payload);
          continue;
        }
        if (header.opcode) { this.opcode = header.opcode; this.compressed = header.compressed; }
        this.messageLength += payload.length;
        this.fragments.push(payload);
        if (!header.fin) continue;
        const opcode = this.opcode;
        const compressed = this.compressed;
        const body = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.messageLength);
        this.fragments = [];
        this.messageLength = 0;
        this.opcode = 0;
        this.compressed = false;
        if (compressed) {
          this.paused = true;
          this.callbacks.pause();
          this.compression.decode(body, (error, data) => {
            if (this.stopped) return;
            if (error) { this.fail(error); return; }
            try { this.callbacks.message(opcode, opcode === 1 ? decodeText(data) : data); }
            catch (error) { this.fail(error); return; }
            this.paused = false;
            this.run();
            if (!this.stopped && !this.paused) this.callbacks.resume();
          });
        } else this.callbacks.message(opcode, opcode === 1 ? decodeText(body) : body);
      }
    } catch (error) { this.fail(error); }
    finally { this.running = false; }
  }
}
module.exports = { Receiver, frame, failure, MAX_MESSAGE };
