'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function escapeShell(value) {
  if (value === '') return process.platform === 'win32' ? '""' : "''";
  if (!/[\t\n\r "#$&'()*;<>%?\\`|~\[\]]/.test(value)) return value;
  if (process.platform === 'win32') {
    return ('"' + value.replace(/"/g, '""') + '"').replace(/^(?:'')+(?!$)/, '')
      .replace(/\\"""/g, '\\"').replace(/%/g, '^%');
  }
  return ("'" + value.replace(/'/g, "'\"'\"'") + "'")
    .replace(/^(?:'')+(?!$)/, '').replace(/\\'''/g, "\\'");
}

function findPackage(cwd) {
  let directory = cwd, selected;
  const bins = [];
  // Node's native runner stops before the filesystem root, but continues
  // collecting ancestor executable directories after selecting a package.
  while (path.dirname(directory) !== directory) {
    const bin = path.join(directory, 'node_modules', '.bin');
    try { if (fs.statSync(bin).isDirectory()) bins.push(bin); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (!selected) {
      const filename = path.join(directory, 'package.json');
      try {
        const source = fs.readFileSync(filename, 'utf8');
        if (source.length) selected = { filename, source };
      } catch (error) {
        // ReadFileSync in node_task_runner ignores unreadable candidates.
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
      }
    }
    directory = path.dirname(directory);
  }
  return selected && { ...selected, bins };
}

function runPackageScript(name, positional = []) {
  const fail = (message, code = 1) => { process.stderr.write(message); process.exitCode = code; };
  const cwd = process.cwd();
  const selected = findPackage(cwd);
  if (!selected) return fail(`Can't find package.json for directory ${cwd}\n`);
  const { filename, source, bins } = selected;
  let pkg;
  try { pkg = JSON.parse(source); }
  catch { return fail(`Can't parse ${filename}\n`); }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg))
    return fail(`Root value unexpected not an object for ${filename}\n\n`);
  const scripts = pkg.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))
    return fail(`Can't find "scripts" field in ${filename}\n`);
  const available = () => 'Available scripts are:\n' + Object.keys(scripts)
    .filter(key => typeof scripts[key] === 'string').map(key => `  ${key}: ${scripts[key]}\n`).join('');
  if (name === '') return fail(available(), 9);
  if (!Object.prototype.hasOwnProperty.call(scripts, name))
    return fail(`Missing script: "${name}" for ${filename}\n\n` + available());
  if (typeof scripts[name] !== 'string')
    return fail(`Script "${name}" is unexpectedly not a string for ${filename}\n\n`);
  const env = { ...process.env, NODE_RUN_SCRIPT_NAME: name, NODE_RUN_PACKAGE_JSON_PATH: filename };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && bins.length) env[key] = bins.join(path.delimiter) + path.delimiter + env[key];
  }
  const command = scripts[name] + positional.map(arg => ' ' + escapeShell(arg)).join('');
  const shell = process.platform === 'win32' ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(shell) ?
    ['/d', '/s', '/c', '"' + command + '"'] : ['-c', command];
  const child = spawn(shell, args, { cwd: path.dirname(filename), env, stdio: 'inherit', windowsVerbatimArguments: true });
  const forward = signal => () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const interrupt = forward('SIGINT'), terminate = forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
  child.once('error', error => { cleanup(); fail(`Error: ${error.message}\n`); });
  child.once('exit', code => {
    cleanup();
    // Node 24's native task runner deliberately normalizes positive exit
    // statuses to 1 and signal termination (zero native exit status) to 0.
    process.exitCode = code > 0 ? 1 : 0;
  });
  return child;
}

module.exports = { runPackageScript };
