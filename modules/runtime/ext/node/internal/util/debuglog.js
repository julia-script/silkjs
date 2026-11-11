'use strict';

// The parts of Node.js v24.22.1 lib/internal/util/debuglog.js that are not util.debuglog
// itself: formatTime is how console.timeEnd and console.timeLog print a duration.
// Copyright Node.js contributors. MIT license (see vendor/node-api/LICENSE).

const { debuglog } = require('util');

function pad(value) { return `${value}`.padStart(2, '0'); }
function formatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (ms >= 1000) {
    if (ms >= 60000) {
      if (ms >= 3600000) {
        hours = Math.floor(ms / 3600000);
        ms = ms % 3600000;
      }
      minutes = Math.floor(ms / 60000);
      ms = ms % 60000;
    }
    seconds = ms / 1000;
  }
  if (hours !== 0 || minutes !== 0) {
    ({ 0: seconds, 1: ms } = seconds.toFixed(3).split('.', 2));
    const res = hours !== 0 ? `${hours}:${pad(minutes)}` : minutes;
    return `${res}:${pad(seconds)}.${ms} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`;
  }
  if (seconds !== 0) return `${seconds.toFixed(3)}s`;
  return `${Number(ms.toFixed(3))}ms`;
}

module.exports = { debuglog, formatTime };
