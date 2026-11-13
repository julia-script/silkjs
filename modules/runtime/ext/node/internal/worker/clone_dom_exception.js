'use strict';

// Node.js v24.22.1 lib/internal/worker/clone_dom_exception.js: the class a cloned
// DOMException is deserialized into. Node delegates to the per-context DOMException
// of the main context; the runtime's main-realm DOMException is
// internal/path_events/event_target's.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

// Delegate to the actual DOMException implementation.
module.exports = {
  DOMException: require('internal/path_events/event_target').DOMException,
};
