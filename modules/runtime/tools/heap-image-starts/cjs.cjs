const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const util = require('node:util'); const events = require('node:events');
console.log(path.join('a', 'b'), typeof fs.readFileSync, typeof os.cpus, typeof util.inspect, typeof events.EventEmitter);
