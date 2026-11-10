import * as os from 'os';
import * as std from 'std';
function assert(value, label) { if (!value) throw Error(label); }
function throws(fn, kind, label) {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    assert(error instanceof kind, label);
}
const mode = scriptArgs[1] || 'clone';
if (mode === 'descriptors') {
    const prototype = os.Worker.prototype;
    const post = Object.getOwnPropertyDescriptor(prototype, 'postMessage');
    const message = Object.getOwnPropertyDescriptor(prototype, 'onmessage');
    assert(os.Worker.length === 1 && prototype.postMessage.length === 1, 'function length');
    assert(post.writable && post.configurable && !post.enumerable, 'method descriptor');
    assert(message.configurable && !message.enumerable && message.get.length === 0 && message.set.length === 1, 'accessor descriptor');
    assert(!Object.prototype.hasOwnProperty.call(os.Worker, 'parent'), 'no parent on main thread');
    throws(() => os.Worker('bad'), TypeError, 'new required');
    throws(() => prototype.postMessage.call({}, 1), TypeError, 'postMessage brand');
    throws(() => message.get.call({}), TypeError, 'getter brand');
    throws(() => message.set.call({}, null), TypeError, 'setter brand');
    print('descriptors:ok');
} else {
    const worker = new os.Worker('./libc_worker_child.mjs');
    const request = message => new Promise(resolve => {
        worker.onmessage = function(event) {
            assert(this === undefined, 'callback receiver');
            assert(Object.getPrototypeOf(event) === Object.prototype, 'event prototype');
            const descriptor = Object.getOwnPropertyDescriptor(event, 'data');
            assert(descriptor.writable && descriptor.enumerable && descriptor.configurable, 'event data descriptor');
            worker.onmessage = null;
            resolve(event.data);
        };
        worker.postMessage(message);
    });
    assert(worker.onmessage === null, 'initial callback');
    for (const invalid of [undefined, false, 0, '', {}])
        throws(() => { worker.onmessage = invalid; }, TypeError, 'callback validation');
    if (mode === 'clone') {
        const buffer = new ArrayBuffer(8);
        const bytes = new Uint8Array(buffer);
        bytes.set([0, 1, 2, 3, 127, 128, 254, 255]);
        const value = {bytes, buffer, alias: bytes, date: new Date(-123456789),
            boxed: new Number(12), text: '\ud800x\udfff', integer: 12345678901234567890n,
            nan: NaN, infinity: Infinity, negativeZero: -0};
        value.self = value;
        const result = await request({command: 'echo', value});
        assert(result !== value && result.self === result, 'cycle clone');
        assert(result.alias === result.bytes && result.bytes.buffer === result.buffer, 'reference clone');
        assert(result.bytes.join(',') === '0,1,2,3,127,128,254,255', 'buffer contents');
        assert(buffer.byteLength === 8 && bytes[7] === 255, 'source not transferred');
        result.bytes[0] = 99;
        assert(bytes[0] === 0, 'ordinary buffer isolation');
        assert(result.date.getTime() === -123456789 && result.boxed.valueOf() === 12, 'boxed clone');
        assert(result.text === value.text && result.integer === value.integer, 'string and bigint clone');
        assert(Number.isNaN(result.nan) && result.infinity === Infinity && Object.is(result.negativeZero, -0), 'number clone');
        // Symbols are unsupported tags; unsupported object classes are TypeErrors.
        throws(() => worker.postMessage(Symbol('x')), InternalError, 'unsupported symbol clone');
        for (const unsupported of [function(){}, new Map(), /x/, new DataView(buffer)])
            throws(() => worker.postMessage(unsupported), TypeError, 'unsupported clone');
        let reads = 0;
        const accessor = {get value() { reads++; return 42; }};
        throws(() => worker.postMessage(accessor), TypeError, 'accessor clone rejected');
        assert(reads === 0, 'getter not invoked during clone');
        const bad = {get value() { reads++; throw Error('accessor'); }};
        throws(() => worker.postMessage(bad), TypeError, 'throwing accessor clone rejected');
        assert(reads === 0, 'throwing getter not invoked during clone');
        assert((await request({command: 'echo', value: 42})) === 42, 'queue survives serialization failure');
    } else if (mode === 'signals') {
        const urgent = os.platform === 'darwin' ? 16 : 23;
        const window = 28;
        const delivered = [];
        os.signal(urgent, () => delivered.push('urgent'));
        os.signal(window, () => delivered.push('window'));
        os.kill(os.getpid(), urgent);
        os.kill(os.getpid(), window);
        await os.sleepAsync(10);
        assert(delivered.sort().join() === 'urgent,window', 'signal delivery with live Worker');
        os.signal(urgent, undefined);
        os.kill(os.getpid(), urgent);
        await os.sleepAsync(10);
        assert(delivered.length === 2, 'signal ignore with live Worker');
        os.signal(urgent, () => delivered.push('readded'));
        os.kill(os.getpid(), urgent);
        await os.sleepAsync(10);
        assert(delivered[2] === 'readded', 'signal reregistration with live Worker');
        os.signal(urgent, null);
        os.signal(window, null);
    } else if (mode === 'sleep-signal') {
        await new Promise((resolve, reject) => {
            worker.onmessage = event => {
                if (event.data === 'waiting') {
                    console.log('READY');
                } else {
                    worker.onmessage = null;
                    if (event.data[0] === 0 && event.data[1] >= 180) resolve();
                    else reject(Error('ordinary signal interrupted Worker sleep: ' + JSON.stringify(event.data)));
                }
            };
            worker.postMessage({command: 'sleep-signal'});
        });
    } else if (mode === 'queue') {
        const count = 257;
        for (let index = 0; index < count; index++) worker.postMessage({command: 'sequence', index});
        await os.sleepAsync(20);
        await new Promise(resolve => {
            let next = 0;
            function receive(event) {
                assert(event.data === next++, 'FIFO ordering');
                if (next === 100) {
                    worker.onmessage = null;
                    os.setTimeout(() => { worker.onmessage = receive; }, 5);
                } else if (next === count) {
                    worker.onmessage = null;
                    resolve();
                }
            }
            worker.onmessage = receive;
            assert(worker.onmessage === receive, 'getter function identity');
        });
    } else if (mode === 'shared') {
        const buffer = new SharedArrayBuffer(8);
        const words = new Int32Array(buffer);
        words[0] = 35;
        const response = await request({command: 'shared', buffer});
        assert(response.first === 42 && Atomics.load(words, 0) === 42 && Atomics.load(words, 1) === 1, 'shared mutation');
        assert(response.buffer !== buffer && response.buffer instanceof SharedArrayBuffer, 'new shared wrapper');
        Atomics.store(new Int32Array(response.buffer), 0, 99);
        assert(Atomics.load(words, 0) === 99, 'roundtrip backing identity');
        const waiting = new SharedArrayBuffer(4);
        await new Promise(resolve => {
            worker.onmessage = event => {
                if (event.data === 'waiting') {
                    Atomics.store(new Int32Array(waiting), 0, 1);
                    Atomics.notify(new Int32Array(waiting), 0);
                } else {
                    assert(event.data === 'ok' || event.data === 'not-equal', 'cross-runtime waiter domain');
                    worker.onmessage = null;
                    resolve();
                }
            };
            worker.postMessage({command: 'wait', buffer: waiting});
        });
    } else if (mode === 'nested') {
        const result = await request({command: 'nested'});
        assert(result[0] && result[1] === false, 'nested Worker rejection precedes coercion');
    } else if (mode === 'environment' || mode === 'experimental') {
        const result = await request({command: 'environment'});
        assert(result.parent && result.url && result.main === false, 'worker module environment');
        assert(result.helpers.join() === 'function,function,function,undefined', 'worker helpers');
        assert(result.base.join() === 'function,function,object,object', 'worker base intrinsics');
        if (mode === 'experimental') {
            assert(result.experimental.join() === 'object,object', 'experimental inheritance');
            const formatted = await request({command: 'experimental'});
            assert(formatted.join('|') === '1,234|2025-02-28', 'worker Intl Temporal');
        }
    } else {
        throw Error('unknown main fixture mode');
    }
    assert(await request({command: 'stop'}) === 'stopped', 'worker close handshake');
    std.gc();
    print(mode + ':ok');
}
