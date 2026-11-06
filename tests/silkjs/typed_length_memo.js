// get_length on typed arrays memoizes the prototype walk to the intrinsic
// getter; every way of changing what length means must still be seen.
function len(a) { return a.length; }
const out = [];
const a = new Uint8Array(3), b = new Float64Array(5);
for (let i = 0; i < 3; i++) out.push(len(a), len(b));
// An own length on one instance.
const c = new Uint8Array(4);
Object.defineProperty(c, "length", { value: 99 });
out.push(len(c), len(a));
// A shadowing length on a class prototype.
Object.defineProperty(Uint8Array.prototype, "length", { get() { return -1; }, configurable: true });
out.push(len(a), len(b));
delete Uint8Array.prototype.length;
out.push(len(a));
// Replacing the intrinsic getter in place (same accessor shape).
const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
const desc = Object.getOwnPropertyDescriptor(typedProto, "length");
Object.defineProperty(typedProto, "length", { get() { return 7; }, configurable: true });
out.push(len(a), len(b));
Object.defineProperty(typedProto, "length", desc);
out.push(len(a), len(b));
// A new prototype for one instance.
const d = new Uint8Array(2);
Object.setPrototypeOf(d, { length: 42 });
out.push(len(d), len(a));
// Detached buffers report 0.
const e = new Int32Array(6);
out.push(len(e));
if (typeof e.buffer.transfer === "function") { e.buffer.transfer(); out.push(len(e)); } else out.push(0);
const got = out.join(",");
const expected = "3,5,3,5,3,5,99,3,-1,5,3,7,7,3,5,42,3,6,0";
if (got !== expected) throw new Error("got " + got + ", expected " + expected);
console.log("ok");
