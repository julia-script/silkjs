'use strict';

// Load the port brands before cloning: transferable MessagePorts use the same
// codec and ownership transaction as worker messages, including same-realm clones.
require('internal/worker/ports');
const { structuredClone } = require('internal/worker/clone');
module.exports = { structuredClone };
