'use strict';

// internalBinding('inspector') (src/inspector_js_api.cc): the async task calls
// (internal/inspector_async), and isEnabled and url over this thread's server.

const asyncTasks = require('internal/inspector_async');

module.exports = {
  ...asyncTasks,
  // inspector_js_api.cc IsEnabled: the agent is listening.
  isEnabled: () => require('internal/inspector').url() !== undefined,
  url: () => require('internal/inspector').url(),
};
