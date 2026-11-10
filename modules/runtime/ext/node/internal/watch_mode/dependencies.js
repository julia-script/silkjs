'use strict';

const host = require('internal/host');
const reported = new Set();
let send;
let active = false;

function initialize(workerSend, enabled = process.env.WATCH_REPORT_DEPENDENCIES === '1') {
  active = enabled;
  send = workerSend || (filename => {
    if (process.connected && typeof process.send === 'function')
      process.send({ 'watch:require': [filename] }, error => {
        if (error && error.code !== 'ERR_IPC_CHANNEL_CLOSED' && error.code !== 'EPIPE') throw error;
      });
  });
  host.reportDependency = active ? report : undefined;
}
function report(filename) {
  if (!active || typeof filename !== 'string') return;
  if (filename.startsWith('file:')) filename = require('url').fileURLToPath(filename);
  if (!require('path').isAbsolute(filename) || reported.has(filename)) return;
  reported.add(filename);
  send(filename);
}

module.exports = { initialize, report, enabled: () => active };
