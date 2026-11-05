// SilkJS regression test for the frameless native paths: charCodeAt/charAt on
// flat strings, fromCharCode of one integer, and Map/Set/WeakMap/WeakSet
// get/has/delete. Each case must match the full native call (and QuickJS).
const out = [];
const flat = "héllo中!", rope = "ab" + String(Math.random() > 2) + "cd";
for (const s of [flat, rope, ""]) {
  for (const i of [0, 1, 2, 7, 8, -1, 100, 1.5, NaN, "1", undefined]) {
    out.push(s.charCodeAt(i), s.charAt(i), s.charCodeAt(), s.charAt());
  }
}
out.push(new String("xyz").charCodeAt(1), String.prototype.charCodeAt.call(123, 1), String.prototype.charAt.call(true, 0));
for (const c of [65, 0, 255, 256, 0x4e2d, 0x10041, -1, 65.7, "66"]) out.push(String.fromCharCode(c));
out.push(String.fromCharCode(), String.fromCharCode(72, 105));
try { String.prototype.charCodeAt.call(null, 0); } catch (e) { out.push(e.constructor.name); }
try { String.prototype.charAt.call(undefined, 0); } catch (e) { out.push(e.constructor.name); }
const m = new Map([[1, "a"], ["k", "b"], [NaN, "n"], [0, "z"]]);
out.push(m.get(1), m.get("k"), m.get(NaN), m.get(-0), m.get(2), m.has(-0), m.has("x"), m.delete(1), m.delete(1), m.has(1), m.size);
const st = new Set([1, "a"]);
out.push(st.has(1), st.has("1"), st.delete("a"), st.delete("a"), st.size);
const key = {}, wm = new WeakMap([[key, 5]]), ws = new WeakSet([key]);
out.push(wm.get(key), wm.get({}), wm.get(1), wm.has(key), wm.has("s"), wm.delete(1), wm.delete(key), wm.has(key));
out.push(ws.has(key), ws.has(3), ws.delete(3), ws.delete(key), ws.has(key));
try { Map.prototype.get.call(new Set(), 1); } catch (e) { out.push(e.constructor.name); }
try { Map.prototype.has.call({}, 1); } catch (e) { out.push(e.constructor.name); }
try { Set.prototype.delete.call(new Map(), 1); } catch (e) { out.push(e.constructor.name); }
out.push(Map.prototype.get.call(m, "k"));
const got = JSON.stringify(out);
const expected = '[104,"h",104,"h",233,"é",104,"h",108,"l",104,"h",null,"",104,"h",null,"",104,"h",null,"",104,"h",null,"",104,"h",233,"é",104,"h",104,"h",104,"h",233,"é",104,"h",104,"h",104,"h",97,"a",97,"a",98,"b",97,"a",102,"f",97,"a",99,"c",97,"a",100,"d",97,"a",null,"",97,"a",null,"",97,"a",98,"b",97,"a",97,"a",97,"a",98,"b",97,"a",97,"a",97,"a",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",null,"",121,50,"t","A","\\u0000","ÿ","Ā","中","A","￿","A","B","","Hi","TypeError","TypeError","a","b","n","z",null,true,false,true,false,false,3,true,false,true,false,1,5,null,null,true,false,false,true,false,true,false,false,true,false,"TypeError","TypeError","TypeError","b"]';
console.log(got === expected ? 'PASS native quick paths' : 'FAIL ' + got);
if (got !== expected) throw new Error('native quick path regressions');
