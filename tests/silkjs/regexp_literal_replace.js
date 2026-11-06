function check(c, m) { if (!c) throw new Error("fail: " + m); }
function run() {
  var s = "the quick abc brown fox jumped abc over", r, d = "+";
  for (var i = 0; i < 3; i++) {
    r = s.replace(/abc /g, "-"); check(r === "the quick -brown fox jumped -over", "g " + r);
    r = s.replace(/abc /, "-"); check(r === "the quick -brown fox jumped abc over", "first " + r);
    r = s.replace(/zzz/g, "-"); check(r === s, "none");
    r = s.replace(/a(b)c/g, d); check(r === "the quick + brown fox jumped + over", "local " + r);
    r = s.replace(/abc/y, "-"); check(r === s, "sticky " + r);
    r = s.replace(/b/g, "$&$&"); check(r.indexOf("bbr") > 0, "dollar " + r);
    r = "".replace(/x*/g, "-"); check(r === "-", "empty " + r);
  }
  var saved = RegExp.prototype[Symbol.replace];
  RegExp.prototype[Symbol.replace] = function () { return "over"; };
  for (var i = 0; i < 3; i++) { r = s.replace(/abc /g, "-"); check(r === "over", "override " + r); }
  RegExp.prototype[Symbol.replace] = saved;
  for (var i = 0; i < 3; i++) { r = s.replace(/abc /g, "-"); check(r === "the quick -brown fox jumped -over", "restored " + r); }
  var g = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags");
  Object.defineProperty(RegExp.prototype, "flags", { get: function () { return ""; }, configurable: true });
  for (var i = 0; i < 3; i++) { r = s.replace(/abc /g, "-"); check(r === "the quick -brown fox jumped abc over", "flags " + r); }
  Object.defineProperty(RegExp.prototype, "flags", g);
  var rep = String.prototype.replace;
  String.prototype.replace = function () { return "str"; };
  for (var i = 0; i < 3; i++) { r = s.replace(/abc /g, "-"); check(r === "str", "string override " + r); }
  String.prototype.replace = rep;
  var calls = 0, ex = RegExp.prototype.exec;
  RegExp.prototype.exec = function (x) { calls++; return ex.call(this, x); };
  for (var i = 0; i < 3; i++) { r = s.replace(/abc /g, "-"); }
  check(calls === 9 && r === "the quick -brown fox jumped -over", "exec override " + calls);
  RegExp.prototype.exec = ex;
}
run();
console.log("PASS regexp literal replace");
