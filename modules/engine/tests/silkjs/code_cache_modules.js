// flags: --std --code-cache
// The opt-in cache keeps modules too: the main thread and each worker import the
// same module graph (a cycle, star exports, top-level await, import.meta), so the
// second worker on decodes stored modules. Every import must behave like a fresh
// compile with fresh module state.
import * as std from "std";
import * as os from "os";

async function load() {
  const lib = await import("./code_cache/lib.mjs");
  return [lib.bump(), lib.bump(), lib.count, lib.meta, lib.answer, new lib.Box(7).value,
    lib.twice(4), lib.cycle, lib.default(), lib.where()].join("|");
}

if (os.Worker.parent) {
  os.Worker.parent.onmessage = () => {
    os.Worker.parent.onmessage = null;
    load().then((result) => os.Worker.parent.postMessage(result));
  };
} else {
  const expected = await load();
  let failed = 0;
  const check = (name, got, want) => {
    if (got === want) { print("PASS", name); return; }
    failed++;
    print("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want));
  };
  check("main", expected.split("|").slice(0, 9).join("|"), "1|2|2|lib.mjs|42|7|8|function|default");
  const next = (index) => {
    if (index > 4) { if (failed) std.exit(1); return; }
    const worker = new os.Worker("./code_cache_modules.js");
    worker.onmessage = (message) => {
      worker.onmessage = null;
      check(`worker ${index}`, message.data, expected);
      next(index + 1);
    };
    worker.postMessage(null);
  };
  next(1);
}
