'use strict';

// Trusted REPL-only entry point: native guarded evaluation runs once and the
// formatter consumes descriptors, never user getters or custom inspect hooks.
const { evaluatePreview, releasePreview } = require('internal/inspector');
module.exports = { evaluate: evaluatePreview, release: releasePreview };
