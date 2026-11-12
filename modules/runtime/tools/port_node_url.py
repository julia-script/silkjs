#!/usr/bin/env python3
"""Ports Node.js v24.22.1 lib/internal/url.js, lib/url.js and lib/internal/data_url.js into
modules/runtime/ext/node. Edit this script and rerun it; do not hand-edit the outputs.

usage: port_node_url.py NODE_SRC

NODE_SRC is a Node.js v24.22.1 checkout."""
import os
import sys
NODE = os.path.join(sys.argv[1], 'lib') + '/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ext', 'node') + '/'
PRIM = ("} = primordials;", "} = require('internal/per_context/primordials');")

def license_of(path):
    s = open(path).read()
    return s[s.index('// Copyright Node.js contributors.'):s.index("'use strict';")]
LIC = license_of(OUT + 'internal/event_target.js')

def port(src, dst, note, reps, keep_header=False):
    s = open(NODE + src).read()
    for a, b in reps:
        n = s.count(a)
        assert n == 1, (src, a, n)
        s = s.replace(a, b)
    head = f'// Adapted from Node.js v24.22.1 lib/{src}. {note}\n'
    open(OUT + dst, 'w').write(head + (s if keep_header else LIC + s))

port('internal/url.js', 'internal/url.js',
     "internalBinding('url') is internal/url_binding over the\n// runtime's WHATWG URL natives; URLPattern and object URLs come from the runtime's web modules.",
     [PRIM,
      ("const { URLPattern } = internalBinding('url_pattern');",
       "const { URLPattern } = require('internal/web/urlpattern');"),
      ("const bindingUrl = internalBinding('url');", "const bindingUrl = require('internal/url_binding');"),
      ("""  const bindingBlob = internalBinding('blob');

  function createObjectURL(obj) {
    const cryptoRandom = lazyCryptoRandom();
    if (cryptoRandom === undefined)
      throw new ERR_NO_CRYPTO();

    const blob = lazyBlob();
    if (!blob.isBlob(obj))
      throw new ERR_INVALID_ARG_TYPE('obj', 'Blob', obj);

    const id = cryptoRandom.randomUUID();

    bindingBlob.storeDataObject(id, obj[blob.kHandle], obj.size, obj.type);

    return `blob:nodedata:${id}`;
  }

  function revokeObjectURL(url) {
    if (arguments.length === 0) {
      throw new ERR_MISSING_ARGS('url');
    }

    bindingBlob.revokeObjectURL(`${url}`);
  }
""", """  // The runtime's Blob keeps object URLs in internal/web/blob, which checks for a Blob
  // and makes the blob:nodedata: id as Node's binding does. It loads on first use.
  let bindingBlob;

  function createObjectURL(obj) {
    const cryptoRandom = lazyCryptoRandom();
    if (cryptoRandom === undefined)
      throw new ERR_NO_CRYPTO();

    bindingBlob ??= require('internal/web/blob');
    return bindingBlob.createObjectURL(obj);
  }

  function revokeObjectURL(url) {
    if (arguments.length === 0) {
      throw new ERR_MISSING_ARGS('url');
    }

    bindingBlob ??= require('internal/web/blob');
    bindingBlob.revokeObjectURL(`${url}`);
  }
"""),
      ("""function lazyBlob() {
  blob ??= require('internal/blob');
  return blob;
}

""", ""),
      ("let blob;\n", ""),
     ])

port('url.js', 'url.js', "internalBinding('url'), internalBinding('encoding_binding').toASCII and\n// isInsideNodeModules come from internal/url_binding and internal/inside_node_modules.",
     [PRIM,
      ("const { URLPattern } = internalBinding('url_pattern');",
       "const { URLPattern } = require('internal/web/urlpattern');"),
      ("const { toASCII } = internalBinding('encoding_binding');",
       "const { toASCII } = require('internal/url_binding');"),
      ("const { isInsideNodeModules } = internalBinding('util');",
       "const { isInsideNodeModules } = require('internal/inside_node_modules');"),
      ("const bindingUrl = internalBinding('url');", "const bindingUrl = require('internal/url_binding');"),
     ], keep_header=True)

port('internal/data_url.js', 'internal/data_url.js', "MIMEType comes from internal/util_public/mime.",
     [PRIM, ("require('internal/mime')", "require('internal/util_public/mime')")])
print('ported')
