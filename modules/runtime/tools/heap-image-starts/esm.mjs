import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import util from 'node:util'; import events from 'node:events';
console.log(path.join('a', 'b'), typeof fs.readFileSync, typeof os.cpus, typeof util.inspect, typeof events.EventEmitter);
