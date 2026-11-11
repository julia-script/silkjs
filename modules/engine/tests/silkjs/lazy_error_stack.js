// Error stacks are captured at throw and formatted when first observed: every
// way of observing or replacing the property must see the eager result.
function assert(value, message) { if (!value) throw new Error(message); }
function made() { return new Error("made"); }
function thrown() { try { null.x; } catch (e) { return e; } }

var e = made();
var d = Object.getOwnPropertyDescriptor(e, "stack");
assert(typeof d.value === "string" && d.writable && !d.enumerable && d.configurable, "data descriptor");
assert(d.value.indexOf("    at made (") === 0, "frame of the constructing function: " + d.value);
assert(Object.getOwnPropertyNames(e).join() === "message,stack", "own names");
assert(Object.keys(e).length === 0 && e.hasOwnProperty("stack"), "non-enumerable own property");

var t = thrown();
assert(t.stack.indexOf("    at thrown (") === 0, "engine error frame: " + t.stack);
assert(t.stack === t.stack, "formatted once, stable");

var assigned = made(); assigned.stack = 5;
assert(assigned.stack === 5, "assignment replaces the captured stack");
var deleted = made();
assert(delete deleted.stack && !("stack" in deleted), "delete removes it");
var frozen = made(); Object.freeze(frozen);
assert(typeof frozen.stack === "string" && Object.isFrozen(frozen), "freeze keeps the string");
var redefined = made(); Object.defineProperty(redefined, "stack", { value: "def" });
assert(redefined.stack === "def", "defineProperty replaces it");

// Frames outlive the functions that made them.
var kept; (function () { var f = function inner() { kept = new Error("kept"); }; f(); f = null; })();
assert(kept.stack.indexOf("    at inner (") === 0, "dropped function still named: " + kept.stack);

function rec(n) { if (n == 0) throw new Error("deep"); rec(n - 1); }
try { rec(80); } catch (deep) { assert(deep.stack.split("\n").length === 83, "deep stacks keep every frame"); }

for (var i = 0; i < 2000; i++) made();
print("ok");
