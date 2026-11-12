// priority_queue adapted from Node.js v24.22.1 lib/internal/priority_queue.js.
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).
'use strict';

// The PriorityQueue is a basic implementation of a binary heap that accepts
// a custom sorting function via its constructor. This function is passed
// the two nodes to compare, similar to the native Array#sort. Crucially
// this enables priority queues that are based on a comparison of more than
// just a single criteria.

// The fields are plain properties here, not Node's #private ones: a private
// field access costs about twice a named one in the engine, and the timer
// lists use this queue on every new list.
module.exports = class PriorityQueue {
  _compare = (a, b) => a - b;
  _heap = [undefined, undefined];
  _setPosition = undefined;
  _size = 0;

  constructor(comparator, setPosition) {
    if (comparator !== undefined)
      this._compare = comparator;
    if (setPosition !== undefined)
      this._setPosition = setPosition;
  }

  insert(value) {
    const heap = this._heap;
    const pos = ++this._size;
    heap[pos] = value;

    this.percolateUp(pos);
  }

  peek() {
    return this._heap[1];
  }

  peekBottom() {
    return this._heap[this._size];
  }

  percolateDown(pos) {
    const compare = this._compare;
    const setPosition = this._setPosition;
    const hasSetPosition = setPosition !== undefined;
    const heap = this._heap;
    const size = this._size;
    const hsize = size >> 1;
    const item = heap[pos];

    while (pos <= hsize) {
      let child = pos << 1;
      const nextChild = child + 1;
      let childItem = heap[child];

      if (nextChild <= size && compare(heap[nextChild], childItem) < 0) {
        child = nextChild;
        childItem = heap[nextChild];
      }

      if (compare(item, childItem) <= 0) break;

      if (hasSetPosition)
        setPosition(childItem, pos);

      heap[pos] = childItem;
      pos = child;
    }

    heap[pos] = item;
    if (hasSetPosition)
      setPosition(item, pos);
  }

  percolateUp(pos) {
    const heap = this._heap;
    const compare = this._compare;
    const setPosition = this._setPosition;
    const hasSetPosition = setPosition !== undefined;
    const item = heap[pos];

    while (pos > 1) {
      const parent = pos >> 1;
      const parentItem = heap[parent];
      if (compare(parentItem, item) <= 0)
        break;
      heap[pos] = parentItem;
      if (hasSetPosition)
        setPosition(parentItem, pos);
      pos = parent;
    }

    heap[pos] = item;
    if (hasSetPosition)
      setPosition(item, pos);
  }

  removeAt(pos) {
    const heap = this._heap;
    let size = this._size;
    heap[pos] = heap[size];
    heap[size] = undefined;
    size = --this._size;

    if (size > 0 && pos <= size) {
      if (pos > 1 && this._compare(heap[pos >> 1], heap[pos]) > 0)
        this.percolateUp(pos);
      else
        this.percolateDown(pos);
    }
  }

  shift() {
    const heap = this._heap;
    const value = heap[1];
    if (value === undefined)
      return;

    this.removeAt(1);

    return value;
  }
};
