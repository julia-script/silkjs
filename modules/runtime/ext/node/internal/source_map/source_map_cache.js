'use strict';

// Node's lib/internal/source_map/source_map_cache.js: the runtime's source map registry.
const { findSourceMap, sourceMapCacheToObject, getSourceMapsSupport, setSourceMapsSupport } = require('internal/source_maps');

module.exports = { findSourceMap, sourceMapCacheToObject, getSourceMapsSupport, setSourceMapsSupport };
