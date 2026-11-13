'use strict';

// Node.js v24.22.1 lib/internal/per_context/messageport.js, which Node runs in every
// context: how a MessagePort moved into a vm context hands a message to its
// onmessage. A realm loads it with its own primordials.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).
const {
  SymbolFor,
} = require('internal/per_context/primordials');

class MessageEvent {
  constructor(data, target, type, ports) {
    this.data = data;
    this.target = target;
    this.type = type;
    this.ports = ports ?? [];
  }
}

const kHybridDispatch = SymbolFor('nodejs.internal.kHybridDispatch');
const kCurrentlyReceivingPorts =
  SymbolFor('nodejs.internal.kCurrentlyReceivingPorts');

exports.emitMessage = function(data, ports, type) {
  if (typeof this[kHybridDispatch] === 'function') {
    this[kCurrentlyReceivingPorts] = ports;
    try {
      this[kHybridDispatch](data, type, undefined);
    } finally {
      this[kCurrentlyReceivingPorts] = undefined;
    }
    return;
  }

  const event = new MessageEvent(data, this, type, ports);
  if (type === 'message') {
    if (typeof this.onmessage === 'function')
      this.onmessage(event);
  } else {
    // eslint-disable-next-line no-lonely-if
    if (typeof this.onmessageerror === 'function')
      this.onmessageerror(event);
  }
};
