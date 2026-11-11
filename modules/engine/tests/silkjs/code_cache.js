// flags: --std --code-cache
// The opt-in script cache (--code-cache) stores a global script on its second
// load and decodes it from then on, here and in workers. Every load must behave
// exactly like a fresh compile: same results, source text, line numbers, and
// closures over fresh state.
import * as std from "std";
import * as os from "os";

const library = `
var lib = (function () {
  "use strict";
  var counter = 0;
  class Shape {
    #side;
    constructor(side) { this.#side = side; }
    get area() { return this.#side * this.#side; }
    static of(n) { return new Shape(n); }
  }
  function* range(n) { for (let i = 0; i < n; i++) yield i; }
  async function later(x) { await null; return x * 2; }
  function scoped() {
    let total = 0;
    const add = (v) => { total += v; return () => total; };
    for (const v of range(4)) add(v);
    return add(0)();
  }
  function unused(a, b) { return [a, b].map((v) => v + 1).join(","); }
  // Each case on a string carries its atom twice: in the fusion prefix and in
  // the push it covers. A decoding runtime has other atom numbers for both.
  function kind(word) {
    switch (word) {
      case "cache-alpha": return 1;
      case "cache-beta": return 2;
      case "cache-gamma": return 3;
      default: return 0;
    }
  }
  // The prefixes of a comparison before a branch and of a loop's last test
  // name their operands again; a decoded copy is checked against them.
  function loops(n, m) {
    var c = 0, i, j = n;
    for (i = 0; i < n; i++) c += i;
    while (j-- > 0) c++;
    for (i = 0; i < 300; i++) if (i < m) c++;
    do { c += 2; } while (--m >= 0);
    return c + "/" + i + "/" + j + "/" + m;
  }
  function where() { try { null.f(); } catch (e) { return e.stack.split("\\n")[1].trim(); } }
  return {
    bump() { return ++counter; },
    area: Shape.of(7).area,
    scoped: scoped(),
    kinds: ["cache-gamma", "cache-alpha", "other", "cache-beta"].map(kind).join(""),
    loops: loops(5, 20),
    text: unused.toString(),
    tag: String.raw\`a\${1 + 1}b\`,
    re: /(\\d+)-(\\d+)/.exec("x 12-34")[2],
    later,
    where,
  };
})();
lib;
`;

function load(source) {
  const lib = std.evalScript(source);
  return [lib.bump(), lib.bump(), lib.area, lib.scoped, lib.text, lib.tag, lib.re, lib.where(), lib.kinds, lib.loops].join("|");
}

let failed = 0;
function check(name, got, want) {
  if (got === want) { print("PASS", name); return; }
  failed++;
  print("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want));
}

if (os.Worker.parent) {
  // A worker has its own runtime: its loads decode the parent's stored bytecode.
  os.Worker.parent.onmessage = (message) => {
    os.Worker.parent.onmessage = null;
    os.Worker.parent.postMessage([load(message.data), load(message.data)]);
  };
} else {
  // Loads 1 and 2 compile (the second stores), 3 and later decode.
  const expected = load(library);
  check("fresh state per load", expected.split("|").slice(0, 2).join(), "1,2");
  check("results", expected.split("|").slice(2, 7).join("|"),
    "49|6|function unused(a, b) { return [a, b].map((v) => v + 1).join(\",\"); }|a2b|34");
  check("string switch", expected.split("|")[8], "3102");
  check("loop tests", expected.split("|")[9], "77/300/-1/-1");
  for (let i = 2; i <= 4; i++) check(`load ${i}`, load(library), expected);
  check("edited script misses", load(library.replace("7).area", "8).area")).split("|")[2], "64");
  std.evalScript(library).later(21).then((v) => check("async function", v, 42));

  const worker = new os.Worker("./code_cache.js");
  worker.onmessage = (message) => {
    worker.onmessage = null;
    check("worker load 1", message.data[0], expected);
    check("worker load 2", message.data[1], expected);
    if (failed) std.exit(1);
  };
  worker.postMessage(library);
}
