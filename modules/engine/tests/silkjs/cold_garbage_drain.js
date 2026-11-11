// Dropping a structure that has gone cold (far larger than the cache, with
// objects, arrays, strings, closures and shared children interleaved) must
// free every cell exactly once, whichever order the drain releases them in.
function assert(value, message) { if (!value) throw new Error(message); }
var shared = {answer: 42, list: [1, 2, 3]};

function node(depth, seed) {
    if (depth === 0) {
        return {
            key: seed,
            text: 'leaf ' + seed,
            pair: [seed, {child: shared}],
            read: function() { return shared.answer + seed; },
        };
    }
    return {
        key: seed,
        left: node(depth - 1, seed * 2),
        right: node(depth - 1, seed * 2 + 1),
        values: [shared, 'branch ' + seed, [seed, seed + 1], null, 1.5],
        owner: shared,
    };
}

function sum(tree) {
    var total = tree.key;
    if (tree.left) total += sum(tree.left) + sum(tree.right);
    return total;
}

for (var round = 0; round < 3; round++) {
    // Several trees built in turn so their cells interleave in memory, then a
    // large unrelated allocation to push all of them out of the cache.
    var trees = [];
    for (var i = 0; i < 4; i++) trees.push(node(14, 1));
    var filler = [];
    for (var i = 0; i < 200000; i++) filler.push({index: i, text: 'filler ' + i});
    assert(sum(trees[0]) === 536854528, 'tree intact before drop');
    assert(trees[3].left.right.values[0] === shared, 'shared child');
    // A survivor inside a dropped tree keeps its own subtree alive.
    var kept = trees[1].left.left;
    var keptSum = sum(kept);
    trees = null;
    assert(sum(kept) === keptSum, 'kept subtree survives the drain');
    assert(kept.values[1] === 'branch 4', 'kept strings survive the drain');
    kept = null;
    // A wide array of cold objects and a long cold chain.
    var chain = null;
    for (var i = 0; i < filler.length; i += 2) chain = {car: filler[i], cdr: chain};
    filler = null;
    assert(chain.car.index === 199998, 'chain head');
    assert(chain.cdr.cdr.car.text === 'filler 199994', 'chain text');
    chain = null;
    assert(shared.answer === 42 && shared.list.length === 3, 'shared owner survives');
}
console.log('PASS cold garbage drain');
