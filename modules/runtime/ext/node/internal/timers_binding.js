'use strict';

// Node's internalBinding('timers') as far as JavaScript reads it: getLibuvNow is
// the event loop's clock in whole milliseconds, brought up to date on each call
// as Node's Environment::GetNow does. Timers here schedule on the same clock.

const host = require('internal/host');

module.exports = {
  getLibuvNow() { return Math.floor(host.now()); },
};
