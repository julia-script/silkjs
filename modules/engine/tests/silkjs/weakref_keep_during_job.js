// A WeakRef keeps its target alive to the end of the job that created it or
// called deref() (ECMA-262 AddToKeptObjects / ClearKeptObjects), even after the
// last strong reference goes. Expected values are what node prints.
const log = [];
let o = {}; const w = new WeakRef(o); o = null;
log.push('new:' + typeof w.deref());
let s = Symbol('s'); const ws = new WeakRef(s); s = null;
log.push('symbol:' + typeof ws.deref());
const held = new Set(); let f = () => 1; const wf = new WeakRef(f); held.add(f); f = null;
for (let i = 0; i < 1000; i++) wf.deref();
Promise.resolve().then(() => {
  // A later job: deref() first keeps the target, so dropping it now is safe.
  log.push('deref:' + typeof wf.deref());
  held.clear();
  log.push('cleared:' + typeof wf.deref());
}).then(() => {
  const got = log.join(' ');
  const expected = 'new:object symbol:symbol deref:function cleared:function';
  if (got !== expected) throw new Error('expected ' + expected + ', got ' + got);
  print('weakref keep during job ok');
});
