// Arrays that hold no heap value are copied and dropped without a scan. Every
// way an object or string gets into such an array must be seen: a missed one
// frees the value under the array or leaks it.
function check(actual, expected, what) { if (actual !== expected) throw new Error(what + ': ' + actual + ' !== ' + expected) }
function numbers(n) { var out = []; for (var i = 0; i < n; i++) out.push(i); return out }
function fresh(i) { return { id: i, text: 'v' + i } }
function total(list) { var sum = 0; for (var i = 0; i < list.length; i++) { var v = list[i]; sum += typeof v === 'number' ? v : v === undefined ? 0 : v.id } return sum }
var ways = {
  index: function (a) { a[3] = fresh(100) },
  append: function (a) { a[a.length] = fresh(100) },
  push: function (a) { a.push(fresh(100)) },
  pushMany: function (a) { a.push(1, fresh(100), 2) },
  unshift: function (a) { a.unshift(fresh(100)) },
  splice: function (a) { a.splice(2, 1, fresh(100)) },
  fill: function (a) { a.fill(fresh(100), 1, 2) },
  copyWithin: function (a) { a[0] = fresh(100); a.copyWithin(5, 0, 1) },
  reverse: function (a) { a[0] = fresh(100); a.reverse() },
  sort: function (a) { a[0] = fresh(100); a.sort(function (x, y) { return total([x]) - total([y]) }) },
  length: function (a) { a.length = 4; a[2] = fresh(100) },
  hole: function (a) { a[a.length + 5] = fresh(100) },
  define: function (a) { Object.defineProperty(a, 1, { value: fresh(100), writable: true, enumerable: true, configurable: true }) },
  reflect: function (a) { Reflect.set(a, 1, fresh(100)) },
  destructure: function (a) { [a[0], a[1]] = [fresh(100), 7] },
  spreadCall: function (a) { a.push.apply(a, [fresh(100)]) },
  shiftThenStore: function (a) { a.shift(); a.pop(); a[0] = fresh(100) }
}
for (var name in ways) {
  for (var size = 4; size <= 80; size += 38) {
    var source = numbers(size)
    ways[name](source)
    var before = total(source)
    // Copies made every way share the values; dropping them must not free them.
    for (var round = 0; round < 4; round++) {
      var copies = [source.slice(), source.slice(1), source.concat(), [].concat(source, numbers(3)), Array.from(source), source.map(function (v) { return v }), source.filter(function () { return true }), [...source]]
      for (var c = 0; c < copies.length; c++) copies[c].length = 0
      copies = null
    }
    check(total(source), before, name + ' at ' + size)
    var found = false
    for (var i = 0; i < source.length; i++) if (typeof source[i] === 'object' && source[i] !== null) { found = true; check(source[i].text, 'v100', name + ' text') }
    check(found, true, name + ' holds its object')
  }
}
// A copy of a number-only array takes objects afterwards.
var plain = numbers(70), copy = plain.slice()
copy[5] = fresh(5); var second = copy.slice(); copy = null
check(second[5].text, 'v5', 'copy of a copy')
// Strings and floats in elements.
var texts = numbers(70); texts[69] = 'tail' + texts.length; texts[0] = 1.5
var again = texts.slice(); texts = null
check(again[69], 'tail70', 'string element'); check(again[0], 1.5, 'float element')
// arguments objects share the element store.
function args() { arguments[0] = fresh(9); return Array.prototype.slice.call(arguments) }
check(args(1, 2, 3)[0].text, 'v9', 'arguments')
console.log('ok')
