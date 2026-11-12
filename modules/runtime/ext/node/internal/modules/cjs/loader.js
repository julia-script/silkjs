'use strict';

// Node's lib/internal/modules/cjs/loader.js exports the CommonJS Module class;
// here it is the runtime loader's (libs/node_resolver).
module.exports = { Module: require('internal/host').loader.Module };
