// Integer fast paths must promote overflowing results and preserve signed zero.
function add(x, y) { return x + y; }
function subtract(x, y) { return x - y; }
function multiply(x, y) { return x * y; }

var cases = [
    [2147483647, 1, 2147483648, 2147483646, 2147483647],
    [-2147483648, -1, -2147483649, -2147483647, 2147483648],
    [-2147483648, 1, -2147483647, -2147483649, -2147483648],
    [2147483647, -1, 2147483646, 2147483648, -2147483647],
    [46340, 46340, 92680, 0, 2147395600],
    [46341, 46341, 92682, 0, 2147488281],
    [-46341, 46341, 0, -92682, -2147488281],
    [2147483647, 2147483647, 4294967294, 0, 4611686014132420600],
    [-2147483648, -2147483648, -4294967296, 0, 4611686018427388000],
    [0, -1, -1, 1, -0],
    [-1, 0, -1, -1, -0],
    [-0, 1, 1, -1, -0],
    [0, 0, 0, 0, 0],
    [-0, -0, -0, 0, 0],
    [NaN, 1, NaN, NaN, NaN],
    [Infinity, 0, Infinity, Infinity, NaN]
];

for (var i = 0; i < cases.length; i++) {
    var row = cases[i];
    var actual = [add(row[0], row[1]), subtract(row[0], row[1]), multiply(row[0], row[1])];
    for (var j = 0; j < actual.length; j++) {
        if (!Object.is(actual[j], row[j + 2]))
            throw new Error('arithmetic case ' + i + ', operation ' + j);
    }
}

// Intermediate results that cross the Int boundary must feed later operations
// as ordinary numbers, including the shifts used by multiword multiplication.
function carry(x, y, z) { return ((x * y + z) >> 28) + ((x * y) & 0xfffffff); }
if (carry(16383, 16383, 268435455) !== 268402690)
    throw new Error('multiply/add carry');
