'use strict';

// Node.js lib/internal/crypto/x509.js names, over the runtime's X509Certificate
// (internal/crypto_certificates). Tests reach it through --expose-internals.

const certificates = require('internal/crypto_certificates');

module.exports = {
  X509Certificate: certificates.X509Certificate,
  isX509Certificate: certificates.isX509Certificate,
};
