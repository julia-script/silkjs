'use strict';
module.exports = require('internal/host').loader.Module;
const { SourceMap, findSourceMap, getSourceMapsSupport, setSourceMapsSupport } = require('internal/source_maps');
Object.assign(module.exports, { SourceMap, findSourceMap, getSourceMapsSupport, setSourceMapsSupport });
const { enableCompileCache, getCompileCacheDir, flushCompileCache, constants } = require('internal/compile_cache');
Object.assign(module.exports, { enableCompileCache, getCompileCacheDir, flushCompileCache, constants });
