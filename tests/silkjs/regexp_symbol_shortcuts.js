// String methods that call the builtin RegExp symbol methods directly, and the
// split path that skips constructing its splitter, must stay unobservable.
var log = [];
function show(x) { log.push(JSON.stringify(x)); }

show("a-b-c".replace(/-/g, "+"));
show("a-b-c".replace(/-/, "$&$&"));
show("a-b-c".replace(/(-)/g, "[$1]"));
show("x".replace(/y/g, "z"));
show("aaa".replace(/a/g, ""));
show("a,b,,c".split(/,/));
show("a,b,,c".split(/(,)/));
show("a,b,,c".split(/,/, 2));
show("abc".split(/(?:)/));
show("".split(/,/));
show("a1b22c".match(/\d+/));
show("a1b22c".match(/\d+/g));
show("a1b22c".search(/\d\d/));

var re = /,/g;
re.lastIndex = 3;
show("a,b".split(re));
show(re.lastIndex);
show("a,b".replace(re, ";"));
show(re.lastIndex);

// An own Symbol.replace / Symbol.split on the instance takes over.
var own = /x/;
own[Symbol.replace] = function (s, r) { return "own:" + s + ":" + r; };
show("axb".replace(own, "y"));
own[Symbol.split] = function (s, l) { return ["split", s, l]; };
show("axb".split(own, 3));

// Overridden flag getters are read by split's generic path.
var reads = [];
var sticky = Object.getOwnPropertyDescriptor(RegExp.prototype, "sticky");
Object.defineProperty(RegExp.prototype, "sticky", { configurable: true, get: function () { reads.push("sticky"); return sticky.get.call(this); } });
show("a,b".split(/,/));
show(reads);
Object.defineProperty(RegExp.prototype, "sticky", sticky);

// A constructor on the instance is a species lookup.
var custom = /,/;
var seen = 0;
custom.constructor = function () { seen++; return /;/y; };
custom.constructor[Symbol.species] = custom.constructor;
show("a;b,c".split(custom));
show(seen);

// Symbol.species overridden on RegExp.
var species = Object.getOwnPropertyDescriptor(RegExp, Symbol.species);
var speciesCalls = 0;
Object.defineProperty(RegExp, Symbol.species, { configurable: true, get: function () { speciesCalls++; return RegExp; } });
show("a,b".split(/,/));
show(speciesCalls);
Object.defineProperty(RegExp, Symbol.species, species);

// An accessor @@match is read by IsRegExp when the splitter is constructed.
var matchReads = 0;
var match = Object.getOwnPropertyDescriptor(RegExp.prototype, Symbol.match);
Object.defineProperty(RegExp.prototype, Symbol.match, { configurable: true, get: function () { matchReads++; return match.value; } });
show("a,b".split(/,/));
show(matchReads > 0);
Object.defineProperty(RegExp.prototype, Symbol.match, match);

// Replaced exec is observed by replace, match and search.
var exec = RegExp.prototype.exec;
var execs = 0;
RegExp.prototype.exec = function (s) { execs++; return exec.call(this, s); };
show("a-b".replace(/-/g, "+"));
show("a1".match(/\d/));
show("a1".search(/\d/));
show(execs);
RegExp.prototype.exec = exec;

// Wide strings.
show("ā-Ă-".replace(/-/g, "ă"));
show("ā,Ă".split(/,/));

const got = log.join(";");
const expected = "\"a+b+c\";\"a--b-c\";\"a[-]b[-]c\";\"x\";\"\";[\"a\",\"b\",\"\",\"c\"];[\"a\",\",\",\"b\",\",\",\"\",\",\",\"c\"];[\"a\",\"b\"];[\"a\",\"b\",\"c\"];[\"\"];[\"1\"];[\"1\",\"22\"];3;[\"a\",\"b\"];3;\"a;b\";0;\"own:axb:y\";[\"split\",\"axb\",3];[\"a\",\"b\"];[\"sticky\"];[\"a\",\"b,c\"];1;[\"a\",\"b\"];1;[\"a\",\"b\"];true;\"a+b\";[\"1\"];1;4;\"āăĂă\";[\"ā\",\"Ă\"]";
console.log(got === expected ? "PASS regexp symbol shortcuts" : "FAIL " + got);
if (got !== expected) throw new Error("regexp symbol shortcut regressions");
