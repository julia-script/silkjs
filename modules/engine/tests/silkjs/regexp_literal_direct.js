// A pattern that is one literal run is matched without the regexp executor,
// for exec on narrow and wide inputs and for global replaces on short inputs.
// Every answer is compared with a plain indexOf model.
function assert(value, message) { if (!value) throw new Error(message); }
function same(actual, expected, message) {
    assert(actual === expected, message + ': got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function execNarrow(s) { return /needle/.exec(s); }
function execWide(s) { return /né中le/.exec(s); }
function execUnicode(s) { return /needle/u.exec(s); }
function execOne(s) { return /q/.exec(s); }
function execGlobal(re, s) { return re.exec(s); }
function replAa(s) { return s.replace(/aa/g, 'b'); }
function replDrop(s) { return s.replace(/ab/g, ''); }
function replGrow(s, r) { return s.replace(/x/g, r); }
function replNeedle(s) { return s.replace(/needle/g, '<$&>'); }
function replPlain(s) { return s.replace(/needle/g, '-'); }
function replLast(s) { return s.replace(/abcdefghijklmnopqrstuvwxyz0123456789/g, '!'); }

function modelExec(s, needle) {
    var at = s.indexOf(needle);
    return at < 0 ? null : at;
}
function modelReplace(s, needle, insert) {
    var out = '', from = 0;
    for (;;) {
        var at = s.indexOf(needle, from);
        if (at < 0) break;
        out += s.slice(from, at) + insert;
        from = at + needle.length;
    }
    return out + s.slice(from);
}
function checkExec(fn, s, needle, label) {
    var result = fn(s), want = modelExec(s, needle);
    if (want === null) { same(result, null, label + ' miss'); return; }
    assert(result !== null, label + ' should match');
    same(result.index, want, label + ' index');
    same(result[0], needle, label + ' text');
    same(result.length, 1, label + ' length');
    same(result.input, s, label + ' input');
}

var pad = '';
for (var i = 0; i < 70; i++) pad += 'ne';
var inputs = ['', 'n', 'needle', 'xneedle', 'needl', 'a needle in a needle stack', pad + 'needle', pad + 'needle' + pad,
    pad + pad + 'needl', 'need中le needle', '中中needle', 'né中le', 'xx né中le yy', 'néle', pad + 'né中le', 'q', pad + 'q' + pad];

for (var round = 0; round < 30; round++) {
    for (var k = 0; k < inputs.length; k++) {
        var s = inputs[k];
        checkExec(execNarrow, s, 'needle', 'narrow ' + k);
        checkExec(execWide, s, 'né中le', 'wide ' + k);
        checkExec(execUnicode, s, 'needle', 'unicode ' + k);
        checkExec(execOne, s, 'q', 'one ' + k);
        same(replPlain(s), modelReplace(s, 'needle', '-'), 'replace plain ' + k);
        same(replNeedle(s), modelReplace(s, 'needle', '<needle>'), 'replace $& ' + k);
    }

    // lastIndex is honoured and updated through the same path.
    var g = /needle/g, text = 'a needle in a needle stack';
    var first = execGlobal(g, text);
    same(first.index, 2, 'global first'); same(g.lastIndex, 8, 'global lastIndex');
    var second = execGlobal(g, text);
    same(second.index, 14, 'global second'); same(g.lastIndex, 20, 'global lastIndex 2');
    same(execGlobal(g, text), null, 'global end'); same(g.lastIndex, 0, 'global reset');
    var y = /needle/y;
    same(execGlobal(y, text), null, 'sticky miss');
    y.lastIndex = 2;
    same(execGlobal(y, text).index, 2, 'sticky hit'); same(y.lastIndex, 8, 'sticky lastIndex');

    // Overlapping candidates, no match, few and many matches, empty results.
    for (var n = 0; n < 80; n++) {
        var a = '';
        for (var j = 0; j < n; j++) a += 'a';
        same(replAa(a), modelReplace(a, 'aa', 'b'), 'aa run ' + n);
        same(replAa(a + 'ba' + a), modelReplace(a + 'ba' + a, 'aa', 'b'), 'aa split ' + n);
        var ab = '';
        for (var j = 0; j < n; j++) ab += 'ab';
        same(replDrop(ab), '', 'drop all ' + n);
        same(replDrop(ab + 'a'), 'a', 'drop tail ' + n);
        same(replDrop('b' + ab), 'b', 'drop head ' + n);
        var xs = '';
        for (var j = 0; j < n; j++) xs += (j % 3 == 0 ? 'x' : 'y');
        same(replGrow(xs, 'long replacement text '), modelReplace(xs, 'x', 'long replacement text '), 'grow ' + n);
        same(replGrow(xs, ''), modelReplace(xs, 'x', ''), 'shrink ' + n);
        same(replGrow(xs, '中'), modelReplace(xs, 'x', '中'), 'wide insert ' + n);
        var tail = a + 'abcdefghijklmnopqrstuvwxyz0123456789';
        same(replLast(tail), a + '!', 'match at end ' + n);
        same(replLast(tail + a), a + '!' + a, 'match inside ' + n);
        same(replLast(tail.slice(0, tail.length - 1)), tail.slice(0, tail.length - 1), 'near miss ' + n);
    }

    // Results larger than the scratch buffer.
    var many = '';
    for (var j = 0; j < 30; j++) many += 'x.';
    var big = replGrow(many, 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ');
    same(big.length, 30 * 53, 'big result length');
    same(big, modelReplace(many, 'x', 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'big result');
}

// The receiver's lastIndex is still reset by a global replace on a real RegExp.
var re = /aa/g;
re.lastIndex = 3;
same('caab'.replace(re, 'x'), 'cxb', 'object replace');
same(re.lastIndex, 0, 'object lastIndex reset');

console.log('PASS regexp_literal_direct');
