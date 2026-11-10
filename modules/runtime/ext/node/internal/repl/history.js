'use strict';
const fs = require('fs');

function setupHistory(server, config, callback) {
  if (typeof config === 'string') config = { filePath: config };
  if (config === undefined) config = {};
  if (!config || typeof config !== 'object') throw Object.assign(new TypeError('The "historyConfig" argument must be an object or string'), { code: 'ERR_INVALID_ARG_TYPE' });
  callback = callback === undefined ? config.onHistoryFileLoaded : callback;
  if (callback !== undefined && typeof callback !== 'function') throw Object.assign(new TypeError('The "callback" argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (callback === undefined) callback = error => { if (error) server.output.write(`Error loading REPL history: ${error.message}\n`); };
  if (config.filePath !== undefined && typeof config.filePath !== 'string') throw Object.assign(new TypeError('The "filePath" argument must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (config.size !== undefined && (typeof config.size !== 'number' || !Number.isInteger(config.size) || config.size < 0)) throw Object.assign(new RangeError('The "size" option must be a nonnegative integer'), { code: 'ERR_OUT_OF_RANGE' });
  const filename = config.filePath === undefined ? require('path').join(require('os').homedir(), '.node_repl_history') : config.filePath.trim();
  if (server._historyCleanup) server._historyCleanup();
  server.setupHistoryManager({
    size: config.size ?? server.historySize,
    history: config.history ?? server.history,
    removeHistoryDuplicates: config.removeHistoryDuplicates,
  });
  if (!filename) { process.nextTick(callback, null, server); return; }
  let fd;
  try {
    fd = fs.openSync(filename, 'a+', 0o600);
    const saved = fs.readFileSync(fd, 'utf8').split(/\r?\n/).filter(Boolean);
    const history = server.history || [];
    server.history = [...history, ...saved].slice(0, config.size ?? server.historySize);
  } catch (error) {
    process.nextTick(callback, error, server);
    return;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  let dirty = false;
  let scheduled = false;
  let active = true;
  const flush = () => {
    scheduled = false;
    if (!active || !dirty) return;
    dirty = false;
    try {
      // Flush the final array, after all history listeners have had the chance
      // to redact entries. Synchronous writes also make close deterministic.
      fs.writeFileSync(filename, server.history.map(line => line.replace(/\r?\n/g, '\r')).join('\n') + '\n', { mode: 0o600 });
      server.emit('flushHistory');
    } catch (error) {
      active = false;
      server.output.write(`Error writing REPL history: ${error.message}\n`);
    }
  };
  const onHistory = () => {
    dirty = true;
    if (!scheduled) { scheduled = true; process.nextTick(flush); }
  };
  const cleanup = () => {
    flush();
    active = false;
    server.removeListener('history', onHistory);
    server.removeListener('exit', cleanup);
    if (server._historyCleanup === cleanup) server._historyCleanup = undefined;
  };
  server._historyCleanup = cleanup;
  server.on('history', onHistory);
  server.once('exit', cleanup);
  process.nextTick(callback, null, server);
}
module.exports = { setupHistory };
