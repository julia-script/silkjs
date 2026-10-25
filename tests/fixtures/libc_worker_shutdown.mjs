import * as os from 'os';
const command = scriptArgs[1];
const workers = Array.from({length: command === 'stdio-lock' ? 2 : 1},
    () => new os.Worker('./libc_worker_child.mjs'));
await Promise.all(workers.map(worker => new Promise(resolve => {
    worker.onmessage = event => {
        if (event.data !== 'blocked') throw Error('shutdown handshake');
        worker.onmessage = null;
        resolve();
    };
    worker.postMessage({command: command === 'stdio-lock' ? 'stdin' : command,
        path: scriptArgs[2], buffer: new SharedArrayBuffer(4)});
})));
await os.sleepAsync(50);
print('shutdown:' + command + ':ok');
