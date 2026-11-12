'use strict';

// Node's lib/internal/source_map/source_map.js: the runtime's SourceMap.
const { kMappings, SourceMap } = require('internal/source_maps');

module.exports = { kMappings, SourceMap };
