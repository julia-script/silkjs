import * as os from 'os';
const parent = os.Worker.parent;
if (!parent) throw Error('missing Worker.parent');
parent.onmessage = event => {
    parent.onmessage = null;
    const message = event.data;
    if (message.command === 'echo') parent.postMessage(message.value);
    else if (message.command === 'sequence') parent.postMessage(message.index);
    else if (message.command === 'read' || message.command === 'write') {
        const fds = os.pipe();
        try {
            const sent = new Uint8Array([42]);
            const received = new Uint8Array(1);
            if (os.write(fds[1], sent.buffer, 0, 1) !== 1 ||
                os.read(fds[0], received.buffer, 0, 1) !== 1 || received[0] !== 42)
                throw Error('real pipe round trip');
            parent.postMessage(message.command + ':ok');
        } finally {
            os.close(fds[0]);
            os.close(fds[1]);
        }
    } else throw Error('unknown fault fixture command');
};
