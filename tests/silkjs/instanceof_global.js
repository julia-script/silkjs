function P(a){this.a=a} function Q(){}
var G = P; var out=[];
var p=new P(1), q=new Q();
out.push(p instanceof G, q instanceof G, 1 instanceof G, null instanceof P);
try { out.push(p instanceof Undeclared) } catch(e) { out.push(e.constructor.name) }
try { out.push(p instanceof TDZ) } catch(e) { out.push(e.constructor.name) }
let TDZ = P;
var NotF = 3; try { out.push(p instanceof NotF) } catch(e) { out.push(e.constructor.name) }
var B = P.bind(null); out.push(p instanceof B);
var H = {[Symbol.hasInstance](v){ return v===7 }}; out.push(7 instanceof H, 8 instanceof H);
var n=0; for (var i=0;i<1000;i++) if ((i&1?p:q) instanceof G) n++; out.push(n);

// get_var followed by instanceof tests against the global without pushing it.
const expected = '[true,false,false,false,"ReferenceError","ReferenceError","TypeError",true,true,false,500]'
const got = JSON.stringify(out)
console.log(got == expected ? "PASS instanceof global" : "FAIL instanceof global " + got)
if (got != expected) throw new Error("instanceof global regressions")
