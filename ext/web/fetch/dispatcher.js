'use strict';

const { EventEmitter } = require('events');
const { Readable, PassThrough } = require('stream');
const { Buffer } = require('buffer');

// Adapt Undici's public dispatch callbacks to the same streaming transaction
// used by the native HTTP transport. Redirects, codecs, byte streams and abort
// handling stay in transport.js; the supplied dispatcher owns its connections.
class DispatcherRequest extends EventEmitter {
  constructor(dispatcher, url, options, hasBody) {
    super();
    this.dispatcher = dispatcher;
    this.url = url;
    this.options = options;
    this.upload = hasBody ? new PassThrough() : null;
    this.incoming = null;
    this.abort = null;
    this.destroyed = false;
    this.completed = false;
    this.reason = undefined;
  }
  write(chunk, callback) { return this.upload.write(chunk, callback); }
  end() { this.upload?.end(); }
  destroy(reason) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.reason = reason || new Error('Request aborted');
    this.upload?.destroy();
    if (!this.completed) {
      const abort = this.abort;
      this.abort = null;
      if (abort) abort(this.reason);
    }
    this.incoming?.destroy();
    return this;
  }
  flushHeaders() {
    if (this.destroyed) return;
    const request = this;
    let resume;
    const fail = error => {
      if (request.destroyed) return;
      request.emit('error', error);
    };
    const handler = {
      onConnect(abort) {
        if (request.destroyed) { abort(request.reason); return; }
        request.abort = abort;
      },
      onResponseStarted() { request.emit('response-started'); },
      onHeaders(status, rawHeaders, continueReading, statusText) {
        if (request.destroyed) return false;
        if (status < 200) { request.emit('information'); return true; }
        resume = continueReading;
        const incoming = new Readable({
          read() { if (!request.destroyed && !request.completed) resume(); },
          destroy(error, callback) {
            if (!request.completed) request.destroy(error);
            callback(error);
          },
        });
        incoming.statusCode = status;
        incoming.statusMessage = statusText || '';
        incoming.rawHeaders = [];
        for (let i = 0; i < rawHeaders.length; i += 2) {
          const name = typeof rawHeaders[i] === 'string' ? rawHeaders[i] : Buffer.from(rawHeaders[i]).toString('latin1');
          const values = Array.isArray(rawHeaders[i + 1]) ? rawHeaders[i + 1] : [rawHeaders[i + 1]];
          for (const value of values) incoming.rawHeaders.push(name, typeof value === 'string' ? value : Buffer.from(value).toString('latin1'));
        }
        request.incoming = incoming;
        request.emit('response', incoming);
        return !request.destroyed;
      },
      onData(chunk) {
        if (request.destroyed) return false;
        return request.incoming.push(chunk);
      },
      onComplete() {
        if (request.destroyed) return;
        request.completed = true;
        request.abort = null;
        request.incoming.push(null);
      },
      onError: fail,
      onUpgrade(status, headers, socket) {
        socket.destroy();
        fail(new Error('Unexpected protocol upgrade'));
      },
      onRequestUpgrade(controller, status, headers, socket) {
        socket.destroy();
        fail(new Error('Unexpected protocol upgrade'));
        return false;
      },
    };
    const path = this.url.pathname + this.url.search;
    const trailingQuestion = this.url.search === '' && this.url.href[this.url.href.length - this.url.hash.length - 1] === '?';
    try {
      this.dispatcher.dispatch({
        origin: this.url.origin, path: path + (trailingQuestion ? '?' : ''),
        method: this.options.method, headers: this.options.headers,
        body: this.upload, maxRedirections: 0, upgrade: undefined,
      }, handler);
    } catch (error) { fail(error); }
  }
}

module.exports = { DispatcherRequest };
