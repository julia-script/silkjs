'use strict';
// internalBinding('tls_wrap') for --expose-internals tests: TLSWrap is the
// transport that stands where Node's TLSWrap does, and SSL_trace is compiled
// into the linked OpenSSL (enableTrace uses it).
const { TLSTransport } = require('internal/tls/transport');
module.exports = { TLSWrap: TLSTransport, HAVE_SSL_TRACE: true };
