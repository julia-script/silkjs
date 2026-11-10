'use strict';

const os = require('os').constants;
module.exports = Object.freeze({
  ...os.dlopen, ...os.errno, ...os.priority, ...os.signals,
  ...require('fs').constants, ...require('crypto').constants,
});
