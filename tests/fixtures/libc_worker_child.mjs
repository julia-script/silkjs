import * as os from 'os';
import * as std from 'std';
const parent = os.Worker.parent;
if (!parent) throw Error('missing Worker.parent');
parent.onmessage = function (event) {
    const message = event.data;
    if (message.command === 'echo') {
        parent.postMessage(message.value);
    } else if (message.command === 'descriptors') {
        parent.postMessage(os.pipe());
    } else if (message.command === 'block') {
        parent.postMessage('blocked');
        Atomics.wait(new Int32Array(message.buffer), 0, 0);
    } else if (message.command === 'spin') {
        parent.postMessage('blocked');
        while (true) {}
    } else if (message.command === 'timer') {
        os.setTimeout(() => {}, 1000000000);
        parent.onmessage = null;
        parent.postMessage('blocked');
    } else if (message.command === 'sleep') {
        parent.postMessage('blocked');
        os.sleep(30000);
    } else if (message.command === 'sleep-signal') {
        parent.postMessage('waiting');
        const before = os.now();
        const result = os.sleep(200);
        parent.postMessage([result, os.now() - before]);
    } else if (message.command === 'stdin') {
        parent.postMessage('blocked');
        std.in.getline();
    } else if (message.command === 'read' || message.command === 'write' || message.command === 'getline') {
        const fds = os.pipe();
        let stream = null;
        try {
            if (message.command === 'getline') stream = std.fdopen(fds[0], 'r');
            parent.postMessage('blocked');
            if (stream) stream.getline();
            else if (message.command === 'read') os.read(fds[0], new ArrayBuffer(1), 0, 1);
            else {
                const buffer = new ArrayBuffer(65536);
                while (os.write(fds[1], buffer, 0, 65536) >= 0) {}
            }
        } finally {
            if (stream) stream.close();
            else os.close(fds[0]);
            os.close(fds[1]);
        }
    } else if (message.command === 'fifo') {
        parent.postMessage('blocked');
        const fd = os.open(message.path, os.O_RDONLY);
        if (fd >= 0) os.close(fd);
    } else if (message.command === 'exec') {
        parent.postMessage('blocked');
        os.exec(['/bin/sleep', '30']);
    } else if (message.command === 'pclose') {
        const stream = std.popen('exec sleep 30', 'r');
        if (!stream) throw Error('popen');
        parent.postMessage('blocked');
        stream.close();
    } else if (message.command === 'sequence') {
        parent.postMessage(message.index);
    } else if (message.command === 'shared') {
        const words = new Int32Array(message.buffer);
        Atomics.add(words, 0, 7);
        Atomics.store(words, 1, 1);
        Atomics.notify(words, 1);
        parent.postMessage({buffer: message.buffer, first: Atomics.load(words, 0)});
    } else if (message.command === 'wait') {
        const words = new Int32Array(message.buffer);
        parent.postMessage('waiting');
        const result = Atomics.wait(words, 0, 0, 10000);
        parent.postMessage(result);
    } else if (message.command === 'nested') {
        let coerced = false;
        let error;
        try { new os.Worker({toString() { coerced = true; return './no-file.mjs'; }}); }
        catch (caught) { error = caught; }
        parent.postMessage([error instanceof TypeError, coerced]);
    } else if (message.command === 'environment') {
        parent.postMessage({parent: parent instanceof os.Worker,
            helpers: [typeof print, typeof console.log, typeof performance.now, typeof scriptArgs],
            base: [typeof Promise, typeof Uint8Array, typeof Atomics, typeof JSON],
            experimental: [typeof Temporal, typeof Intl],
            main: import.meta.main,
            url: import.meta.url.endsWith('/libc_worker_child.mjs')});
    } else if (message.command === 'experimental') {
        parent.postMessage([new Intl.NumberFormat('en').format(1234),
            Temporal.PlainDate.from('2024-02-29').add({years: 1}).toString()]);
    } else if (message.command === 'stop') {
        parent.postMessage('stopped');
        parent.onmessage = null;
    } else {
        throw Error('unknown worker fixture command');
    }
};
