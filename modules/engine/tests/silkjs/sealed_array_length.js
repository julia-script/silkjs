// A refused element add on a non-extensible Array must leave length alone.
function check(actual, expected, what) { if (actual !== expected) throw new Error(what + ': ' + actual + ' !== ' + expected) }
function store(target, index, value) { target[index] = value }
var sealed = Object.seal([1, 2]); sealed[2] = 3
check(sealed.length, 2, 'sealed append'); check(sealed[2], undefined, 'sealed element')
store(sealed, 7, 1); check(sealed.length, 2, 'sealed far store')
var pushed = Object.seal([1, 2]); var threw = false
try { pushed.push(3) } catch (error) { threw = error instanceof TypeError }
check(threw, true, 'sealed push throws'); check(pushed.length, 2, 'sealed push')
var frozen = Object.freeze([1, 2]); frozen[2] = 3; store(frozen, 9, 1); check(frozen.length, 2, 'frozen')
var closed = Object.preventExtensions([1, 2]); closed[2] = 3; store(closed, 9, 1); check(closed.length, 2, 'closed')
closed[0] = 5; check(closed[0], 5, 'closed overwrite')
var holey = Object.preventExtensions([1, , 3]); holey[1] = 2; check(holey.length, 3, 'holey'); check(1 in holey, false, 'hole stays')
var strictThrew = false
;(function () { 'use strict'; var target = Object.seal([1, 2]); try { target[2] = 3 } catch (error) { strictThrew = error instanceof TypeError } check(target.length, 2, 'strict') })()
check(strictThrew, true, 'strict store throws')
var defined = Object.seal([1, 2]); threw = false
try { Object.defineProperty(defined, 4, { value: 1 }) } catch (error) { threw = error instanceof TypeError }
check(threw, true, 'define throws'); check(defined.length, 2, 'define')
check(Reflect.set(Object.seal([1]), 3, 1), false, 'Reflect.set')
console.log('ok')
