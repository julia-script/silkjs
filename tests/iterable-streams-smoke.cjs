'use strict';

// Run with --experimental-stream-iter. Exercises byte-batch protocols and
// ownership, rather than assuming these APIs are generic iterator helpers.
const assert = require('node:assert/strict');
const S = require('node:stream/iter');
const Z = require('node:zlib/iter');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const tick = () => new Promise(resolve => setImmediate(resolve));
const string = batch => Buffer.concat(batch).toString();

async function protocolsAndPipelines() {
  assert.equal(S.toStreamable, Symbol.for('Stream.toStreamable'));
  assert.equal(S.toAsyncStreamable, Symbol.for('Stream.toAsyncStreamable'));
  assert.equal(S.textSync({ [S.toStreamable]() { return ['a', Buffer.from('b')]; } }), 'ab');
  assert.equal(await S.text({ async [S.toAsyncStreamable]() { return ['c', 'd']; } }), 'cd');
  const backing = Uint8Array.of(0, 65, 66, 0);
  assert.equal(S.textSync(new DataView(backing.buffer, 1, 2)), 'AB');
  assert.throws(() => S.textSync([Promise.resolve('bad')]), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(await S.text([Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac)]), '€');
  assert.deepEqual([...new Uint8Array(await S.arrayBuffer(['a', 'b']))], [97, 98]);
  assert.deepEqual([...new Uint8Array(S.arrayBufferSync(['c', 'd']))], [99, 100]);
  assert.deepEqual((await S.array(['a', 'b'])).map(x => Buffer.from(x).toString()), ['a', 'b']);
  assert.deepEqual(S.arraySync(['c', 'd']).map(x => Buffer.from(x).toString()), ['c', 'd']);

  let reads = 0;
  let closed = 0;
  function* source() { try { reads++; yield 'one'; reads++; yield 'two'; } finally { closed++; } }
  const pipeline = S.pullSync(source(), batch => batch === null ? '!' : string(batch).toUpperCase());
  assert.equal(reads, 0);
  const iterator = pipeline[Symbol.iterator]();
  assert.equal(string(iterator.next().value), 'ONE');
  assert.equal(reads, 1);
  iterator.return();
  assert.equal(closed, 1);
  assert.equal(S.textSync(S.pullSync(['x'], batch => batch === null ? '!' : batch)), 'x!');

  const stateful = {
    *transform(source) {
      for (const batch of source) yield batch === null ? ['end'] : batch;
    },
  };
  assert.equal(S.textSync(S.pullSync(['start:'], stateful)), 'start:end');
  let tapped = '';
  assert.equal(await S.text(S.pull(['x', 'y'], S.tap(batch => { if (batch) tapped += string(batch); }))), 'xy');
  assert.equal(tapped, 'xy');
  let syncTapped = '';
  assert.equal(S.textSync(S.pullSync(['z'], S.tapSync(batch => { if (batch) syncTapped += string(batch); }))), 'z');
  assert.equal(syncTapped, 'z');
  const merged = await S.array(S.merge(['a'], (async function*() { yield 'b'; })()));
  assert.deepEqual(merged.map(x => Buffer.from(x).toString()).sort(), ['a', 'b']);

  const reason = new Error('source failure');
  let failed;
  await assert.rejects(S.pipeTo((async function*() { yield 'a'; throw reason; })(), {
    write() {}, fail(error) { failed = error; },
  }), error => error === reason);
  assert.equal(failed, reason);
  let syncWrites = '', ended = false;
  assert.equal(S.pipeToSync(['a', 'b'], {
    writeSync(chunk) { syncWrites += Buffer.from(chunk).toString(); return true; },
    endSync() { ended = true; return 2; },
  }), 2);
  assert.equal(syncWrites, 'ab');
  assert.equal(ended, true);

  const abort = new AbortController();
  let returned = false;
  let releaseRead;
  const blocked = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => { releaseRead = resolve; }); },
    return() { returned = true; return Promise.resolve({ done: true }); },
  };
  const pending = S.text(S.pull(blocked, { signal: abort.signal }));
  await tick();
  abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
  // Abort rejects promptly; the generator's queued return owns cleanup once
  // the already-pending upstream read settles.
  assert.equal(returned, false);
  releaseRead({ done: false, value: 'late' });
  await tick();
  assert.equal(returned, true);
  await assert.rejects(S.bytes(['abcd'], { limit: 3 }), { code: 'ERR_OUT_OF_RANGE' });
}

