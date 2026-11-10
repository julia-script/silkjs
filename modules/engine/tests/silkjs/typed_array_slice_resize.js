// SilkJS regression test: TypedArray.prototype.slice when argument coercion
// shrinks a length-tracking view to zero (test262
// built-ins/TypedArray/prototype/slice/resize-count-bytes-to-zero.js). With a
// start past the new end there is nothing to copy; SilkJS used to trap here.
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
let failed = 0;
for (const TA of [Uint8Array, Int16Array, Float64Array, BigInt64Array]) {
  for (let startIndex = 0; startIndex <= 4; startIndex++) {
    const buffer = new ArrayBuffer(4 * TA.BYTES_PER_ELEMENT, { maxByteLength: 4 * TA.BYTES_PER_ELEMENT });
    const ta = new TA(buffer);
    ta.fill(TA === BigInt64Array ? 1n : 1);
    const start = { valueOf() { buffer.resize(0); return startIndex; } };
    const sliced = ta.slice(start);
    const zero = TA === BigInt64Array ? 0n : 0;
    const ok = sliced.length === 4 - startIndex && Array.prototype.every.call(sliced, (v) => v === zero);
    if (!ok) { failed++; print('FAIL ' + TA.name + ' start ' + startIndex + ' -> ' + String(sliced)); }
  }
}
print(failed ? failed + ' failed' : 'all passed');
if (failed) throw new Error('typed array slice resize regressions');
