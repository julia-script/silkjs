'use strict';
const { openSync, readFileSync, closeSync } = require('fs');
const core = require('internal/fs/utils');
const { parseEnv } = require('internal/util_public/parse_env');
const { Buffer } = require('buffer');
const { isUint8Array } = require('util').types;
const { fileURLToPath } = require('url');
const { errno } = require('os').constants;
const { writeStartupDiagnostic } = require('internal/host');

function filename(value) {
  if (value == null) return '.env';
  if (isUint8Array(value)) {
    if (!Buffer.isBuffer(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof URL) value = fileURLToPath(value);
  else if (typeof value !== 'string') throw core.invalid('path', 'a string, Buffer, or file URL');
  return core.path(value);
}
function read(path) {
  let fd;
  try { fd = openSync(path, 'r'); }
  catch (cause) {
    if (typeof cause.errno !== 'number') throw cause;
    throw core.error('ENOENT', 'open', path, undefined, errno.ENOENT);
  }
  let content;
  try { content = readFileSync(fd, 'utf8'); }
  catch (cause) {
    if (typeof cause.errno !== 'number') throw cause;
    throw Object.assign(new TypeError(`Contents of '${path}' should be a valid string.`), { code: 'ERR_INVALID_ARG_TYPE' });
  } finally { closeSync(fd); }
  return parseEnv(content);
}
function apply(values) {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(process.env, key)) process.env[key] = values[key];
  }
}
function loadEnvFile(path = undefined) {
  apply(read(filename(path)));
}
function loadEnvironmentFiles(files) {
  const pending = Object.create(null), errors = [];
  let loaded = false;
  for (const file of files) {
    try { Object.assign(pending, read(file.path)); loaded = true; }
    catch (cause) {
      if (cause.code === 'ENOENT') {
        if (file.optional) writeStartupDiagnostic(file.path + ' not found. Continuing without it.\n');
        else errors.push(file.path + ': not found');
      } else if (cause.code === 'ERR_INVALID_ARG_TYPE') errors.push(file.path + ': invalid format');
      else throw cause;
    }
  }
  if (!errors.length) apply(pending);
  return { loaded, errors };
}
module.exports = { loadEnvFile, loadEnvironmentFiles };
