// A new zero-reference root and the cells its destruction queues must drain
// iteratively, including a full zero stack's overflow and shared child edges.
function assert(value, message) { if (!value) throw new Error(message); }
var shared = {answer:42};
for (var round=0; round<4; round++) {
    var head = null;
    for (var i=0; i<20000; i++) head = {car:{child:shared}, cdr:head};
    assert(head.car.child === shared, 'deep root');
    head = null;
    var wide = [];
    for (var i=0; i<4000; i++) wide.push({left:{child:shared}, right:{child:shared}});
    assert(wide[3999].right.child.answer === 42, 'wide root');
    wide = null;
    var functions = [];
    for (var i=0; i<1000; i++) functions.push((function(value) {
        return function() { return value.answer; };
    })(shared));
    assert(functions[999]() === 42, 'closure root');
    functions = null;
    assert(shared.answer === 42, 'shared owner survives draining');
}
console.log('PASS zero reference drain');