async function pushAndDuplex() {
  const { writer, readable } = S.push({ budget: 16384, backpressure: 'strict' });
  const chunk = Buffer.alloc(16384, 65);
  assert.equal(writer.writeSync(chunk), true);
  assert.equal(writer.writeSync('B'), false);
  let settled = false;
  const blocked = writer.write('B').then(() => { settled = true; });
  const drained = S.ondrain(writer);
  await tick();
  assert.equal(settled, false);
  await assert.rejects(writer.write('C'), { code: 'ERR_INVALID_STATE' });
  const iterator = readable[Symbol.asyncIterator]();
  assert.equal(string((await iterator.next()).value), 'A'.repeat(16384));
  await blocked;
  assert.equal(settled, true);
  await drained;
  writer.endSync();
  assert.equal(string((await iterator.next()).value), 'B');
  assert.equal((await iterator.next()).done, true);

  const cancelled = S.push();
  const consumer = cancelled.readable[Symbol.asyncIterator]();
  await consumer.return();
  await assert.rejects(cancelled.writer.write('late'), { code: 'ERR_INVALID_STATE' });
  assert.equal(cancelled.writer.canWrite, null);

  const failed = S.push();
  const failure = new Error('writer failure');
  const reading = S.text(failed.readable);
  failed.writer.fail(failure);
  await assert.rejects(reading, error => error === failure);

  for (const policy of ['drop-oldest', 'drop-newest']) {
    const p = S.push({ budget: 16384, backpressure: policy });
    p.writer.writeSync(Buffer.alloc(16384, 65));
    p.writer.writeSync(Buffer.alloc(16384, 66));
    p.writer.endSync();
    assert.equal(await S.text(p.readable), (policy === 'drop-oldest' ? 'B' : 'A').repeat(16384));
  }

  const [a, b] = S.duplex();
  const aText = S.text(a.readable);
  const bText = S.text(b.readable);
  await a.writer.write('a-to-b');
  await b.writer.write('b-to-a');
  await Promise.all([a.writer.end(), b.writer.end()]);
  assert.equal(await aText, 'b-to-a');
  assert.equal(await bText, 'a-to-b');
  await Promise.all([a.close(), b.close()]);
}

async function fanout() {
  let pulls = 0, cleanup = 0;
  const shared = S.share((async function*() {
    try { pulls++; yield 'a'; pulls++; yield 'b'; } finally { cleanup++; }
  })());
  const one = shared.pull();
  const two = shared.pull();
  assert.equal(pulls, 0);
  assert.deepEqual(await Promise.all([S.text(one), S.text(two)]), ['ab', 'ab']);
  assert.equal(pulls, 2);
  assert.equal(cleanup, 1);

  const sync = S.shareSync(['x', 'y']);
  const left = sync.pull();
  const right = sync.pull();
  assert.equal(S.textSync(left), 'xy');
  assert.equal(S.textSync(right), 'xy');
  assert.equal(S.Share.from({ [S.shareProtocol]() { return shared; } }), shared);
  assert.equal(S.SyncShare.fromSync({ [S.shareSyncProtocol]() { return sync; } }), sync);

  const bc = S.broadcast({ budget: 16384 });
  const fast = bc.broadcast.push()[Symbol.asyncIterator]();
  const slow = bc.broadcast.push()[Symbol.asyncIterator]();
  assert.equal(bc.broadcast.consumerCount, 2);
  bc.writer.writeSync(Buffer.alloc(16384, 65));
  assert.equal(string((await fast.next()).value), 'A'.repeat(16384));
  assert.equal(bc.writer.writeSync('B'), false);
  await slow.return();
  assert.equal(bc.broadcast.consumerCount, 1);
  assert.equal(bc.writer.writeSync('B'), true);
  bc.writer.endSync();
  assert.equal(string((await fast.next()).value), 'B');
  assert.equal((await fast.next()).done, true);
  const viaProtocol = S.Broadcast.from({ [S.broadcastProtocol]() { return bc.broadcast; } });
  assert.equal(viaProtocol.broadcast, bc.broadcast);
}

async function classicAdapters() {
  const readable = Readable.from(['classic', Buffer.from('-input')]);
  assert.equal(S.fromReadable(readable), S.fromReadable(readable));
  assert.equal(await S.text(S.fromReadable(readable)), 'classic-input');
  assert.equal(await S.text(Readable.from(['direct-protocol'])), 'direct-protocol');
  const asReadable = S.toReadable(S.from(['iter', '-output']));
  assert.equal(await S.text(S.fromReadable(asReadable)), 'iter-output');
  assert.equal(await S.text(S.fromReadable(S.toReadableSync(['sync']))), 'sync');

  let data = '';
  const writable = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) { data += chunk.toString(); setImmediate(callback); },
  });
  assert.equal(await S.pipeTo(['one', 'two'], S.fromWritable(writable, { backpressure: 'unbounded' })), 6);
  await finished(writable);
  assert.equal(data, 'onetwo');

  const p = S.push();
  const collected = S.text(p.readable);
  const adapted = S.toWritable(p.writer);
  const done = finished(adapted);
  adapted.write('classic-');
  adapted.end('writer');
  await done;
  assert.equal(await collected, 'classic-writer');

  let closed = false;
  const early = S.toReadable((async function*() {
    try { yield 'first'; yield 'second'; } finally { closed = true; }
  })(), { highWaterMark: 1 });
  for await (const chunk of early) { assert.ok(chunk.length); break; }
  await tick();
  assert.equal(closed, true);
}

