// SilkJS regression test: searches whose first-unit set has at most three members
// (skipToSet's vector path), on Latin-1 and wide inputs. Expected values come from V8.
var r = [];
var long = 'Zbmvyyn/5.0 (Jvaqbjf; H; Jvaqbjf AG 5.1; ra-HF) NccyrJroXvg/528.9 (XUGZY, yvxr Trpxb) Puebzr/2.0.157.0 Fnsnev/528.9';
var cases = [/zfvr/gi, /puebzr/i, /xutzy|yvxr/i, /[qz]v/g, /[a-c]x/g, /(?:a|b|c)9/g, /Āx/i, /ā+/g, /q?ZY/g];
var inputs = [long, long + 'ZFVR zfvr', 'xyz', '', 'ĀĀāxāā AX', 'ā' + long + 'qv 9', long.toUpperCase(), 'c9' + 'z'.repeat(40) + 'B9a9', 'āāāZYqZY'];
for (var i = 0; i < cases.length; i++) for (var j = 0; j < inputs.length; j++) {
  var m = inputs[j].match(cases[i]);
  r.push(i + ',' + j + ':' + (m ? JSON.stringify(m) + (cases[i].global ? '' : '@' + m.index) : 'null'));
}
const got = r.join('\n');
const expected = "0,0:null\n0,1:[\"ZFVR\",\"zfvr\"]\n0,2:null\n0,3:null\n0,4:null\n0,5:null\n0,6:null\n0,7:null\n0,8:null\n1,0:[\"Puebzr\"]@86\n1,1:[\"Puebzr\"]@86\n1,2:null\n1,3:null\n1,4:null\n1,5:[\"Puebzr\"]@87\n1,6:[\"PUEBZR\"]@86\n1,7:null\n1,8:null\n2,0:[\"yvxr\"]@74\n2,1:[\"yvxr\"]@74\n2,2:null\n2,3:null\n2,4:null\n2,5:[\"yvxr\"]@75\n2,6:[\"YVXR\"]@74\n2,7:null\n2,8:null\n3,0:null\n3,1:null\n3,2:null\n3,3:null\n3,4:null\n3,5:[\"qv\"]\n3,6:null\n3,7:null\n3,8:null\n4,0:null\n4,1:null\n4,2:null\n4,3:null\n4,4:null\n4,5:null\n4,6:null\n4,7:null\n4,8:null\n5,0:null\n5,1:null\n5,2:null\n5,3:null\n5,4:null\n5,5:null\n5,6:null\n5,7:[\"c9\",\"a9\"]\n5,8:null\n6,0:null\n6,1:null\n6,2:null\n6,3:null\n6,4:[\"āx\"]@2\n6,5:null\n6,6:null\n6,7:null\n6,8:null\n7,0:null\n7,1:null\n7,2:null\n7,3:null\n7,4:[\"ā\",\"āā\"]\n7,5:[\"ā\"]\n7,6:null\n7,7:null\n7,8:[\"āāā\"]\n8,0:[\"ZY\"]\n8,1:[\"ZY\"]\n8,2:null\n8,3:null\n8,4:null\n8,5:[\"ZY\"]\n8,6:[\"ZY\"]\n8,7:null\n8,8:[\"ZY\",\"qZY\"]";
console.log(got === expected ? 'PASS regexp small first sets' : 'FAIL ' + JSON.stringify(got));
if (got !== expected) throw new Error('regexp small first set regressions');
