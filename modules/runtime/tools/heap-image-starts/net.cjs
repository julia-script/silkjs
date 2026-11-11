const http = require('node:http'); const crypto = require('node:crypto'); const stream = require('node:stream'); const url = require('node:url'); const zlib = require('node:zlib'); const cp = require('node:child_process');
console.log(typeof http.createServer, typeof crypto.createHash, typeof stream.Readable, typeof url.parse, typeof zlib.gzipSync, typeof cp.spawn);
