'use strict';

const { spawn } = require('child_process');
const { inspect } = require('util');
const path = require('path');
const { FilesWatcher } = require('internal/watch_mode/files_watcher');
const { signalNumber } = require('internal/process_signals');

const valueOptions = new Set(['--watch-path', '--watch-kill-signal']);
const booleanOptions = new Set(['--watch', '--no-watch', '--watch-preserve-output', '--no-watch-preserve-output']);
function withoutWatchOptions(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], separator = arg.indexOf('=');
    const name = (separator < 0 ? arg : arg.slice(0, separator)).replace(/_/g, '-');
    if (booleanOptions.has(name)) continue;
    if (valueOptions.has(name)) { if (separator < 0) index++; continue; }
    result.push(arg);
  }
  return result;
}

function start({ args, paths = [], preserveOutput = false, killSignal = 'SIGTERM', envFiles = [], env = process.env }) {
  signalNumber(killSignal);
  const watcher = new FilesWatcher();
  const explicit = paths.length > 0;
  const seeds = envFiles.map(file => path.resolve(typeof file === 'string' ? file : file.path));
  const childEnv = { ...env, WATCH_REPORT_DEPENDENCIES: explicit ? '0' : '1' };
  // Keep an explicit (possibly empty) NODE_OPTIONS so an env file cannot
  // reintroduce --watch and recursively launch another supervisor.
  childEnv.NODE_OPTIONS = withoutWatchOptions(require('internal/options').parseEnvironment(
    childEnv.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '')).map(arg => JSON.stringify(arg)).join(' ');
  const command = inspect(process.argv.slice(1).join(' '));
  const colorOutput = process.env.FORCE_COLOR !== undefined ? process.env.FORCE_COLOR !== '0' :
    !!process.stderr.isTTY && process.env.TERM !== 'dumb';
  let child, currentExit, exited = true, stopping = false, restarting = false, pending = false, graceTimer;
  let closed = false;
  const print = message => process.stdout.write(message + '\n');
  function launch() {
    if (closed) return;
    watcher.beginRun(seeds);
    exited = false;
    stopping = false;
    child = spawn(process.execPath, args, {
      stdio: explicit ? 'inherit' : ['inherit', 'inherit', 'inherit', 'ipc'], env: childEnv,
    });
    currentExit = new Promise(resolve => {
      let settled = false;
      const settle = code => { if (!settled) { settled = true; exited = true; resolve(code); } };
      child.once('error', error => {
        print(`Failed running ${command}: ${error.message}. Waiting for file changes before restarting...`);
        settle(1);
      });
      child.once('exit', code => {
        settle(code);
        if (!stopping && !closed) print(`${code === 0 ? 'Completed' : 'Failed'} running ${command}. Waiting for file changes before restarting...`);
      });
    });
    if (!explicit) child.on('message', message => {
      if (closed || stopping || !message || typeof message !== 'object') return;
      try {
        if (Array.isArray(message['watch:require'])) for (const file of message['watch:require'])
          if (typeof file === 'string') watcher.filterFile(file);
        if (Array.isArray(message['watch:import'])) for (const file of message['watch:import'])
          if (typeof file === 'string' && file.startsWith('file:')) watcher.filterFile(require('url').fileURLToPath(file));
      } catch (error) { fail(error); }
    });
  }
  async function stop(signal) {
    stopping = true;
    if (child && !exited) child.kill(signal);
    return currentExit ? await currentExit : 0;
  }
  async function restart() {
    if (closed) return;
    if (restarting) { pending = true; return; }
    restarting = true;
    try {
      do {
        pending = false;
        if (!preserveOutput && colorOutput) process.stdout.write('\x1bc');
        print(`Restarting ${command}`);
        graceTimer = setTimeout(() => print('Waiting for graceful termination...'), 500);
        graceTimer.unref();
        await stop(killSignal);
        clearTimeout(graceTimer);
        if (!closed) launch();
      } while (pending && !closed);
    } catch (error) { await fail(error); }
    finally { clearTimeout(graceTimer); restarting = false; }
  }
  async function shutdown(signal, code) {
    if (closed) { if (child && !exited) child.kill(signal); return; }
    closed = true;
    watcher.clear();
    clearTimeout(graceTimer);
    const status = await stop(signal);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('exit', emergency);
    process.exit(code === undefined ? status ?? 0 : code);
  }
  async function fail(error) {
    process.stderr.write((error.stack || String(error)) + '\n');
    await shutdown('SIGTERM', 1);
  }
  const interrupt = () => { shutdown('SIGINT'); };
  const terminate = () => { shutdown('SIGTERM'); };
  const emergency = () => { if (child && !exited) child.kill('SIGKILL'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('exit', emergency);
  watcher.on('changed', restart);
  watcher.on('error', fail);
  try {
    for (const watched of paths) watcher.watchPath(watched);
    // The entry may fail before the loader resolves it; still recover on edit.
    if (!explicit && process.argv[1] && process.argv[1] !== '-') seeds.push(path.resolve(process.argv[1]));
    launch();
  } catch (error) { fail(error); }
  return watcher;
}

module.exports = { start, withoutWatchOptions };
