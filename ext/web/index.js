'use strict';

// Self-contained web globals for the QuickJS bootstrap. Networking is supplied
// separately; these constructors never delegate to another JavaScript runtime.
const { URL, URLSearchParams } = require('internal/web/url');
const { Blob, File } = require('internal/web/blob');
const { WebSocket, MessageEvent, CloseEvent } = require('internal/web/websocket');
const { MessageChannel, MessagePort, BroadcastChannel } = require('worker_threads');
module.exports = {
  ...require('internal/web/encoding'),
  ...require('internal/web/streams'),
  ...require('internal/web/fetch'),
  ...require('internal/web/structured_clone'),
  ...require('internal/web/compression'),
  ...require('internal/web/navigator'),
  ...require('internal/web/urlpattern'),
  ...require('internal/web/intl'),
  URL, URLSearchParams, Blob, File, WebSocket, MessageEvent, CloseEvent,
  MessageChannel, MessagePort, BroadcastChannel,
};
