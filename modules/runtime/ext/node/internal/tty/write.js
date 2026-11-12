'use strict';

// The write goes to the descriptor itself, as Node's SyncWriteStream reaches
// binding.writeBuffer, so a user patch of fs.writeSync does not take over stdio.
const c = require('internal/fs/utils');

// Files and POSIX terminals are synchronous Node stdio destinations. Do not
// silently truncate a partial write, and leave callback scheduling to Writable.
function writeAll(fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const count = c.fail(c.os.write(fd, chunk.buffer, chunk.byteOffset + offset, chunk.length - offset), 'write');
    if (count === 0) throw Object.assign(new Error('EIO: write returned zero bytes'), { code: 'EIO', syscall: 'write', errno: -5 });
    offset += count;
  }
}

module.exports = { writeAll };
