// Churn that frees blocks of several sizes in scrambled order, enough times for
// the allocator to sort its idle lists by address many times over. Every live
// object must keep its own contents through each sort.
function assert(value, message) { if (!value) throw new Error(message); }
var seed = 12345;
function next() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
function make(id) {
    switch (id % 4) {
    case 0: return {id: id};
    case 1: return {id: id, a: id + 1, b: id + 2};
    case 2: return {id: id, list: [id, id + 1, id + 2, id + 3, id + 4]};
    default: return {id: id, text: 'v' + id, pair: {car: id, cdr: null}};
    }
}
function check(o) {
    switch (o.id % 4) {
    case 0: return true;
    case 1: return o.a === o.id + 1 && o.b === o.id + 2;
    case 2: return o.list.length === 5 && o.list[4] === o.id + 4;
    default: return o.text === 'v' + o.id && o.pair.car === o.id;
    }
}
var live = [];
for (var i = 0; i < 5000; i++) live.push(make(i));
var id = 5000;
for (var round = 0; round < 400000; round++) {
    var slot = next() % live.length;
    assert(check(live[slot]), 'object ' + live[slot].id + ' kept its contents');
    live[slot] = make(id++);
}
for (var i = 0; i < live.length; i++) assert(check(live[i]), 'final object ' + live[i].id);
console.log('PASS idle list sort');
