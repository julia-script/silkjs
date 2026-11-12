'use strict';

// The CommonJS half of Node's lib/internal/process/execution.js evalScript:
// --eval, --print and stdin source runs from here, so its frames and the async
// tasks it schedules sit under node:internal/process/execution as in Node.
const host = require('internal/host');

// name is the script name ([eval] or [stdin]); the caller has installed the
// module globals under the cwd and handled ESM input.
function evalScript(name, body, print) {
  const result = host.compileFunction(body, name, undefined, undefined, undefined, true);
  // As Node, --print logs the result on exit, after the loop has run (a promise
  // settled in a later tick prints settled).
  if (print) {
    const { log } = require('console');
    process.on('exit', () => { log(result); });
  }
  return result;
}

// tryGetCwd of Node's lib/internal/process/execution.js.
function tryGetCwd() {
  try {
    return process.cwd();
  } catch {
    // getcwd(3) can fail if the current working directory has been deleted.
    // Fall back to the directory name of the (absolute) executable path.
    // It's not really correct but what are the alternatives?
    return require('path').dirname(process.execPath);
  }
}

module.exports = { evalScript, tryGetCwd };
