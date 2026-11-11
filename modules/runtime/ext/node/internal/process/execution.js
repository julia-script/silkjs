'use strict';

// The CommonJS half of Node's lib/internal/process/execution.js evalScript:
// --eval, --print and stdin source runs from here, so its frames and the async
// tasks it schedules sit under node:internal/process/execution as in Node.
const host = require('internal/host');

// name is the script name ([eval] or [stdin]); the caller has installed the
// module globals under the cwd and handled ESM input.
function evalScript(name, body, print) {
  const result = host.compileFunction(body, name, undefined, undefined, undefined, true);
  if (print) console.log(result);
  return result;
}

module.exports = { evalScript };
