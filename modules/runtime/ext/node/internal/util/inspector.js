'use strict';

// sendInspectorCommand of Node's lib/internal/util/inspector.js: runs cb with a
// connected in-process inspector session, or onError when the permission model
// is on (the inspector is then unavailable, so no REPL previews or completion).
let session;
function sendInspectorCommand(cb, onError) {
  if (require('internal/permission').enabled()) return onError();
  const inspector = require('inspector');
  if (session === undefined) session = new inspector.Session();
  session.connect();
  try {
    return cb(session);
  } finally {
    session.disconnect();
  }
}

module.exports = { sendInspectorCommand };
