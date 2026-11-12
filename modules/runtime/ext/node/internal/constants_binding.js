'use strict';

// internalBinding('constants') for --expose-internals tests: the same objects the
// public modules expose, grouped as Node's src/node_constants.cc groups them.
const os = require('os').constants;
const fs = require('fs').constants;
const crypto = require('crypto').constants;
const zlib = require('zlib').constants;

// Node's TRACE_EVENT_PHASE_* values: the character code of each phase letter.
const trace = { __proto__: null };
for (const [name, letter] of [
  ['BEGIN', 'B'], ['END', 'E'], ['COMPLETE', 'X'], ['INSTANT', 'I'], ['ASYNC_BEGIN', 'S'],
  ['ASYNC_STEP_INTO', 'T'], ['ASYNC_STEP_PAST', 'p'], ['ASYNC_END', 'F'], ['NESTABLE_ASYNC_BEGIN', 'b'],
  ['NESTABLE_ASYNC_END', 'e'], ['NESTABLE_ASYNC_INSTANT', 'n'], ['FLOW_BEGIN', 's'], ['FLOW_STEP', 't'],
  ['FLOW_END', 'f'], ['METADATA', 'M'], ['COUNTER', 'C'], ['SAMPLE', 'P'], ['CREATE_OBJECT', 'N'],
  ['SNAPSHOT_OBJECT', 'O'], ['DELETE_OBJECT', 'D'], ['MEMORY_DUMP', 'v'], ['MARK', 'R'], ['CLOCK_SYNC', 'c'],
  ['ENTER_CONTEXT', '('], ['LEAVE_CONTEXT', ')'], ['LINK_IDS', '='],
]) trace[`TRACE_EVENT_PHASE_${name}`] = letter.charCodeAt(0);

// The extensionless entry formats of the module loader, in Node's enum order.
const internal = { __proto__: null, EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1 };

module.exports = { os, fs, crypto, zlib, trace, internal };
