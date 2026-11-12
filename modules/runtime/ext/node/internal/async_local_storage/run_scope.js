// Ported from Node.js v24.22.1 lib/internal/async_local_storage/run_scope.js.
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).
'use strict';

class RunScope {
  #storage;
  #previousStore;
  #disposed = false;

  constructor(storage, store) {
    this.#storage = storage;
    this.#previousStore = storage.getStore();
    storage.enterWith(store);
  }

  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#storage.enterWith(this.#previousStore);
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

module.exports = RunScope;
