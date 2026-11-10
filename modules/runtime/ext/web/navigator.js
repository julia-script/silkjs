'use strict';

const os = require('os');
const initialize = Symbol('initialize Navigator');

function navigatorPlatform() {
  const platform = os.platform();
  const arch = os.arch();
  // These are the web-compatible identifiers used by Node, selected using
  // actual host platform/architecture rather than the build machine's values.
  if (platform === 'darwin') return 'MacIntel';
  if (platform === 'win32') return 'Win32';
  if (platform === 'linux') return `Linux ${arch === 'ia32' ? 'i686' : arch === 'x64' ? 'x86_64' : arch}`;
  if (platform === 'freebsd' || platform === 'openbsd') {
    return `${platform === 'freebsd' ? 'FreeBSD' : 'OpenBSD'} ${arch === 'ia32' ? 'i386' : arch === 'x64' ? 'amd64' : arch}`;
  }
  if (platform === 'sunos') return `SunOS ${arch === 'ia32' ? 'i86pc' : arch}`;
  if (platform === 'aix') return 'AIX';
  return `${platform[0].toUpperCase()}${platform.slice(1)} ${arch}`;
}

class Navigator {
  #hardwareConcurrency;
  #languages;
  #platform;
  #userAgent;
  constructor() {
    if (arguments[0] !== initialize) {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
  }
  get hardwareConcurrency() { return this.#hardwareConcurrency ??= os.availableParallelism(); }
  get language() {
    this.#languages; // Brand check even though language itself is not cached.
    // The default locale comes from the operating system locale configuration.
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  }
  get languages() { return this.#languages ??= Object.freeze([this.language]); }
  get platform() { return this.#platform ??= navigatorPlatform(); }
  get userAgent() { return this.#userAgent ??= `Node.js/${process.versions.node.split('.')[0]}`; }
}
for (const key of ['hardwareConcurrency', 'language', 'languages', 'platform', 'userAgent']) {
  Object.defineProperty(Navigator.prototype, key, { enumerable: true });
}
Object.defineProperty(Navigator.prototype, Symbol.toStringTag, { value: 'Navigator', configurable: true });
module.exports = { Navigator, navigator: new Navigator(initialize) };
