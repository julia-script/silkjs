// Copyright Joyent, Inc. and other Node contributors. MIT license (see vendor/node-api/LICENSE).
// Adapted from Node.js v24.22.1 lib/internal/freelist.js.
'use strict';

class FreeList {
  constructor(name, max, ctor) {
    this.name = name;
    this.ctor = ctor;
    this.max = max;
    this.list = [];
  }

  alloc() {
    return this.list.length > 0 ?
      this.list.pop() :
      Reflect.apply(this.ctor, this, arguments);
  }

  free(obj) {
    if (this.list.length < this.max) {
      this.list.push(obj);
      return true;
    }
    return false;
  }
}

module.exports = FreeList;
