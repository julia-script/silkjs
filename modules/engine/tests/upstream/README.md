QuickJS's own `tests/*.js`, vendored from the pinned upstream revision
(bellard/quickjs 7d1c13c5, MIT), unchanged except where upstream asserts behaviour
ECMA-262 forbids (marked `SilkJS:`; test_weak_ref expects a WeakRef target freed
in the job that created it). `scripts/check.py` runs them under the SilkJS `qjs`.
`test_bjson.js` is omitted because it needs upstream's `bjson.so` C plugin.
