'use strict';

const fs = require('fs');

// Files and POSIX terminals are synchronous Node stdio destinations. Do not
// silently truncate a partial write, and leave callback scheduling to Writable.
function writeAll(fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const count = fs.writeSync(fd, chunk, offset, chunk.length - offset, null);
    if (count === 0) throw Object.assign(new Error('EIO: write returned zero bytes'), { code: 'EIO', syscall: 'write', errno: -5 });
    offset += count;
  }
}

module.exports = { writeAll };
