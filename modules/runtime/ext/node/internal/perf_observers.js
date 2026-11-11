'use strict';
// Performance entries that runtime modules make themselves (Node's http2 entries
// come from C++). perf_hooks installs these functions when it loads; before that
// nothing can observe an entry.
module.exports = {
  // Whether an observer takes entries of this type.
  observing(type) { return false; },
  // Reports an entry; start is a host.now() time.
  emit(name, type, start, duration, detail) {},
};
