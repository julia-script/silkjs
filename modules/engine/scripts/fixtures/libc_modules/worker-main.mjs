import * as os from 'os';
const worker = new os.Worker('./worker.mjs');
worker.onmessage = ({ data }) => {
    if (data !== 42) throw Error('worker module bundle');
    print('worker:42');
    worker.onmessage = null;
};
