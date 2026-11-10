'use strict';
module.exports = process.env.NODE_UNIQUE_ID === undefined ?
  require('internal/cluster/primary') : require('internal/cluster/child');
