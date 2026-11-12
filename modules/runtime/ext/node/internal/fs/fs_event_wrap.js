'use strict';

// Node's internalBinding('fs_event_wrap') FSEvent (src/fs_event_wrap.cc) over the runtime's
// watcher. start() returns 0 or a negative errno; onchange(status, eventType, filename) gets
// the filename in the encoding start() was given, or a negative status on an error.

const c = require('internal/fs/utils');

const uvCode = code => require('internal/uv_binding')[`UV_${code}`] ?? require('internal/uv_binding').UV_EINVAL;
const kWatch = Symbol('kWatch');
const kInitialized = Symbol('kInitialized');

function encodeName(name, encoding) {
  if (name == null) return null;
  if (typeof name === 'string') return c.encoded(name, encoding);
  return encoding === 'buffer' ? c.Buffer.from(name) : c.Buffer.from(name).toString(encoding);
}

class FSEvent {
  constructor() {
    this.onchange = null;
    this[kWatch] = null;
    this[kInitialized] = false;
  }
  get initialized() { return this[kInitialized]; }
  start(filename, persistent = true, recursive = false, encoding = 'utf8') {
    if (this[kInitialized]) return 0;
    if (typeof c.host.watch !== 'function') return uvCode('ENOSYS');
    // FSEvent::Start: THROW_IF_INSUFFICIENT_PERMISSIONS(env, kFileSystemRead, path).
    if (c.host.builtinLoaded('internal/permission')) require('internal/permission').check('fs.read', String(filename));
    try {
      this[kWatch] = c.host.watch(filename, { persistent, recursive, encoding }, (err, eventType, name) => {
        if (typeof this.onchange !== 'function') return;
        if (err) { this.onchange(err.errno ?? uvCode(err.code), null, null); return; }
        this.onchange(0, eventType, encodeName(name, encoding));
      });
    } catch (error) {
      return error.errno ?? uvCode(error.code);
    }
    this[kInitialized] = true;
    if (!persistent) this[kWatch].unref();
    return 0;
  }
  close() {
    if (this[kWatch]) { this[kWatch].close(); this[kWatch] = null; }
    this[kInitialized] = false;
  }
  ref() { this[kWatch]?.ref(); }
  unref() { this[kWatch]?.unref(); }
  hasRef() { return this[kWatch]?.hasRef?.() ?? false; }
}

module.exports = { FSEvent };
