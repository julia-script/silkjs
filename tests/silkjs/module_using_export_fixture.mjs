export let disposed = false;
using resource = { name: 'r', [Symbol.dispose]() { if (disposed) throw new Error('disposed twice'); disposed = true; } };
export { resource };
export function readResource() { return resource; }
if (disposed) throw new Error('disposed before module evaluation completed');
