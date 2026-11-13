'use strict';
// TLS and OpenSSL command-line options, after Node.js v24 src/node_options.cc.
const booleans = [
  '--tls-min-v1.0', '--tls-min-v1.1', '--tls-min-v1.2', '--tls-min-v1.3', '--tls-max-v1.2', '--tls-max-v1.3',
  '--use-openssl-ca', '--use-bundled-ca', '--use-system-ca', '--openssl-legacy-provider', '--openssl-shared-config', '--trace-tls',
  '--enable-fips', '--force-fips', '--enable-fips-indicator-events',
];
// --force-fips=<policy> arrives as [force_fips_crypto_policy]=<policy> and --force-fips.
const values = ['--tls-cipher-list', '--tls-keylog', '--openssl-config', '--secure-heap', '--secure-heap-min', '[force_fips_crypto_policy]'];
const state = new Map();
// getOptionValue reads its tables without user-mutable methods (a replaced
// Map.prototype.get must not run), as Node's binding does.
const mapGet = Function.prototype.call.bind(Map.prototype.get);
const mapHas = Function.prototype.call.bind(Map.prototype.has);

function applyOption(arg) {
  const separator = arg.indexOf('=');
  const name = separator < 0 ? arg : arg.slice(0, separator);
  if (separator < 0) {
    const positive = name.startsWith('--no-') ? '--' + name.slice(5) : name;
    if (!booleans.includes(positive)) return false;
    state.set(positive, positive === name);
    // --use-bundled-ca and --use-openssl-ca select the same store (Node's ImpliesNot).
    if (positive === '--use-bundled-ca' && positive === name) state.set('[openssl-store]', false);
    if (positive === '--use-openssl-ca') state.set('[openssl-store]', positive === name);
    return true;
  }
  if (!values.includes(name)) return false;
  const value = arg.slice(separator + 1);
  if (name === '--secure-heap' || name === '--secure-heap-min') {
    if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a number`);
  }
  state.set(name, value);
  return true;
}
function isPowerOfTwo(value) { return value > 0 && (value & (value - 1)) === 0; }
// The checks Node's PerProcessOptions and EnvironmentOptions run after
// parsing. Like Node, every failed check is reported, one per line.
function validate() {
  const errors = [];
  if (state.get('--use-openssl-ca') && state.get('--use-bundled-ca')) errors.push('either --use-openssl-ca or --use-bundled-ca can be used, not both');
  const heap = state.has('--secure-heap') ? Number(state.get('--secure-heap')) : 0;
  if (heap && !isPowerOfTwo(heap)) errors.push('--secure-heap must be a power of 2');
  const heapMin = state.has('--secure-heap-min') ? Number(state.get('--secure-heap-min')) : 2;
  if (heap && !isPowerOfTwo(heapMin)) errors.push('--secure-heap-min must be a power of 2');
  if (state.get('--tls-min-v1.3') && state.get('--tls-max-v1.2')) errors.push('either --tls-min-v1.3 or --tls-max-v1.2 can be used, not both');
  if (state.get('--use-system-ca') && state.get('--use-openssl-ca')) errors.push('either --use-openssl-ca or --use-system-ca can be used, not both');
  const policy = state.get('[force_fips_crypto_policy]');
  if (policy !== undefined && policy !== 'provider' && policy !== 'strict') errors.push("invalid value for --force-fips; expected 'provider' or 'strict'");
  return errors;
}
// Node's InitializeOncePerProcess for OpenSSL, run when an OpenSSL option or
// OPENSSL_CONF is given: the configuration file loads under the nodejs_conf
// section (openssl_conf with --openssl-shared-config), then the FIPS options
// apply, then the random generator must seed or the process aborts.
// Returns the startup error, if any.
function processOpenSSLOptions() {
  const host = require('internal/host');
  const file = state.get('--openssl-config') || process.env.OPENSSL_CONF || '';
  const section = state.get('--openssl-shared-config') ? 'openssl_conf' : 'nodejs_conf';
  try { host.crypto('opensslInit', [file, section]); } catch (error) { return 'OpenSSL configuration error:\n' + error.message.replace(/^ERR_[A-Z0-9_]+: /, ''); }
  const fipsError = processFipsOptions(host);
  if (fipsError !== undefined) return fipsError;
  if (host.crypto('csprngCheck', []) !== 1) process.abort();
  return undefined;
}
// Node's ProcessFipsOptions: --enable-fips and --force-fips turn FIPS mode on
// at startup, and refuse to start when no FIPS provider is active.
function processFipsOptions(host) {
  const force = !!state.get('--force-fips');
  if (!force && !state.get('--enable-fips')) return undefined;
  if (host.crypto('fipsAvailable', []) !== 1) {
    return `${force ? '--force-fips' : '--enable-fips'} requires an active OpenSSL provider named "fips". ` +
      'FIPS mode is configured through OpenSSL; see https://nodejs.org/api/crypto.html#fips-mode';
  }
  try { host.crypto('setFips', [1]); } catch (error) { return 'OpenSSL error when trying to enable FIPS:\n' + error.message; }
  return undefined;
}
const DEFAULT_CIPHER_LIST = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';
function getOptionValue(name) {
  if (name === '--tls-cipher-list') return mapGet(state, name) ?? DEFAULT_CIPHER_LIST;
  if (name === '--use-openssl-ca') return !!mapGet(state, '[openssl-store]');
  if (name === '--secure-heap' || name === '--secure-heap-min') return mapHas(state, name) ? Number(mapGet(state, name)) : (name === '--secure-heap' ? 0 : 2);
  if (values.includes(name)) return mapGet(state, name) ?? '';
  if (name === '--use-system-ca' && !mapHas(state, name)) return process.env.NODE_USE_SYSTEM_CA === '1';
  if (booleans.includes(name)) return !!mapGet(state, name);
  return undefined;
}
// Whether the command line or NODE_OPTIONS gave any TLS or OpenSSL option.
function given() { return state.size > 0; }
module.exports = { applyOption, given, validate, processOpenSSLOptions, getOptionValue, DEFAULT_CIPHER_LIST };
