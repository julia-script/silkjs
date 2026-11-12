// flags: --std
// WeakMap and WeakSet entries are ephemerons (ECMA-262 9.10.3, Liveness): a
// value is reachable only through a reachable key. A value that refers back to
// its own key, directly or through other weak entries, must not keep the key
// alive, and every value whose key is reachable some other way must survive.
var failures = 0;
function check(ok, what) { if (!ok) { failures++; if (failures < 10) print("bad " + what); } }
function collect() { if (typeof gc == "function") gc(); else std.gc(); }
if (typeof print != "function") globalThis.print = console.log;
var later = typeof setTimeout == "function" ? setTimeout : os.setTimeout;

var finalized = [];
var registry = new FinalizationRegistry(function (tag) { finalized.push(tag); });
var weak = {};
function track(object, tag) { registry.register(object, tag); weak[tag] = new WeakRef(object); }

var map = new WeakMap();
var set = new WeakSet();

// 1. A value holding its key: map.set(k, {owner: k}).
(function () { var key = {}; map.set(key, { owner: key }); track(key, "self"); })();
// 2. A chain through two tables: k1 -> {next: k2}, k2 -> {back: k1}.
var other = new WeakMap();
(function () {
  var k1 = {}, k2 = {};
  map.set(k1, { next: k2 }); other.set(k2, { back: k1 });
  track(k1, "chain1"); track(k2, "chain2");
})();
// 3. The key is the value itself, and a WeakSet member that holds itself.
(function () { var key = { name: "same" }; key.me = key; map.set(key, key); set.add(key); track(key, "same"); })();
// 4. A long chain in one table, each value holding the next key and its own.
(function () {
  var first = {}, key = first;
  for (var i = 0; i < 300; i++) { var next = {}; map.set(key, { own: key, next: next }); key = next; }
  map.set(key, { own: key, back: first });
  track(first, "long");
})();

// Live: a key reachable from outside keeps its value, and what that value
// reaches as a key keeps its own value in turn (resolved in later rounds).
var liveKey = {};
(function () {
  var hidden = {};
  map.set(hidden, { payload: "hidden" });
  map.set(liveKey, { payload: "live", hidden: hidden });
  // hidden's value reaches a third key only through it.
  var third = {};
  other.set(third, { payload: "third" });
  map.get(hidden).third = third;
})();
// Live chain registered in the reverse order of reachability.
var chainHead = {};
(function () {
  var keys = [];
  for (var i = 0; i < 50; i++) keys.push({ i: i });
  for (var i = 49; i >= 0; i--) map.set(keys[i], { i: i, next: i + 1 < 50 ? keys[i + 1] : null });
  map.set(chainHead, { next: keys[0] });
})();

collect();

// Values with live keys are intact.
var live = map.get(liveKey);
check(live && live.payload == "live", "live value");
var hiddenValue = live && map.get(live.hidden);
check(hiddenValue && hiddenValue.payload == "hidden", "value reached through a value");
check(hiddenValue && other.get(hiddenValue.third) && other.get(hiddenValue.third).payload == "third", "third round");
var walk = map.get(chainHead).next, count = 0;
while (walk) { var v = map.get(walk); if (!v || v.i != count) break; count++; walk = v.next; }
check(count == 50, "live chain " + count);
// Dead keys are gone after the next collection, once the WeakRefs no longer
// keep their targets (the script's job has ended).
later(function () {
  collect();
  ["self", "chain1", "chain2", "same", "long"].forEach(function (tag) { check(weak[tag].deref() === undefined, "collected " + tag); });
  // The tables still work after their entries left during the collection.
  var k = {};
  map.set(k, 1); set.add(k);
  check(map.get(k) === 1 && set.has(k) && map.get(liveKey).payload == "live", "tables usable");
  later(function () {
    finalized.sort();
    check(finalized.join() == "chain1,chain2,long,same,self", "finalized " + finalized.join());
    if (failures) throw new Error(failures + " failures");
    print("weak collection ephemerons ok");
  }, 10);
}, 0);
