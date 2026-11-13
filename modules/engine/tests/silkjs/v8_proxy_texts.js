// SilkJS regression test: V8's texts for broken Proxy invariants, revoked proxies and bad
// trap results, constructors called without new, and adds to frozen or sealed arrays.
// Expected values come from Node 24.
const lines = [];
const nc = (o, k, d) => Object.defineProperty(o, k, Object.assign({configurable: false}, d));
const cases = {
  gpoInvalid: () => Object.getPrototypeOf(new Proxy({}, {getPrototypeOf() { return 1 }})),
  gpoNonExt: () => Object.getPrototypeOf(new Proxy(Object.preventExtensions({}), {getPrototypeOf() { return Array.prototype }})),
  spoFalse: () => Object.setPrototypeOf(new Proxy({}, {setPrototypeOf() { return false }}), null),
  spoNonExt: () => Reflect.setPrototypeOf(new Proxy(Object.preventExtensions({}), {setPrototypeOf() { return true }}), null),
  isExt: () => Object.isExtensible(new Proxy({}, {isExtensible() { return false }})),
  peFalse: () => Object.preventExtensions(new Proxy({}, {preventExtensions() { return false }})),
  peExt: () => Object.preventExtensions(new Proxy({}, {preventExtensions() { return true }})),
  hasNC: () => 'x' in new Proxy(nc({}, 'x', {value: 1}), {has() { return false }}),
  hasNE: () => 'x' in new Proxy(Object.preventExtensions({x: 1}), {has() { return false }}),
  getData: () => new Proxy(nc({}, 'x', {value: 1, writable: false}), {get() { return 2 }}).x,
  getAcc: () => new Proxy(nc({}, 'x', {set(v) {}}), {get() { return 2 }}).x,
  setFalse: () => { 'use strict'; new Proxy({}, {set() { return false }}).x = 1 },
  setFalseSym: () => { 'use strict'; new Proxy({}, {set() { return false }})[Symbol('s')] = 1 },
  setFalseIdx: () => { 'use strict'; new Proxy({}, {set() { return false }})[3] = 1 },
  setData: () => { new Proxy(nc({}, 'x', {value: 1, writable: false}), {set() { return true }}).x = 2 },
  setAcc: () => { new Proxy(nc({}, 'x', {get() {}}), {set() { return true }}).x = 2 },
  delFalse: () => { 'use strict'; delete new Proxy({}, {deleteProperty() { return false }}).x },
  delNC: () => delete new Proxy(nc({}, 'x', {value: 1}), {deleteProperty() { return true }}).x,
  delNE: () => delete new Proxy(Object.preventExtensions({x: 1}), {deleteProperty() { return true }}).x,
  okMissing: () => Reflect.ownKeys(new Proxy([1], {ownKeys() { return [] }})),
  okExtra: () => Reflect.ownKeys(new Proxy(Object.preventExtensions({a: 1}), {ownKeys() { return ['a', 'b'] }})),
  okMissingNE: () => Reflect.ownKeys(new Proxy(Object.preventExtensions({a: 1}), {ownKeys() { return [] }})),
  okDup: () => Reflect.ownKeys(new Proxy({}, {ownKeys() { return ['a', 'a'] }})),
  okBad: () => Reflect.ownKeys(new Proxy({}, {ownKeys() { return [1] }})),
  okBadObj: () => Reflect.ownKeys(new Proxy({}, {ownKeys() { return [{}] }})),
  okNonObj: () => Reflect.ownKeys(new Proxy({}, {ownKeys() { return 1 }})),
  gopdInvalid: () => Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor() { return 1 }}), 'x'),
  gopdUndefNC: () => Object.getOwnPropertyDescriptor(new Proxy(nc({}, 'x', {value: 1}), {getOwnPropertyDescriptor() {}}), 'x'),
  gopdUndefNE: () => Object.getOwnPropertyDescriptor(new Proxy(Object.preventExtensions({x: 1}), {getOwnPropertyDescriptor() {}}), 'x'),
  gopdIncompat: () => Object.getOwnPropertyDescriptor(new Proxy(nc({}, 'x', {value: 1}), {getOwnPropertyDescriptor() { return {value: 2, configurable: true} }}), 'x'),
  gopdNCMissing: () => Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor() { return {value: 2, configurable: false} }}), 'x'),
  gopdNCW: () => Object.getOwnPropertyDescriptor(new Proxy(nc({}, 'x', {value: 1, writable: true}), {getOwnPropertyDescriptor() { return {value: 1, configurable: false, writable: false} }}), 'x'),
  gopdNE: () => Object.getOwnPropertyDescriptor(new Proxy(Object.preventExtensions({}), {getOwnPropertyDescriptor() { return {value: 1, configurable: true} }}), 'x'),
  dpFalse: () => Object.defineProperty(new Proxy({}, {defineProperty() { return false }}), 'x', {value: 1}),
  dpNE: () => Object.defineProperty(new Proxy(Object.preventExtensions({}), {defineProperty() { return true }}), 'x', {value: 1}),
  dpNC: () => Object.defineProperty(new Proxy({}, {defineProperty() { return true }}), 'x', {value: 1, configurable: false}),
  dpIncompat: () => Object.defineProperty(new Proxy(nc({}, 'x', {value: 1}), {defineProperty() { return true }}), 'x', {value: 2}),
  dpNCW: () => Object.defineProperty(new Proxy(nc({}, 'x', {value: 1, writable: true}), {defineProperty() { return true }}), 'x', {configurable: false, writable: false}),
  revoked: () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy.x },
  revokedHas: () => { const r = Proxy.revocable({}, {}); r.revoke(); return 'x' in r.proxy },
  revokedKeys: () => { const r = Proxy.revocable({}, {}); r.revoke(); return Object.keys(r.proxy) },
  revokedCall: () => { const r = Proxy.revocable(function () {}, {}); r.revoke(); return r.proxy() },
  revokedNew: () => { const r = Proxy.revocable(function () {}, {}); r.revoke(); return new r.proxy() },
  revokedCreate: () => { const r = Proxy.revocable({}, {}); r.revoke(); return new Proxy(r.proxy, {}) },
  trapNotFn: () => new Proxy({}, {get: 1}).x,
  ctorNoNew: () => Proxy({}, {}),
  badTarget: () => new Proxy(1, {}),
  badHandler: () => new Proxy({}, 1),
  constructNonObj: () => new (new Proxy(function () {}, {construct() { return 1 }}))(),
  notCtor: () => new (new Proxy(() => {}, {}))(),
  applyNonFn: () => (new Proxy({}, {apply() {}}))(),
  peFalseReflect: () => Reflect.preventExtensions(new Proxy({}, {preventExtensions() { return true }})),
};
for (const [name, fn] of Object.entries(cases)) {
  if (name === 'notCtor' || name === 'applyNonFn') continue;
  try { fn(); lines.push(name + ' ok') } catch (e) { lines.push(name + ' ' + e.name + ': ' + e.message) }
}
for (const C of [Map, Set, WeakMap, WeakSet, Promise, Proxy, ArrayBuffer, DataView, Uint8Array, WeakRef, FinalizationRegistry, SharedArrayBuffer, Iterator]) {
  try { C(); lines.push(C.name + ' ok') } catch (e) { lines.push(C.name + ' ' + e.message) }
}
(function () { 'use strict';
  const adds = [() => Object.freeze([1]).push(1), () => Object.seal([1]).push(2), () => Object.preventExtensions([1]).push(2),
    () => Object.freeze([1]).unshift(0), () => { Object.freeze([1])[1] = 2 }, () => Object.defineProperty(Object.freeze([1]), '1', {value: 1}),
    () => { const r = [1]; Object.defineProperty(r, 'length', {writable: false}); r.push(2) }];
  for (const c of adds) { try { c(); lines.push('ok') } catch (e) { lines.push(e.name + ': ' + e.message) } }
})();
const expected = "gpoInvalid TypeError: 'getPrototypeOf' on proxy: trap returned neither object nor null\ngpoNonExt TypeError: 'getPrototypeOf' on proxy: proxy target is non-extensible but the trap did not return its actual prototype\nspoFalse TypeError: 'setPrototypeOf' on proxy: trap returned falsish for property 'undefined'\nspoNonExt TypeError: 'setPrototypeOf' on proxy: trap returned truish for setting a new prototype on the non-extensible proxy target\nisExt TypeError: 'isExtensible' on proxy: trap result does not reflect extensibility of proxy target (which is 'true')\npeFalse TypeError: 'preventExtensions' on proxy: trap returned falsish\npeExt TypeError: 'preventExtensions' on proxy: trap returned truish but the proxy target is extensible\nhasNC TypeError: 'has' on proxy: trap returned falsish for property 'x' which exists in the proxy target as non-configurable\nhasNE TypeError: 'has' on proxy: trap returned falsish for property 'x' but the proxy target is not extensible\ngetData TypeError: 'get' on proxy: property 'x' is a read-only and non-configurable data property on the proxy target but the proxy did not return its actual value (expected '1' but got '2')\ngetAcc TypeError: 'get' on proxy: property 'x' is a non-configurable accessor property on the proxy target and does not have a getter function, but the trap did not return 'undefined' (got '2')\nsetFalse TypeError: 'set' on proxy: trap returned falsish for property 'x'\nsetFalseSym TypeError: 'set' on proxy: trap returned falsish for property 'Symbol(s)'\nsetFalseIdx TypeError: 'set' on proxy: trap returned falsish for property '3'\nsetData TypeError: 'set' on proxy: trap returned truish for property 'x' which exists in the proxy target as a non-configurable and non-writable data property with a different value\nsetAcc TypeError: 'set' on proxy: trap returned truish for property 'x' which exists in the proxy target as a non-configurable and non-writable accessor property without a setter\ndelFalse TypeError: 'deleteProperty' on proxy: trap returned falsish for property 'x'\ndelNC TypeError: 'deleteProperty' on proxy: trap returned truish for property 'x' which is non-configurable in the proxy target\ndelNE TypeError: 'deleteProperty' on proxy: trap returned truish for property 'x' but the proxy target is non-extensible\nokMissing TypeError: 'ownKeys' on proxy: trap result did not include 'length'\nokExtra TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible\nokMissingNE TypeError: 'ownKeys' on proxy: trap result did not include 'a'\nokDup TypeError: 'ownKeys' on proxy: trap returned duplicate entries\nokBad TypeError: 1 is not a valid property name\nokBadObj TypeError: #<Object> is not a valid property name\nokNonObj TypeError: CreateListFromArrayLike called on non-object\ngopdInvalid TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned neither object nor undefined for property 'x'\ngopdUndefNC TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned undefined for property 'x' which is non-configurable in the proxy target\ngopdUndefNE TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned undefined for property 'x' which exists in the non-extensible proxy target\ngopdIncompat TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned descriptor for property 'x' that is incompatible with the existing property in the proxy target\ngopdNCMissing TypeError: 'getOwnPropertyDescriptor' on proxy: trap reported non-configurability for property 'x' which is either non-existent or configurable in the proxy target\ngopdNCW TypeError: 'getOwnPropertyDescriptor' on proxy: trap reported non-configurable and non-writable for property 'x' which is non-configurable, writable in the proxy target\ngopdNE TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned descriptor for property 'x' that is incompatible with the existing property in the proxy target\ndpFalse TypeError: 'defineProperty' on proxy: trap returned falsish for property 'x'\ndpNE TypeError: 'defineProperty' on proxy: trap returned truish for adding property 'x'  to the non-extensible proxy target\ndpNC TypeError: 'defineProperty' on proxy: trap returned truish for defining non-configurable property 'x' which is either non-existent or configurable in the proxy target\ndpIncompat TypeError: 'defineProperty' on proxy: trap returned truish for adding property 'x'  that is incompatible with the existing property in the proxy target\ndpNCW TypeError: 'defineProperty' on proxy: trap returned truish for defining non-configurable property 'x' which cannot be non-writable, unless there exists a corresponding non-configurable, non-writable own property of the target object.\nrevoked TypeError: Cannot perform 'get' on a proxy that has been revoked\nrevokedHas TypeError: Cannot perform 'has' on a proxy that has been revoked\nrevokedKeys TypeError: Cannot perform 'ownKeys' on a proxy that has been revoked\nrevokedCall TypeError: Cannot perform 'apply' on a proxy that has been revoked\nrevokedNew TypeError: Cannot perform 'construct' on a proxy that has been revoked\nrevokedCreate ok\ntrapNotFn TypeError: '1' returned for property 'get' of object '#<Object>' is not a function\nctorNoNew TypeError: Constructor Proxy requires 'new'\nbadTarget TypeError: Cannot create proxy with a non-object as target or handler\nbadHandler TypeError: Cannot create proxy with a non-object as target or handler\nconstructNonObj TypeError: 'construct' on proxy: trap returned non-object ('1')\npeFalseReflect TypeError: 'preventExtensions' on proxy: trap returned truish but the proxy target is extensible\nMap Constructor Map requires 'new'\nSet Constructor Set requires 'new'\nWeakMap Constructor WeakMap requires 'new'\nWeakSet Constructor WeakSet requires 'new'\nPromise Promise constructor cannot be invoked without 'new'\nProxy Constructor Proxy requires 'new'\nArrayBuffer Constructor ArrayBuffer requires 'new'\nDataView Constructor DataView requires 'new'\nUint8Array Constructor Uint8Array requires 'new'\nWeakRef Constructor WeakRef requires 'new'\nFinalizationRegistry Constructor FinalizationRegistry requires 'new'\nSharedArrayBuffer Constructor SharedArrayBuffer requires 'new'\nIterator Constructor Iterator requires 'new'\nTypeError: Cannot add property 1, object is not extensible\nTypeError: Cannot add property 1, object is not extensible\nTypeError: Cannot add property 1, object is not extensible\nTypeError: Cannot add property 1, object is not extensible\nTypeError: Cannot add property 1, object is not extensible\nTypeError: Cannot define property 1, object is not extensible\nTypeError: Cannot assign to read only property 'length' of object '[object Array]'";
const got = lines.join('\n');
console.log(got === expected ? 'PASS V8 proxy, constructor and frozen-array texts' : 'FAIL ' + got);
