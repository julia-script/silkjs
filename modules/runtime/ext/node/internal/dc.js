'use strict';

// Built-in modules publish to diagnostics channels through this module, so a process that
// never loads diagnostics_channel pays one property read per publish site. No channel can
// have a subscriber before diagnostics_channel loads: subscribing needs its exports, and the
// node.diagnostics_channel trace category loads it when the category is enabled.
const host = require('internal/host');

function hasSubscribers(name) {
  const dc = host.diagnosticsChannel;
  return dc !== undefined && dc.hasSubscribers(name);
}
function publish(name, message) {
  const dc = host.diagnosticsChannel;
  if (dc !== undefined && dc.hasSubscribers(name)) dc.channel(name).publish(message);
}
function channel(name) { return host.diagnosticsChannel.channel(name); }
// The tracing channel for name, or undefined when nothing observes any of its events.
function tracing(name) {
  const dc = host.diagnosticsChannel;
  if (dc === undefined) return undefined;
  const channels = dc.tracingChannel(name);
  return channels.hasSubscribers ? channels : undefined;
}

module.exports = { hasSubscribers, publish, channel, tracing };
