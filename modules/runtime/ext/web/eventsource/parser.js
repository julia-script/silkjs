'use strict';

const { TextDecoder } = require('internal/web/encoding');
const { kStringMaxLength } = require('buffer');
function tooLarge() {
  const error = new Error('EventSource message size exceeded');
  error.aborted = false;
  throw error;
}

// Node commits id/retry only at an empty line and discards incomplete EOF
// events. Count original bytes, not replacement characters, for dispatcher
// eventSourceOptions.maxEventSize; UTF-8 decoder state survives every read.
class EventSourceParser {
  constructor(settings, dispatch, maxEventSize = kStringMaxLength) {
    this.settings = settings;
    this.dispatch = dispatch;
    this.decoder = new TextDecoder();
    this.fragments = [];
    this.skipLF = false;
    this.data = [];
    this.type = '';
    this.id = undefined;
    this.retry = undefined;
    this.maxEventSize = maxEventSize;
    this.maxItems = Math.min(131072, Math.max(1024, Math.floor(maxEventSize / 128)));
    this.lineBytes = 0;
    this.prefixLength = 0;
    this.bom = true;
    this.firstLine = true;
    this.size = 0;
    this.sizes = { data: 0, event: 0, id: 0, retry: 0 };
  }
  feed(bytes) {
    if (this.maxEventSize > 0 && this.fragments.length >= this.maxItems && bytes.length && bytes[0] !== 10 && bytes[0] !== 13) tooLarge();
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i];
      if (this.prefixLength < 3) {
        const expected = this.prefixLength === 0 ? 239 : this.prefixLength === 1 ? 187 : 191;
        this.bom = this.bom && code === expected;
        this.prefixLength++;
      }
      if (this.skipLF) {
        this.skipLF = false;
        if (code === 10) { start = i + 1; continue; }
      }
      if (code !== 10 && code !== 13) {
        this.lineBytes++;
        const bomAllowance = this.firstLine && this.bom ? this.prefixLength : 0;
        if (this.maxEventSize > 0 && this.lineBytes - bomAllowance > this.maxEventSize + 7) tooLarge();
        continue;
      }
      // Include the delimiter so an incomplete UTF-8 sequence before it is
      // replaced now, rather than leaking into the following line.
      let line = this.decoder.decode(bytes.subarray(start, i + 1), { stream: true }).slice(0, -1);
      if (this.fragments.length) {
        this.fragments.push(line);
        line = this.fragments.join('');
        this.fragments.length = 0;
      }
      let length = this.lineBytes;
      if (this.firstLine && this.bom && this.prefixLength === 3) length -= 3;
      this.firstLine = false;
      this.lineBytes = 0;
      this.skipLF = code === 13;
      start = i + 1;
      if (this.line(line, length) === false) return;
    }
    if (start < bytes.length) this.fragments.push(this.decoder.decode(bytes.subarray(start), { stream: true }));
  }
  fieldSize(field, size) {
    const next = this.size - this.sizes[field] + size;
    if (this.maxEventSize > 0 && next > this.maxEventSize) tooLarge();
    this.size = next;
    this.sizes[field] = size;
  }
  line(line, byteLength) {
    if (line === '') {
      if (this.id !== undefined) this.settings.lastEventId = this.id;
      if (this.retry !== undefined) this.settings.reconnectionTime = this.retry;
      const data = this.data;
      const type = this.type || 'message';
      this.data = [];
      this.type = '';
      this.id = this.retry = undefined;
      this.size = 0;
      this.sizes.data = this.sizes.event = this.sizes.id = this.sizes.retry = 0;
      if (data.length) return this.dispatch(type, data.join('\n'));
      return;
    }
    const colon = line.indexOf(':');
    if (colon === 0) return;
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    const space = value[0] === ' ';
    if (space) value = value.slice(1);
    // Recognized field names are ASCII, so their character and byte offsets agree.
    const size = colon < 0 ? 0 : byteLength - colon - 1 - (space ? 1 : 0);
    switch (field) {
      case 'data':
        if (this.maxEventSize > 0 && this.data.length >= this.maxItems) tooLarge();
        this.fieldSize('data', this.sizes.data + size + (this.data.length ? 1 : 0));
        this.data.push(value);
        break;
      // An empty event field does not replace a preceding nonempty field in Node 24.
      case 'event': if (value) { this.fieldSize('event', size); this.type = value; } break;
      case 'id': if (!value.includes('\0')) { this.fieldSize('id', size); this.id = value; } break;
      case 'retry': if (/^[0-9]+$/.test(value)) { this.fieldSize('retry', size); this.retry = Number(value); } break;
    }
  }
}

module.exports = { EventSourceParser };
