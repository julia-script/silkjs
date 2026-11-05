// SilkJS regression test: replace with a pattern that is one Latin-1 literal searches without
// the matcher (latinReplace's literal path). Expected values come from V8.
var r = [];
var subjects = ['aad2bd2d2', 'd2', '', 'xyz', 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2', '%3P%3R%3q', 'abc abc abcabc', 'ā d2 ā'];
var pats = [/d2/g, /d2/, /%3P/g, /abc /g, /abcabc/g, /a/g, /zz/g];
for (var i = 0; i < pats.length; i++) for (var j = 0; j < subjects.length; j++) {
  pats[i].lastIndex = 3; r.push(i + ',' + j + ':' + subjects[j].replace(pats[i], '-') + ':' + pats[i].lastIndex);
}
var g = /d2/g; g.lastIndex = 2; r.push('d2d2'.replace(g, '$&!'), g.lastIndex);
r.push('xd2x'.replace(/d2/gy, '_'), 'd2xd2'.replace(/d2/gy, '_'));
const got = r.join('\n');
const expected = "0,0:aa-b--:0\n0,1:-:0\n0,2::0\n0,3:xyz:0\n0,4:------------------:0\n0,5:%3P%3R%3q:0\n0,6:abc abc abcabc:0\n0,7:ā - ā:0\n1,0:aa-bd2d2:3\n1,1:-:3\n1,2::3\n1,3:xyz:3\n1,4:-d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:3\n1,5:%3P%3R%3q:3\n1,6:abc abc abcabc:3\n1,7:ā - ā:3\n2,0:aad2bd2d2:0\n2,1:d2:0\n2,2::0\n2,3:xyz:0\n2,4:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:0\n2,5:-%3R%3q:0\n2,6:abc abc abcabc:0\n2,7:ā d2 ā:0\n3,0:aad2bd2d2:0\n3,1:d2:0\n3,2::0\n3,3:xyz:0\n3,4:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:0\n3,5:%3P%3R%3q:0\n3,6:--abcabc:0\n3,7:ā d2 ā:0\n4,0:aad2bd2d2:0\n4,1:d2:0\n4,2::0\n4,3:xyz:0\n4,4:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:0\n4,5:%3P%3R%3q:0\n4,6:abc abc -:0\n4,7:ā d2 ā:0\n5,0:--d2bd2d2:0\n5,1:d2:0\n5,2::0\n5,3:xyz:0\n5,4:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:0\n5,5:%3P%3R%3q:0\n5,6:-bc -bc -bc-bc:0\n5,7:ā d2 ā:0\n6,0:aad2bd2d2:0\n6,1:d2:0\n6,2::0\n6,3:xyz:0\n6,4:d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2:0\n6,5:%3P%3R%3q:0\n6,6:abc abc abcabc:0\n6,7:ā d2 ā:0\nd2!d2!\n0\nxd2x\n_xd2";
console.log(got === expected ? 'PASS regexp literal replace' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp literal replace regressions');
