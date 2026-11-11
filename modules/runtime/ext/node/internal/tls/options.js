'use strict';
// TLS and OpenSSL command-line options, after Node.js v24 src/node_options.cc.
const booleans = [
  '--tls-min-v1.0', '--tls-min-v1.1', '--tls-min-v1.2', '--tls-min-v1.3', '--tls-max-v1.2', '--tls-max-v1.3',
  '--use-openssl-ca', '--use-bundled-ca', '--use-system-ca', '--openssl-legacy-provider', '--openssl-shared-config', '--trace-tls',
];
const values = ['--tls-cipher-list', '--tls-keylog', '--openssl-config', '--secure-heap', '--secure-heap-min'];
const state = new Map();

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
// The checks Node's PerProcessOptions and EnvironmentOptions run after parsing.
function validate() {
  if (state.get('--use-openssl-ca') && state.get('--use-bundled-ca')) return 'either --use-openssl-ca or --use-bundled-ca can be used, not both';
  const heap = state.has('--secure-heap') ? Number(state.get('--secure-heap')) : 0;
  if (heap && !isPowerOfTwo(heap)) return '--secure-heap must be a power of 2';
  const heapMin = state.has('--secure-heap-min') ? Number(state.get('--secure-heap-min')) : 2;
  if (heap && !isPowerOfTwo(heapMin)) return '--secure-heap-min must be a power of 2';
  if (state.get('--tls-min-v1.3') && state.get('--tls-max-v1.2')) return 'either --tls-min-v1.3 or --tls-max-v1.2 can be used, not both';
  if (state.get('--use-system-ca') && state.get('--use-openssl-ca')) return 'either --use-openssl-ca or --use-system-ca can be used, not both';
}
const DEFAULT_CIPHER_LIST = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';
function getOptionValue(name) {
  if (name === '--tls-cipher-list') return state.get(name) ?? DEFAULT_CIPHER_LIST;
  if (name === '--use-openssl-ca') return !!state.get('[openssl-store]');
  if (name === '--secure-heap' || name === '--secure-heap-min') return state.has(name) ? Number(state.get(name)) : (name === '--secure-heap' ? 0 : 2);
  if (values.includes(name)) return state.get(name) ?? '';
  if (name === '--use-system-ca' && !state.has(name)) return process.env.NODE_USE_SYSTEM_CA === '1';
  if (booleans.includes(name)) return !!state.get(name);
  return undefined;
}
module.exports = { applyOption, validate, getOptionValue, DEFAULT_CIPHER_LIST };
