'use strict';

// The parts of Node's internalBinding('errors') (src/node_errors.cc) that ported
// modules read: the process exit codes of src/node_exit_code.h and
// triggerUncaughtException, which is the runtime's uncaught exception path.
const exitCodes = {
  __proto__: null,
  kNoFailure: 0,
  kGenericUserError: 1,
  kInternalJSParseError: 3,
  kInternalJSEvaluationFailure: 4,
  kV8FatalError: 5,
  kInvalidFatalExceptionMonkeyPatching: 6,
  kExceptionInFatalExceptionHandler: 7,
  kInvalidCommandLineArgument: 9,
  kBootstrapFailure: 10,
  kInvalidCommandLineArgument2: 12,
  kUnsettledTopLevelAwait: 13,
  kStartupSnapshotFailure: 14,
  kAbort: 134,
};

const { triggerUncaughtException } = require('internal/host');

module.exports = { exitCodes, triggerUncaughtException };
