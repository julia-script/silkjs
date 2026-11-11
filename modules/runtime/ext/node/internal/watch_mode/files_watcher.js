'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const within = (parent, child) => parent === child || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
function stat(filename) {
  try { return fs.statSync(filename); }
  catch (error) { if (missing(error)) return null; throw error; }
}

class FilesWatcher extends EventEmitter {
  constructor({ debounce = 200 } = {}) {
    super();
    this.debounce = debounce;
    this.files = new Set();
    this.roots = new Set();
    this.handles = new Map();
    this.timer = null;
    this.closed = false;
  }
  watchPath(filename) {
    filename = path.resolve(filename);
    fs.statSync(filename);
    this.roots.add(filename);
    this.refresh();
  }
  filterFile(filename) {
    filename = path.resolve(filename);
    if (this.files.has(filename)) return;
    this.files.add(filename);
    this.refresh();
  }
  beginRun(seeds) {
    // A failed reload must still recover when a deleted dependency reappears.
    for (const file of this.files) if (stat(file)) this.files.delete(file);
    for (const file of seeds) this.files.add(path.resolve(file));
    this.refresh();
  }
  refresh() {
    if (this.closed) return;
    const wanted = new Map();
    const directory = filename => {
      const info = stat(filename);
      if (info?.isDirectory()) wanted.set(filename, String(info.dev) + ':' + String(info.ino));
      return info;
    };
    const ancestors = filename => {
      let parent = path.dirname(filename);
      for (;;) {
        directory(parent);
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    };
    const tree = filename => {
      const info = directory(filename);
      if (!info?.isDirectory()) return;
      let entries;
      try { entries = fs.readdirSync(filename, { withFileTypes: true }); }
      catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) if (entry.isDirectory()) tree(path.join(filename, entry.name));
    };
    for (const file of this.files) ancestors(file);
    for (const root of this.roots) { ancestors(root); tree(root); }
    for (const [filename, record] of this.handles) {
      if (wanted.get(filename) !== record.identity) {
        record.handle.close();
        this.handles.delete(filename);
      }
    }
    for (const [filename, identity] of wanted) {
      if (this.handles.has(filename)) continue;
      let handle;
      try { handle = fs.watch(filename, (event, name) => this.change(filename, event, name)); }
      catch (error) { if (missing(error)) continue; throw error; }
      this.handles.set(filename, { handle, identity });
      handle.on('error', error => {
        this.handles.delete(filename);
        if (missing(error)) {
          try { this.change(filename, 'rename', null); } catch (cause) { this.emit('error', cause); }
        } else this.emit('error', error);
      });
    }
  }
  change(directory, event, name) {
    if (this.closed) return;
    const trigger = name == null ? directory : path.resolve(directory, String(name));
    let relevant = false;
    for (const file of this.files) if (within(trigger, file)) { relevant = true; break; }
    if (!relevant) for (const root of this.roots) {
      if (within(root, trigger) || within(trigger, root)) { relevant = true; break; }
    }
    if (!relevant) return;
    try { if (event === 'rename') this.refresh(); }
    catch (error) { this.emit('error', error); return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('changed', { trigger, eventType: event });
    }, this.debounce);
  }
  clear() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const { handle } of this.handles.values()) handle.close();
    this.handles.clear();
    this.files.clear();
    this.roots.clear();
  }
}

module.exports = { FilesWatcher };
