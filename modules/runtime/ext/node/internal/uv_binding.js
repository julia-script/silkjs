'use strict';

// Node's internalBinding('uv'): libuv's error names and messages and a UV_<name>
// constant for each error, read from the runtime's error table (the same one
// util.getSystemErrorMap reads). The constants are read-only, as in Node.

const host = require('internal/host');

const entries = host.utilErrorMap();
const names = new Map();
for (let i = 0; i < entries.length; i += 3) names.set(entries[i], entries[i + 1]);

// uv_err_name, which names an unknown code as Node's binding does.
function errname(err) {
  return names.get(err) ?? `Unknown system error ${err}`;
}
function getErrorMessage(err) {
  return host.utilErrorMessage(err);
}
function getErrorMap() {
  const map = new Map();
  for (let i = 0; i < entries.length; i += 3) map.set(entries[i], [entries[i + 1], entries[i + 2]]);
  return map;
}

const binding = { errname, getErrorMessage, getErrorMap };
for (const [code, name] of names) {
  Object.defineProperty(binding, `UV_${name}`, { value: code, enumerable: true, writable: false, configurable: false });
}
module.exports = binding;
