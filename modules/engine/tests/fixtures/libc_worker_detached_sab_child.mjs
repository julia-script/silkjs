import * as os from 'os';

os.Worker.parent.onmessage = event => {
    const cells = new Int32Array(event.data);
    os.Worker.parent.onmessage = null;
    Atomics.store(cells, 1, 1);
    let result;
    try {
        result = Atomics.wait(cells, 0, 0);
    } catch {
        result = 'error';
    }
    Atomics.store(cells, 2, result === 'ok' ? 73 : -1);
    // Keep the child's queue lease live until the host owns its late lease,
    // including a genuine unexpected/spurious return from the first wait.
    while (Atomics.load(cells, 3) === 0)
        Atomics.wait(cells, 3, 0, 1000);
};
