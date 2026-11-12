'use strict';
const host = require('internal/host');
const { Buffer } = require('buffer');
const { EventEmitter } = require('events');
const { AsyncResource } = require('async_hooks');
const native = (op, args) => host.processNative(op, args);
const failure = (code, message) => Object.assign(new Error(message), { code });
const { codes: { ERR_INVALID_ARG_TYPE, ERR_MISSING_ARGS }, codedError, validateObject } = require('internal/validators');
// Node's target[kChannelHandle]: the channel's pipe handle, null once it closes.
const kChannelHandle = Symbol('kChannelHandle');
function setupChannel(target, fd, mode = 'json', onClose) {
  const resource = new AsyncResource('PIPEWRAP');
  let input = Buffer.alloc(0), receivedFD = -1, queue = [], bytes = 0, pendingHandle = null;
  let closing = false, closed = false, explicitRef = null, reading = true;
  const socketLists = new Map();
  const sentSocketLists = new Map();
  const codec = mode === 'advanced' ? require('internal/serialization/v8') : null;
  const channel = new EventEmitter();
  const id = native('ipcOpen', [fd, (events) => {
    host.invokeResource(resource, ready, undefined, [events], false);
    host.checkpoint();
  }]);
  if (id < 0) { native('closeFd', [fd]); resource.emitDestroy(); throw failure(native('errorName', [id]), 'Cannot open IPC channel'); }
  function refState() {
    if (closed) return;
    const ref = explicitRef === null ? queue.length > 0 || pendingHandle !== null || target.listenerCount('message') > 0 || target.listenerCount('disconnect') > 0 : explicitRef;
    native(ref ? 'ref' : 'unref', [id]);
  }
  // Readable interest follows readStart/readStop, as uv_read_start/stop do for Node's
  // pipe: while stopped, messages wait in the kernel and arrive together on readStart.
  function arm() {
    if (closed) return;
    native('ipcEvents', [id, (reading ? 1 : 0) | (queue.length && (!pendingHandle || queue[0].control) ? 2 : 0)]);
  }
  target[kChannelHandle] = {
    __proto__: null,
    fd,
    readStart() { if (closed) return -9; reading = true; arm(); return 0; },
    readStop() { if (closed) return -9; reading = false; arm(); return 0; },
    ref() { channel.ref(); },
    unref() { channel.unref(); },
  };
  Object.defineProperty(channel, 'fd', { value: fd, enumerable: true });
  channel.ref = () => { explicitRef = true; refState(); };
  channel.unref = () => { explicitRef = false; refState(); };
  target.channel = channel;
  Object.defineProperty(target, '_channel', {
    configurable: true, enumerable: false,
    get: require('util').deprecate(() => target.channel, '_channel is deprecated. Use ChildProcess.channel instead.', 'DEP0129'),
    set: require('util').deprecate(value => { target.channel = value; }, '_channel is deprecated. Use ChildProcess.channel instead.', 'DEP0129'),
  });
  target.connected = true;
  const changed = name => { if (name === 'message' || name === 'disconnect') process.nextTick(refState); };
  target.on('newListener', changed);
  target.on('removeListener', changed);
  function complete(error) {
    if (closed) return;
    closed = true; target.connected = false; target.channel = null; target[kChannelHandle] = null;
    native('ipcClose', [id]);
    if (receivedFD >= 0) native('closeFd', [receivedFD]);
    receivedFD = -1;
    target.removeListener('newListener', changed); target.removeListener('removeListener', changed);
    const unsent = queue; queue = [];
    for (const item of unsent) {
      if (item.transfer) native('closeFd', [item.transfer.fd]);
      if (item.callback) process.nextTick(item.callback, error || failure('ERR_IPC_CHANNEL_CLOSED', 'Channel closed'));
    }
    if (pendingHandle) {
      native('closeFd', [pendingHandle.fd]);
      if (!pendingHandle.options.keepOpen && pendingHandle.type === 'net.Socket') pendingHandle.handle.destroy();
    }
    pendingHandle = null;
    process.nextTick(() => { target.emit('disconnect'); if (onClose) onClose(); resource.emitDestroy(); });
  }
  function encode(value) {
    if (!codec) return Buffer.from(JSON.stringify(value) + '\n');
    const payload = codec.serializeIPC(value);
    const result = Buffer.allocUnsafe(payload.length + 4);
    result.writeUInt32BE(payload.length, 0); payload.copy(result, 4); return result;
  }
  function submit(value, handleFD = -1, callback, transfer) {
    const buffer = encode(value);
    queue.push({ buffer, offset: 0, fd: handleFD, callback, transfer }); bytes += buffer.length;
    flush(); refState(); return bytes < 131072;
  }
  function flush() {
    if (closed) return;
    while (queue.length) {
      const item = queue[0];
      if (pendingHandle && !item.control) break;
      const n = native('ipcWrite', [fd, item.buffer.buffer, item.buffer.byteOffset + item.offset, item.buffer.length - item.offset, item.fd]);
      if (n < 0) {
        const code = native('errorName', [n]);
        if (code === 'EAGAIN' || code === 'EINTR') break;
        const error = failure(code, `write ${code}`); complete(error); if (!item.callback) target.emit('error', error); return;
      }
      if (!n) break;
      item.fd = -1; item.offset += n; bytes -= n;
      if (item.offset < item.buffer.length) continue;
      queue.shift();
      if (item.transfer) pendingHandle = item.transfer;
      if (item.callback) process.nextTick(item.callback, null);
    }
    arm();
    if (closing && !queue.length && !pendingHandle) complete();
    refState();
  }
  function control(value) {
    const buffer = encode(value);
    queue.splice(queue[0]?.offset ? 1 : 0, 0, { buffer, offset: 0, fd: -1, control: true }); bytes += buffer.length; flush();
  }
  function deliver(value, handle) {
    target.emit(value && typeof value.cmd === 'string' && value.cmd.startsWith('NODE_') ? 'internalMessage' : 'message', value, handle);
  }
  // A TCP or pipe handle over a received descriptor, or null after reporting the failure.
  function openHandle(passed, server) {
    const { tcp_wrap: { TCP }, pipe_wrap: { Pipe }, guessHandleType } = require('internal/net/binding');
    const kind = guessHandleType(passed);
    let handle;
    if (kind === 'TCP') handle = new TCP(server ? TCP.SERVER : TCP.SOCKET);
    else if (kind === 'PIPE') handle = new Pipe(server ? Pipe.SERVER : Pipe.SOCKET);
    const status = handle ? handle.open(passed) : -22;
    if (status >= 0) return handle;
    handle?.close();
    native('closeFd', [passed]);
    target.emit('error', failure('ERR_INVALID_HANDLE_TYPE', `Unsupported IPC handle ${kind}`));
    return null;
  }
  function message(value) {
    if (value && typeof value.cmd === 'string' && value.cmd.startsWith('NODE_')) {
      if (value.cmd === 'NODE_HANDLE_ACK' || value.cmd === 'NODE_HANDLE_NACK') {
        const transfer = pendingHandle; pendingHandle = null;
        if (transfer && value.cmd === 'NODE_HANDLE_NACK') {
          if (transfer.retries++ < 3) {
            const buffer = encode(transfer.message);
            queue.splice(queue[0]?.offset ? 1 : 0, 0, { buffer, offset: 0, fd: transfer.fd, transfer }); bytes += buffer.length;
          } else {
            native('closeFd', [transfer.fd]);
            if (!transfer.options.keepOpen && transfer.type === 'net.Socket') transfer.handle.destroy();
          }
        } else if (transfer) {
          native('closeFd', [transfer.fd]);
          if (!transfer.options.keepOpen && transfer.type === 'net.Socket') transfer.handle.destroy();
        }
        flush(); return;
      }
      if (value.cmd === 'NODE_HANDLE') {
        const passed = receivedFD; receivedFD = -1;
        if (passed < 0) { control({ cmd: 'NODE_HANDLE_NACK' }); return; }
        control({ cmd: 'NODE_HANDLE_ACK' });
        const net = require('net');
        if (value.type === 'net.Socket') {
          const internal = value.msg?.cmd === 'NODE_CLUSTER';
          const socket = new net.Socket({ fd: passed, readable: true, writable: true, manualStart: internal });
          if (value.key !== undefined) {
            let list = socketLists.get(value.key);
            if (!list) { list = { count: 0, notify: false }; socketLists.set(value.key, list); }
            list.count++;
            socket.once('close', () => {
              if (--list.count === 0 && list.notify && !closed) control({ cmd: 'NODE_SOCKET_ALL_CLOSED', key: value.key });
            });
          }
          deliver(value.msg, socket);
        } else if (value.type === 'net.Server') {
          const server = new net.Server();
          server.once('error', error => {
            if (value.msg?.cmd === 'NODE_CLUSTER') deliver({ ...value.msg, error: { code: error.code, message: error.message, errno: error.errno, syscall: error.syscall } });
            else target.emit('error', error);
          });
          // As in Node, the server listens on the received handle itself: listen({ fd }) in a
          // cluster worker would ask the primary for a server on that descriptor number.
          const handle = openHandle(passed, true);
          if (!handle) return;
          server.listen(handle, () => deliver(value.msg, server));
        } else if (value.type === 'dgram.Socket') {
          const socket = require('dgram').createSocket(value.dgramType || 'udp4');
          socket.once('error', error => target.emit('error', error));
          socket.bind({ fd: passed, exclusive: true }, () => deliver(value.msg, socket));
        } else if (value.type === 'net.Native') {
          // Like Node's handleConversion: a raw TCP or pipe handle (cluster) arrives as a handle.
          const handle = openHandle(passed, false);
          if (handle) deliver(value.msg, handle);
        } else if (value.type === 'dgram.Native') {
          const handle = require('internal/dgram').newHandle(value.dgramType || 'udp4');
          const status = handle.open(passed);
          if (status < 0) {
            handle.close();
            native('closeFd', [passed]);
            target.emit('error', failure('ERR_INVALID_HANDLE_TYPE', `Unsupported IPC handle ${value.type}`));
            return;
          }
          deliver(value.msg, handle);
        } else { native('closeFd', [passed]); target.emit('error', failure('ERR_INVALID_HANDLE_TYPE', `Unsupported IPC handle ${value.type}`)); }
        return;
      }
      if (value.cmd === 'NODE_SOCKET_GET_COUNT') {
        control({ cmd: 'NODE_SOCKET_COUNT', key: value.key, count: socketLists.get(value.key)?.count || 0 }); return;
      }
      if (value.cmd === 'NODE_SOCKET_NOTIFY_CLOSE') {
        const list = socketLists.get(value.key);
        if (!list || list.count === 0) control({ cmd: 'NODE_SOCKET_ALL_CLOSED', key: value.key });
        else list.notify = true;
        return;
      }
      target.emit('internalMessage', value); return;
    }
    target.emit('message', value);
  }
  function parse() {
    while (input.length) {
      let value;
      if (codec) {
        if (input.length < 4) return;
        const size = input.readUInt32BE(0); if (input.length < size + 4) return;
        value = codec.deserializeIPC(input.subarray(4, size + 4)); input = input.subarray(size + 4);
      } else {
        const end = input.indexOf(10); if (end < 0) return;
        value = JSON.parse(input.subarray(0, end).toString()); input = input.subarray(end + 1);
      }
      message(value);
    }
  }
  function ready(events) {
    if (closed) return;
    if (events < 0) { complete(failure(native('errorName', [events]), 'IPC channel failed')); return; }
    if (events & 1) {
      while (!closed && reading) {
        const result = native('ipcRead', [fd]);
        if (typeof result === 'number') {
          const code = native('errorName', [result]);
          if (code !== 'EAGAIN' && code !== 'EINTR') complete(failure(code, `read ${code}`));
          break;
        }
        const chunk = Buffer.from(result[0]);
        if (result[1] >= 0) { if (receivedFD >= 0) native('closeFd', [receivedFD]); receivedFD = result[1]; }
        if (!chunk.length) { complete(); break; }
        input = input.length ? Buffer.concat([input, chunk]) : chunk; parse();
      }
    }
    if (!closed && events & 2) flush();
  }
  target.send = function send(value, handle, options, callback) {
    if (typeof handle === 'function') { callback = handle; handle = undefined; options = undefined; }
    else if (typeof options === 'function') { callback = options; options = undefined; }
    else if (options !== undefined) validateObject(options, 'options');
    options = { swallowErrors: false, ...options };
    if (!target.connected) {
      const error = failure('ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
      process.nextTick(() => { if (typeof callback === 'function') callback(error); else target.emit('error', error); }); return false;
    }
    if (value === undefined) throw new ERR_MISSING_ARGS('message');
    if (typeof value !== 'string' && typeof value !== 'object' && typeof value !== 'number' && typeof value !== 'boolean')
      throw new ERR_INVALID_ARG_TYPE('message', ['string', 'object', 'number', 'boolean'], value);
    // Like Node, messages sent while a handle waits for its ACK queue behind it; the
    // first of them reports true, later ones false.
    if (!handle && (pendingHandle || queue.some(item => item.transfer))) {
      submit(value, -1, callback);
      let waiting = 0, behind = false;
      for (const item of queue) { if (item.transfer) { behind = true; waiting = 0; } else if (behind && !item.control) waiting++; }
      if (pendingHandle && !queue.some(item => item.transfer)) waiting = queue.filter(item => !item.control).length;
      return waiting === 1;
    }
    if (!handle) return submit(value, -1, callback);
    const net = require('net'); let type, handleFD;
    if (handle instanceof net.Socket) { type = 'net.Socket'; handleFD = handle._transport?.call('fileno'); }
    else if (handle instanceof net.Server) { type = 'net.Server'; handleFD = handle._transport?.call('fileno'); }
    else if (handle instanceof require('dgram').Socket) { type = 'dgram.Socket'; handleFD = handle[require('internal/dgram').kStateSymbol].handle?.fd; }
    else if (require('internal/net/binding').isStreamHandle(handle)) { type = 'net.Native'; handleFD = handle.fd; }
    else if (handle instanceof require('internal/dgram').UDP) { type = 'dgram.Native'; handleFD = handle.fd; }
    else throw codedError(TypeError, 'ERR_INVALID_HANDLE_TYPE', 'This handle type cannot be sent');
    if (!Number.isInteger(handleFD) || handleFD < 0) throw failure('ERR_INVALID_HANDLE_TYPE', 'Handle is closed');
    const envelope = { cmd: 'NODE_HANDLE', type, msg: value };
    // Like Node's handleConversion['net.Socket'].send: a server's socket carries its server's
    // key, and the first one sent to this child joins the server's worker list.
    if (type === 'net.Socket' && handle.server && handle.server._connectionKey !== undefined) {
      const key = envelope.key = handle.server._connectionKey;
      let list = sentSocketLists.get(key);
      if (!list) {
        list = new (require('internal/child_process/socket_list').SocketListSend)(target, key);
        sentSocketLists.set(key, list);
        handle.server._setupWorker(list);
      }
      // Node: "Act like socket is detached". The socket no longer counts toward its server,
      // and its later destroy (after the ACK below) must not count it off again.
      if (!options.keepOpen) { handle.server._connections--; handle._server = null; }
    }
    if (type === 'dgram.Socket') envelope.dgramType = handle.type || (handle._family === 6 ? 'udp6' : 'udp4');
    if (type === 'dgram.Native') envelope.dgramType = handle.family === 6 ? 'udp6' : 'udp4';
    const buffer = encode(envelope);
    // Hold an independent descriptor until ACK, including time spent behind backpressure.
    handleFD = host.net('duplicateFd', [handleFD]);
    if (handleFD < 0) throw failure(native('errorName', [handleFD]), 'Cannot duplicate IPC handle');
    if (type === 'net.Socket' && !options.keepOpen) handle.pause();
    const transfer = { handle, fd: handleFD, options, type, message: envelope, retries: 0 };
    queue.push({ buffer, offset: 0, fd: handleFD, callback, transfer }); bytes += buffer.length;
    flush(); refState(); return bytes < 131072;
  };
  // Node's internal _send for its own NODE_ messages, queued in order with user messages.
  target._send = function _send(value) { return submit(value, -1); };
  target.disconnect = function disconnect() {
    if (!target.connected) { target.emit('error', failure('ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected')); return; }
    target.connected = false; closing = true; flush();
  };
  refState();
  return channel;
}
function installChild(process) {
  const value = process.env.NODE_CHANNEL_FD;
  if (value === undefined) return;
  const mode = process.env.NODE_CHANNEL_SERIALIZATION_MODE || 'json';
  delete process.env.NODE_CHANNEL_FD; delete process.env.NODE_CHANNEL_SERIALIZATION_MODE;
  setupChannel(process, Number(value), mode);
}
module.exports = { setupChannel, installChild, kChannelHandle };
