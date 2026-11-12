// Adapted from Node.js v24.22.1 lib/internal/dns/callback_resolver.js by tools/port_node_net.py.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayPrototypeMap,
  FunctionPrototypeCall,
  Symbol,
} = require('internal/per_context/primordials');

const {
  DNSException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
  },
} = require('internal/errors');

const {
  createResolverClass,
} = require('internal/dns/utils');

const {
  validateFunction,
  validateStringWithoutNullBytes,
} = require('internal/validators');

const {
  QueryReqWrap,
} = require('internal/dns/cares_wrap');

const {
  hasObserver,
  startPerf,
  stopPerf,
} = require('internal/perf/observe');
const { assignFunctionName } = require('internal/util');

const kPerfHooksDnsLookupResolveContext = Symbol('kPerfHooksDnsLookupResolveContext');

function onresolve(err, result, ttls) {
  if (ttls && this.ttl)
    result = ArrayPrototypeMap(
      result, (address, index) => ({ address, ttl: ttls[index] }));

  if (err)
    this.callback(new DNSException(err, this.bindingName, this.hostname));
  else {
    this.callback(null, result);
    if (this[kPerfHooksDnsLookupResolveContext] && hasObserver('dns')) {
      stopPerf(this, kPerfHooksDnsLookupResolveContext, { detail: { result } });
    }
  }
}

function resolver(bindingName) {
  function query(name, /* options, */ callback) {
    let options;
    if (arguments.length > 2) {
      options = callback;
      callback = arguments[2];
    }

    validateStringWithoutNullBytes(name, 'name');
    validateFunction(callback, 'callback');

    const req = new QueryReqWrap();
    req.bindingName = bindingName;
    req.callback = callback;
    req.hostname = name;
    req.oncomplete = onresolve;
    req.ttl = !!(options?.ttl);
    const err = this._handle[bindingName](req, name);
    if (err) throw new DNSException(err, bindingName, name);
    if (hasObserver('dns')) {
      startPerf(req, kPerfHooksDnsLookupResolveContext, {
        type: 'dns',
        name: bindingName,
        detail: {
          host: name,
          ttl: req.ttl,
        },
      });
    }
    return req;
  }
  return assignFunctionName(bindingName, query);
}

// This is the callback-based resolver. There is another similar
// resolver in dns/promises.js with resolve methods that are based
// on promises instead.
const { Resolver, resolveMap } = createResolverClass(resolver);
Resolver.prototype.resolve = resolve;

function resolve(hostname, rrtype, callback) {
  let resolver;
  if (typeof rrtype === 'string') {
    resolver = resolveMap[rrtype];
  } else if (typeof rrtype === 'function') {
    resolver = resolveMap.A;
    callback = rrtype;
  } else {
    throw new ERR_INVALID_ARG_TYPE('rrtype', 'string', rrtype);
  }

  if (typeof resolver === 'function') {
    return FunctionPrototypeCall(resolver, this, hostname, callback);
  }
  throw new ERR_INVALID_ARG_VALUE('rrtype', rrtype);
}

module.exports = {
  Resolver,
};
