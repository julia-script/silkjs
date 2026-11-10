// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const { SecureContext, createSecureContext } = require('internal/tls/context');

// Legacy certificate normalization follows Node's internal/tls/common.js.
// The DER projection already produces normalized fields and does not use this.
function translatePeerCertificate(cert) {
  if (!cert) return null;
  if (cert.issuerCertificate != null && cert.issuerCertificate !== cert) {
    cert.issuerCertificate = translatePeerCertificate(cert.issuerCertificate);
  }
  if (cert.infoAccess != null) {
    const info = cert.infoAccess;
    cert.infoAccess = Object.create(null);
    info.replace(/([^\n:]*):([^\n]*)(?:\n|$)/g, (all, key, value) => {
      if (value.charCodeAt(0) === 0x22) value = JSON.parse(value);
      if (key in cert.infoAccess) cert.infoAccess[key].push(value);
      else cert.infoAccess[key] = [value];
    });
  }
  return cert;
}

module.exports = { SecureContext, createSecureContext, translatePeerCertificate };