async function compression() {
  const input = 'A framed UTF-8 message: € and 日本語. '.repeat(256);
  const payload = Buffer.from(input);
  const chunks = () => (function*() {
    for (let i = 0; i < payload.length; i += 113) yield payload.subarray(i, i + 113);
  })();
  const formats = [
    ['Gzip', 'gzip', 'gunzip'],
    ['Deflate', 'deflate', 'inflate'],
    ['Brotli', 'brotliCompress', 'brotliDecompress'],
    ['Zstd', 'zstdCompress', 'zstdDecompress'],
  ];
  for (const [name, encode, decode] of formats) {
    const compressed = await S.bytes(S.pull(chunks(), Z['compress' + name]({ chunkSize: 128 })));
    assert.equal(zlib[decode + 'Sync'](compressed).toString(), input);
    const syncCompressed = S.bytesSync(S.pullSync(chunks(), Z['compress' + name + 'Sync']({ chunkSize: 128 })));
    assert.equal(zlib[decode + 'Sync'](syncCompressed).toString(), input);
    assert.equal(await S.text(S.pull(compressed, Z['decompress' + name]({ chunkSize: 128 }))), input);
    assert.equal(S.textSync(S.pullSync(syncCompressed, Z['decompress' + name + 'Sync']({ chunkSize: 128 }))), input);
    const native = zlib[encode + 'Sync'](payload);
    const splitFrames = (function*() { for (let i = 0; i < native.length; i++) yield native.subarray(i, i + 1); })();
    assert.equal(await S.text(S.pull(splitFrames, Z['decompress' + name]())), input);
    await assert.rejects(S.bytes(S.pull(native.subarray(0, native.length - 1), Z['decompress' + name]())));
    assert.throws(() => S.bytesSync(S.pullSync(native.subarray(0, native.length - 1), Z['decompress' + name + 'Sync']())));
    assert.equal(zlib[decode + 'Sync'](S.bytesSync(S.pullSync([], Z['compress' + name + 'Sync']()))).length, 0);
  }
  const joinedGzip = Buffer.concat([zlib.gzipSync('first'), zlib.gzipSync('second')]);
  assert.equal(await S.text(S.pull(joinedGzip, Z.decompressGzip({ chunkSize: 64 }))), 'firstsecond');
  const dictionary = Buffer.from('shared streaming dictionary words');
  const dictCompressed = S.bytesSync(S.pullSync([dictionary], Z.compressDeflateSync({ dictionary })));
  assert.deepEqual(zlib.inflateSync(dictCompressed, { dictionary }), dictionary);
  assert.throws(() => S.bytesSync(S.pullSync(['abc'], Z.compressZstdSync({ pledgedSrcSize: 2 }))), { code: 'ZSTD_error_srcSize_wrong' });
  const pledged = S.bytesSync(S.pullSync(['abc'], Z.compressZstdSync({ pledgedSrcSize: 3 })));
  assert.equal(zlib.zstdDecompressSync(pledged).toString(), 'abc');

  // Output must be available before upstream completion, not synthesized by
  // collecting the source and invoking a one-shot codec at EOF.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let closed = false;
  const inputStream = (async function*() {
    try { yield 'header'; await gate; yield 'tail'; } finally { closed = true; }
  })();
  const iterator = S.pull(inputStream, Z.compressGzip())[Symbol.asyncIterator]();
  const header = await iterator.next();
  assert.equal(header.done, false);
  const compressed = [...header.value];
  assert.deepEqual([...Buffer.concat(compressed).subarray(0, 3)], [0x1f, 0x8b, 0x08]);
  release();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    compressed.push(...next.value);
  }
  assert.equal(zlib.gunzipSync(Buffer.concat(compressed)).toString(), 'headertail');
  assert.equal(closed, true);
}

(async () => {
  await protocolsAndPipelines();
  await pushAndDuplex();
  await fanout();
  await classicAdapters();
  await compression();
  console.log('iterable streams smoke: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
