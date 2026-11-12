'use strict';

// process.title as node_process_object.cc ProcessTitleGetter/Setter over libuv's
// uv_get_process_title/uv_set_process_title (src/unix/proctitle.c, linux.c).
// libuv keeps the title in the memory that held argv, whose size is the
// capacity: ps and /proc/<pid>/cmdline read it there, and the thread name is set
// as prctl(PR_SET_NAME) does. On Linux that memory is the kernel's
// [arg_start, arg_end) from /proc/self/stat, written through /proc/self/mem, so
// every thread reads the one process-wide title from /proc/self/cmdline.
// Elsewhere the title is kept here, as libuv keeps process_title.str.
const host = require('internal/host');
const linux = process.platform === 'linux';
let kept;

function text(bytes) {
  const buffer = host.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = buffer.indexOf(0);
  return buffer.toString('utf8', 0, end === -1 ? buffer.length : end);
}
function get() {
  if (!linux) return kept ?? process.argv0;
  return text(host.readFile('/proc/self/cmdline'));
}
// Fields 48 and 49 of /proc/self/stat, counted after the parenthesized command.
function argvArea() {
  const stat = text(host.readFile('/proc/self/stat'));
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { start: Number(fields[45]), end: Number(fields[46]) };
}
// /proc/self/mem is written at an address; comm takes a plain write.
function writeFile(path, offset, bytes) {
  const fd = host.fsSync('open', [path, require('fs').constants.O_RDWR, 0]);
  try {
    if (offset === undefined) host.rawOS.write(fd, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else host.fsSync('pwrite', [fd, bytes.buffer, bytes.byteOffset, bytes.byteLength, offset]);
  } finally { host.fsSync('close', [fd]); }
}
function set(title) {
  if (!linux) { kept = title; return; }
  const { start, end } = argvArea();
  const capacity = end - start;
  if (!(capacity > 0)) return;
  // uv_set_process_title: at most capacity - 1 bytes, the rest zeroed.
  const bytes = host.Buffer.from(title, 'utf8');
  const area = host.Buffer.alloc(capacity);
  bytes.copy(area, 0, 0, Math.min(bytes.length, capacity - 1));
  writeFile('/proc/self/mem', start, area);
  // prctl(PR_SET_NAME) on this thread: the kernel keeps the first 15 bytes.
  if (bytes.length) writeFile('/proc/thread-self/comm', undefined, bytes.subarray(0, 15));
}

module.exports = { get, set };
