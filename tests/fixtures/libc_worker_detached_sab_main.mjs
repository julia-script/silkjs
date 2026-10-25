import * as os from 'os';

globalThis.detachedShared = new SharedArrayBuffer(16);
globalThis.detachedWorker = new os.Worker('./libc_worker_detached_sab_child.mjs');
detachedWorker.postMessage(detachedShared);
