'use strict';

// The parts of Node.js lib/internal/net.js that the ported modules use.
const { isIP, isIPv4, isIPv6 } = require('net');

module.exports = { isIP, isIPv4, isIPv6 };
