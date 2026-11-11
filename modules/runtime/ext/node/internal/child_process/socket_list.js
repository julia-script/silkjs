// SocketListSend adapted from Node.js v24.22.1 lib/internal/socket_list.js: the parent's
// view of the server sockets it sent to one child, for server.close() and getConnections().
// The child's side (Node's SocketListReceive) is in internal/child_process/ipc.js.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const { ERR_CHILD_CLOSED_BEFORE_REPLY } = require('internal/errors').codes;
const EventEmitter = require('events');

class SocketListSend extends EventEmitter {
  constructor(child, key) {
    super();
    this.key = key;
    this.child = child;
    child.once('exit', () => this.emit('exit', this));
  }

  _request(msg, cmd, callback) {
    const self = this;
    if (!this.child.connected) return onclose();
    this.child._send(msg);

    function onclose() {
      self.child.removeListener('internalMessage', onreply);
      callback(new ERR_CHILD_CLOSED_BEFORE_REPLY());
    }

    function onreply(msg) {
      if (!(msg.cmd === cmd && msg.key === self.key)) return;
      self.child.removeListener('disconnect', onclose);
      self.child.removeListener('internalMessage', onreply);
      callback(null, msg);
    }

    this.child.once('disconnect', onclose);
    this.child.on('internalMessage', onreply);
  }

  close(callback) {
    this._request({ cmd: 'NODE_SOCKET_NOTIFY_CLOSE', key: this.key }, 'NODE_SOCKET_ALL_CLOSED', callback);
  }

  getConnections(callback) {
    this._request({ cmd: 'NODE_SOCKET_GET_COUNT', key: this.key }, 'NODE_SOCKET_COUNT', (err, msg) => {
      if (err) return callback(err);
      callback(null, msg.count);
    });
  }
}

module.exports = { SocketListSend };
